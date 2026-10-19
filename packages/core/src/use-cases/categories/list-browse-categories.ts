import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReadThroughCachePort } from "@th/ports/read-through-cache";
import type { Repos } from "@th/ports/repos";
import {
  type CategoryListItemWithNames,
  loadCurrentTranslationSlugs,
  withCategoryNamesAndSlugs,
} from "./list-categories";

export type ListBrowseCategoriesDeps = {
  repos: Pick<Repos, "categories">;
  logger?: LoggerPort;
  /** Clock for "upcoming"; defaults to the system clock. */
  clock?: ClockPort;
  /**
   * Optional whole-result cache. Hand one in ONLY for requests whose answer
   * cannot depend on the caller: the transport passes it for anonymous
   * requests only. The list takes no input and nothing in it varies by
   * caller or locale, so the key is a constant; it must grow if the answer
   * ever starts to vary (a locale, a viewer, an input).
   *
   * Writes through the API (a category edit, an event published, unpublished
   * or moved category by a signed-in actor) reach the cache through the
   * public-read generation within seconds. What only the TTL bounds: the
   * clock (the last upcoming event in a category starting) and background
   * jobs.
   */
  cache?: ReadThroughCachePort;
};

/**
 * Categories worth offering as a browse entry point (the homepage's hero
 * chips and "Browse by category" section): active categories whose page
 * lists at least one upcoming event, in sortOrder. Owner ruling 2026-10-14:
 * a category with nothing in it is not offered, so no entry point leads to an
 * empty page.
 *
 * "Lists" is the category page's own listing rule, gated events included (a
 * person sent there sees them, gate on the card). The sitemap uses the
 * narrower indexable rule instead (`listCategorySitemapEntries`).
 *
 * Pickers, search facets and the category page's name lookup keep
 * `listCategories`: they need every active category, empty or not.
 */
export async function listBrowseCategories(
  deps: ListBrowseCategoriesDeps,
): Promise<CategoryListItemWithNames[]> {
  if (deps.cache) {
    // A failed load is never stored (ReadThroughCachePort contract), and this
    // read swallows nothing, so there is no degraded answer to keep out.
    const { cache, ...uncached } = deps;
    return cache.getOrLoad("categories.listBrowseCategories:v1", () =>
      listBrowseCategories(uncached),
    );
  }
  const now = deps.clock?.now() ?? new Date();
  const [categories, translationSlugs] = await Promise.all([
    deps.repos.categories.listActiveWithListedEvents({ now }),
    loadCurrentTranslationSlugs(deps.repos.categories),
  ]);
  deps.logger?.info("categories.list_browse", { count: categories.length });
  // Belt and braces: the repo already filters on `active` and orders by
  // sortOrder then name; the sort is stable, so the name tie-break survives.
  return categories
    .filter((c) => c.active)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((c) => withCategoryNamesAndSlugs(c, translationSlugs));
}
