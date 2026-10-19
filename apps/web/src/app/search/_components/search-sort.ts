/**
 * search-sort — the /search sort model: option list, scope rules, and the
 * mapping onto the server's `MultiSearchSort` enum.
 *
 * Pure and framework-free so the server route, the client page, and the tests
 * all read ONE definition of what "sort" means. Before this module the sort
 * control was decorative: the tRPC procedure took no `sort` at all, so all
 * seven options were applied client-side over the ~50 rows already loaded.
 * "Price: Low to High" meant "cheapest of the rows on screen", `popularity`
 * was indistinguishable from `relevance`, and `featured` fell through a
 * switch into the date branch — it silently meant "Date: Latest".
 *
 * Two rules hold everything together:
 *
 * 1. SORT IS EVENT-ONLY. Every non-relevance mode orders on an event column
 *    (`startsAt`, `lowestBuyerTotalCents`, `popularityScore`). Humans, orgs and
 *    places are NULL there, so a mixed-type date sort does not interleave them
 *    — it dumps every venue and artist below every event. So picking a
 *    non-relevance sort also narrows the scope to Events. This is Baymard's
 *    "faceted sorting": scope and ordering are ONE choice, not two that can
 *    contradict each other. The transport enforces the same rule server-side
 *    (`scopeSortToEvents`), so this module is the UX half of a guarantee, not
 *    the guarantee itself.
 *
 * 2. DISTANCE NEEDS A COORDINATE. Offering "Nearest" with no location set is
 *    an option that silently does something else (the adapters degrade it to
 *    date order), so it is hidden until a location resolves.
 */

import type { SearchScope } from "./search-url";

/**
 * Sort ids as they appear in the URL and the UI.
 *
 * `date_asc` is the UI's name for the server's `date`. The server keeps the
 * shorter name because six browse callers (embeds, featured, tiered-popular,
 * discover-by-category) already pass it; the UI spells the direction out
 * because it sits next to `date_desc` in a menu, where "Date" alone is
 * ambiguous. `toServerSort` bridges the two.
 */
export type SortId =
  | "relevance"
  | "date_asc"
  | "date_desc"
  | "distance"
  | "price_asc"
  | "price_desc"
  | "popularity";

/** The server-side enum (`MultiSearchSort` in @th/ports). */
export type ServerSort =
  | "relevance"
  | "date"
  | "date_desc"
  | "distance"
  | "price_asc"
  | "price_desc"
  | "popularity";

export const DEFAULT_SORT: SortId = "relevance";

export type SortOptionDef = {
  id: SortId;
  label: string;
  /** Hidden until a geo coordinate resolves — see rule 2 above. */
  requiresGeo?: boolean;
};

/**
 * Menu order is deliberate: relevance first (the default), then the two axes
 * buyers actually use on a listings page — when it is on, and what it costs —
 * then the softer signals. Baymard's guidance is to order options by expected
 * use rather than alphabetically or by internal grouping.
 */
export const SORT_OPTIONS: readonly SortOptionDef[] = [
  { id: "relevance", label: "Most relevant" },
  { id: "date_asc", label: "Date: soonest" },
  { id: "date_desc", label: "Date: latest" },
  { id: "distance", label: "Nearest first", requiresGeo: true },
  { id: "price_asc", label: "Price: low to high" },
  { id: "price_desc", label: "Price: high to low" },
  { id: "popularity", label: "Most popular" },
];

const SORT_IDS: readonly string[] = SORT_OPTIONS.map((o) => o.id);

/**
 * Legacy `?sort=` values that used to exist in the UI and may still sit in
 * bookmarks, shared links and search-engine indexes.
 *
 * `featured` is the interesting one. It was never implemented: the client-side
 * sort switch handled relevance/popularity/price and let everything else fall
 * into the date branch, so `featured` rendered as "Date: latest". It is mapped
 * to `popularity` rather than preserved-as-date because popularity is what the
 * label promised, and a stale link is better served by the honest reading of
 * its intent than by bug-compatibility.
 */
const LEGACY_SORT_ALIASES: Record<string, SortId> = {
  date: "date_asc",
  featured: "popularity",
};

/** Whitelist a `sort` URL param; anything unrecognised falls back to default. */
export const parseSortParam = (raw: string | null | undefined): SortId => {
  if (!raw) return DEFAULT_SORT;
  const value = raw.trim();
  if (SORT_IDS.includes(value)) return value as SortId;
  return LEGACY_SORT_ALIASES[value] ?? DEFAULT_SORT;
};

/** UI id → the enum the tRPC procedure accepts. */
export const toServerSort = (id: SortId): ServerSort =>
  id === "date_asc" ? "date" : id;

/**
 * True when this mode orders on an event-only column, and so implies an
 * event-scoped query. Only `relevance` is safe across mixed result types.
 */
export const isEventOnlySort = (id: SortId): boolean => id !== "relevance";

/**
 * The scope a sort choice implies. Picking anything but relevance narrows to
 * Events, mirroring the transport's `scopeSortToEvents` so the UI never shows
 * a scope the server will not honour.
 */
export const scopeForSort = (id: SortId, current: SearchScope): SearchScope =>
  isEventOnlySort(id) ? "event" : current;

/**
 * The options to offer for the current scope and location state.
 *
 * In a non-event scope (People / Groups / Places) only relevance applies, so
 * the caller should hide the control entirely rather than render a menu of
 * one. In `all` the full list stays available: choosing from it is what
 * narrows the user to Events, which is the faceted-sorting behaviour.
 */
export const availableSorts = (
  scope: SearchScope,
  hasGeo: boolean,
): readonly SortOptionDef[] => {
  if (scope !== "all" && scope !== "event") {
    return SORT_OPTIONS.filter((o) => o.id === "relevance");
  }
  return SORT_OPTIONS.filter((o) => !o.requiresGeo || hasGeo);
};

/**
 * Coerce a sort that is no longer offered back to the default.
 *
 * Reachable two ways: the user clears their location while sorted by Nearest,
 * or a deep link pairs `?type=place` with `?sort=price_asc`. Silently leaving
 * the stale value selected would show a sort the results do not reflect.
 */
export const reconcileSort = (
  id: SortId,
  scope: SearchScope,
  hasGeo: boolean,
): SortId =>
  availableSorts(scope, hasGeo).some((o) => o.id === id) ? id : DEFAULT_SORT;

/** Menu label for the active sort — falls back to the default's label. */
export const sortLabel = (id: SortId): string =>
  SORT_OPTIONS.find((o) => o.id === id)?.label ??
  SORT_OPTIONS[0]?.label ??
  "Most relevant";
