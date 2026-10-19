/**
 * SEO helpers for geo×category landing pages
 * (`/events/category/<categorySlug>/<citySegment>` and its Spanish twin).
 *
 * The title and description text live in the web app's catalogs (one per
 * language); this module keeps the language-free parts: the robots rule and
 * the description length limit.
 */

// Meta descriptions read best around ~155–160 chars; Google truncates past
// that. We trim on a word boundary and append an ellipsis when clipping.
const DESCRIPTION_MAX_CHARS = 160;

const truncateAtWordBoundary = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  const base = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.replace(/[.,;:\-\s]+$/, "")}…`;
};

/**
 * Clip a meta description to the length search results show, on a word
 * boundary with an ellipsis.
 */
export const truncateMetaDescription = (text: string): string =>
  truncateAtWordBoundary(text, DESCRIPTION_MAX_CHARS);

export interface GeoCategoryPageRobotsInput {
  /**
   * Upcoming events on the page that are NOT gated. Only these count toward
   * `minEvents`: a gated event's own page is noindex, so it does not make
   * this page worth indexing (owner ruling 2026-10-13). The geo×category
   * sitemap counts ungated events too, so every URL it lists clears this.
   */
  indexableCount: number;
  /** Threshold below which the page is marked `noindex`. */
  minEvents: number;
}

/**
 * Thin-page rule: a page below `minEvents` ungated events is `noindex` but
 * stays crawlable (`follow`).
 */
export function geoCategoryPageRobots(input: GeoCategoryPageRobotsInput): {
  index: boolean;
  follow: boolean;
} {
  return { index: input.indexableCount >= input.minEvents, follow: true };
}
