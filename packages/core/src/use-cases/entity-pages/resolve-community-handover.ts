/**
 * resolveCommunityHandover: the owner's "Keep it" / "Clear it" on what
 * community moderators wrote on their PLACE's page before they claimed it
 * (moderator place page spec
 * docs/specs/2026-10-14/moderator-place-page.spec.yaml, D6, FR-007b).
 *
 * OWNER ONLY (`canManagePlace`, the same check as getCommunityHandover),
 * checked before any read or transaction.
 *
 * Both choices log `entity_page.community_handover` in the transaction,
 * which ends the pending state (the public attribution and the notice) by
 * derivation; no flag is stored. Row data: { actorHumanId, pageId, placeId,
 * choice, pendingUpdateCount, pendingTruncated } and, for a Clear, `before`
 * and `queuedImageKeys` (below). `pendingUpdateCount` is EXACT when
 * `pendingTruncated` is false and a LOWER BOUND when it is true (the pending
 * read is bounded at COMMUNITY_HANDOVER_MAX_UPDATES).
 *
 *   keep    the audit row, nothing else.
 *   clear   ONE transaction, scoped to what the spec lists and nothing of
 *           the owner's own:
 *             - refused when the page's draft holds anything (data or a
 *               Place patch): `INVALID_INPUT`, meta.reason
 *               "handover_draft_pending", nothing written. The owner
 *               publishes or discards first, so Clear never drops work of
 *               theirs they did not see go;
 *             - page: bio, avatarUrl and bannerUrl emptied (slug, display
 *               name and visibility stay);
 *             - blocks: the MAIN section only. Its non-pinned blocks are
 *               deleted and the PLACE template written fresh, in template
 *               order (`templateSpecToBlock`, as the first seed writes it).
 *               Pinned blocks (track_record) are kept and moved to their
 *               kind's template slot; a pinned kind the page lacks is not
 *               created here. Every other section (memberships) keeps
 *               its blocks, content and images; its blocks only move, in
 *               order, to after the new main column;
 *             - theme: every column back to null (the defaults), when the
 *               page has a theme row;
 *             - recovery: `before` holds the bio, avatarUrl, bannerUrl, the
 *               theme columns and every main-section block's id, kind and
 *               data, each bounded by `boundAuditValue` (evidence and a
 *               recovery aid; a large value is kept as a digest);
 *             - images: every owned page image (this place's key prefix, at
 *               the storage's public origin) that the page fields, theme or
 *               main-section blocks referenced before the clear and that
 *               nothing references after it (page, theme, every block, the
 *               Place row) is queued on the pending-object-deletions outbox
 *               under COMMUNITY_HANDOVER_CLEAR_DELETION_SOURCE, after the
 *               discard grace. The drain RE-CHECKS that the page still does
 *               not use the key right before deleting
 *               (`isPageImageKeyReferenced`), so an image the owner puts
 *               back afterwards by ANY path (Undo through managePageBlocks,
 *               updatePage re-sending the old avatar, a draft) survives;
 *             - search: the place is marked for reindex (the bio is in its
 *               document) and reindexed after commit, as updatePage does.
 *
 * Nothing pending (no moderator write newer than the latest handover):
 * `outcome: "nothing_pending"`, NO write and no audit row, for either
 * choice. A retry after a lost response is harmless, and Clear can never
 * reset a page the moderators did not write.
 *
 * Concurrency: the page's draft row lock is taken FIRST (the documented lock
 * order: PageDraft, then EntityPage), and the pending state and the draft
 * are read after it, so two owners choosing at once apply one choice (the
 * second answers "nothing_pending") and a draft save cannot slip in between
 * the draft check and the clear. Moderators cannot write meanwhile: the
 * place is owned, and their writes re-check ownership under the claim lock.
 *
 * SERVER-ONLY (imports page-draft-ops). Import by subpath:
 * `@th/core/use-cases/entity-pages/resolve-community-handover`.
 */

import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type {
  EntityPageRecord,
  PageBlockRecord,
  PageThemeRecord,
} from "@th/types/repos/entity-pages";
import type { EnqueuePendingObjectDeletionItem } from "@th/types/repos/pending-object-deletions";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import {
  markForSearchReindex,
  type SearchReindexSelector,
} from "../search/search-reindex-marks";
import { isPinnedBlockKind } from "./block-config";
import { normalizeBlockSection } from "./block-sections";
import {
  ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION,
  findPendingCommunityHandover,
} from "./community-handover-state";
import { ENTITY_PAGE_AUDIT_ENTITY, boundAuditValue } from "./entity-page-access";
import { requirePlaceOwner } from "./get-community-handover";
import { isEmptyDraft } from "./page-draft-ops";
import {
  PAGE_DRAFT_DISCARD_DELETE_GRACE_MS,
  pageImageScope,
} from "./page-draft-shared";
import { COMMUNITY_HANDOVER_CLEAR_DELETION_SOURCE } from "./page-image-references";
import { collectStrings, ownedPageImageKeysIn } from "./page-image-urls";
import { getPageTemplate, resolveCategory } from "./page-templates";
import { templateSpecToBlock } from "./seed-page-template-blocks";

export const COMMUNITY_HANDOVER_CHOICES = ["keep", "clear"] as const;

/** `meta.reason` of a Clear refused because the page draft holds edits. */
export const HANDOVER_DRAFT_PENDING_REASON = "handover_draft_pending";

export const resolveCommunityHandoverInputSchema = z
  .object({
    actorHumanId: z.string().min(1).max(200),
    placeId: z.string().uuid(),
    choice: z.enum(COMMUNITY_HANDOVER_CHOICES),
  })
  .strict();

export const resolveCommunityHandoverOutputSchema = z
  .object({
    outcome: z.enum(["kept", "cleared", "nothing_pending"]),
    pageId: z.string(),
    /** Image objects queued for deletion (after the grace); 0 unless cleared. */
    imagesQueuedForDeletion: z.number().int().nonnegative(),
  })
  .strict();

export type ResolveCommunityHandoverInput = z.infer<
  typeof resolveCommunityHandoverInputSchema
>;
export type ResolveCommunityHandoverOutput = z.infer<
  typeof resolveCommunityHandoverOutputSchema
>;
export type CommunityHandoverChoice =
  (typeof COMMUNITY_HANDOVER_CHOICES)[number];

export type ResolveCommunityHandoverDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "canManagePlace">;
  clock: ClockPort;
  /**
   * The file storage's public base URL (S3_PUBLIC_BASE_URL). Null = no URL
   * is an owned upload, so nothing is queued (objects leak; the wrong one is
   * never deleted), as in discardPageDraft.
   */
  storagePublicBaseUrl: string | null;
  /** The post-commit reindex after a Clear (as updatePage). */
  search?: MultiSearchPort;
  logger?: LoggerPort;
  /** Forwarded to the reindex and the pending read's malformed-row report. */
  reportError?: ReporterPort;
};

export async function resolveCommunityHandover(
  deps: ResolveCommunityHandoverDeps,
  rawInput: unknown,
): Promise<ResolveCommunityHandoverOutput> {
  const logger = deps.logger?.child({ useCase: "resolveCommunityHandover" });

  const execute = async (): Promise<ResolveCommunityHandoverOutput> => {
    const input = parseInput(resolveCommunityHandoverInputSchema, rawInput);
    await requirePlaceOwner(deps.authz, input.actorHumanId, input.placeId);

    const page = await deps.repos.entityPages.getByOwner("PLACE", input.placeId);
    if (!page) fail("PAGE_NOT_FOUND");

    const selector: SearchReindexSelector = { kind: "place", id: input.placeId };

    const result = await deps.repos.tx(
      async (tx): Promise<ResolveCommunityHandoverOutput> => {
        // The FIRST lock of the transaction (PageDraft, then EntityPage):
        // serialises two owners choosing at once, and holds off a draft
        // save between the check below and the clear.
        const draft = await tx.entityPages.lockDraftForUpdate(page.id);
        const pending = await findPendingCommunityHandover(
          tx,
          page.id,
          deps.reportError,
        );
        if (!pending) {
          return {
            outcome: "nothing_pending",
            pageId: page.id,
            imagesQueuedForDeletion: 0,
          };
        }
        if (input.choice === "clear" && !isEmptyDraft(draft)) {
          fail("INVALID_INPUT", {
            message: HANDOVER_DRAFT_PENDING_REASON,
            meta: { reason: HANDOVER_DRAFT_PENDING_REASON },
          });
        }

        const now = deps.clock.now();
        let cleared: ClearedPage | null = null;
        if (input.choice === "clear") {
          cleared = await clearPage(deps, tx, {
            pageId: page.id,
            placeId: input.placeId,
            now,
          });
          await markForSearchReindex(tx, [selector], now);
        }

        await tx.audit.log({
          entity: ENTITY_PAGE_AUDIT_ENTITY,
          entityId: page.id,
          action: ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION,
          data: {
            actorHumanId: input.actorHumanId,
            pageId: page.id,
            placeId: input.placeId,
            choice: input.choice,
            pendingUpdateCount: pending.updates.length,
            pendingTruncated: pending.truncated,
            ...(cleared && {
              before: cleared.before,
              queuedImageKeys: boundAuditValue(cleared.queuedImageKeys),
            }),
          },
          at: now,
        });

        return {
          outcome: input.choice === "clear" ? "cleared" : "kept",
          pageId: page.id,
          imagesQueuedForDeletion: cleared?.queuedImageKeys.length ?? 0,
        };
      },
    );

    if (result.outcome === "cleared") {
      reindexAfterMutation(
        {
          repos: deps.repos,
          search: deps.search,
          clock: deps.clock,
          logger: deps.logger,
          reportError: deps.reportError,
        },
        "resolveCommunityHandover",
        selector,
      );
    }

    return resolveCommunityHandoverOutputSchema.parse(result);
  };

  if (logger) return logger.withTime("resolveCommunityHandover", execute);
  return execute();
}

type ClearedPage = {
  /** The recovery snapshot for the audit row (each value bounded). */
  before: Record<string, unknown>;
  /** Storage keys queued for deletion. */
  queuedImageKeys: string[];
};

function isMainSection(block: PageBlockRecord): boolean {
  return normalizeBlockSection(block.section) === "main";
}

/** What Clear changes, as it stood, bounded per value for the audit row. */
function beforeSnapshot(
  page: EntityPageRecord,
  theme: PageThemeRecord | null,
  mainBlocks: PageBlockRecord[],
): Record<string, unknown> {
  return {
    bio: boundAuditValue(page.bio),
    avatarUrl: boundAuditValue(page.avatarUrl),
    bannerUrl: boundAuditValue(page.bannerUrl),
    theme: theme
      ? {
          colorPrimary: theme.colorPrimary,
          colorBg: theme.colorBg,
          colorText: theme.colorText,
          fontKey: theme.fontKey,
          layoutKey: theme.layoutKey,
        }
      : null,
    mainBlocks: mainBlocks.map((block) => ({
      id: block.id,
      kind: block.kind,
      orderIndex: block.orderIndex,
      visible: block.visible,
      data: boundAuditValue(block.data),
    })),
  };
}

/** The Clear, inside the caller's transaction (after the draft lock). */
async function clearPage(
  deps: Pick<ResolveCommunityHandoverDeps, "storagePublicBaseUrl">,
  tx: TxRepos,
  args: { pageId: string; placeId: string; now: Date },
): Promise<ClearedPage> {
  const { pageId, placeId, now } = args;
  const current = await tx.entityPages.getById(pageId);
  if (!current) fail("PAGE_NOT_FOUND");
  const themeBefore = await tx.entityPages.getTheme(pageId);
  const blocksBefore = (await tx.entityPages.listBlocks(pageId)).sort(
    (a, b) => a.orderIndex - b.orderIndex,
  );
  const mainBefore = blocksBefore.filter(isMainSection);
  const otherSections = blocksBefore.filter((block) => !isMainSection(block));
  const before = beforeSnapshot(current, themeBefore, mainBefore);

  // Only what Clear removes can be orphaned by it: the page images, the
  // theme, the main section. Another section's images are not candidates.
  const imageScope = pageImageScope("PLACE", placeId, deps.storagePublicBaseUrl);
  const candidateKeys = ownedPageImageKeysIn(
    [
      current.avatarUrl,
      current.bannerUrl,
      themeBefore,
      mainBefore.map((block) => block.data),
    ],
    imageScope,
  );

  // ── Page fields ─────────────────────────────────────────────────────────
  await tx.entityPages.upsert({
    ownerType: "PLACE",
    ownerId: placeId,
    slug: current.slug,
    displayName: current.displayName,
    bio: null,
    avatarUrl: null,
    bannerUrl: null,
    visibility: current.visibility,
  });

  // ── Main-section blocks: the template, fresh; pinned blocks kept ───────
  await resetMainSectionToTemplate(tx, pageId, mainBefore, otherSections);

  // ── Theme: the defaults ─────────────────────────────────────────────────
  if (themeBefore) {
    await tx.entityPages.upsertTheme({
      pageId,
      colorPrimary: null,
      colorBg: null,
      colorText: null,
      fontKey: null,
      layoutKey: null,
    });
  }

  // ── Images no longer used: the outbox ───────────────────────────────────
  if (candidateKeys.length === 0) return { before, queuedImageKeys: [] };
  // What still references a key, read after the clear: every string of
  // every surface (every section included), substring match.
  const livePage = await tx.entityPages.getById(pageId);
  const liveTheme = await tx.entityPages.getTheme(pageId);
  const liveBlocks = await tx.entityPages.listBlocks(pageId);
  const place = await tx.places.getById(placeId);
  const liveStrings = collectStrings([
    livePage,
    liveTheme,
    liveBlocks.map((block) => block.data),
    place,
  ]);
  const orphanKeys = candidateKeys.filter(
    (key) => !liveStrings.some((value) => value.includes(key)),
  );
  if (orphanKeys.length === 0) return { before, queuedImageKeys: [] };
  const notBefore = new Date(now.getTime() + PAGE_DRAFT_DISCARD_DELETE_GRACE_MS);
  const items: EnqueuePendingObjectDeletionItem[] = orphanKeys.map(
    (targetKey) => ({
      targetKey,
      targetKind: "KEY",
      source: COMMUNITY_HANDOVER_CLEAR_DELETION_SOURCE,
      sourceId: pageId,
      notBefore,
    }),
  );
  // Same transaction as the clear (transactional outbox).
  await tx.pendingObjectDeletions.enqueueMany(items);
  return { before, queuedImageKeys: orphanKeys };
}

/**
 * The MAIN section's non-pinned blocks deleted; the PLACE template written
 * fresh in its order, with each kept pinned block moved to its kind's
 * template slot. Pinned blocks the template does not place go after it.
 * Other sections keep their content and relative order; only their
 * orderIndex moves to after the new main column, the one index space per
 * page publishPageDraft keeps (main column first, then the other sections).
 */
async function resetMainSectionToTemplate(
  tx: TxRepos,
  pageId: string,
  mainBefore: PageBlockRecord[],
  otherSections: PageBlockRecord[],
): Promise<void> {
  const kept = mainBefore.filter((block) => isPinnedBlockKind(block.kind));
  for (const block of mainBefore) {
    if (!isPinnedBlockKind(block.kind)) {
      await tx.entityPages.deleteBlock(block.id);
    }
  }

  const template = getPageTemplate(
    "PLACE",
    resolveCategory("PLACE", { performerEnabled: false }),
  );
  const remainingPinned = [...kept];
  let orderIndex = 0;
  for (const spec of template) {
    if (isPinnedBlockKind(spec.kind)) {
      const at = remainingPinned.findIndex((block) => block.kind === spec.kind);
      if (at === -1) continue;
      const [pinned] = remainingPinned.splice(at, 1);
      if (pinned) {
        await tx.entityPages.updateBlock({ id: pinned.id, orderIndex });
        orderIndex += 1;
      }
      continue;
    }
    const seeded = templateSpecToBlock(spec);
    await tx.entityPages.createBlock({
      pageId,
      kind: seeded.kind,
      orderIndex,
      data: seeded.data,
      visible: seeded.visible,
      section: "main",
    });
    orderIndex += 1;
  }
  for (const pinned of remainingPinned) {
    await tx.entityPages.updateBlock({ id: pinned.id, orderIndex });
    orderIndex += 1;
  }
  for (const block of otherSections) {
    if (block.orderIndex !== orderIndex) {
      await tx.entityPages.updateBlock({ id: block.id, orderIndex });
    }
    orderIndex += 1;
  }
}
