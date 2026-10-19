import { describe, expect, it } from "vitest";

import { shuffleIds } from "../ArtistAttributionPicker";

describe("shuffleIds", () => {
  it("preserves membership and length (it is a permutation)", () => {
    const input = ["a", "b", "c", "d", "e"];
    const result = shuffleIds(input);

    expect(result).toHaveLength(input.length);
    expect([...result].sort()).toEqual([...input].sort());
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b", "c"];
    const copy = [...input];
    shuffleIds(input);
    expect(input).toEqual(copy);
  });

  it("handles empty and single-element inputs", () => {
    expect(shuffleIds([])).toEqual([]);
    expect(shuffleIds(["only"])).toEqual(["only"]);
  });
});
