import { describe, expect, it } from "vitest";

import {
  CANADA_GST_HST_BPS,
  CANADA_TAX_RATE_SOURCE,
  provinceFromCanadianPostalCode,
  resolveCanadaGstHst,
} from "../canada-rates";

describe("canada-rates", () => {
  it("Alberta resolves to a flat 5% GST (500 bps)", () => {
    expect(resolveCanadaGstHst({ region: "AB", postalCode: null })).toEqual({
      province: "AB",
      rateBps: 500,
    });
    expect(CANADA_GST_HST_BPS.AB).toBe(500);
    expect(CANADA_TAX_RATE_SOURCE).toBe("ca_gst_hst");
  });

  it("lower-case region is normalized", () => {
    expect(resolveCanadaGstHst({ region: "ab", postalCode: null })).toEqual({
      province: "AB",
      rateBps: 500,
    });
  });

  it("a PST/QST province (BC) is intentionally unsupported: province resolved, rate null", () => {
    // Charging only the 5% GST would UNDER-collect the missing PST, so the map
    // omits BC and the caller must warn + collect nothing rather than guess.
    const r = resolveCanadaGstHst({ region: "BC", postalCode: null });
    expect(r.province).toBe("BC");
    expect(r.rateBps).toBeNull();
  });

  it("unknown region → province echoed, rate null; no region/postal → both null", () => {
    expect(resolveCanadaGstHst({ region: "ZZ", postalCode: null })).toEqual({
      province: "ZZ",
      rateBps: null,
    });
    expect(resolveCanadaGstHst({ region: null, postalCode: null })).toEqual({
      province: null,
      rateBps: null,
    });
  });

  it("falls back to postal-code first letter when region is blank (T → AB)", () => {
    expect(provinceFromCanadianPostalCode("T5J 3N9")).toBe("AB");
    expect(resolveCanadaGstHst({ region: null, postalCode: "T5J3N9" })).toEqual({
      province: "AB",
      rateBps: 500,
    });
  });

  it("returns null province for non-Canadian / empty postal codes", () => {
    expect(provinceFromCanadianPostalCode("33901")).toBeNull();
    expect(provinceFromCanadianPostalCode("")).toBeNull();
    expect(provinceFromCanadianPostalCode(null)).toBeNull();
  });
});
