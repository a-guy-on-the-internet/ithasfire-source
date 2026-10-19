import type { LoggerPort } from "@th/ports/logger";
import type { ReadThroughCachePort } from "@th/ports/read-through-cache";
import type { Repos } from "@th/ports/repos";
import type {
  CategoriesRepo,
  CategoryListItem,
} from "@th/ports/repos/categories";
import {
  CATEGORY_TRANSLATION_LOCALES,
  categoryNames,
  type CategoryNames,
  type CategoryTranslationLocale,
} from "@th/types";

/** A category's current slug per language: `en` always, the others when set. */
export type CategorySlugs = { en: string } & Partial<
  Record<CategoryTranslationLocale, string>
>;

/**
 * A list item plus `names` (`{ en, es? }`), what every category output
 * carries, and `slugs` (`{ en, es? }`), what the public lists carry so a
 * Spanish page links to the Spanish category page (spanish-seo FR-006).
 */
export type CategoryListItemWithNames = CategoryListItem & {
  names: CategoryNames;
  slugs: CategorySlugs;
};

/** Current non-English slugs, keyed by category id. */
export type CurrentTranslationSlugs = ReadonlyMap<
  string,
  Partial<Record<CategoryTranslationLocale, string>>
>;

/**
 * Every category's current slug in each non-English language: one read per
 * language, never one per category. `en` is not read: `Category.slug` is the
 * read copy of the current English slug.
 */
export async function loadCurrentTranslationSlugs(
  categories: Pick<CategoriesRepo, "listCurrentSlugs">,
): Promise<CurrentTranslationSlugs> {
  const perLocale = await Promise.all(
    CATEGORY_TRANSLATION_LOCALES.map((locale) =>
      categories.listCurrentSlugs(locale),
    ),
  );
  const byCategory = new Map<
    string,
    Partial<Record<CategoryTranslationLocale, string>>
  >();
  for (const [i, locale] of CATEGORY_TRANSLATION_LOCALES.entries()) {
    for (const row of perLocale[i] ?? []) {
      const slugs = byCategory.get(row.categoryId) ?? {};
      slugs[locale] = row.slug;
      byCategory.set(row.categoryId, slugs);
    }
  }
  return byCategory;
}

export function withCategoryNamesAndSlugs(
  item: CategoryListItem,
  translationSlugs: CurrentTranslationSlugs,
): CategoryListItemWithNames {
  return {
    ...item,
    names: categoryNames(item),
    slugs: { ...translationSlugs.get(item.id), en: item.slug },
  };
}

export type ListCategoriesDeps = {
  repos: Pick<Repos, "categories">;
  logger?: LoggerPort;
  /**
   * Optional whole-result cache. Hand one in ONLY for requests whose answer
   * cannot depend on the caller: the transport passes it for anonymous
   * requests only. The list takes no input and nothing in it varies by
   * caller or locale, so the key is a constant; it must grow if the answer
   * ever starts to vary (a locale, a viewer, an input). Staff writes reach it
   * through the public-read generation within seconds; that covers the slugs
   * too (`changeSlug`, `setTranslations` and `create` are signed-in
   * mutations). The slug backfill script runs outside the API, so only the
   * TTL bounds what it changes.
   */
  cache?: ReadThroughCachePort;
};

export async function listCategories(
  deps: ListCategoriesDeps,
): Promise<CategoryListItemWithNames[]> {
  const scopedLogger = deps.logger?.child({ useCase: "listCategories" });

  const execute = async () => {
    const [categories, translationSlugs] = await Promise.all([
      deps.repos.categories.listActive(),
      loadCurrentTranslationSlugs(deps.repos.categories),
    ]);
    return categories
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => withCategoryNamesAndSlugs(c, translationSlugs));
  };

  const run = () =>
    scopedLogger ? scopedLogger.withTime("listCategories", execute) : execute();

  // A failed load is never stored (ReadThroughCachePort contract), and this
  // read swallows nothing, so there is no degraded answer to keep out.
  if (deps.cache) {
    return deps.cache.getOrLoad("categories.listCategories:v1", run);
  }

  return run();
}
