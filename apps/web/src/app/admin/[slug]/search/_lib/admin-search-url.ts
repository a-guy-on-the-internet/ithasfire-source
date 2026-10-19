/**
 * admin-search-url — pure, framework-free helpers for the /admin/[slug]/search
 * deep-link sync (FR-011).
 *
 * Modelled on the consumer page's `app/search/_components/search-url.ts`: one
 * module owns the param names, the parse, and the serialise, so the two
 * directions cannot drift.
 *
 * ## The param names are a CONTRACT with the spotlight
 *
 * `SpotlightSearch`'s "View all" builds its hand-off URL by calling
 * `appendAdminFacetParams` (FR-007). This module WRITES through that exact same
 * function rather than re-spelling `status` / `from` / `to` / `category` /
 * `type` locally — a duplicated name list is precisely how a hand-off silently
 * starts dropping filters. Reading is the only side that names them, and
 * `__tests__/admin-search-url.test.ts` pins reader and writer against each
 * other.
 *
 * ## Single writer
 *
 * The page NEVER writes the URL from an effect that watches its own state.
 * That is the classic parse → state → build → replace → parse loop, and it also
 * races back/forward: an effect running with the new `searchParams` but the
 * pre-adoption state pushes the old state straight back over the navigation.
 * Instead every mutation goes through one `commit()` at the call site, which
 * sets state and writes the URL together, and the only effect is URL → state
 * (which no-ops when the URL already describes the current state — see
 * {@link adminSearchStateEquals}).
 */

import {
  ADMIN_DATE_FACETS,
  ADMIN_GROUPS,
  ADMIN_STATUS_FACETS,
  EMPTY_ADMIN_FACETS,
  appendAdminFacetParams,
  isLocalEndOfDay,
  isLocalStartOfDay,
  toLocalDateInputValue,
  type AdminDateFacet,
  type AdminFacetState,
  type AdminGroup,
  type AdminStatusFacet,
} from "@/components/search/spotlight-admin-facets";

/** Everything this module owns on the querystring. Anything else is preserved. */
export const ADMIN_SEARCH_OWNED_PARAMS = [
  "search",
  "type",
  "status",
  "date",
  "from",
  "to",
  "category",
  "uncat",
] as const;

export type AdminSearchUrlState = {
  query: string;
  /** The entity pill, or null for "All". Serialised as `?type=`. */
  group: AdminGroup | null;
  facets: AdminFacetState;
};

export const EMPTY_ADMIN_SEARCH_URL_STATE: AdminSearchUrlState = {
  query: "",
  group: null,
  facets: EMPTY_ADMIN_FACETS,
};

/** Minimal accessor shared by URLSearchParams and Next's readonly variant. */
type ParamGetter = { get(key: string): string | null };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseGroupParam = (raw: string | null): AdminGroup | null =>
  raw && (ADMIN_GROUPS as readonly string[]).includes(raw)
    ? (raw as AdminGroup)
    : null;

/** Unrecognised (or absent) → "ALL", which sends no `statuses` key at all. */
const parseStatusParam = (raw: string | null): AdminStatusFacet =>
  raw && (ADMIN_STATUS_FACETS as readonly string[]).includes(raw)
    ? (raw as AdminStatusFacet)
    : "ALL";

/**
 * `categoryIds` is `z.string().uuid()` server-side, so a hand-typed
 * `?category=music` would 400 the query on every keystroke rather than simply
 * not filtering. Drop anything that isn't UUID-shaped at the boundary.
 */
const parseCategoryParam = (raw: string | null): string | null =>
  raw && UUID_PATTERN.test(raw.trim()) ? raw.trim() : null;

/**
 * "Uncategorised" — the `categoryId IS NULL` arm of the category facet.
 *
 * Strictly `=== "1"`, which is the only value `appendAdminFacetParams` ever
 * writes (and it writes nothing at all when off). Anything else — `uncat=true`,
 * `uncat=0`, `uncat=` — reads as off, so a hand-edited URL degrades to "no
 * filter" instead of round-tripping to a param the builder would then rewrite,
 * which is what would make the URL → state effect ping-pong.
 */
const parseUncategorisedParam = (raw: string | null): boolean => raw === "1";

const parseDateParam = (raw: string | null): Date | null => {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

type DateFacetSlice = Pick<
  AdminFacetState,
  "date" | "dateAnchorMs" | "customFrom" | "customTo"
>;

const ANY_DATE: DateFacetSlice = {
  date: "ANY",
  dateAnchorMs: null,
  customFrom: "",
  customTo: "",
};

const parseDateModeParam = (raw: string | null): AdminDateFacet | null =>
  raw && (ADMIN_DATE_FACETS as readonly string[]).includes(raw)
    ? (raw as AdminDateFacet)
    : null;

/**
 * Reconstruct the date facet, preferring the EXPLICIT `?date=` mode.
 *
 * `appendAdminFacetParams` writes the mode whenever the facet is not ANY, so
 * this is the path every URL either surface produces today takes. It is what
 * makes a blank "Custom range" — the state the pill produces on its first
 * click, which carries no `from`/`to` at all — representable, and therefore
 * survivable across the next commit.
 *
 * When `date` is absent the bounds-only INFERENCE below still runs, so links
 * shared before the mode param existed keep working. The tell is the time
 * component: a relative anchor is `Date.now()` (an arbitrary wall-clock
 * instant), while a custom bound is always the first/last instant of its local
 * day by construction (`buildAdminDateRange`). One bound at an arbitrary time
 * is therefore "Upcoming"/"Past"; anything else is an explicit range.
 *
 * Either way the round-trip is exact — `build(parse(qs))` is `qs` for every
 * state this page can produce — which is why the URL → state effect never has
 * to fight a rewrite.
 */
function parseDateFacet(
  mode: string | null,
  from: Date | null,
  to: Date | null,
): DateFacetSlice {
  const customBounds: DateFacetSlice = {
    date: "CUSTOM",
    dateAnchorMs: null,
    customFrom: from ? toLocalDateInputValue(from) : "",
    customTo: to ? toLocalDateInputValue(to) : "",
  };

  switch (parseDateModeParam(mode)) {
    case "ANY":
      return ANY_DATE;
    case "UPCOMING":
      // The anchor rides in `from`; a mode with no bound is still the mode.
      return { ...ANY_DATE, date: "UPCOMING", dateAnchorMs: from?.getTime() ?? null };
    case "PAST":
      return { ...ANY_DATE, date: "PAST", dateAnchorMs: to?.getTime() ?? null };
    case "CUSTOM":
      return customBounds;
    default:
      break;
  }

  // ── Legacy: no `?date=`, infer from the bounds ──────────────────────
  if (from && !to && !isLocalStartOfDay(from)) {
    return { ...ANY_DATE, date: "UPCOMING", dateAnchorMs: from.getTime() };
  }
  if (to && !from && !isLocalEndOfDay(to)) {
    return { ...ANY_DATE, date: "PAST", dateAnchorMs: to.getTime() };
  }
  if (from || to) return customBounds;
  return ANY_DATE;
}

/** Parse the owned params out of a querystring into page-state shape. */
export function parseAdminSearchParams(
  params: ParamGetter,
): AdminSearchUrlState {
  return {
    query: (params.get("search") ?? "").trim(),
    group: parseGroupParam(params.get("type")),
    facets: {
      status: parseStatusParam(params.get("status")),
      categoryId: parseCategoryParam(params.get("category")),
      includeUncategorised: parseUncategorisedParam(params.get("uncat")),
      ...parseDateFacet(
        params.get("date"),
        parseDateParam(params.get("from")),
        parseDateParam(params.get("to")),
      ),
    },
  };
}

export type BuildAdminSearchQueryStringInput = {
  state: AdminSearchUrlState;
  /** Current querystring — its NON-owned keys are preserved verbatim. */
  preserved?: string | null;
};

/**
 * Serialise page state → querystring.
 *
 * Owned keys are cleared first and then re-written, so a cleared facet really
 * disappears instead of lingering from `preserved`. The facet block goes
 * through `appendAdminFacetParams` — the overlay's own writer — so the page
 * emits byte-identical URLs to the ones "View all" hands it.
 *
 * Note the facets are serialised even when the active group makes them
 * inapplicable (`?type=attendee&status=DRAFT`). They are not SENT to the
 * backend in that case — but they are still the user's state, and dropping
 * them here would make the URL → state effect wipe a facet the moment someone
 * pinned the Attendees pill.
 */
export function buildAdminSearchQueryString(
  input: BuildAdminSearchQueryStringInput,
): string {
  const params = new URLSearchParams(input.preserved ?? "");
  for (const key of ADMIN_SEARCH_OWNED_PARAMS) params.delete(key);

  const query = input.state.query.trim();
  if (query) params.set("search", query);

  appendAdminFacetParams(params, input.state.facets, input.state.group);

  return params.toString();
}

/** Canonical form of a querystring — `build ∘ parse`, preserving foreign keys. */
export function normalizeAdminSearchQueryString(qs: string): string {
  return buildAdminSearchQueryString({
    state: parseAdminSearchParams(new URLSearchParams(qs)),
    preserved: qs,
  });
}

/**
 * Logical equality — the loop guard.
 *
 * The URL → state effect calls this before setting state, so a URL that already
 * describes the current state (i.e. every URL this page wrote itself) is a
 * no-op rather than a re-render that re-derives the query key.
 */
export function adminSearchStateEquals(
  a: AdminSearchUrlState,
  b: AdminSearchUrlState,
): boolean {
  return (
    a.query === b.query &&
    a.group === b.group &&
    a.facets.status === b.facets.status &&
    a.facets.categoryId === b.facets.categoryId &&
    a.facets.includeUncategorised === b.facets.includeUncategorised &&
    a.facets.date === b.facets.date &&
    a.facets.dateAnchorMs === b.facets.dateAnchorMs &&
    a.facets.customFrom === b.facets.customFrom &&
    a.facets.customTo === b.facets.customTo
  );
}
