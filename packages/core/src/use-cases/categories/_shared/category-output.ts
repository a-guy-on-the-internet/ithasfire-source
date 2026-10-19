import { z } from "zod";

import type { CategoryRecord } from "@th/ports/repos/categories";
import { categoryNames, type CategoryTranslationLocale } from "@th/types";

/**
 * Every name a category has: `en` (its `name`) always, each translation when
 * set. Readers show `names[locale] ?? names.en`. `satisfies` makes a new
 * locale in `CATEGORY_TRANSLATION_LOCALES` a compile error until it is here.
 */
export const categoryNamesSchema = z
  .object({
    en: z.string(),
    es: z.string().optional(),
  } satisfies Record<"en" | CategoryTranslationLocale, unknown>)
  .strict();

/**
 * A category's current URL slug per language (spanish-seo FR-006): `en` (its
 * `slug`) always, each other language when the category has a current slug
 * there. A category with no slug in a language has its page there at the
 * English slug, so links read `slugs[locale] ?? slugs.en`. Same `satisfies`
 * guard as {@link categoryNamesSchema}.
 */
export const categorySlugsSchema = z
  .object({
    en: z.string(),
    es: z.string().optional(),
  } satisfies Record<"en" | CategoryTranslationLocale, unknown>)
  .strict();

/**
 * The category shape the staff lifecycle use cases return (rename, activate /
 * deactivate, reorder, the staff list, translations). Same fields as
 * `createCategory`'s `category`.
 */
export const categoryOutputSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    names: categoryNamesSchema,
    seoType: z.string(),
    active: z.boolean(),
    sortOrder: z.number().int(),
  })
  .strict();

export type CategoryOutput = z.infer<typeof categoryOutputSchema>;

export function toCategoryOutput(record: CategoryRecord): CategoryOutput {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    names: categoryNames(record),
    seoType: record.seoType,
    active: record.active,
    sortOrder: record.sortOrder,
  };
}
