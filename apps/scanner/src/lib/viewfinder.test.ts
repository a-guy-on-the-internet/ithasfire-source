import { describe, expect, it } from "vitest";

import { VIEWFINDER_MAX, VIEWFINDER_MIN, viewfinderSize } from "./viewfinder";

describe("viewfinderSize", () => {
  it("gives the same optical proportion on an SE and a Max", () => {
    // Frame width = screen width minus the screen's own gutters.
    expect(viewfinderSize(343)).toBe(213); // 375-class
    expect(viewfinderSize(398)).toBe(247); // 430-class
  });

  it("clamps rather than producing an unusable box", () => {
    expect(viewfinderSize(100)).toBe(VIEWFINDER_MIN);
    expect(viewfinderSize(1200)).toBe(VIEWFINDER_MAX);
  });

  it("degrades to the minimum before layout has measured the frame", () => {
    // `onLayout` has not fired yet on first render, so width is 0.
    expect(viewfinderSize(0)).toBe(VIEWFINDER_MIN);
    expect(viewfinderSize(Number.NaN)).toBe(VIEWFINDER_MIN);
  });
});
