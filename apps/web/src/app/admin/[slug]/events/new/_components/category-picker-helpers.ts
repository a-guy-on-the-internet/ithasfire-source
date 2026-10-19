/**
 * Pure filtering logic for the event builder's Category picker.
 *
 * Extracted from `CategoryTagsSection` so the combobox behaviour is unit
 * testable without mounting the trpc/Tamagui component tree.
 *
 * `name` is the name shown (the organiser's language); `names`, when present,
 * holds every name the category has, and the typeahead matches any of them
 * (category-translations FR-009): "música" finds Music for an English reader.
 */

import {
  categoryDisplayName,
  categoryNameCandidates,
  type CategoryNameSource,
} from "@/lib/category-display-name";

type PickerOption = {
  name: string;
  slug: string;
  names?: Partial<Record<string, string>> | null;
};

/**
 * Case-insensitive substring match against a category's names, in any
 * language, or its slug.
 */
export const optionMatchesQuery = (
  option: PickerOption,
  query: string,
): boolean => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return (
    categoryNameCandidates(option).some((name) =>
      name.toLowerCase().includes(normalizedQuery),
    ) || option.slug.includes(normalizedQuery)
  );
};

/** True when `name` is exactly one of the option's names, in any language. */
export const optionHasName = (option: PickerOption, name: string): boolean => {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  return categoryNameCandidates(option).some(
    (candidate) => candidate.trim().toLowerCase() === normalized,
  );
};

/**
 * True when the input text is exactly the committed selection's name — i.e.
 * the user hasn't typed anything new since selecting (or since hydration
 * copied the selection's name into the input).
 */
export const queryIsCommittedSelection = (
  query: string,
  selectedName: string | null | undefined,
): boolean => {
  if (!selectedName) return false;
  return query.trim().toLowerCase() === selectedName.trim().toLowerCase();
};

/**
 * Standard combobox open behaviour: when the query is empty OR still exactly
 * equal to the committed selection's name, show the FULL list (the selected
 * row is marked separately by the row renderer). Only filter once the user
 * actually edits the text.
 *
 * Without the committed-selection escape hatch, re-opening the dropdown after
 * a page refresh (which hydrates `query = selection.name`) filtered the list
 * down to just the already-selected row — the "collapsed dropdown" bug.
 */
export function filterCategoryOptions<T extends PickerOption>(
  opts: {
    categories: readonly T[];
    query: string;
    selectedName?: string | null;
    /** Cap applied only when the user is actively filtering. */
    limit?: number;
  },
): T[] {
  const { categories, query, selectedName, limit = 12 } = opts;
  const trimmed = query.trim();
  if (!trimmed || queryIsCommittedSelection(trimmed, selectedName)) {
    return [...categories];
  }
  return categories
    .filter((item) => optionMatchesQuery(item, trimmed))
    .slice(0, limit);
}

/**
 * Resolve the `{ slug, name }` pair to hydrate the Category field with after
 * a refresh, given the event's saved `categoryId`.
 *
 * Preference order:
 * 1. The matching entry in the ACTIVE category list (normal case).
 * 2. The server-joined `category` from `getEventForEdit` — this is the ONLY
 *    source for a category that has since been DEACTIVATED, since
 *    `categories.list` returns active rows only. Without this fallback the
 *    field hydrated blank for events on a deactivated category. Its name is
 *    read in `locale` from its `names`, like the active list's names are.
 *
 * Returns null when the event has no category (or the row was hard-deleted
 * and the server join came back null).
 */
export function resolveHydratedCategory(opts: {
  categoryId: string | null | undefined;
  /** Joined summary from getEventForEdit; includes inactive categories. */
  serverCategory:
    | ({ id: string; slug: string } & CategoryNameSource)
    | null
    | undefined;
  /** Already in the viewer's language (`withCategoryDisplayNames`). */
  activeCategories: readonly { id: string; slug: string; name: string }[];
  /** The viewer's locale, for the server-joined category's name. */
  locale?: string | null;
}): { slug: string; name: string } | null {
  const { categoryId, serverCategory, activeCategories, locale } = opts;
  if (!categoryId) return null;
  const active = activeCategories.find((c) => c.id === categoryId);
  if (active) return { slug: active.slug, name: active.name };
  if (serverCategory && serverCategory.id === categoryId) {
    return {
      slug: serverCategory.slug,
      name: categoryDisplayName(serverCategory, locale),
    };
  }
  return null;
}
