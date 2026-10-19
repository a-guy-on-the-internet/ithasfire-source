/**
 * search-url — pure, framework-free helpers for the /search deep-link sync.
 *
 * Both the server route (`page.tsx`) and the client page
 * (`UniversalSearchPage.tsx`) parse the same URL params; sharing these keeps
 * the two from drifting. The querystring builder is the core of the
 * bidirectional single-writer loop guard and is unit-tested in
 * `__tests__/search-url.test.ts`.
 *
 * Only `search` / `type` / `category` and the geo block
 * (`near`/`place`/`lat`/`lng`/`radius`) are owned by the sync. Any other key
 * present on the current querystring (notably `sort`) is preserved verbatim.
 */

export type SearchScope = "all" | "event" | "human" | "organization" | "place";

/** Non-"all" scope values that are valid as the `type` URL param. */
const SCOPE_PARAM_VALUES = [
  "event",
  "human",
  "organization",
  "place",
] as const;

export type SearchUrlGeo = { lat: number; lng: number; label: string };

export type SearchUrlState = {
  query: string;
  scope: SearchScope;
  categories: string[];
  geo: SearchUrlGeo | null;
  radiusKm: number | null;
  nearMe: boolean;
};

/** Whitelist the `type` param; anything unrecognised falls back to "all". */
export const parseScopeParam = (raw: string | null | undefined): SearchScope =>
  raw && (SCOPE_PARAM_VALUES as readonly string[]).includes(raw)
    ? (raw as SearchScope)
    : "all";

/** Comma-separated category list → trimmed, de-duped, empty-dropped array. */
export const parseCategoryParam = (
  raw: string | null | undefined,
): string[] => {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0),
    ),
  );
};

/** Minimal accessor shape shared by URLSearchParams and Next's readonly variant. */
type ParamGetter = { get(key: string): string | null };

/** Parse the owned params out of a querystring into local-state shape. */
export const parseSearchParams = (params: ParamGetter): SearchUrlState => {
  const query = (params.get("search") ?? "").trim();
  const scope = parseScopeParam(params.get("type"));
  const categories = parseCategoryParam(params.get("category"));

  const nearMe = params.get("near") === "1";
  const place = (params.get("place") ?? "").trim();
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  const geo =
    place && Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng, label: place }
      : null;

  const radiusRaw = Number(params.get("radius"));
  const radiusKm =
    Number.isFinite(radiusRaw) && radiusRaw > 0 ? radiusRaw : null;

  return { query, scope, categories, geo, radiusKm, nearMe };
};

export type BuildSearchQueryStringInput = {
  query: string;
  scope: SearchScope;
  categories: string[];
  geo: SearchUrlGeo | null;
  radiusKm: number;
  /** "Use my location" intent — serialised as `near=1` independently of geo. */
  nearMe?: boolean;
  /** Current querystring — its non-owned keys (e.g. `sort`) are preserved. */
  preserved?: string | null;
};

/**
 * Serialise search state → querystring, preserving any non-owned keys already
 * present in `preserved`. Empty query / category are dropped; `type=all` is
 * omitted. The place block (`place`/`lat`/`lng`/`radius`) is written when a
 * resolved geo location is present and removed otherwise; `near=1` tracks the
 * "use my location" intent separately, so landing on `?near=1` (before coords
 * resolve) is stable. Pure and deterministic — feeding the output back through
 * `parseSearchParams` yields the same logical state.
 */
export const buildSearchQueryString = (
  input: BuildSearchQueryStringInput,
): string => {
  const params = new URLSearchParams(input.preserved ?? "");

  const query = input.query.trim();
  if (query) params.set("search", query);
  else params.delete("search");

  if (input.scope !== "all") params.set("type", input.scope);
  else params.delete("type");

  const categories = parseCategoryParam(input.categories.join(","));
  if (categories.length > 0) params.set("category", categories.join(","));
  else params.delete("category");

  if (input.geo) {
    params.set("place", input.geo.label);
    params.set("lat", String(input.geo.lat));
    params.set("lng", String(input.geo.lng));
    params.set("radius", String(input.radiusKm));
  } else {
    params.delete("place");
    params.delete("lat");
    params.delete("lng");
    params.delete("radius");
  }

  if (input.nearMe) params.set("near", "1");
  else params.delete("near");

  return params.toString();
};

/** Params driven by continuous controls (typing, slider drags). A diff that
 *  touches only these is `replace`d so a drag/keystroke never spams history. */
const CONTINUOUS_PARAM_KEYS = new Set<string>(["search", "radius"]);

/**
 * True when two querystrings differ ONLY in continuous params (`search`
 * and/or `radius`). Drives the push-vs-replace decision: a continuous-only
 * change is a slider drag or typing (→ `replace`, no history spam); a diff
 * touching any discrete param (`type`, `category`, geo, …) is a discrete
 * action (→ `push`, so Back restores it).
 */
export const diffIsContinuousOnly = (a: string, b: string): boolean => {
  const pa = new URLSearchParams(a);
  const pb = new URLSearchParams(b);
  const keys = new Set<string>([...pa.keys(), ...pb.keys()]);
  for (const key of keys) {
    if (CONTINUOUS_PARAM_KEYS.has(key)) continue;
    if (pa.get(key) !== pb.get(key)) return false;
  }
  return true;
};

/**
 * True when two querystrings differ ONLY in `category`.
 *
 * Category is a SET the reader edits one member at a time. Now that the
 * desktop rail applies instantly there is no Apply button coalescing the
 * ticks, so five checkboxes would push five history entries and cost five
 * Back presses to leave /search. Treating a category-only diff as a `replace`
 * keeps Back meaning "the page before this search" instead of "one checkbox
 * ago"; the active-filter chips and Clear all are the in-page undo.
 *
 * Deliberately separate from `diffIsContinuousOnly` rather than folded into
 * `CONTINUOUS_PARAM_KEYS`: category is not continuous, and the two predicates
 * answer different questions even though they currently pick the same verb.
 */
export const diffIsCategoryOnly = (a: string, b: string): boolean => {
  const pa = new URLSearchParams(a);
  const pb = new URLSearchParams(b);
  if (pa.get("category") === pb.get("category")) return false;
  const keys = new Set<string>([...pa.keys(), ...pb.keys()]);
  for (const key of keys) {
    if (key === "category") continue;
    if (pa.get(key) !== pb.get(key)) return false;
  }
  return true;
};

/** Keys that carry the resolved geo. They may differ across a near-me
 *  resolution: `place`/`radius` are filled in alongside `lat`/`lng`. */
const NEAR_ME_RESOLUTION_KEYS = new Set<string>([
  "near",
  "place",
  "lat",
  "lng",
  "radius",
]);

/**
 * True when `a` is the "use my location" intent (`near=1`) and `b` is that
 * same intent resolved into coordinates: `near` dropped, `lat`/`lng` present,
 * and every other key (query, scope, categories, preserved keys) unchanged.
 *
 * `?near=1` is an intent, not a destination. If resolving it were a `push`,
 * Back would land on `?near=1`, which re-resolves and pushes again, trapping
 * the reader. Treating the resolution as a `replace` overwrites the intent
 * entry so Back goes to the page before /search. A reader adding a place by
 * hand (no `near` in `a`) is a discrete action and stays a push.
 *
 * Any coordinates count, not only the "My location" label: the label is
 * translated, and a place picked by hand from `?near=1` keeps `near=1` in `b`
 * (`handleLocationSelect` does not clear it), so it never reaches this check.
 */
export const diffIsNearMeResolution = (a: string, b: string): boolean => {
  const pa = new URLSearchParams(a);
  const pb = new URLSearchParams(b);
  if (pa.get("near") !== "1") return false;
  if (pb.has("near")) return false;
  if (!pb.has("lat") || !pb.has("lng")) return false;
  const keys = new Set<string>([...pa.keys(), ...pb.keys()]);
  for (const key of keys) {
    if (NEAR_ME_RESOLUTION_KEYS.has(key)) continue;
    if (pa.get(key) !== pb.get(key)) return false;
  }
  return true;
};

/**
 * Canonicalise a querystring by round-tripping it through the owned-param
 * parser + serialiser (dedupes `category`, drops `type=all`, trims, orders
 * the geo block). Used to detect that an outbound divergence is pure
 * normalization of an inbound/mount value rather than a user edit — so the
 * write can be a `replace` and not inject a spurious history entry.
 * `defaultRadiusKm` mirrors the app's fallback when a geo URL omits `radius`.
 */
export const normalizeQueryString = (
  qs: string,
  defaultRadiusKm: number,
): string => {
  const parsed = parseSearchParams(new URLSearchParams(qs));
  return buildSearchQueryString({
    query: parsed.query,
    scope: parsed.scope,
    categories: parsed.categories,
    geo: parsed.geo,
    radiusKm: parsed.radiusKm ?? defaultRadiusKm,
    nearMe: parsed.nearMe,
    preserved: qs,
  });
};

/** Push-vs-replace verdict of the outbound URL sync. */
export type SearchUrlWriteMethod = "push" | "replace";

/** The slice of the App Router the outbound sync navigates with. */
export type SearchUrlRouter = {
  push: (href: string, options: { scroll: boolean }) => void;
};

/** The slice of `window.history` the outbound sync writes with. */
export type SearchUrlHistory = Pick<History, "replaceState">;

/**
 * Write the outbound /search URL.
 *
 * `replace` (typing, radius drag, category ticks, canonicalising an adopted
 * value) goes through the NATIVE `history.replaceState`, never
 * `router.replace`. The App Router patches `replaceState` and folds the new
 * URL into `useSearchParams` / `usePathname` with a history-restore action
 * that reuses the rendered tree, so there is no RSC request. `router.replace`
 * soft-navigated instead: the server re-ran `page.tsx` (and its event search)
 * and React committed the result as a page navigation. Measured on prod at 6x
 * CPU throttle: one 911ms frame after typing "comedy", an 872ms INP in RUM.
 * The page fetches its own results over tRPC from client state, so nothing on
 * screen needs that server render.
 *
 * `push` (scope, geo add/clear) stays on the router: a discrete action is a
 * real history step, and the router's push keeps its usual behaviour.
 *
 * `null` state is deliberate: Next's patch copies its own `__NA` marker and
 * tree into the entry, which is what lets Back/Forward restore it in place
 * rather than reloading the page.
 */
export const writeSearchUrl = ({
  method,
  href,
  router,
  history,
}: {
  method: SearchUrlWriteMethod;
  href: string;
  router: SearchUrlRouter;
  history: SearchUrlHistory;
}): void => {
  if (method === "replace") {
    history.replaceState(null, "", href);
    return;
  }
  router.push(href, { scroll: false });
};
