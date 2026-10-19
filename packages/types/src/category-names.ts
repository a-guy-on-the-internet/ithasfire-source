/**
 * Category names by language (category-translations spec, 2026-10-16).
 *
 * English lives in `Category.name` and stays the slug source. Every other
 * supported language is a key in `Category.nameTranslations`; an absent key
 * means no translation, and readers fall back to the English name.
 *
 * Shared by core (validation, uniqueness), the adapters (reading the JSON
 * column) and the web (display), so it lives here rather than in
 * `@th/locale`, which core does not depend on.
 */

/**
 * The UI locales a category name can be read or requested in. Mirrors
 * `SUPPORTED_LOCALES` in `@th/locale` (core and the adapters cannot import
 * that package); `category-names.test.ts` fails when the two drift.
 */
export const CATEGORY_NAME_LOCALES = ["en", "es"] as const;
export type CategoryNameLocale = (typeof CATEGORY_NAME_LOCALES)[number];

/** The non-English locales a category can carry a translated name in. */
export const CATEGORY_TRANSLATION_LOCALES = ["es"] as const;
export type CategoryTranslationLocale =
  (typeof CATEGORY_TRANSLATION_LOCALES)[number];

/** A category's non-English names, keyed by locale. */
export type CategoryNameTranslations = Partial<
  Record<CategoryTranslationLocale, string>
>;

/** Every name a category has: English always, the others when set. */
export type CategoryNames = { en: string } & CategoryNameTranslations;

export function isCategoryTranslationLocale(
  value: string,
): value is CategoryTranslationLocale {
  return (CATEGORY_TRANSLATION_LOCALES as readonly string[]).includes(value);
}

export function isCategoryNameLocale(
  value: string,
): value is CategoryNameLocale {
  return (CATEGORY_NAME_LOCALES as readonly string[]).includes(value);
}

/**
 * Read the stored JSON column into the typed map. Keeps only supported
 * locales whose value is a non-empty string, so an odd row (a hand edit, a
 * locale later removed) never reaches a reader. Never throws.
 */
export function parseCategoryNameTranslations(
  raw: unknown,
): CategoryNameTranslations {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: CategoryNameTranslations = {};
  for (const locale of CATEGORY_TRANSLATION_LOCALES) {
    const value = (raw as Record<string, unknown>)[locale];
    if (typeof value === "string" && value.trim().length > 0) {
      out[locale] = value;
    }
  }
  return out;
}

/** `{ en: name, ...translations }`, the `names` field every output carries. */
export function categoryNames(category: {
  name: string;
  nameTranslations?: CategoryNameTranslations | null;
}): CategoryNames {
  return { ...(category.nameTranslations ?? {}), en: category.name };
}
