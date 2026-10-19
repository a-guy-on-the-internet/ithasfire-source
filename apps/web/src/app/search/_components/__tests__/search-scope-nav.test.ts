import { describe, expect, it } from "vitest";

import {
  SCOPE_ORDER,
  nextScopeForKey,
  scopeRadioDomId,
} from "../search-scope-nav";
import type { SearchScope } from "../search-url";

describe("SCOPE_ORDER", () => {
  it("is the five scope values in display order", () => {
    expect(SCOPE_ORDER).toEqual([
      "all",
      "event",
      "human",
      "organization",
      "place",
    ]);
  });
});

describe("scopeRadioDomId", () => {
  it("builds one stable id per scope", () => {
    const ids = SCOPE_ORDER.map(scopeRadioDomId);
    expect(ids).toEqual([
      "search-scope-all",
      "search-scope-event",
      "search-scope-human",
      "search-scope-organization",
      "search-scope-place",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("nextScopeForKey", () => {
  it("moves forward on ArrowRight / ArrowDown", () => {
    expect(nextScopeForKey("all", "ArrowRight")).toBe("event");
    expect(nextScopeForKey("event", "ArrowDown")).toBe("human");
  });

  it("moves backward on ArrowLeft / ArrowUp", () => {
    expect(nextScopeForKey("event", "ArrowLeft")).toBe("all");
    expect(nextScopeForKey("place", "ArrowUp")).toBe("organization");
  });

  it("wraps in both directions", () => {
    expect(nextScopeForKey("place", "ArrowRight")).toBe("all");
    expect(nextScopeForKey("all", "ArrowLeft")).toBe("place");
  });

  it("jumps to the ends on Home / End", () => {
    expect(nextScopeForKey("human", "Home")).toBe("all");
    expect(nextScopeForKey("human", "End")).toBe("place");
  });

  it("re-selects the focused option on Space / Enter", () => {
    expect(nextScopeForKey("human", " ")).toBe("human");
    expect(nextScopeForKey("human", "Enter")).toBe("human");
  });

  it("returns null for keys it does not handle", () => {
    // Load-bearing: the component only preventDefaults on a non-null result,
    // so returning null here is what keeps Tab from becoming a keyboard trap.
    for (const key of ["Tab", "Escape", "a", "PageDown", "Shift"]) {
      expect(nextScopeForKey("all", key)).toBeNull();
    }
  });

  it("does not treat an unknown current value as 'one before the first'", () => {
    const unknown = "totally-not-a-scope" as SearchScope;
    expect(nextScopeForKey(unknown, "ArrowRight")).toBe("all");
    expect(nextScopeForKey(unknown, "ArrowLeft")).toBe("place");
    expect(nextScopeForKey(unknown, "Enter")).toBe("all");
  });

  it("returns null for every key when the order is empty", () => {
    expect(nextScopeForKey("all", "ArrowRight", [])).toBeNull();
    expect(nextScopeForKey("all", "Home", [])).toBeNull();
  });
});
