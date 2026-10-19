/**
 * search-facet-apply — the /search desktop-vs-mobile apply decision, extracted
 * so it is testable without mounting the page.
 *
 * `applied` is the committed snapshot the tRPC query, the request key and the
 * outbound URL writer all read. The draft is what the facet rail edits. This
 * module answers the one question that sits between them: given a draft and a
 * committed snapshot, WHAT KIND of difference is pending?
 *
 *  • "none"       — identical. Committing must be a NO-OP: `applied` is an
 *                   object identity that keys the pagination reset, so
 *                   reallocating it throws away every accumulated Load-more
 *                   page for nothing.
 *  • "continuous" — only the price bounds moved. A reader types "1", "12",
 *                   "125"; each is a valid draft and none of them is a
 *                   request. Desktop settles these before committing.
 *  • "discrete"   — anything else. A category checkbox, a date preset, the
 *                   free toggle: one deliberate press, one commit, now.
 *
 * Category comparison is ORDER-INSENSITIVE. Untick "music", tick it again and
 * the array is `[comedy, music]` where the applied copy is `[music, comedy]` —
 * the same filter, and a positional compare would report a pending change that
 * never settles.
 */

/** The event-only facet values that make up the committed snapshot. */
export type FacetSnapshot = {
  categories: readonly string[];
  dateFrom: string;
  dateTo: string;
  freeOnly: boolean;
  priceMin: string;
  priceMax: string;
};

export type FacetDiffKind = "none" | "continuous" | "discrete";

/** Order-insensitive set equality over category slugs. */
export const sameCategories = (
  a: readonly string[],
  b: readonly string[],
): boolean => {
  if (a.length !== b.length) return false;
  const seen = new Set(b);
  return a.every((slug) => seen.has(slug));
};

/** True when two snapshots would produce the same query. */
export const sameFacets = (a: FacetSnapshot, b: FacetSnapshot): boolean =>
  a.dateFrom === b.dateFrom &&
  a.dateTo === b.dateTo &&
  a.freeOnly === b.freeOnly &&
  a.priceMin === b.priceMin &&
  a.priceMax === b.priceMax &&
  sameCategories(a.categories, b.categories);

/**
 * Classify the pending difference.
 *
 * "continuous" is deliberately NARROW: it requires that price is the *only*
 * thing that moved. A category ticked in the same tick as a price edit is
 * treated as discrete and commits both immediately, because the reader expects
 * the thing they just clicked to take effect.
 */
export const facetDiffKind = (
  draft: FacetSnapshot,
  applied: FacetSnapshot,
): FacetDiffKind => {
  if (sameFacets(draft, applied)) return "none";
  const onlyPriceMoved =
    draft.dateFrom === applied.dateFrom &&
    draft.dateTo === applied.dateTo &&
    draft.freeOnly === applied.freeOnly &&
    sameCategories(draft.categories, applied.categories);
  return onlyPriceMoved ? "continuous" : "discrete";
};

/** The all-clear snapshot — what "Clear" in the mobile sheet writes. */
export const EMPTY_FACETS: FacetSnapshot = {
  categories: [],
  dateFrom: "",
  dateTo: "",
  freeOnly: false,
  priceMin: "",
  priceMax: "",
};

/** True when a snapshot narrows nothing — gates the sheet's Clear button. */
export const facetsAreEmpty = (facets: FacetSnapshot): boolean =>
  sameFacets(facets, EMPTY_FACETS);
