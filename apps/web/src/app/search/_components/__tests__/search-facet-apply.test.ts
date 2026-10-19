import { describe, expect, it } from "vitest";

import {
  EMPTY_FACETS,
  facetDiffKind,
  facetsAreEmpty,
  sameCategories,
  sameFacets,
  type FacetSnapshot,
} from "../search-facet-apply";

const base: FacetSnapshot = {
  categories: ["music"],
  dateFrom: "2026-09-01",
  dateTo: "2026-09-07",
  freeOnly: false,
  priceMin: "10",
  priceMax: "40",
};

const withPatch = (patch: Partial<FacetSnapshot>): FacetSnapshot => ({
  ...base,
  ...patch,
});

describe("sameCategories", () => {
  it("ignores order", () => {
    expect(sameCategories(["music", "comedy"], ["comedy", "music"])).toBe(true);
  });

  it("still distinguishes different sets of the same size", () => {
    expect(sameCategories(["music", "comedy"], ["music", "film"])).toBe(false);
  });

  it("distinguishes different lengths", () => {
    expect(sameCategories(["music"], ["music", "comedy"])).toBe(false);
    expect(sameCategories([], ["music"])).toBe(false);
  });

  it("treats two empty sets as equal", () => {
    expect(sameCategories([], [])).toBe(true);
  });
});

describe("sameFacets", () => {
  it("is true for an identical snapshot", () => {
    expect(sameFacets(base, { ...base })).toBe(true);
  });

  it("is true across a category re-order", () => {
    // Untick then re-tick: the array order changes, the filter does not.
    const a = withPatch({ categories: ["music", "comedy"] });
    const b = withPatch({ categories: ["comedy", "music"] });
    expect(sameFacets(a, b)).toBe(true);
  });

  it.each([
    ["dateFrom", { dateFrom: "2026-09-02" }],
    ["dateTo", { dateTo: "2026-09-08" }],
    ["freeOnly", { freeOnly: true }],
    ["priceMin", { priceMin: "11" }],
    ["priceMax", { priceMax: "41" }],
    ["categories", { categories: ["comedy"] }],
  ] as const)("is false when %s differs", (_label, patch) => {
    expect(sameFacets(base, withPatch(patch))).toBe(false);
  });
});

describe("facetDiffKind", () => {
  it("reports none for an unchanged draft", () => {
    // Load-bearing: the page must NOT reallocate `applied` here, because its
    // identity keys the pagination reset that drops accumulated pages.
    expect(facetDiffKind({ ...base }, base)).toBe("none");
  });

  it("reports none across a pure category re-order", () => {
    expect(
      facetDiffKind(
        withPatch({ categories: ["comedy", "music"] }),
        withPatch({ categories: ["music", "comedy"] }),
      ),
    ).toBe("none");
  });

  it("reports continuous when only a price bound moved", () => {
    expect(facetDiffKind(withPatch({ priceMin: "12" }), base)).toBe(
      "continuous",
    );
    expect(facetDiffKind(withPatch({ priceMax: "" }), base)).toBe("continuous");
    expect(
      facetDiffKind(withPatch({ priceMin: "5", priceMax: "50" }), base),
    ).toBe("continuous");
  });

  it.each([
    ["a category", { categories: ["music", "comedy"] }],
    ["a date bound", { dateFrom: "2026-09-02" }],
    ["the free toggle", { freeOnly: true }],
  ] as const)("reports discrete when %s moved", (_label, patch) => {
    expect(facetDiffKind(withPatch(patch), base)).toBe("discrete");
  });

  it("reports discrete when a price edit rides along with a discrete one", () => {
    // The reader just clicked a checkbox; it must not wait out the price
    // debounce before anything happens.
    expect(
      facetDiffKind(withPatch({ categories: [], priceMin: "12" }), base),
    ).toBe("discrete");
  });
});

describe("EMPTY_FACETS / facetsAreEmpty", () => {
  it("recognises the all-clear snapshot", () => {
    expect(facetsAreEmpty(EMPTY_FACETS)).toBe(true);
    expect(facetsAreEmpty({ ...EMPTY_FACETS, categories: [] })).toBe(true);
  });

  it.each([
    ["a category", { categories: ["music"] }],
    ["a from date", { dateFrom: "2026-09-01" }],
    ["a to date", { dateTo: "2026-09-01" }],
    ["free only", { freeOnly: true }],
    ["a min price", { priceMin: "1" }],
    ["a max price", { priceMax: "1" }],
  ] as const)("is false with %s set", (_label, patch) => {
    expect(facetsAreEmpty({ ...EMPTY_FACETS, ...patch })).toBe(false);
  });

  it("clearing a populated snapshot is a discrete change", () => {
    expect(facetDiffKind(EMPTY_FACETS, base)).toBe("discrete");
  });
});
