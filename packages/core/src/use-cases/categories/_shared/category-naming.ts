import { z } from "zod";

import { fail } from "@th/errors";
import {
  CATEGORY_NAME_MAX_LENGTH,
  CATEGORY_NAME_MIN_LENGTH,
  CATEGORY_SLUG_REGEX,
  CATEGORY_TRANSLATION_LOCALES,
  categoryNameIssue,
  categorySlugIssue,
  deriveCategorySlug,
  normalizeCategoryName,
  type CategoryNameTranslations,
  type CategoryTranslationLocale,
} from "@th/types";

import {
  plainTextOptional,
  plainTextRequired,
} from "../../../lib/sanitize-plain-text";

/**
 * How a category gets its name and its slug. Two paths make categories: an
 * organiser's request that staff approve (`requestCategoryOption` →
 * `reviewCategoryRequest`), and staff creating one directly
 * (`createCategory`). Both go through this module, so the two can never
 * disagree about the slug a given name produces.
 */

/**
 * The word and slug rules themselves live in `@th/types`
 * (`category-name-rules.ts`), the one copy the web also checks against. This
 * module wraps them in the boundary schema and the typed error.
 */
export { CATEGORY_SLUG_REGEX };

/**
 * Boundary schema for a category name: sanitised to plain text first, then
 * bounded (2 to 80 characters). Pass the parsed value through
 * {@link normalizeAndValidateCategoryName} before using it.
 */
export const categoryNameInputSchema = plainTextRequired(
  CATEGORY_NAME_MAX_LENGTH,
).pipe(z.string().min(CATEGORY_NAME_MIN_LENGTH));

/**
 * Collapse whitespace and refuse names that are not plain words: fewer than
 * two letters or digits, characters outside letters / digits / space / `&`
 * `'` `+` `-`, a link or a handle, or one character repeated eight times
 * (`categoryNameIssue` in `@th/types`).
 */
export function normalizeAndValidateCategoryName(rawName: string): string {
  const name = normalizeCategoryName(rawName);
  if (categoryNameIssue(name) !== null) {
    throw fail("INVALID_CATEGORY_REQUEST_NAME");
  }
  return name;
}

/**
 * Derive the slug from a normalised name: accents stripped, lowercased, every
 * run of other characters turned into one hyphen. Refuses a result outside 2
 * to 40 characters (a name with no latin letters or digits slugs to nothing).
 */
export function slugifyCategoryName(name: string): string {
  const slug = deriveCategorySlug(name);
  if (categorySlugIssue(slug) !== null) {
    throw fail("INVALID_CATEGORY_REQUEST_NAME");
  }
  return slug;
}

/** Sort value for a new category: one past the highest in use, 1 when none. */
export function nextCategorySortOrder(values: number[]): number {
  if (values.length === 0) {
    return 1;
  }

  return Math.max(...values) + 1;
}

/** Names compare without case, so "live music" cannot sit beside "Live Music". */
const nameKey = (name: string): string =>
  name.normalize("NFKC").toLowerCase();

/**
 * The slug a stored name would derive, or `null` for a name the current rules
 * cannot slug (an old row predating them). Never throws: it runs over every
 * existing category, and one odd row must not refuse an unrelated write.
 */
function derivedSlugOrNull(name: string): string | null {
  try {
    return slugifyCategoryName(name);
  } catch {
    return null;
  }
}

/**
 * THE rule for whether a category may take a name. Staff creation, rename and
 * the approval of a request all call it, so no path can admit what another
 * refuses. `candidate.slug` is the slug the name derives (creation and
 * approval store it; a rename only compares it).
 *
 * Refused with `CATEGORY_ALREADY_EXISTS` when, against any OTHER category:
 *  - the candidate's slug is their stored slug (`meta.field: "slug"`);
 *  - the names match without case (`meta.field: "name"`);
 *  - the candidate's slug is the slug their CURRENT name derives
 *    (`meta.field: "name"`). A rename keeps the stored slug, so after "Jazz"
 *    (slug `jazz`) becomes "Improvised Music" nothing stores
 *    `improvised-music`; without this, "Improvised-Music" could be created
 *    beside it and two categories would answer to the same words.
 *
 * `exceptId` leaves one category out: a rename passes the id of the category
 * being renamed, so changing only the case of its own name is not a collision
 * with itself.
 *
 * The comparison is only as good as the list it is given. Callers take
 * `categories.lockNaming()` first and read `listAll()` after it, so two
 * writers cannot both pass on a list the other is about to change (the unique
 * index on `Category.name` is case-sensitive and would let "Live Music" and
 * "live music" both commit).
 */
export function assertCategoryNamingFree(
  categories: ReadonlyArray<{ id?: string; slug: string; name: string }>,
  candidate: { name: string; slug: string },
  exceptId?: string,
): void {
  const others = categories.filter(
    (c) => exceptId === undefined || c.id !== exceptId,
  );

  if (others.some((c) => c.slug === candidate.slug)) {
    throw fail("CATEGORY_ALREADY_EXISTS", { meta: { field: "slug" } });
  }

  const candidateKey = nameKey(candidate.name);
  if (
    others.some(
      (c) =>
        nameKey(c.name) === candidateKey ||
        derivedSlugOrNull(c.name) === candidate.slug,
    )
  ) {
    throw fail("CATEGORY_ALREADY_EXISTS", { meta: { field: "name" } });
  }
}

/**
 * Refuse a name an existing category already carries (case-insensitively).
 * The name half of {@link assertCategoryNamingFree}, for the one caller that
 * is not writing a category: an organiser SUBMITTING a request
 * (`requestCategoryOption`), refused early while they are still looking at
 * the form. Approval then applies the whole rule.
 */
export function assertCategoryNameFree(
  categories: ReadonlyArray<{ id?: string; name: string }>,
  name: string,
): void {
  if (categories.some((c) => nameKey(c.name) === nameKey(name))) {
    throw fail("CATEGORY_ALREADY_EXISTS", { meta: { field: "name" } });
  }
}

// ── Translated names (category-translations spec, 2026-10-16) ──────────────

/**
 * One translated name at the boundary: sanitised to plain text and bounded
 * like the English name, but blank or `null` allowed (it means "no
 * translation"). A non-blank value then goes through
 * {@link normalizeAndValidateCategoryName}, so every language obeys the same
 * word rules. Translated names never derive a slug.
 */
const translatedNameInputSchema = plainTextOptional(80).nullable().optional();

/**
 * Boundary schema for a category's translated names, one optional key per
 * supported non-English locale. `satisfies` makes adding a locale to
 * `CATEGORY_TRANSLATION_LOCALES` a compile error here until it has a field.
 */
export const categoryTranslationsInputSchema = z
  .object({
    es: translatedNameInputSchema,
  } satisfies Record<CategoryTranslationLocale, unknown>)
  .strict();

export type CategoryTranslationsInput = z.infer<
  typeof categoryTranslationsInputSchema
>;

/**
 * What a translations input says to do with each locale it mentions:
 * a validated name to store, or `null` to clear. A locale the input does not
 * mention is absent from the result (left as it is by an edit).
 */
export function normalizeCategoryTranslationChanges(
  input: CategoryTranslationsInput | undefined,
): Partial<Record<CategoryTranslationLocale, string | null>> {
  const changes: Partial<Record<CategoryTranslationLocale, string | null>> =
    {};
  if (!input) return changes;
  for (const locale of CATEGORY_TRANSLATION_LOCALES) {
    if (!(locale in input)) continue;
    const raw = input[locale];
    if (raw === undefined) continue;
    changes[locale] =
      raw === null || raw.trim() === ""
        ? null
        : normalizeAndValidateCategoryName(raw);
  }
  return changes;
}

/**
 * Apply {@link normalizeCategoryTranslationChanges}' result to a stored map:
 * a name replaces, `null` removes, an absent locale is kept.
 */
export function applyCategoryTranslationChanges(
  current: CategoryNameTranslations,
  changes: Partial<Record<CategoryTranslationLocale, string | null>>,
): CategoryNameTranslations {
  const next: CategoryNameTranslations = {};
  for (const locale of CATEGORY_TRANSLATION_LOCALES) {
    const change = changes[locale];
    const value = change === undefined ? current[locale] : change;
    if (value) next[locale] = value;
  }
  return next;
}

/** Same map, same names, ignoring key order. */
export function sameCategoryTranslations(
  a: CategoryNameTranslations,
  b: CategoryNameTranslations,
): boolean {
  return CATEGORY_TRANSLATION_LOCALES.every(
    (locale) => (a[locale] ?? null) === (b[locale] ?? null),
  );
}

/**
 * The translated-name half of the naming rule. A translated name is unique
 * WITHIN ITS LANGUAGE, without case, across every other category; it is not
 * compared with English names or other languages ("Jazz" can be both the
 * English and the Spanish name). Refused with `CATEGORY_ALREADY_EXISTS`,
 * `meta: { field: "nameTranslations", locale }`.
 *
 * Same calling contract as {@link assertCategoryNamingFree}: take
 * `categories.lockNaming()` first and read `listAll()` after it. No index
 * backs this rule (Prisma cannot model one on a JSON key), so the lock is the
 * only thing that stops two writers both passing.
 *
 * `exceptId` leaves out the category being edited, so re-saving its own name
 * in a different case is not a collision with itself.
 */
export function assertCategoryTranslationsFree(
  categories: ReadonlyArray<{
    id?: string;
    nameTranslations?: CategoryNameTranslations | null;
  }>,
  translations: CategoryNameTranslations,
  exceptId?: string,
): void {
  const others = categories.filter(
    (c) => exceptId === undefined || c.id !== exceptId,
  );
  for (const locale of CATEGORY_TRANSLATION_LOCALES) {
    const candidate = translations[locale];
    if (!candidate) continue;
    const candidateKey = nameKey(candidate);
    if (
      others.some((c) => {
        const theirs = c.nameTranslations?.[locale];
        return theirs ? nameKey(theirs) === candidateKey : false;
      })
    ) {
      throw fail("CATEGORY_ALREADY_EXISTS", {
        meta: { field: "nameTranslations", locale },
      });
    }
  }
}

/**
 * The category whose `locale` name is `name` (without case), or `undefined`.
 * Approval uses it to resolve a request made in another language onto the
 * category that already carries that name in that language.
 */
export function findCategoryByTranslatedName<
  T extends { nameTranslations?: CategoryNameTranslations | null },
>(
  categories: ReadonlyArray<T>,
  locale: CategoryTranslationLocale,
  name: string,
): T | undefined {
  const key = nameKey(name);
  return categories.find((c) => {
    const theirs = c.nameTranslations?.[locale];
    return theirs ? nameKey(theirs) === key : false;
  });
}
