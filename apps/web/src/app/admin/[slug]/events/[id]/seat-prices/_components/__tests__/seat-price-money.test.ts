import { describe, expect, it } from "vitest";

import {
  MAX_CUSTOM_PRICE_CENTS,
  centsToInputValue,
  currencySymbolFor,
  parseCustomPriceInput,
} from "../seat-price-money";

describe("parseCustomPriceInput", () => {
  it.each([
    ["19.99", 1999],
    ["0.07", 7],
    ["0.1", 10],
    ["1.1", 110],
    ["4.35", 435],
    ["60", 6000],
    ["60.00", 6000],
    ["0", 0],
    ["0.00", 0],
    ["1500.00", 150000],
    ["1,500.00", 150000],
    [" 45.5 ", 4550],
    ["$60.00", 6000],
  ])("reads %j as %i cents with no float error", (raw, cents) => {
    expect(parseCustomPriceInput(raw)).toEqual({ ok: true, cents });
  });

  it("reports an empty field as empty, not as an error to show", () => {
    expect(parseCustomPriceInput("")).toEqual({ ok: false, reason: "empty" });
    expect(parseCustomPriceInput("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it.each(["-1", "-0.01", "-60.00"])("refuses the negative price %j", (raw) => {
    expect(parseCustomPriceInput(raw)).toEqual({ ok: false, reason: "negative" });
  });

  it.each(["19.9999", "0.001", "0.125", "1,500.005"])(
    "refuses %j, which has more than two decimal places",
    (raw) => {
      expect(parseCustomPriceInput(raw)).toEqual({
        ok: false,
        reason: "tooPrecise",
      });
    },
  );

  // Exactly three digits after a lone separator is the shared parser's
  // "thousands or decimals?" case ("19.999" is nineteen thousand in es), so
  // it is refused as ambiguous before the decimal count is ever looked at.
  it.each(["1,500", "19.999", "60.000"])(
    "refuses %j, whose separator could mean thousands or decimals",
    (raw) => {
      expect(parseCustomPriceInput(raw)).toEqual({
        ok: false,
        reason: "ambiguous",
      });
    },
  );

  it.each(["abc", "12abc", "1.2.3.4x", "--5"])("refuses %j as not a price", (raw) => {
    const result = parseCustomPriceInput(raw);
    expect(result.ok).toBe(false);
  });
  it("refuses a price above what the write can store, and takes the cap itself", () => {
    expect(parseCustomPriceInput("21474836.47")).toEqual({
      ok: true,
      cents: MAX_CUSTOM_PRICE_CENTS,
    });
    expect(parseCustomPriceInput("21474836.48")).toEqual({
      ok: false,
      reason: "tooLarge",
    });
    expect(parseCustomPriceInput("99999999999")).toEqual({
      ok: false,
      reason: "tooLarge",
    });
  });

  it("matches core's MAX_SEAT_PRICE_OVERRIDE_CENTS (Postgres INT4)", () => {
    expect(MAX_CUSTOM_PRICE_CENTS).toBe(2 ** 31 - 1);
  });
});

describe("centsToInputValue", () => {
  it.each([
    [1999, "19.99"],
    [6000, "60.00"],
    [7, "0.07"],
    [0, "0.00"],
    [150000, "1500.00"],
    [435, "4.35"],
  ])("writes %i cents as %j", (cents, text) => {
    expect(centsToInputValue(cents)).toBe(text);
  });

  it("round-trips through the parser", () => {
    for (const cents of [0, 1, 9, 10, 99, 100, 435, 1999, 100000, 2147483647]) {
      expect(parseCustomPriceInput(centsToInputValue(cents))).toEqual({
        ok: true,
        cents,
      });
    }
  });

  it("writes nothing for a value that is not whole, non-negative cents", () => {
    expect(centsToInputValue(-1)).toBe("");
    expect(centsToInputValue(19.5)).toBe("");
    expect(centsToInputValue(Number.NaN)).toBe("");
  });
});

describe("currencySymbolFor", () => {
  it("gives the narrow symbol for a known currency, in either case", () => {
    expect(currencySymbolFor("usd")).toBe("$");
    expect(currencySymbolFor("CAD")).toBe("$");
    expect(currencySymbolFor("eur")).toBe("€");
  });

  it("falls back to the code for a currency Intl does not know", () => {
    expect(currencySymbolFor("not-a-code")).toBe("NOT-A-CODE");
  });
});
