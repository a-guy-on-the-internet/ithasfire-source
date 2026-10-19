/**
 * savePageDraft: merge one batch of field-level patch ops into the page's
 * ONE shared draft (page editor spec
 * docs/specs/2026-10-08/entity-page-wysiwyg-editor.spec.yaml, R2, R9, R14,
 * FR-014, FR-015; storage: `model PageDraft`; op grammar and merge:
 * page-draft-ops.ts).
 *
 * ONE `repos.tx()`, under the draft row lock (lock order PageDraft, then
 * EntityPage, then Place; nothing here locks the other two). A community
 * moderator takes the place's claim advisory lock (`lockPlaceForClaim`)
 * FIRST, before PageDraft, the order claim submit and review use:
 *   0. (moderator only) lockPlaceForClaim, then the access rules again.
 *   1. lockDraftForUpdate.
 *   2. isBatchApplied BEFORE any validation: a batch whose id is already
 *      recorded is a lost-response retry. It is answered as success
 *      (`deduped`) from the current state and writes nothing. It is never
 *      re-validated: against the state it already produced it can fail (a
 *      retried "remove new block" finds the block gone).
 *   3. parseOps: grammar, caps, per-path value schemas, zone and pinned
 *      rules, rich-text sanitising (the only sanitising path), bio <= 280,
 *      reserved `v` / `v.*` paths, and image URLs (see below). Refused =>
 *      `refused` with every error; nothing is written.
 *   4. cancelPending for every owned page-image key the batch's values
 *      reference: a Discard queued draft-only images for deletion after a
 *      grace (discard-page-draft.ts), and this batch is using one again.
 *   5. mergeOps (last write wins per path, fieldEditors, placeBase on first
 *      touch, batch id recorded and trimmed) and writeDraft at revision + 1.
 *
 * Authz is updatePage's (entity-page-access.ts). A community moderator on a
 * PLACE nobody owns saves under the place's claim lock, taken BEFORE step 1
 * and re-checked there, so a claim that landed since the advisory check
 * refuses the save; an `applied` batch logs `entity_page.community_updated`
 * in the same transaction. ONE rule for moderators across save, discard and
 * publish: a moderator may not change an owner's pending Place patch in any
 * way, and never sees it. Here any `place.*` op, set or revert, is refused
 * (`place_fact_not_for_moderator`, like any other op error): Place facts go
 * through `updateCommunityPlace` and its rules (moderator place page spec,
 * D3).
 *
 * Image URLs (page.avatarUrl / page.bannerUrl): a NEW URL is accepted only
 * when the PARSED URL is at the storage's public origin and names a
 * metadata-STRIPPED copy under this page owner's key prefix
 * (`ownedStrippedPageImageKeyFromUrl`, page-image-urls.ts): Discard can
 * clean up what the draft alone referenced, nobody can point a page at
 * someone else's object, and a raw upload (original bytes, GPS included)
 * never reaches a page. The page's current live avatar / banner URL keeps
 * passing. Image-holding BLOCK fields (by BlockConfig field kind: the
 * Photos list today) accept the same stripped uploads, plus any URL already
 * in an image field of the live page (photos a page already shows from
 * elsewhere keep working); a new outside URL is refused. publishPageDraft
 * applies the same rule again.
 *
 * ── CLIENT CONTRACT ─────────────────────────────────────────────────────────
 * - `batchId` (UUID) is the idempotency key. Resend a batch after a network
 *   error with the SAME id and the same ops; the answer is `deduped`. Any
 *   change to the ops needs a NEW id.
 * - `refused` writes nothing. On `block_not_found` for a `new:<uuid>` block
 *   id (another editor removed that new block, or a Discard cleared it), the
 *   client drops every op of that batch on `blocks.new:<uuid>.*`, and that
 *   id from any `order.main` value, then resends the rest under a new batch
 *   id. Every other refusal is shown to the editor; resending it unchanged
 *   is refused again.
 * - `sync.clearedSince`: a Publish or Discard cleared the draft after
 *   `clientRevision`. An `applied` batch still landed, on top of the cleared
 *   draft (an edit made after the clear is the most recent write, R14). The
 *   client drops its local overlay and its undo entries into it, and takes
 *   `overlay` whole; it never merges its old overlay back.
 * - `sync.resync` without `clearedSince`: editor entries newer than the
 *   client were pruned; take `overlay` whole, keep unsent ops.
 * - Otherwise `sync.changes` lists every path written after
 *   `clientRevision` with its current value (the client's own batch
 *   included; `appliedRevision` tells it which revision was its own).
 *
 * SERVER-ONLY (imports page-draft-ops). Import by subpath:
 * `@th/core/use-cases/entity-pages/save-page-draft`.
 */

import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { PageDraftRecord } from "@th/types/repos/entity-pages";

import { parseInput } from "../../lib/io";
import {
  PAGE_DRAFT_MAX_OPS,
  changeCount,
  isBatchApplied,
  isEmptyDraft,
  mergeOps,
  pageDraftBatchIdSchema,
  parseOps,
  placeDraftFactsFromRecord,
  type PageDraftOpError,
  type PlaceDraftFacts,
} from "./page-draft-ops";
import {
  PAGE_DRAFT_DISCARD_DELETION_SOURCE,
  buildDraftSync,
  draftForEditor,
  draftValueAt,
  loadPageForDraft,
  pageDraftOwnerInputShape,
  pageImageScope,
  requireDraftLayout,
  withoutPlacePaths,
  type PageDraftSync,
} from "./page-draft-shared";
import { blockImageUrlsIn } from "./block-config";
import {
  logCommunityPageUpdate,
  recheckCommunityPageEditor,
  type EntityPageEditor,
} from "./entity-page-access";
import {
  chunkPageImageKeys,
  ownedStrippedPageImageKeyFromUrl,
  pageImageKeysMentionedIn,
} from "./page-image-urls";

export const savePageDraftInputSchema = z
  .object({
    ...pageDraftOwnerInputShape,
    batchId: pageDraftBatchIdSchema,
    /** The draft revision the client last saw (0 = none). */
    clientRevision: z.number().int().min(0),
    /**
     * Raw ops; parseOps validates each. Bounded here too: a batch over the
     * cap was never applied, so this can never refuse a genuine retry.
     */
    ops: z.array(z.unknown()).max(PAGE_DRAFT_MAX_OPS),
  })
  .strict();

export type SavePageDraftInput = z.infer<typeof savePageDraftInputSchema>;

type SavePageDraftState = {
  /** The draft revision after this call. */
  revision: number;
  changeCount: number;
  isEmpty: boolean;
  sync: PageDraftSync;
  /** The whole overlay when `sync.resync`; null otherwise. */
  overlay: {
    data: Record<string, unknown>;
    placePatch: Record<string, unknown>;
  } | null;
};

export type SavePageDraftOutput =
  | (SavePageDraftState & {
      outcome: "applied";
      /** The revision this batch wrote. */
      appliedRevision: number;
      /** Every path the batch changed. */
      touchedPaths: string[];
    })
  | (SavePageDraftState & {
      /** The batch id was already applied: a retry; nothing written. */
      outcome: "deduped";
    })
  | (SavePageDraftState & {
      /** Validation refused the batch; nothing written. */
      outcome: "refused";
      errors: PageDraftOpError[];
    });

export type SavePageDraftDeps = {
  /** `events` serves the community moderator access rules. */
  repos: Pick<
    Repos,
    "entityPages" | "places" | "events" | "pendingObjectDeletions" | "tx"
  >;
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace" | "hasStaffRole">;
  clock: ClockPort;
  /**
   * The file storage's public base URL (S3_PUBLIC_BASE_URL), against which
   * avatar / banner URLs are checked. REQUIRED so a composition root cannot
   * forget it; null where the deployment has none, which refuses every image
   * URL (fail closed).
   */
  storagePublicBaseUrl: string | null;
  logger?: LoggerPort;
};

/**
 * The answer's draft state, as `editor` may see it: a community moderator
 * gets no `place.*` value (an earlier owner's pending Place patch) in the
 * counts, the sync or the overlay.
 */
function stateOf(
  stored: PageDraftRecord,
  clientRevision: number,
  editor: EntityPageEditor,
): SavePageDraftState {
  const draft = draftForEditor(stored, editor);
  const sync = withoutPlacePaths(buildDraftSync(draft, clientRevision), editor);
  return {
    revision: draft.revision,
    changeCount: changeCount(draft),
    isEmpty: isEmptyDraft(draft),
    sync,
    overlay: sync.resync
      ? { data: draft.data, placePatch: draft.placePatch }
      : null,
  };
}

export async function savePageDraft(
  deps: SavePageDraftDeps,
  rawInput: unknown,
): Promise<SavePageDraftOutput> {
  const logger = deps.logger?.child({ useCase: "savePageDraft" });

  const execute = async (): Promise<SavePageDraftOutput> => {
    const input = parseInput(savePageDraftInputSchema, rawInput);
    const { page, editor } = await loadPageForDraft(deps, input);
    const imageScope = pageImageScope(
      input.ownerType,
      input.ownerId,
      deps.storagePublicBaseUrl,
    );

    return deps.repos.tx(async (tx): Promise<SavePageDraftOutput> => {
      // A community moderator: the claim lock FIRST (before the draft row),
      // then the rules again. No-op for an owner.
      await recheckCommunityPageEditor(tx, editor, deps.clock.now());
      const locked = await tx.entityPages.lockDraftForUpdate(page.id);

      // Idempotency FIRST, before any validation (see the module comment).
      if (isBatchApplied(locked, input.batchId)) {
        return {
          outcome: "deduped",
          ...stateOf(locked, input.clientRevision, editor),
        };
      }

      const theme = await tx.entityPages.getTheme(page.id);
      const layout = requireDraftLayout(input.ownerType, theme);
      const liveBlocks = await tx.entityPages.listBlocks(page.id);
      const liveImageUrls = blockImageUrlsIn(liveBlocks);

      const parsed = parseOps(input.ops, {
        ownerType: input.ownerType,
        layout,
        liveBlocks,
        draft: locked,
        // A NEW image must be this page's metadata-STRIPPED upload; the URL
        // the live page already shows in THAT field keeps passing (undo back
        // to live), as publishPageDraft decides. Never the other field's.
        isAllowedImageUrl: (url, field) =>
          ownedStrippedPageImageKeyFromUrl(url, imageScope) !== null ||
          (field === "avatarUrl" && url === page.avatarUrl) ||
          (field === "bannerUrl" && url === page.bannerUrl),
        isAllowedBlockImageUrl: (url) =>
          ownedStrippedPageImageKeyFromUrl(url, imageScope) !== null ||
          liveImageUrls.has(url),
      });
      if (!parsed.ok) {
        return {
          outcome: "refused",
          errors: parsed.errors,
          ...stateOf(locked, input.clientRevision, editor),
        };
      }
      if (editor.kind === "community_moderator") {
        const placeErrors: PageDraftOpError[] = [];
        parsed.ops.forEach((op, index) => {
          if (op.target.area === "place") {
            placeErrors.push({
              index,
              path: op.path,
              code: "place_fact_not_for_moderator",
            });
          }
        });
        if (placeErrors.length > 0) {
          return {
            outcome: "refused",
            errors: placeErrors,
            ...stateOf(locked, input.clientRevision, editor),
          };
        }
      }

      // A Discard may have queued some of these keys for deletion (after a
      // grace); this batch uses them again, so withdraw those intents in the
      // same transaction as the write. GENEROUS on purpose: over-cancelling
      // only leaks storage, under-cancelling deletes a live image. Any
      // mention of a key under this page's prefix, in any string of any set
      // value at any depth (a query-string variant, HTML; R19: no
      // image-field list). publishPageDraft (step 5) must do the same over
      // the WHOLE draft it publishes.
      const reusedKeys = pageImageKeysMentionedIn(
        parsed.ops.flatMap((op) => (op.op === "set" ? [op.value] : [])),
        imageScope.keyPrefix,
      );
      // Every key, in bounded chunks (the scan is never capped).
      for (const targetKeys of chunkPageImageKeys(reusedKeys)) {
        await tx.pendingObjectDeletions.cancelPending({
          source: PAGE_DRAFT_DISCARD_DELETION_SOURCE,
          targetKeys,
        });
      }

      // placeBase needs the live Place value of each field first set.
      let placeLive: PlaceDraftFacts | null = null;
      if (
        parsed.ops.some(
          (op) => op.op === "set" && op.target.area === "place",
        )
      ) {
        const place = await tx.places.getById(input.ownerId);
        if (!place) fail("OWNER_NOT_FOUND", { meta: { entity: "place" } });
        placeLive = placeDraftFactsFromRecord(place);
      }

      const merged = mergeOps(locked, parsed.ops, {
        batchId: input.batchId,
        actorHumanId: input.actorHumanId,
        now: deps.clock.now(),
        placeLive,
      });
      if (merged.deduped) {
        // Unreachable after isBatchApplied above; mergeOps keeps it as a
        // backstop, and the answer is the same.
        return {
          outcome: "deduped",
          ...stateOf(locked, input.clientRevision, editor),
        };
      }

      const written = await tx.entityPages.writeDraft(page.id, merged.next);
      await logCommunityPageUpdate(
        tx,
        editor,
        {
          actorHumanId: input.actorHumanId,
          pageId: page.id,
          op: "savePageDraft",
          fields: merged.touchedPaths,
          ...draftPathChanges(locked, written, merged.touchedPaths),
        },
        deps.clock.now(),
      );
      return {
        outcome: "applied",
        appliedRevision: written.revision,
        touchedPaths: merged.touchedPaths,
        ...stateOf(written, input.clientRevision, editor),
      };
    });
  };

  if (logger) return logger.withTime("savePageDraft", execute);
  return execute();
}

/**
 * A moderator save's audit `from` / `to`: each touched path's draft value
 * before and after the batch (absent = not in the draft, the live value
 * shows), with the revisions. A `place.*` path is recorded as PRESENCE only
 * (`{ present: true }` / `{ absent: true }`): its value can be an earlier
 * owner's pending street address or phone, which a moderator may revert but
 * the audit row must not copy.
 */
function draftPathChanges(
  before: PageDraftRecord,
  after: PageDraftRecord,
  touchedPaths: readonly string[],
): { from: unknown; to: unknown } {
  const side = (draft: PageDraftRecord) => ({
    revision: draft.revision,
    paths: Object.fromEntries(
      touchedPaths.map((path) => {
        const at = draftValueAt(draft, path);
        if (!at.present) return [path, { absent: true }];
        return [
          path,
          path.startsWith("place.") ? { present: true } : { value: at.value },
        ];
      }),
    ),
  });
  return { from: side(before), to: side(after) };
}
