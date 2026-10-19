import { describe, expect, it } from "vitest";

import { pruneSelection } from "../prune-selection";

describe("pruneSelection", () => {
  it("drops keys whose rows are no longer loaded", () => {
    const selected = new Set(["a", "b", "c"]);
    const next = pruneSelection(selected, ["b", "c", "d"]);
    expect([...next].sort()).toEqual(["b", "c"]);
    expect(next).not.toBe(selected);
    // The input is never mutated.
    expect([...selected].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns the same instance when every key is still loaded", () => {
    const selected = new Set(["a", "b"]);
    expect(pruneSelection(selected, ["c", "b", "a"])).toBe(selected);
  });

  it("returns the same instance for an empty selection", () => {
    const selected = new Set<string>();
    expect(pruneSelection(selected, [])).toBe(selected);
  });

  it("empties the selection when no selected row is loaded", () => {
    const next = pruneSelection(new Set(["a"]), []);
    expect(next.size).toBe(0);
  });
});
