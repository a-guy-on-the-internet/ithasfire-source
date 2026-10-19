/**
 * Whether an uploaded page image is still used anywhere on its page, asked
 * by the deletion drain right before it deletes an object the moderator
 * place page handover's Clear queued (moderator place page spec
 * docs/specs/2026-10-14/moderator-place-page.spec.yaml, D6) or a page
 * draft Discard queued (discardPageDraft).
 *
 * Why the drain asks, not the writers: Clear queues LIVE images (the
 * moderator's avatar, banner, photos), and after it the owner can put one
 * back through any live editor path (managePageBlocks `add` from Undo,
 * updatePage re-sending the old avatar, updatePageTheme), none of which
 * cancel outbox intents. Checking at delete time covers every path, present
 * and future, in one place.
 *
 * "Used" is the same generous rule discardPageDraft applies after its clear:
 * any string anywhere in the page row, its theme, EVERY block's data (every
 * section), its draft (data and Place patch) or, for a PLACE page, the Place
 * row contains the key. A page that no longer exists uses nothing.
 *
 * Pure reads; no node-only imports (safe for the barrel's import graph).
 */

import type { Repos } from "@th/ports/repos";

import { collectStrings } from "./page-image-urls";

/**
 * `source` of the pending-object-deletions rows resolveCommunityHandover's
 * Clear writes (`sourceId` = the page id). The drain re-checks references
 * for this source before deleting ({@link isPageImageKeyReferenced}).
 */
export const COMMUNITY_HANDOVER_CLEAR_DELETION_SOURCE =
  "community_handover_clear";

/**
 * `source` of the pending-object-deletions rows discardPageDraft writes
 * (`sourceId` = the page id; every key is under the page owner's prefix).
 * Defined here, not in page-draft-shared (which re-exports it), so the
 * drain's import stays free of the server-only draft ops.
 */
export const PAGE_DRAFT_DISCARD_DELETION_SOURCE = "page_draft_discard";

/**
 * Sources whose rows name a page image (`sourceId` = the page id) that a
 * live editor path can put back between enqueue and drain: the drain re-asks
 * {@link isPageImageKeyReferenced} right before deleting. Discard's own
 * grace + cancelPending covers draft saves and publishes, not the live
 * editors (updatePage, managePageBlocks, updatePageTheme), which cancel
 * nothing.
 */
const PAGE_REFERENCE_CHECKED_SOURCES: ReadonlySet<string> = new Set([
  COMMUNITY_HANDOVER_CLEAR_DELETION_SOURCE,
  PAGE_DRAFT_DISCARD_DELETION_SOURCE,
]);

/** True when the drain must re-check page references before deleting. */
export function isPageReferenceCheckedSource(
  source: string | null,
): source is string {
  return source !== null && PAGE_REFERENCE_CHECKED_SOURCES.has(source);
}

export type PageImageReferenceRepos = {
  entityPages: Pick<
    Repos["entityPages"],
    "getById" | "getTheme" | "listBlocks" | "getDraft"
  >;
  places: Pick<Repos["places"], "getById">;
};

/** True when anything on page `pageId` still mentions storage key `key`. */
export async function isPageImageKeyReferenced(
  repos: PageImageReferenceRepos,
  pageId: string,
  key: string,
): Promise<boolean> {
  const page = await repos.entityPages.getById(pageId);
  if (!page) return false;
  const theme = await repos.entityPages.getTheme(pageId);
  const blocks = await repos.entityPages.listBlocks(pageId);
  const draft = await repos.entityPages.getDraft(pageId);
  const place =
    page.ownerType === "PLACE"
      ? await repos.places.getById(page.ownerId)
      : null;
  return collectStrings([
    page,
    theme,
    blocks.map((block) => block.data),
    draft ? [draft.data, draft.placePatch] : null,
    place,
  ]).some((value) => value.includes(key));
}
