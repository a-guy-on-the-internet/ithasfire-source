/**
 * discardPageDraft: throw away the page's shared draft and queue deletion of
 * the uploaded images only the draft used (page editor spec
 * docs/specs/2026-10-08/entity-page-wysiwyg-editor.spec.yaml, FR-018, R2;
 * storage: `model PageDraft`).
 *
 * The draft row is CLEARED (`clearDraft`: overlays to `{}`, revision + 1,
 * appliedBatchIds and lastPublishedRevision kept), never deleted: revision
 * and appliedBatchIds are idempotency keys that must not restart (see the
 * PageDraft comment). Same authz as updatePage (entity-page-access.ts): a
 * community moderator on a PLACE nobody owns discards under the place's
 * claim lock, re-checked in the transaction, and a discard that clears logs
 * `entity_page.community_updated` there. ONE rule for moderators across
 * save, discard and publish: a moderator may not change an owner's pending
 * Place patch in any way, and never sees it. Here a draft holding a Place
 * patch refuses a moderator's discard (`INVALID_INPUT` /
 * `page_draft_holds_place_patch`), since the clear would drop it.
 *
 * `expectedRevision` is REQUIRED: the revision the editor confirmed the
 * discard against. Outcomes:
 *   discarded      cleared; draft-only images queued for deletion.
 *   already_empty  nothing pending (a lost-response retry lands here); no
 *                  write.
 *   stale          the draft moved past `expectedRevision` (another editor
 *                  saved after the confirm): nothing written, so nobody's
 *                  newer edits vanish unseen. The client refetches and asks
 *                  again.
 *
 * ── IMAGE CLEANUP ───────────────────────────────────────────────────────────
 * Candidates: keys the pre-clear draft referenced as owned page images
 * (exact storage origin, under this owner's key prefix: page-image-urls.ts)
 * that no string in the live page, theme, blocks (every section) or, for a
 * PLACE page, the Place row contains, read in this transaction after the
 * clear. They are enqueued to the pending-object-deletions outbox INSIDE the
 * transaction, under the draft lock, with `notBefore` = now +
 * PAGE_DRAFT_DISCARD_DELETE_GRACE_MS. A failed enqueue rolls the discard
 * back and surfaces; there is no swallow.
 *
 * Why the grace: R14 applies a save that lands after the clear (an editor's
 * in-flight batch, or one sent before its poll saw the clear), and that save
 * may put a candidate key back. savePageDraft cancels the PENDING intents of
 * every owned key its batch references (`cancelPending`, same transaction as
 * the write), and publishPageDraft must do the same over the whole draft.
 * So a key is deleted only when nothing referenced it for the whole grace.
 *
 * The drain also re-checks page references at delete time
 * (isPageImageKeyReferenced), for this source and for the handover Clear. That
 * covers the live editors (updatePage, managePageBlocks, updatePageTheme),
 * which cancel nothing: a key they put back during the grace is kept.
 *
 * Remaining gap: a client that resends a key AFTER the drain deleted it (more
 * than the grace after the discard, with no page reference at that moment)
 * stores a dangling URL. Step 10's client must drop its local overlay and its
 * undo stack on `clearedSince`, so it never resends what the discard removed.
 *
 * Also not queued: an image the draft held and then replaced (last write
 * wins) is no longer in the overlay at discard time.
 *
 * SERVER-ONLY (imports page-draft-ops). Import by subpath:
 * `@th/core/use-cases/entity-pages/discard-page-draft`.
 */

import { z } from "zod";

import { fail } from "@th/errors";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EnqueuePendingObjectDeletionItem } from "@th/types/repos/pending-object-deletions";

import { parseInput } from "../../lib/io";
import {
  logCommunityPageUpdate,
  recheckCommunityPageEditor,
} from "./entity-page-access";
import { isEmptyDraft } from "./page-draft-ops";
import {
  PAGE_DRAFT_DISCARD_DELETE_GRACE_MS,
  PAGE_DRAFT_DISCARD_DELETION_SOURCE,
  draftForEditor,
  loadPageForDraft,
  pageDraftOwnerInputShape,
  pageImageScope,
} from "./page-draft-shared";
import { collectStrings, ownedPageImageKeysIn } from "./page-image-urls";

export const discardPageDraftInputSchema = z
  .object({
    ...pageDraftOwnerInputShape,
    /** The draft revision the editor confirmed the discard against. */
    expectedRevision: z.number().int().min(0),
  })
  .strict();

export type DiscardPageDraftInput = z.infer<typeof discardPageDraftInputSchema>;

export type DiscardPageDraftOutput = {
  outcome: "discarded" | "already_empty" | "stale";
  /** The draft revision after this call. */
  revision: number;
  /** Draft-only image objects queued for deletion after the grace. */
  imagesQueuedForDeletion: number;
};

export type DiscardPageDraftDeps = {
  /** `events` serves the community moderator access rules. */
  repos: Pick<
    Repos,
    "entityPages" | "places" | "events" | "pendingObjectDeletions" | "tx"
  >;
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace" | "hasStaffRole">;
  clock: ClockPort;
  /**
   * The file storage's public base URL (S3_PUBLIC_BASE_URL). Null = no URL
   * is an owned upload, so nothing is queued (objects leak; the wrong one is
   * never deleted).
   */
  storagePublicBaseUrl: string | null;
  logger?: LoggerPort;
};

export async function discardPageDraft(
  deps: DiscardPageDraftDeps,
  rawInput: unknown,
): Promise<DiscardPageDraftOutput> {
  const logger = deps.logger?.child({ useCase: "discardPageDraft" });

  const execute = async (): Promise<DiscardPageDraftOutput> => {
    const input = parseInput(discardPageDraftInputSchema, rawInput);
    const { page, editor } = await loadPageForDraft(deps, input);
    const imageScope = pageImageScope(
      input.ownerType,
      input.ownerId,
      deps.storagePublicBaseUrl,
    );

    return deps.repos.tx(async (tx): Promise<DiscardPageDraftOutput> => {
      // A community moderator: the claim lock FIRST (before the draft row),
      // then the rules again, so a claim that landed since the advisory
      // check refuses the discard. No-op for an owner.
      await recheckCommunityPageEditor(tx, editor, deps.clock.now());
      const locked = await tx.entityPages.lockDraftForUpdate(page.id);
      // A moderator's view has no Place patch (they never see it), so a
      // draft holding only an owner's pending Place edits is empty to them.
      if (isEmptyDraft(draftForEditor(locked, editor))) {
        return {
          outcome: "already_empty",
          revision: locked.revision,
          imagesQueuedForDeletion: 0,
        };
      }
      if (input.expectedRevision !== locked.revision) {
        return {
          outcome: "stale",
          revision: locked.revision,
          imagesQueuedForDeletion: 0,
        };
      }
      // A moderator cannot see the Place patch an earlier owner left, so
      // discarding it would drop edits they never saw: refused, nothing
      // written (they can revert page paths one by one). clearDraft clears
      // both overlays and is the only clear that keeps the sync contract.
      if (
        editor.kind === "community_moderator" &&
        Object.keys(locked.placePatch).length > 0
      ) {
        fail("INVALID_INPUT", {
          message: "page_draft_holds_place_patch",
          meta: { reason: "page_draft_holds_place_patch" },
        });
      }

      const draftKeys = ownedPageImageKeysIn(
        [locked.data, locked.placePatch],
        imageScope,
      );
      const cleared = await tx.entityPages.clearDraft(page.id, {
        revision: locked.revision + 1,
        updatedByHumanId: input.actorHumanId,
      });
      // Paths only, never the discarded values (data minimisation: a Place
      // patch can hold a street address the place withholds).
      const discardedPaths = [
        ...Object.keys(locked.data),
        ...Object.keys(locked.placePatch).map((field) => `place.${field}`),
      ];
      await logCommunityPageUpdate(
        tx,
        editor,
        {
          actorHumanId: input.actorHumanId,
          pageId: page.id,
          op: "discardPageDraft",
          fields: discardedPaths,
          from: { revision: locked.revision },
          to: { revision: cleared.revision },
        },
        deps.clock.now(),
      );
      if (draftKeys.length === 0) {
        return {
          outcome: "discarded",
          revision: cleared.revision,
          imagesQueuedForDeletion: 0,
        };
      }

      // What the LIVE page still uses, read after the clear. Every string of
      // every surface (R19: a later image field needs no change here), and a
      // substring match: anything that mentions the key keeps it.
      const livePage = await tx.entityPages.getById(page.id);
      const theme = await tx.entityPages.getTheme(page.id);
      const blocks = await tx.entityPages.listBlocks(page.id);
      const place =
        input.ownerType === "PLACE"
          ? await tx.places.getById(input.ownerId)
          : null;
      const liveStrings = collectStrings([
        livePage,
        theme,
        blocks.map((block) => block.data),
        place,
      ]);
      const orphanKeys = draftKeys.filter(
        (key) => !liveStrings.some((value) => value.includes(key)),
      );

      const notBefore = new Date(
        deps.clock.now().getTime() + PAGE_DRAFT_DISCARD_DELETE_GRACE_MS,
      );
      const items: EnqueuePendingObjectDeletionItem[] = orphanKeys.map(
        (targetKey) => ({
          targetKey,
          targetKind: "KEY",
          source: PAGE_DRAFT_DISCARD_DELETION_SOURCE,
          sourceId: page.id,
          notBefore,
        }),
      );
      // Same transaction as the clear (transactional outbox): both commit or
      // neither does.
      await tx.pendingObjectDeletions.enqueueMany(items);
      return {
        outcome: "discarded",
        revision: cleared.revision,
        imagesQueuedForDeletion: items.length,
      };
    });
  };

  if (logger) return logger.withTime("discardPageDraft", execute);
  return execute();
}
