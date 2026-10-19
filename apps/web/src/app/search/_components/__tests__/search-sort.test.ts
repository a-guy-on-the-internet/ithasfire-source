import { describe, expect, it } from "vitest";

import {
  DEFAULT_SORT,
  SORT_OPTIONS,
  availableSorts,
  isEventOnlySort,
  parseSortParam,
  reconcileSort,
  scopeForSort,
  sortLabel,
  toServerSort,
  type SortId,
} from "../search-sort";

const ALL_IDS = SORT_OPTIONS.map((o) => o.id);

describe("parseSortParam", () => {
  it("passes through every offered sort id", () => {
    for (const id of ALL_IDS) {
      expect(parseSortParam(id)).toBe(id);
    }
  });

  it("falls back to the default for missing or unknown values", () => {
    expect(parseSortParam(undefined)).toBe(DEFAULT_SORT);
    expect(parseSortParam(null)).toBe(DEFAULT_SORT);
    expect(parseSortParam("")).toBe(DEFAULT_SORT);
    expect(parseSortParam("cheapest")).toBe(DEFAULT_SORT);
  });

  it("trims surrounding whitespace", () => {
    expect(parseSortParam("  price_asc  ")).toBe("price_asc");
  });

  // Old links must keep working. `?sort=date` was the server's spelling and
  // `?sort=featured` shipped in the previous UI.
  it("migrates the legacy `date` alias to the explicit direction", () => {
    expect(parseSortParam("date")).toBe("date_asc");
  });

  // `featured` was never implemented — it fell through the old client-side
  // switch into the date branch and rendered as "Date: latest". It maps to
  // popularity (what the label promised), not to date (what the bug did).
  it("migrates the legacy `featured` alias to popularity", () => {
    expect(parseSortParam("featured")).toBe("popularity");
  });
});

describe("toServerSort", () => {
  it("renames only date_asc, which the server calls `date`", () => {
    expect(toServerSort("date_asc")).toBe("date");
  });

  it("passes every other id through unchanged", () => {
    for (const id of ALL_IDS.filter((i) => i !== "date_asc")) {
      expect(toServerSort(id)).toBe(id);
    }
  });
});

describe("isEventOnlySort", () => {
  it("treats relevance as the only mixed-type-safe mode", () => {
    expect(isEventOnlySort("relevance")).toBe(false);
    for (const id of ALL_IDS.filter((i) => i !== "relevance")) {
      expect(isEventOnlySort(id)).toBe(true);
    }
  });
});

describe("scopeForSort", () => {
  it("narrows to events for any event-only sort", () => {
    expect(scopeForSort("date_asc", "all")).toBe("event");
    expect(scopeForSort("price_desc", "place")).toBe("event");
  });

  it("leaves the scope alone for relevance", () => {
    expect(scopeForSort("relevance", "all")).toBe("all");
    expect(scopeForSort("relevance", "human")).toBe("human");
  });
});

describe("availableSorts", () => {
  it("offers only relevance outside an event-bearing scope", () => {
    for (const scope of ["human", "organization", "place"] as const) {
      expect(availableSorts(scope, true).map((o) => o.id)).toEqual([
        "relevance",
      ]);
    }
  });

  it("hides distance until a coordinate resolves", () => {
    expect(availableSorts("all", false).map((o) => o.id)).not.toContain(
      "distance",
    );
    expect(availableSorts("all", true).map((o) => o.id)).toContain("distance");
  });

  // `all` keeps the full menu on purpose: choosing from it is what narrows the
  // user to Events (faceted sorting). Filtering it down to relevance here
  // would make the option unreachable from the default scope.
  it("keeps the full menu in the `all` scope", () => {
    expect(availableSorts("all", true).map((o) => o.id)).toEqual(ALL_IDS);
  });
});

describe("reconcileSort", () => {
  it("keeps a sort that is still offered", () => {
    expect(reconcileSort("price_asc", "event", false)).toBe("price_asc");
    expect(reconcileSort("distance", "event", true)).toBe("distance");
  });

  it("drops Nearest when the location is cleared", () => {
    expect(reconcileSort("distance", "event", false)).toBe(DEFAULT_SORT);
  });

  it("drops an event-only sort when the scope is not event-bearing", () => {
    expect(reconcileSort("price_asc", "place", true)).toBe(DEFAULT_SORT);
  });

  it("is idempotent", () => {
    for (const id of ALL_IDS) {
      const once = reconcileSort(id, "all", false);
      expect(reconcileSort(once, "all", false)).toBe(once);
    }
  });
});

describe("sortLabel", () => {
  it("names every offered sort", () => {
    for (const id of ALL_IDS) {
      expect(sortLabel(id)).toBeTruthy();
    }
  });

  it("falls back rather than rendering an empty menu button", () => {
    expect(sortLabel("nonsense" as SortId)).toBe("Most relevant");
  });
});
