/**
 * Read-time image review gate for a PUBLIC entity page (moderator place page
 * spec docs/specs/2026-10-14/moderator-place-page.spec.yaml, owner ruling
 * R5: a community moderator's page uploads go through the image review).
 *
 * finalize-page-image-upload enqueues an `ImageModerationRecord` for every
 * image a community moderator uploads to an unowned place's page. This hides
 * any page image whose record is not APPROVED (PENDING, FLAGGED, REJECTED,
 * ORPHANED) from the public payload, by the one visibility rule every public
 * image read uses (`resolveVisibleImageKeys`: no record = legacy = visible).
 * Owner uploads have no record, so they are never hidden.
 *
 * A hidden image is ABSENT, never a broken URL:
 *   - `avatarUrl` / `bannerUrl` naming one → null;
 *   - an `image` field naming one → the field is dropped;
 *   - an `imageList` item naming one → the item is dropped;
 *   - anything else in a block that still names one (an `<img>` inside rich
 *     text, a URL in a text field) → the whole block is omitted. Fail closed:
 *     the block comes back once the image is approved (minutes, normally).
 *
 * Exactly ONE `resolveByKeys` round-trip per PLACE page, and none for a page
 * that names no uploaded image or is not a place's. Candidate keys are found by the same generous
 * scan the delete paths use (`pageImageKeysMentionedIn`, the page's own key
 * prefix), so an image is gated wherever on the page it sits.
 *
 * A failing lookup THROWS (the page read fails; nothing is cached), the same
 * as the event hero gate in get-event-seo: there is no catch-and-fallback
 * here, so no `reportError` either. The tRPC backstop reports the throw.
 *
 * Editor reads (getMyPage, getPageDraft) do not run this: the editor shows
 * what was uploaded, pending or not, as the event editor shows a pending hero.
 */

import type { Repos } from "@th/ports/repos";
import type { PageOwnerType } from "@th/types/repos/entity-pages";

import { resolveVisibleImageKeys } from "../moderation/gate-image-visibility";
import { getBlockConfig, type BlockFieldKind } from "./block-config";
import { getEntityPageImageKeyPrefix } from "./page-image-upload-helpers";
import { collectStrings, pageImageKeysMentionedIn } from "./page-image-urls";

type GateablePage = {
  ownerType: PageOwnerType;
  ownerId: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
};

type GateableBlock = { kind: string; data: unknown };

export type GatedPublicPageImages<P, B> = {
  page: P;
  blocks: B[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The public page and its blocks with every image the image review has not
 * approved taken out (see the module comment). Returns the inputs unchanged
 * (same objects) when nothing is hidden.
 */
export async function gatePublicPageImages<
  P extends GateablePage,
  B extends GateableBlock,
>(
  repos: Pick<Repos, "imageModerationRecords">,
  page: P,
  blocks: readonly B[],
): Promise<GatedPublicPageImages<P, B>> {
  // Only a PLACE page can hold a reviewed image (a community moderator's
  // upload to an unowned place, the only producer of a page image record),
  // so a HUMAN or ORGANIZATION page costs no lookup.
  if (page.ownerType !== "PLACE") return { page, blocks: [...blocks] };
  const keyPrefix = getEntityPageImageKeyPrefix(page.ownerType, page.ownerId);
  const candidates = pageImageKeysMentionedIn(
    [page.avatarUrl, page.bannerUrl, blocks.map((block) => block.data)],
    keyPrefix,
  );
  if (candidates.length === 0) return { page, blocks: [...blocks] };

  const visible = await resolveVisibleImageKeys(repos, candidates);
  const hidden = candidates.filter((key) => !visible.has(key));
  if (hidden.length === 0) return { page, blocks: [...blocks] };

  const mentionsHidden = (value: string) =>
    hidden.some((key) => value.includes(key));
  const anyHidden = (value: unknown) =>
    collectStrings(value).some(mentionsHidden);

  const gatedPage: P = {
    ...page,
    avatarUrl:
      page.avatarUrl !== null && mentionsHidden(page.avatarUrl)
        ? null
        : page.avatarUrl,
    bannerUrl:
      page.bannerUrl !== null && mentionsHidden(page.bannerUrl)
        ? null
        : page.bannerUrl,
  };

  const gatedBlocks: B[] = [];
  for (const block of blocks) {
    if (!anyHidden(block.data)) {
      gatedBlocks.push(block);
      continue;
    }
    const data: unknown = isRecord(block.data) ? { ...block.data } : block.data;
    if (isRecord(data)) {
      for (const field of getBlockConfig(block.kind)?.fields ?? []) {
        // Widened: no config uses an `image` field today, and one added
        // later is gated here without a change.
        const fieldKind = field.kind as BlockFieldKind;
        const value = data[field.name];
        if (
          fieldKind === "image" &&
          typeof value === "string" &&
          mentionsHidden(value)
        ) {
          delete data[field.name];
        } else if (fieldKind === "imageList" && Array.isArray(value)) {
          data[field.name] = value.filter((item) => !anyHidden(item));
        }
      }
    }
    // Still names a hidden image somewhere the fields above do not cover:
    // omit the block rather than publish the URL.
    if (anyHidden(data)) continue;
    gatedBlocks.push({ ...block, data });
  }

  return { page: gatedPage, blocks: gatedBlocks };
}
