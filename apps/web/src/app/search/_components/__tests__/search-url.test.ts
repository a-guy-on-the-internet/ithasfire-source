import { describe, expect, it, vi } from "vitest";

import {
  buildSearchQueryString,
  diffIsCategoryOnly,
  diffIsContinuousOnly,
  diffIsNearMeResolution,
  normalizeQueryString,
  parseCategoryParam,
  parseScopeParam,
  parseSearchParams,
  writeSearchUrl,
  type BuildSearchQueryStringInput,
} from "../search-url";

const base: BuildSearchQueryStringInput = {
  query: "",
  scope: "all",
  categories: [],
  geo: null,
  radiusKm: 40,
  preserved: null,
};

describe("parseScopeParam", () => {
  it("passes through whitelisted scopes", () => {
    expect(parseScopeParam("event")).toBe("event");
    expect(parseScopeParam("place")).toBe("place");
  });

  it("falls back to 'all' for missing or invalid values", () => {
    expect(parseScopeParam(null)).toBe("all");
    expect(parseScopeParam("")).toBe("all");
    expect(parseScopeParam("all")).toBe("all");
    expect(parseScopeParam("bogus")).toBe("all");
  });
});

describe("parseCategoryParam", () => {
  it("splits, trims, drops empties, and de-dupes", () => {
    expect(parseCategoryParam("music, comedy ,,music")).toEqual([
      "music",
      "comedy",
    ]);
  });

  it("returns [] for missing input", () => {
    expect(parseCategoryParam(null)).toEqual([]);
    expect(parseCategoryParam("")).toEqual([]);
  });
});

describe("buildSearchQueryString", () => {
  it("joins categories into a comma-separated `category` param", () => {
    const qs = buildSearchQueryString({
      ...base,
      categories: ["music", "comedy"],
    });
    expect(new URLSearchParams(qs).get("category")).toBe("music,comedy");
  });

  it("omits `type` when scope is 'all'", () => {
    const qs = buildSearchQueryString({ ...base, scope: "all", query: "jazz" });
    expect(new URLSearchParams(qs).has("type")).toBe(false);
  });

  it("writes `type` for a non-'all' scope", () => {
    const qs = buildSearchQueryString({ ...base, scope: "place" });
    expect(new URLSearchParams(qs).get("type")).toBe("place");
  });

  it("deletes empty query and empty category rather than emitting blanks", () => {
    const qs = buildSearchQueryString({
      ...base,
      query: "   ",
      categories: ["", "  "],
      preserved: "search=old&category=music",
    });
    const params = new URLSearchParams(qs);
    expect(params.has("search")).toBe(false);
    expect(params.has("category")).toBe(false);
  });

  it("preserves non-owned params (sort) verbatim", () => {
    const qs = buildSearchQueryString({
      ...base,
      query: "jazz",
      preserved: "sort=date_asc",
    });
    const params = new URLSearchParams(qs);
    expect(params.get("sort")).toBe("date_asc");
    expect(params.get("search")).toBe("jazz");
  });

  it("writes the place block when geo is present (no `near` unless near-me)", () => {
    const qs = buildSearchQueryString({
      ...base,
      geo: { lat: 40.7128, lng: -74.006, label: "New York" },
      radiusKm: 25,
    });
    const params = new URLSearchParams(qs);
    expect(params.has("near")).toBe(false);
    expect(params.get("place")).toBe("New York");
    expect(params.get("lat")).toBe("40.7128");
    expect(params.get("lng")).toBe("-74.006");
    expect(params.get("radius")).toBe("25");
  });

  it("serialises `near=1` from the near-me intent independently of geo", () => {
    // Intent set before coords resolve — geo still null.
    const qs = buildSearchQueryString({ ...base, geo: null, nearMe: true });
    const params = new URLSearchParams(qs);
    expect(params.get("near")).toBe("1");
    expect(params.has("place")).toBe(false);
  });

  it("removes a stale geo/near block when geo is null and not near-me", () => {
    const qs = buildSearchQueryString({
      ...base,
      geo: null,
      nearMe: false,
      preserved: "near=1&place=Old&lat=1&lng=2&radius=10&sort=featured",
    });
    const params = new URLSearchParams(qs);
    expect(params.has("near")).toBe(false);
    expect(params.has("place")).toBe(false);
    expect(params.has("lat")).toBe(false);
    expect(params.has("lng")).toBe(false);
    expect(params.has("radius")).toBe(false);
    // non-owned param survives the geo teardown
    expect(params.get("sort")).toBe("featured");
  });

  it("round-trips: build → parse yields the same logical state", () => {
    const state: BuildSearchQueryStringInput = {
      query: "jazz",
      scope: "place",
      categories: ["music", "comedy"],
      geo: { lat: 40.7128, lng: -74.006, label: "New York" },
      radiusKm: 25,
      nearMe: true,
      preserved: "sort=date_asc",
    };
    const qs = buildSearchQueryString(state);
    const parsed = parseSearchParams(new URLSearchParams(qs));
    expect(parsed).toEqual({
      query: "jazz",
      scope: "place",
      categories: ["music", "comedy"],
      geo: { lat: 40.7128, lng: -74.006, label: "New York" },
      radiusKm: 25,
      nearMe: true,
    });
  });

  it("is idempotent: feeding output back as preserved is a no-op", () => {
    const state: BuildSearchQueryStringInput = {
      query: "jazz",
      scope: "event",
      categories: ["music"],
      geo: null,
      radiusKm: 40,
      preserved: null,
    };
    const first = buildSearchQueryString(state);
    const second = buildSearchQueryString({ ...state, preserved: first });
    expect(second).toBe(first);
  });
});

describe("diffIsContinuousOnly", () => {
  it("is true (continuous → replace) when only the search value differs", () => {
    expect(
      diffIsContinuousOnly("search=jaz&type=place", "search=jazz&type=place"),
    ).toBe(true);
  });

  it("is true when search is added on an otherwise identical string", () => {
    expect(diffIsContinuousOnly("type=place", "search=jazz&type=place")).toBe(
      true,
    );
  });

  it("is true when only radius differs (slider drag → replace)", () => {
    expect(
      diffIsContinuousOnly(
        "place=NYC&lat=1&lng=2&radius=40",
        "place=NYC&lat=1&lng=2&radius=50",
      ),
    ).toBe(true);
  });

  it("is true when a search+radius diff is combined (both continuous)", () => {
    expect(
      diffIsContinuousOnly(
        "place=NYC&lat=1&lng=2&radius=40",
        "search=jazz&place=NYC&lat=1&lng=2&radius=50",
      ),
    ).toBe(true);
  });

  it("is false (discrete → push) when a scope param differs", () => {
    expect(diffIsContinuousOnly("search=jazz", "search=jazz&type=place")).toBe(
      false,
    );
  });

  it("is false when a category differs", () => {
    expect(
      diffIsContinuousOnly("category=music", "category=music,comedy"),
    ).toBe(false);
  });

  it("is false when a geo place is added (discrete geo action)", () => {
    expect(
      diffIsContinuousOnly("search=jazz", "search=jazz&place=NYC&lat=1&lng=2&radius=40"),
    ).toBe(false);
  });
});

describe("normalizeQueryString", () => {
  const DEFAULT_RADIUS = 40;

  it("drops type=all and dedupes/trims category", () => {
    const normalized = normalizeQueryString(
      "type=all&search=jazz&category=music,%20music%20",
      DEFAULT_RADIUS,
    );
    const params = new URLSearchParams(normalized);
    expect(params.has("type")).toBe(false);
    expect(params.get("search")).toBe("jazz");
    expect(params.get("category")).toBe("music");
  });

  it("is idempotent — normalizing an already-canonical string is a no-op", () => {
    const canonical = buildSearchQueryString({
      ...base,
      query: "jazz",
      scope: "place",
      categories: ["music"],
    });
    expect(normalizeQueryString(canonical, DEFAULT_RADIUS)).toBe(canonical);
  });

  it("fills the default radius when a geo URL omits it", () => {
    const normalized = normalizeQueryString(
      "place=NYC&lat=1&lng=2",
      DEFAULT_RADIUS,
    );
    expect(new URLSearchParams(normalized).get("radius")).toBe("40");
  });
});

describe("diffIsCategoryOnly", () => {
  it("is true when only the category list changed", () => {
    expect(diffIsCategoryOnly("search=jazz", "search=jazz&category=music")).toBe(
      true,
    );
    expect(
      diffIsCategoryOnly(
        "search=jazz&category=music",
        "search=jazz&category=music,comedy",
      ),
    ).toBe(true);
    expect(diffIsCategoryOnly("category=music", "")).toBe(true);
  });

  it("is false when category did not change", () => {
    // Nothing to coalesce — the caller must not downgrade an unrelated diff.
    expect(diffIsCategoryOnly("category=music", "category=music")).toBe(false);
    expect(diffIsCategoryOnly("", "")).toBe(false);
  });

  it("is false when any other owned param moved alongside it", () => {
    expect(diffIsCategoryOnly("category=music", "category=comedy&type=place")).toBe(
      false,
    );
    expect(
      diffIsCategoryOnly("category=music", "category=comedy&search=jazz"),
    ).toBe(false);
    expect(
      diffIsCategoryOnly("category=music", "category=comedy&near=1"),
    ).toBe(false);
  });

  it("is false when a preserved non-owned key moved alongside it", () => {
    expect(
      diffIsCategoryOnly("category=music&sort=price_asc", "category=comedy&sort=date"),
    ).toBe(false);
  });

  it("does not overlap with diffIsContinuousOnly", () => {
    // The two predicates are OR'd at the call site; a category-only diff is
    // not continuous, and a radius-only diff is not category.
    const a = "search=jazz&category=music";
    const b = "search=jazz&category=comedy";
    expect(diffIsCategoryOnly(a, b)).toBe(true);
    expect(diffIsContinuousOnly(a, b)).toBe(false);

    const c = "place=Nashville&lat=1&lng=2&radius=50";
    const d = "place=Nashville&lat=1&lng=2&radius=80";
    expect(diffIsCategoryOnly(c, d)).toBe(false);
    expect(diffIsContinuousOnly(c, d)).toBe(true);
  });
});

describe("diffIsNearMeResolution", () => {
  const coords = "place=My+location&lat=36.16&lng=-86.78&radius=50";

  it("is true when near=1 resolves into coordinates", () => {
    expect(diffIsNearMeResolution("near=1", coords)).toBe(true);
  });

  it("is true when the other keys are unchanged", () => {
    expect(
      diffIsNearMeResolution(
        "search=jazz&type=event&category=music&sort=date&near=1",
        `search=jazz&type=event&category=music&sort=date&${coords}`,
      ),
    ).toBe(true);
  });

  it("is false when query, scope, categories or a preserved key also changed", () => {
    expect(diffIsNearMeResolution("near=1", `search=jazz&${coords}`)).toBe(false);
    expect(diffIsNearMeResolution("near=1", `type=place&${coords}`)).toBe(false);
    expect(
      diffIsNearMeResolution("near=1", `category=music&${coords}`),
    ).toBe(false);
    expect(
      diffIsNearMeResolution("near=1&sort=date", `sort=price_asc&${coords}`),
    ).toBe(false);
  });

  it("is false for coords to coords", () => {
    expect(
      diffIsNearMeResolution(coords, "place=Nashville&lat=36.1&lng=-86.7&radius=50"),
    ).toBe(false);
  });

  it("is false when a place is added by hand (no near in the source)", () => {
    expect(diffIsNearMeResolution("", coords)).toBe(false);
    expect(diffIsNearMeResolution("search=jazz", `search=jazz&${coords}`)).toBe(
      false,
    );
  });

  it("is false while near is still set or coordinates are missing", () => {
    expect(diffIsNearMeResolution("near=1", `near=1&${coords}`)).toBe(false);
    expect(diffIsNearMeResolution("near=1", "")).toBe(false);
    expect(diffIsNearMeResolution("near=1", "lat=36.16")).toBe(false);
  });
});

describe("writeSearchUrl", () => {
  const fakes = () => ({
    router: { push: vi.fn() },
    history: { replaceState: vi.fn() },
  });

  it("writes a replace through the native History API, never the router", () => {
    // router.replace soft-navigated: an RSC request plus a page-level commit,
    // measured as a 911ms frame after typing settled.
    const { router, history } = fakes();
    writeSearchUrl({
      method: "replace",
      href: "/search?search=comedy",
      router,
      history,
    });
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    expect(history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/search?search=comedy",
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps a push on the router so the discrete step is a history entry", () => {
    const { router, history } = fakes();
    writeSearchUrl({
      method: "push",
      href: "/search?search=comedy&type=place",
      router,
      history,
    });
    expect(router.push).toHaveBeenCalledWith(
      "/search?search=comedy&type=place",
      { scroll: false },
    );
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it("writes the bare path when the querystring is empty", () => {
    const { router, history } = fakes();
    writeSearchUrl({ method: "replace", href: "/search", router, history });
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/search");
  });
});
