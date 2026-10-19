import type { PageVisibility } from "@th/types/repos/entity-pages";

/**
 * THE single place that decides whether an EntityPage's slug may be used to
 * build a link. Every surface that emits a `/p/{slug}` or `/places/{slug}` URL
 * MUST go through one of these two functions rather than reading `page.slug`
 * directly — a bare `page?.slug ?? null` is the bug this module exists to stop.
 *
 * ── Why a slug is not a link ────────────────────────────────────────────────
 * `EntityPage.visibility` is owner-settable on the venue page editor
 * (`update-page.ts`, `PageFieldsEditor`), and the public loader
 * (`get-public-page.ts`) throws `PAGE_NOT_FOUND` for PRIVATE — the route then
 * calls `notFound()`. So a PRIVATE page keeps its slug in the database while
 * that slug resolves to a 404 for everyone, owner included.
 *
 * UNLISTED renders, but the product copy shown to the owner when they pick it
 * (`i18n peVisibilityUnlistedHint`) is an explicit promise:
 *
 *   "Only people with the link can open it. It stays out of search and browse."
 *
 * That promise is the whole reason the two functions below differ.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Split by whether the surface CREATES DISCOVERY or merely FOLLOWS A LINK the
 * viewer already has a right to:
 *
 *   crawlablePageSlug — PUBLIC only. For anything a crawler or a search/browse
 *     surface can reach: the sitemap, the search index, the public event page's
 *     "At {venue}" link. Emitting an UNLISTED slug here is what breaks the
 *     promise above; emitting a PRIVATE one publishes a guaranteed 404.
 *     Matches the house precedent exactly — `humans.listForSearchIndex`
 *     (adapters/db/prisma/humans.ts) already filters human pages to
 *     `visibility: "PUBLIC"` before they may enter the index.
 *
 *   linkablePageSlug — anything except PRIVATE. For surfaces that ARE the link:
 *     the claimant's own "my venue claims" list, the owner's admin panel. These
 *     are authenticated, non-crawlable, and shown to someone who already knows
 *     the venue exists, so UNLISTED is exactly the case it was designed for.
 *     PRIVATE still 404s, so it is still excluded.
 *
 * Both return `null` rather than a substitute. Callers fall back to
 * `/places/id/{placeId}` — a DIFFERENT route (`loadPlacePublic`, keyed on the
 * Place, not the EntityPage), so the fallback does not leak the hidden page.
 * Never fall back to `Place.slug`: that is a multi-segment directory key no
 * route resolves at all.
 */

/** A page as far as link-building is concerned. */
export type LinkablePage = {
  slug: string;
  visibility: PageVisibility;
} | null;

/**
 * The slug for a surface that creates PUBLIC DISCOVERY — sitemap, search
 * index, crawler-visible page links. PUBLIC only.
 */
export function crawlablePageSlug(page: LinkablePage | undefined): string | null {
  if (!page) return null;
  // Fail closed: only the literal "PUBLIC" opts a page into discovery, so a
  // future visibility value is excluded by default rather than leaked.
  if (page.visibility !== "PUBLIC") return null;
  return page.slug || null;
}

/**
 * The slug for a surface that IS the link — authenticated owner/claimant
 * views. Everything except PRIVATE (which resolves to a 404).
 */
export function linkablePageSlug(page: LinkablePage | undefined): string | null {
  if (!page) return null;
  // ALLOWLIST, not `!== "PRIVATE"`. A denylist here fails OPEN: add a value to
  // PageVisibility later (say ARCHIVED for soft-deleted pages) and this would
  // hand an owner a live link to a 404 without a single line changing. Both
  // gates in this module must enumerate what they ADMIT.
  if (page.visibility !== "PUBLIC" && page.visibility !== "UNLISTED") {
    return null;
  }
  return page.slug || null;
}
