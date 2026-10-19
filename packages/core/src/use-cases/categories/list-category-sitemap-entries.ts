import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

export type CategorySitemapEntry = {
  /** Current English slug. */
  slug: string;
  /**
   * Current Spanish slug when the /es/ page is indexable, else `null`: the
   * category must have a Spanish name (spanish-seo R9). A category whose
   * Spanish name was cleared keeps its es slug reserved (R20) but gets no
   * es entry.
   */
  esSlug: string | null;
};

export type ListCategorySitemapEntriesDeps = {
  repos: Pick<Repos, "categories">;
  logger?: LoggerPort;
};

export type ListCategorySitemapEntriesOptions = {
  /** Clock for "upcoming"; defaults to the current time. */
  now?: Date;
};

/**
 * Category landing pages worth advertising: active categories whose page
 * lists at least one upcoming PUBLISHED, PUBLIC, ungated event. A category
 * page with none is `noindex` (see the web route's metadata; gated events
 * list but do not count, owner ruling 2026-10-13), so listing it in the
 * sitemap would only send crawlers to a page they are told to drop.
 *
 * Each entry also carries the Spanish twin's slug when that twin is
 * indexable (see {@link CategorySitemapEntry.esSlug}); the gated-only and
 * empty rules above apply to both languages.
 */
export async function listCategorySitemapEntries(
  deps: ListCategorySitemapEntriesDeps,
  options: ListCategorySitemapEntriesOptions = {},
): Promise<CategorySitemapEntry[]> {
  const now = options.now ?? new Date();
  const [categories, esSlugs] = await Promise.all([
    deps.repos.categories.listActiveWithUpcomingEvents({ now }),
    deps.repos.categories.listCurrentSlugs("es"),
  ]);
  deps.logger?.info("categories.list_sitemap_entries", {
    count: categories.length,
  });
  const esSlugByCategory = new Map(
    esSlugs.map((row) => [row.categoryId, row.slug]),
  );
  // Belt and braces: the repo already filters on `active`.
  return categories
    .filter((c) => c.active)
    .map((c) => ({
      slug: c.slug,
      esSlug: c.nameTranslations?.es?.trim()
        ? (esSlugByCategory.get(c.id) ?? null)
        : null,
    }));
}
