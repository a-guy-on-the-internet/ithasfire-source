import { describe, expect, it, vi } from "vitest";

import {
  TAXABLE_BASE_RULES,
  findTaxableBaseRule,
  isUnknownTaxableBaseSitus,
  reportUnknownTaxableBaseSitus,
  resolveTaxableBase,
} from "./taxable-base";

describe("TAXABLE_BASE_RULES — the table itself", () => {
  it("is exactly the four ruled jurisdictions, and TN + MN are the only BUYER_TOTAL rows", () => {
    expect(
      TAXABLE_BASE_RULES.map((rule) => ({
        countryCode: rule.countryCode,
        region: rule.region,
        base: rule.base,
      })),
    ).toEqual([
      { countryCode: "US", region: "TN", base: "BUYER_TOTAL" },
      { countryCode: "US", region: "MN", base: "BUYER_TOTAL" },
      { countryCode: "US", region: "FL", base: "TICKET_FACE" },
      { countryCode: "CA", region: null, base: "TICKET_FACE" },
    ]);

    expect(
      TAXABLE_BASE_RULES.filter((rule) => rule.base === "BUYER_TOTAL").map(
        (rule) => `${rule.countryCode}/${rule.region}`,
      ),
    ).toEqual(["US/TN", "US/MN"]);
  });

  it("every row carries a ruling note", () => {
    for (const rule of TAXABLE_BASE_RULES) {
      expect(rule.note.length).toBeGreaterThan(20);
    }
  });

  it("has no duplicate country/region rows (first-match would hide one)", () => {
    const keys = TAXABLE_BASE_RULES.map(
      (rule) => `${rule.countryCode}/${rule.region ?? "*"}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the FL row warns that bundling the fee into one price makes it taxable", () => {
    const florida = TAXABLE_BASE_RULES.find(
      (rule) => rule.countryCode === "US" && rule.region === "FL",
    );
    expect(florida?.note).toMatch(/separately stated/i);
    expect(florida?.note).toMatch(/bundl/i);
  });

  it("US/MN → BUYER_TOTAL, ruled (not flagged unknown), note cites RN 16-02 and FS 164M", () => {
    const mn = { countryCode: "US", region: "MN" };
    expect(resolveTaxableBase(mn)).toBe("BUYER_TOTAL");
    expect(isUnknownTaxableBaseSitus(mn, 903)).toBe(false);

    const minnesota = findTaxableBaseRule(mn);
    expect(minnesota?.note).toMatch(/16-02/);
    expect(minnesota?.note).toMatch(/164M/);
  });

  it("TEXAS IS DELIBERATELY ABSENT — a TX event must shout, not inherit a guess", () => {
    expect(
      TAXABLE_BASE_RULES.some(
        (rule) => rule.countryCode === "US" && rule.region === "TX",
      ),
    ).toBe(false);

    const tx = { countryCode: "US", region: "TX" };
    // Falls back to today's behaviour …
    expect(resolveTaxableBase(tx)).toBe("TICKET_FACE");
    // … AND is flagged, so the fallback is never silent.
    expect(isUnknownTaxableBaseSitus(tx, 825)).toBe(true);
  });
});

describe("resolveTaxableBase", () => {
  it("US/TN → BUYER_TOTAL", () => {
    expect(resolveTaxableBase({ countryCode: "US", region: "TN" })).toBe(
      "BUYER_TOTAL",
    );
  });

  it("US/FL → TICKET_FACE (separately-stated service charge is excluded)", () => {
    expect(resolveTaxableBase({ countryCode: "US", region: "FL" })).toBe(
      "TICKET_FACE",
    );
  });

  it("Canada resolves country-wide, whatever the province", () => {
    for (const region of ["AB", "ON", "QC", null]) {
      expect(resolveTaxableBase({ countryCode: "CA", region })).toBe(
        "TICKET_FACE",
      );
    }
  });

  it("normalises case and whitespace on both halves of the situs", () => {
    expect(resolveTaxableBase({ countryCode: "us", region: " tn " })).toBe(
      "BUYER_TOTAL",
    );
  });

  it("does NOT confuse US/CA (California) with CA (Canada)", () => {
    // The Canada row is country-wide; a California situs must not match it,
    // and must be reported as unruled rather than inheriting it.
    expect(findTaxableBaseRule({ countryCode: "US", region: "CA" })).toBeNull();
    expect(resolveTaxableBase({ countryCode: "US", region: "CA" })).toBe(
      "TICKET_FACE",
    );
    expect(
      isUnknownTaxableBaseSitus({ countryCode: "US", region: "CA" }, 862),
    ).toBe(true);
  });

  it("US with no region (postal-only situs) has no US-wide rule → TICKET_FACE", () => {
    expect(
      resolveTaxableBase({ countryCode: "US", region: null }),
    ).toBe("TICKET_FACE");
    expect(findTaxableBaseRule({ countryCode: "US", region: null })).toBeNull();
  });

  it("null / undefined / empty situs → TICKET_FACE", () => {
    expect(resolveTaxableBase(null)).toBe("TICKET_FACE");
    expect(resolveTaxableBase(undefined)).toBe("TICKET_FACE");
    expect(resolveTaxableBase({ countryCode: null, region: null })).toBe(
      "TICKET_FACE",
    );
  });
});

describe("isUnknownTaxableBaseSitus", () => {
  it("is false for a ruled jurisdiction at any rate", () => {
    expect(
      isUnknownTaxableBaseSitus({ countryCode: "US", region: "TN" }, 975),
    ).toBe(false);
    expect(
      isUnknownTaxableBaseSitus({ countryCode: "US", region: "MN" }, 903),
    ).toBe(false);
    expect(
      isUnknownTaxableBaseSitus({ countryCode: "US", region: "FL" }, 650),
    ).toBe(false);
    expect(
      isUnknownTaxableBaseSitus({ countryCode: "CA", region: "AB" }, 500),
    ).toBe(false);
  });

  it("is false when nothing is being collected — no liability, no Sentry noise", () => {
    for (const rateBps of [0, -1, Number.NaN]) {
      expect(
        isUnknownTaxableBaseSitus({ countryCode: "US", region: "TX" }, rateBps),
      ).toBe(false);
    }
    // A null situs at a zero rate is the ordinary "no location" order.
    expect(isUnknownTaxableBaseSitus(null, 0)).toBe(false);
  });

  it("is true for an unruled situs that IS collecting — including a null situs", () => {
    expect(
      isUnknownTaxableBaseSitus({ countryCode: "US", region: "NY" }, 888),
    ).toBe(true);
    expect(isUnknownTaxableBaseSitus(null, 888)).toBe(true);
  });
});

describe("reportUnknownTaxableBaseSitus", () => {
  it("reports with the convention's tags and the situs in the message", () => {
    const reportError = vi.fn();

    reportUnknownTaxableBaseSitus(reportError, {
      situs: { countryCode: "US", region: "TX" },
      rateBps: 825,
      extra: { eventId: "event-1", orderId: "order-1" },
    });

    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, context] = reportError.mock.calls[0]!;
    expect((err as Error).message).toBe("unknown_taxable_base_situs US/TX");
    expect(context).toEqual({
      tags: { area: "tax", step: "resolveTaxableBase" },
      extra: {
        eventId: "event-1",
        orderId: "order-1",
        situs: { countryCode: "US", region: "TX" },
        rateBps: 825,
      },
    });
  });

  it("labels a null situs rather than crashing on it", () => {
    const reportError = vi.fn();
    reportUnknownTaxableBaseSitus(reportError, { situs: null, rateBps: 888 });
    expect((reportError.mock.calls[0]![0] as Error).message).toBe(
      "unknown_taxable_base_situs ??/??",
    );
    expect(reportError.mock.calls[0]![1]!.extra!.situs).toBeNull();
  });

  it("a throwing reporter never reaches the caller (money must not depend on Sentry)", () => {
    expect(() =>
      reportUnknownTaxableBaseSitus(
        () => {
          throw new Error("sentry down");
        },
        { situs: { countryCode: "US", region: "TX" }, rateBps: 825 },
      ),
    ).not.toThrow();
  });

  it("no reporter wired → no-op", () => {
    expect(() =>
      reportUnknownTaxableBaseSitus(undefined, {
        situs: { countryCode: "US", region: "TX" },
        rateBps: 825,
      }),
    ).not.toThrow();
  });
});
