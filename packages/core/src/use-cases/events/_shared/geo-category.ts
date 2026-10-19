/**
 * Shared slug helpers for the geo×category SEO landing pages
 * (`/events/category/<categorySlug>/<citySegment>`).
 *
 * The city segment is a stable, canonical encoding of a free-text locality plus
 * an optional 2-letter region code (e.g. ("Nashville","tn") → "nashville-tn").
 * These helpers are pure and dependency-free so both the sitemap job and the
 * page transport can round-trip segments without a DB read.
 */

/**
 * Minimum number of upcoming events a geo×category combo must have before we
 * publish (and index) a dedicated landing page for it. Below this threshold the
 * page is thin content — we still render it, but mark it `noindex`.
 */
export const MIN_EVENTS_PER_GEO_CATEGORY_PAGE = 3;

/**
 * Slugify a free-text city/locality: lowercase, trim, collapse every run of
 * non-alphanumeric characters to a single hyphen, and strip leading/trailing
 * hyphens. (e.g. "New York" → "new-york", "St. Louis" → "st-louis").
 */
export function slugifyCity(locality: string): string {
  return locality
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the CANONICAL city segment from a locality and optional region code.
 * When `regionCode` is a non-empty 2-letter code it is appended lowercased as a
 * `-<region>` suffix. (e.g. ("Nashville","tn") → "nashville-tn";
 * ("Nashville",null) → "nashville").
 */
export function buildCitySegment(
  locality: string,
  regionCode: string | null | undefined,
): string {
  const city = slugifyCity(locality);
  const region = (regionCode ?? "").trim().toLowerCase();
  if (region.length === 2 && /^[a-z]{2}$/.test(region)) {
    return `${city}-${region}`;
  }
  return city;
}

/**
 * Inverse of {@link buildCitySegment}. Returns the raw city SLUG (hyphenated,
 * NOT converted to spaces) so it can be matched directly against a slug-folded
 * `locality` in SQL — keeping the enumerate-side fold and the fetch-side match
 * byte-for-byte identical. When the segment ends in `-<2 letters>` the trailing
 * pair is treated as the region code and the remainder as the `citySlug`;
 * otherwise the whole (normalized) segment is the `citySlug` and region is null.
 *
 * (e.g. "nashville-tn" → { citySlug:"nashville", region:"tn" };
 *  "new-york" → { citySlug:"new-york", region:null } — "york" is 4 chars;
 *  "san-jose-ca" → { citySlug:"san-jose", region:"ca" };
 *  "st-louis-mo" → { citySlug:"st-louis", region:"mo" }).
 *
 * NOTE: a region-less city whose last token is exactly 2 letters (e.g. "foo-ba")
 * will false-split into region "ba"; callers should retry with the whole
 * segment as the city slug when the region-scoped fetch is empty.
 */
export function parseCitySegment(segment: string): {
  citySlug: string;
  region: string | null;
} {
  const normalized = slugifyCity(segment);
  const match = /^(.+)-([a-z]{2})$/.exec(normalized);
  if (match) {
    const citySlug = match[1] ?? "";
    const region = match[2] ?? null;
    return { citySlug, region };
  }
  return { citySlug: normalized, region: null };
}
