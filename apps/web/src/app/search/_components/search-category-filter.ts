/**
 * search-category-filter — how the /search page turns its selected categories
 * into the search request, and which of them it shows as applied.
 *
 * Pure and framework-free, like its siblings (./search-url, ./search-sort), so
 * the page and the tests read one definition.
 *
 * A category travels as `categorySlugs`, never as `tags`. The two land in the
 * same index field, but only `categorySlugs` is checked against the ACTIVE
 * categories by the server: a slug that is unknown or switched off is dropped
 * there and the search runs with no category filter. `tags` is the ungated
 * free-form filter, and this page does not send it.
 */

/**
 * Bounds of the search procedure's `categorySlugs` input
 * (`packages/transport/trpc/src/routers/unified-search.ts`). The slugs come
 * from the URL, so a hand-edited `?category=` can exceed them; trimming here
 * keeps such a link a search with no category filter instead of a 400.
 */
export const MAX_CATEGORY_SLUG_LENGTH = 64;
export const MAX_CATEGORY_SLUGS = 50;

/**
 * The category part of the search request: `{ categorySlugs }` when events are
 * in scope and at least one sendable category is selected, `{}` otherwise.
 * Spread it into the query input.
 */
export const categoryFilterInput = (input: {
  /** Event-only filters are omitted outside an event scope. */
  eventsInScope: boolean;
  selectedCategories: readonly string[];
}): { categorySlugs?: string[] } => {
  if (!input.eventsInScope) return {};
  const categorySlugs = input.selectedCategories
    .filter((slug) => slug.length > 0 && slug.length <= MAX_CATEGORY_SLUG_LENGTH)
    .slice(0, MAX_CATEGORY_SLUGS);
  return categorySlugs.length > 0 ? { categorySlugs } : {};
};

/**
 * The selected categories the page presents as applied filters.
 *
 * `activeSlugs` is the slug list of `categories.list` (active categories only),
 * or `null` while that list has not loaded. Once it has, a selected slug that
 * is not in it (unknown, deleted or inactive) is not shown: the server drops
 * the same slug from the search, so a chip for it would name a filter that is
 * not applied. Before it loads every selected slug is kept, so a deep link
 * shows its chip without waiting on a second request.
 */
export const shownCategorySlugs = (
  selectedCategories: readonly string[],
  activeSlugs: readonly string[] | null,
): string[] => {
  if (activeSlugs === null) return [...selectedCategories];
  const active = new Set(activeSlugs);
  return selectedCategories.filter((slug) => active.has(slug));
};

/**
 * What to prune from a category selection, or `null` when there is nothing to
 * do.
 *
 * `activeSlugs` is the same list `shownCategorySlugs` takes. `null` (the list
 * has not loaded, or its request failed) always answers `null`: a selection is
 * only ever pruned against a list the server actually returned, so a slow or
 * failed request never strips a valid category from the URL. A selection with
 * every slug active also answers `null`, which is what lets the page's prune
 * effect run into its own early return after it has pruned once.
 *
 * `kept` preserves the selection's order.
 */
export const pruneCategorySelection = (
  selectedCategories: readonly string[],
  activeSlugs: readonly string[] | null,
): { kept: string[]; dropped: string[] } | null => {
  if (activeSlugs === null) return null;
  const active = new Set(activeSlugs);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const slug of selectedCategories) {
    (active.has(slug) ? kept : dropped).push(slug);
  }
  return dropped.length > 0 ? { kept, dropped } : null;
};

/**
 * Which "no longer available" notice a prune earns: `"all"` when no category
 * is left selected, `"some"` when others remain.
 */
export type UnavailableCategoryNoticeKind = "all" | "some";

export const unavailableCategoryNoticeKind = (
  keptAppliedCategories: readonly string[],
): UnavailableCategoryNoticeKind =>
  keptAppliedCategories.length > 0 ? "some" : "all";
