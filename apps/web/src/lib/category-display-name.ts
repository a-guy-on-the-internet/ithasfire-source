/**
 * A category's name in the viewer's language (category-translations spec,
 * FR-002). Every category output carries `names: { en, es? }` beside the
 * English `name`; the browser picks the one for its locale and falls back to
 * English, unflagged (owner ruling R4).
 *
 * `names` is optional on the input so a page still renders against an API
 * that predates it (a deploy window): the English `name` is shown then.
 *
 * Page metadata, OG text, JSON-LD and the sitemap stay English (NFR-001), so
 * this is for visible text only.
 */

/** The fields this module reads; every category output has them. */
export type CategoryNameSource = {
  name: string;
  names?: Partial<Record<string, string>> | null;
};

const present = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** `names[locale]`, else `names.en`, else `name`. */
export function categoryDisplayName(
  category: CategoryNameSource,
  locale: string | null | undefined,
): string {
  const names = category.names;
  if (names) {
    const own = locale ? names[locale] : undefined;
    if (present(own)) return own;
    if (present(names.en)) return names.en;
  }
  return category.name;
}

/**
 * The same list with each `name` swapped for its display name. A row whose
 * name does not change keeps its identity, so memoised consumers do not
 * re-render for nothing. Send slugs or ids to the server, never this `name`:
 * it is no longer the English one.
 */
export function withCategoryDisplayNames<T extends CategoryNameSource>(
  categories: readonly T[],
  locale: string | null | undefined,
): T[] {
  return categories.map((category) => {
    const name = categoryDisplayName(category, locale);
    return name === category.name ? category : { ...category, name };
  });
}

/**
 * Every name a category answers to, in every language, for a typeahead that
 * matches across languages (FR-009). The display `name` first.
 */
export function categoryNameCandidates(category: CategoryNameSource): string[] {
  const out = [category.name];
  for (const value of Object.values(category.names ?? {})) {
    if (present(value) && !out.includes(value)) out.push(value);
  }
  return out;
}
