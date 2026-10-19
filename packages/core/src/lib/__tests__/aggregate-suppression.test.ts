import { describe, expect, it } from "vitest";

import {
  gateSlice,
  passesThreshold,
  roundPercentToStep,
  roundToBucket,
  toCountBand,
  topCode,
} from "../aggregate-suppression";

describe("passesThreshold", () => {
  it.each([
    // [distinctCount, min, expected]
    [0, 3, false],
    [2, 3, false],
    [3, 3, true], // boundary: exactly at threshold passes
    [4, 3, true],
    [4, 5, false],
    [5, 5, true],
    [9, 10, false],
    [10, 10, true],
    [0, 0, true],
  ])("(%i, min=%i) → %s", (count, min, expected) => {
    expect(passesThreshold(count, min)).toBe(expected);
  });
});

describe("gateSlice", () => {
  const slice = { payout: { medianCents: 20000 } };

  it("returns the slice at/above threshold", () => {
    expect(gateSlice(5, 5, slice)).toBe(slice);
    expect(gateSlice(6, 5, slice)).toBe(slice);
  });

  it("returns an empty object below threshold — spreading omits the key", () => {
    const out = { version: 1, ...gateSlice(4, 5, slice) };
    expect(out).toStrictEqual({ version: 1 });
    expect("payout" in out).toBe(false);
  });
});

describe("roundToBucket (round-half-up)", () => {
  it.each([
    // [value, bucket, expected]
    [0, 2500, 0],
    [1, 2500, 0],
    [1249, 2500, 0],
    [1250, 2500, 2500], // exact half rounds up
    [1251, 2500, 2500],
    [2500, 2500, 2500],
    [3749, 2500, 2500],
    [3750, 2500, 5000], // exact half rounds up
    [22000, 2500, 22500],
    [12, 5, 10],
    [13, 5, 15],
    [12.5, 5, 15], // half up
  ])("(%d, bucket=%d) → %d", (value, bucket, expected) => {
    expect(roundToBucket(value, bucket)).toBe(expected);
  });

  it("rejects non-finite values and invalid buckets", () => {
    expect(() => roundToBucket(Number.NaN, 5)).toThrow();
    expect(() => roundToBucket(Infinity, 5)).toThrow();
    expect(() => roundToBucket(10, 0)).toThrow();
    expect(() => roundToBucket(10, -5)).toThrow();
    expect(() => roundToBucket(10, 2.5)).toThrow();
  });

  // Negative values: shared module, future callers may feed signed values.
  // Halves still round toward +Infinity, so negative half-buckets round
  // toward zero (NOT symmetric with the positive side).
  it("handles negative values with the same toward-+Infinity half rule", () => {
    expect(roundToBucket(-1, 2500) === 0).toBe(true); // JS -0, but -0 === 0
    expect(roundToBucket(-1249, 2500) === 0).toBe(true);
    expect(roundToBucket(-1250, 2500) === 0).toBe(true); // half → toward +∞ → 0
    expect(roundToBucket(-1251, 2500)).toBe(-2500);
    expect(roundToBucket(-3750, 2500)).toBe(-2500); // half → toward +∞
    expect(roundToBucket(-3751, 2500)).toBe(-5000);
    expect(roundToBucket(-5000, 2500)).toBe(-5000);
  });
});

describe("roundPercentToStep", () => {
  it.each([
    // [pct, step, expected]
    [0, 5, 0],
    [2, 5, 0],
    [2.4, 5, 0],
    [2.5, 5, 5], // half up
    [3, 5, 5],
    [7, 5, 5],
    [7.5, 5, 10],
    [50, 5, 50],
    [99, 5, 100],
    [100, 5, 100],
    [103, 5, 100], // clamped to 100
    [-3, 5, 0], // clamped to 0
  ])("(%d, step=%d) → %d", (pct, step, expected) => {
    expect(roundPercentToStep(pct, step)).toBe(expected);
  });
});

describe("topCode", () => {
  it.each([
    // [value, ceiling, expectedValue, expectedFlag]
    [100, 500, 100, false],
    [499, 500, 499, false],
    [500, 500, 500, false], // at the ceiling is NOT top-coded
    [501, 500, 500, true],
    [100000, 500, 500, true],
  ])("(%d, ceiling=%d) → %d topCoded=%s", (value, ceiling, ev, ef) => {
    expect(topCode(value, ceiling)).toStrictEqual({ value: ev, topCoded: ef });
  });
});

describe("toCountBand", () => {
  const bands = [20, 50] as const;

  it.each([
    // [n, expected]
    [0, "0"],
    [3, "3"],
    [19, "19"], // exact below the first band
    [20, "20+"], // boundary: first band
    [21, "20+"],
    [49, "20+"],
    [50, "50+"], // boundary: second band
    [51, "50+"],
    [5000, "50+"],
  ])("(%i) → %s", (n, expected) => {
    expect(toCountBand(n, bands)).toBe(expected);
  });

  it("with no bands, always shows the exact count", () => {
    expect(toCountBand(123, [])).toBe("123");
  });

  it("rejects negative/fractional counts and malformed bands", () => {
    expect(() => toCountBand(-1, bands)).toThrow();
    expect(() => toCountBand(1.5, bands)).toThrow();
    expect(() => toCountBand(5, [50, 20])).toThrow(); // not ascending
    expect(() => toCountBand(5, [0, 20])).toThrow(); // non-positive band
  });
});
