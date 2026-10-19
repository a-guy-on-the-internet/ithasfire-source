import { describe, it, expect } from "vitest";
import {
  isZeroDecimalCurrency,
  toMajorUnits,
  toMinorUnits,
  currencyFractionDigits,
  ZERO_DECIMAL_CURRENCIES,
} from "./currency-utils";

describe("isZeroDecimalCurrency", () => {
  it.each(["jpy", "krw", "vnd", "bif", "clp", "xaf"])(
    "returns true for %s",
    (c) => {
      expect(isZeroDecimalCurrency(c)).toBe(true);
    },
  );

  it("is case-insensitive", () => {
    expect(isZeroDecimalCurrency("JPY")).toBe(true);
    expect(isZeroDecimalCurrency("Jpy")).toBe(true);
  });

  it.each(["usd", "eur", "gbp", "cad", "aud", "brl"])(
    "returns false for %s",
    (c) => {
      expect(isZeroDecimalCurrency(c)).toBe(false);
    },
  );
});

describe("toMajorUnits", () => {
  it("divides by 100 for normal currencies", () => {
    expect(toMajorUnits(1000, "usd")).toBe(10);
    expect(toMajorUnits(50, "eur")).toBe(0.5);
  });

  it("is a no-op for zero-decimal currencies", () => {
    expect(toMajorUnits(500, "jpy")).toBe(500);
    expect(toMajorUnits(12000, "krw")).toBe(12000);
  });
});

describe("toMinorUnits", () => {
  it("multiplies by 100 for normal currencies", () => {
    expect(toMinorUnits(10, "usd")).toBe(1000);
    expect(toMinorUnits(0.5, "eur")).toBe(50);
  });

  it("rounds for normal currencies", () => {
    expect(toMinorUnits(10.999, "usd")).toBe(1100);
  });

  it("is a no-op (with rounding) for zero-decimal currencies", () => {
    expect(toMinorUnits(500, "jpy")).toBe(500);
    expect(toMinorUnits(500.4, "krw")).toBe(500);
  });
});

describe("currencyFractionDigits", () => {
  it("returns 0 for zero-decimal", () => {
    expect(currencyFractionDigits("jpy")).toBe(0);
  });

  it("returns 2 for normal currencies", () => {
    expect(currencyFractionDigits("usd")).toBe(2);
    expect(currencyFractionDigits("eur")).toBe(2);
  });
});

describe("ZERO_DECIMAL_CURRENCIES set", () => {
  it("contains all 16 Stripe zero-decimal currencies", () => {
    expect(ZERO_DECIMAL_CURRENCIES.size).toBe(16);
  });
});
