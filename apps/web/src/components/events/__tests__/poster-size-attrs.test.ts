import { describe, expect, it } from "vitest";

import { posterSizeAttrs } from "../poster-size-attrs";

describe("posterSizeAttrs", () => {
  it("passes a whole, positive size through", () => {
    expect(posterSizeAttrs({ width: 1080, height: 1350 })).toEqual({
      width: 1080,
      height: 1350,
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["zero width", { width: 0, height: 10 }],
    ["negative height", { width: 10, height: -1 }],
    ["fractional", { width: 10.5, height: 10 }],
    ["NaN", { width: Number.NaN, height: 10 }],
  ])("%s → no attributes", (_name, size) => {
    expect(posterSizeAttrs(size)).toEqual({});
  });
});
