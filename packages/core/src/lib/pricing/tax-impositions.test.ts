import { describe, expect, it } from "vitest";

import {
  LOCAL_TAX_IMPOSITION_RULES,
  resolveTaxImpositions,
  type LocalTaxImpositionRule,
} from "./tax-impositions";
import { resolveTaxableBase } from "./taxable-base";

const NASHVILLE = { countryCode: "US", region: "TN", postalCode: "37203" };
const CHICAGO = { countryCode: "US", region: "IL", postalCode: "60614" };
const DENVER = { countryCode: "US", region: "CO", postalCode: "80202" };

/**
 * Test-only rows. None of these rates is verified (so none ships) — they exist
 * to prove a second line flows end to end.
 */
const CHI_AMUSEMENT_FIXTURE: LocalTaxImpositionRule = {
  code: "CHI_AMUSEMENT",
  label: "Chicago amusement tax",
  jurisdiction: "US/IL/Chicago",
  countryCode: "US",
  region: "IL",
  postalCodes: ["60614", "60601"],
  rateBps: 900,
  base: "BUYER_TOTAL",
  collector: "PLATFORM",
  appliesToResale: true,
  source: "TEST FIXTURE — not a real citation",
};

const ORGANISER_FIXTURE: LocalTaxImpositionRule = {
  code: "DEN_SEAT",
  label: "Denver seat tax",
  jurisdiction: "US/CO/Denver",
  countryCode: "US",
  region: "CO",
  postalCodes: null,
  rateBps: 1000,
  base: "TICKET_FACE",
  collector: "ORGANISER",
  appliesToResale: true,
  source: "TEST FIXTURE — not a real citation",
};

describe("resolveTaxImpositions", () => {
  it("ships exactly ONE local row: the Minneapolis entertainment tax, every field pinned", () => {
    // This row charges real buyers. Any change to it must change this test.
    expect(LOCAL_TAX_IMPOSITION_RULES).toHaveLength(1);
    const [mpls] = LOCAL_TAX_IMPOSITION_RULES;
    expect(mpls).toEqual({
      code: "MPLS_ENTERTAINMENT",
      label: "Minneapolis entertainment tax",
      jurisdiction: "US/MN/Minneapolis",
      countryCode: "US",
      region: "MN",
      postalCodes: [
        "55401", "55402", "55403", "55404", "55405", "55406", "55407",
        "55408", "55409", "55411", "55412", "55413", "55414", "55415",
        "55417", "55419", "55454", "55455",
        "55410", "55416", "55418", "55421", "55423", "55430", "55450",
      ],
      rateBps: 300,
      base: "TICKET_FACE",
      collector: "PLATFORM",
      appliesToResale: false,
      source: expect.any(String),
    });
    expect(mpls!.postalCodes).toHaveLength(25);
    expect(new Set(mpls!.postalCodes).size).toBe(25);
    expect(mpls!.source.trim()).not.toBe("");
    // The citation names every source the row stands on.
    for (const cite of [
      "164M",
      "rev. Feb 2025",
      "Ticketmaster v. Commissioner of Revenue",
      "Minn. Tax Ct. 2008-03-06",
      "2743000",
      "tab20_zcta520_place20_natl.txt",
      "mn-zip-code-search-2026q4.xlsx",
      "2026-10-05",
    ]) {
      expect(mpls!.source).toContain(cite);
    }
  });

  it("every local rule is well-formed: integer positive rate, a real citation", () => {
    // `OrderTaxLine.rateBps` is an Int column and the fee-rates payload
    // requires a positive integer — a fractional row would fail checkout.
    for (const rule of LOCAL_TAX_IMPOSITION_RULES) {
      expect(Number.isInteger(rule.rateBps) && rule.rateBps > 0).toBe(true);
      expect(rule.source.trim()).not.toBe("");
      expect(rule.code).not.toBe("SALES");
    }
  });

  it("yields exactly one SALES line at the stamped rate, collected by the platform", () => {
    expect(
      resolveTaxImpositions({
        situs: { countryCode: "US", region: "GA", postalCode: "30303" },
        salesTaxRateBps: 890,
      }),
    ).toEqual([
      {
        code: "SALES",
        label: "Sales tax",
        jurisdiction: "US/GA",
        rateBps: 890,
        base: "TICKET_FACE",
        collector: "PLATFORM",
      },
    ]);
  });

  it("takes the SALES base from resolveTaxableBase — TN is BUYER_TOTAL", () => {
    const [sales] = resolveTaxImpositions({
      situs: NASHVILLE,
      salesTaxRateBps: 925,
    });
    expect(sales?.base).toBe("BUYER_TOTAL");
    expect(sales?.base).toBe(resolveTaxableBase(NASHVILLE));
    expect(sales?.jurisdiction).toBe("US/TN");
  });

  it("zero / negative / non-finite rate with no local rule → no lines at all", () => {
    for (const salesTaxRateBps of [0, -1, Number.NaN]) {
      expect(
        resolveTaxImpositions({ situs: NASHVILLE, salesTaxRateBps }),
      ).toEqual([]);
    }
  });

  it("a null situs still carries a stamped rate (face base, UNKNOWN jurisdiction)", () => {
    expect(
      resolveTaxImpositions({ situs: null, salesTaxRateBps: 700 }),
    ).toEqual([
      expect.objectContaining({
        code: "SALES",
        jurisdiction: "UNKNOWN",
        base: "TICKET_FACE",
        rateBps: 700,
      }),
    ]);
  });

  it("labels Canadian sales tax GST/HST", () => {
    const [sales] = resolveTaxImpositions({
      situs: { countryCode: "CA", region: "AB", postalCode: "T2P 1J9" },
      salesTaxRateBps: 500,
    });
    expect(sales?.label).toBe("GST/HST");
  });

  it("SALES + an injected local PLATFORM line, in that order", () => {
    expect(
      resolveTaxImpositions(
        { situs: CHICAGO, salesTaxRateBps: 1025 },
        [CHI_AMUSEMENT_FIXTURE],
      ),
    ).toEqual([
      {
        code: "SALES",
        label: "Sales tax",
        jurisdiction: "US/IL",
        rateBps: 1025,
        base: "TICKET_FACE",
        collector: "PLATFORM",
      },
      {
        code: "CHI_AMUSEMENT",
        label: "Chicago amusement tax",
        jurisdiction: "US/IL/Chicago",
        rateBps: 900,
        base: "BUYER_TOTAL",
        collector: "PLATFORM",
      },
    ]);
  });

  it("a local line applies even when the sales rate is 0 (independent impositions)", () => {
    expect(
      resolveTaxImpositions(
        { situs: CHICAGO, salesTaxRateBps: 0 },
        [CHI_AMUSEMENT_FIXTURE],
      ).map((line) => line.code),
    ).toEqual(["CHI_AMUSEMENT"]);
  });

  it("postal list gates a local rule: same state, other ZIP → SALES only", () => {
    expect(
      resolveTaxImpositions(
        {
          situs: { countryCode: "US", region: "IL", postalCode: "62701" },
          salesTaxRateBps: 900,
        },
        [CHI_AMUSEMENT_FIXTURE],
      ).map((line) => line.code),
    ).toEqual(["SALES"]);
  });

  it("matches a ZIP+4 and case/whitespace-normalised situs", () => {
    expect(
      resolveTaxImpositions(
        {
          situs: { countryCode: " us ", region: "il", postalCode: "60614-1234" },
          salesTaxRateBps: 0,
        },
        [CHI_AMUSEMENT_FIXTURE],
      ).map((line) => line.code),
    ).toEqual(["CHI_AMUSEMENT"]);
  });

  it("sale: RESALE drops a local row that does not apply to resale; SALES is unaffected", () => {
    const rule = { ...CHI_AMUSEMENT_FIXTURE, appliesToResale: false };
    expect(
      resolveTaxImpositions(
        { situs: CHICAGO, salesTaxRateBps: 1025, sale: "RESALE" },
        [rule],
      ).map((line) => line.code),
    ).toEqual(["SALES"]);
    // …and keeps one that does.
    expect(
      resolveTaxImpositions(
        { situs: CHICAGO, salesTaxRateBps: 1025, sale: "RESALE" },
        [CHI_AMUSEMENT_FIXTURE],
      ).map((line) => line.code),
    ).toEqual(["SALES", "CHI_AMUSEMENT"]);
    // Omitted sale = PRIMARY = the row applies.
    expect(
      resolveTaxImpositions({ situs: CHICAGO, salesTaxRateBps: 1025 }, [rule]).map(
        (line) => line.code,
      ),
    ).toEqual(["SALES", "CHI_AMUSEMENT"]);
  });

  it("carries an ORGANISER line through with its collector (the solver decides it is not charged)", () => {
    const lines = resolveTaxImpositions(
      { situs: DENVER, salesTaxRateBps: 0 },
      [ORGANISER_FIXTURE],
    );
    expect(lines).toEqual([
      expect.objectContaining({ code: "DEN_SEAT", collector: "ORGANISER" }),
    ]);
  });

  it("a zero-rate local row yields nothing", () => {
    expect(
      resolveTaxImpositions(
        { situs: CHICAGO, salesTaxRateBps: 0 },
        [{ ...CHI_AMUSEMENT_FIXTURE, rateBps: 0 }],
      ),
    ).toEqual([]);
  });
});

describe("resolveTaxImpositions — the shipped Minneapolis entertainment tax", () => {
  const MN_SALES_BPS = 903; // 6.875% state + 2.15% local general sales tax
  const mn = (postalCode: string | null) => ({
    countryCode: "US",
    region: "MN",
    postalCode,
  });
  const codes = (
    situs: Parameters<typeof resolveTaxImpositions>[0]["situs"],
    sale?: "PRIMARY" | "RESALE",
  ) =>
    resolveTaxImpositions({ situs, salesTaxRateBps: MN_SALES_BPS, sale }).map(
      (line) => line.code,
    );

  it("PRIMARY at 55403: SALES first, then a 3% face-based platform line", () => {
    expect(
      resolveTaxImpositions({
        situs: mn("55403"),
        salesTaxRateBps: MN_SALES_BPS,
        sale: "PRIMARY",
      }),
    ).toEqual([
      {
        code: "SALES",
        label: "Sales tax",
        jurisdiction: "US/MN",
        rateBps: MN_SALES_BPS,
        // Minnesota's sales base (676c342d0) — the ent. tax does not change it.
        base: "BUYER_TOTAL",
        collector: "PLATFORM",
      },
      {
        code: "MPLS_ENTERTAINMENT",
        label: "Minneapolis entertainment tax",
        jurisdiction: "US/MN/Minneapolis",
        rateBps: 300,
        base: "TICKET_FACE",
        collector: "PLATFORM",
      },
    ]);
  });

  it("omitting `sale` is PRIMARY", () => {
    expect(codes(mn("55403"))).toEqual(["SALES", "MPLS_ENTERTAINMENT"]);
  });

  it("matches a ZIP+4 and a ZIP with surrounding whitespace", () => {
    expect(codes(mn("55403-1234"))).toEqual(["SALES", "MPLS_ENTERTAINMENT"]);
    expect(codes(mn("55403 "))).toEqual(["SALES", "MPLS_ENTERTAINMENT"]);
  });

  it("charges a straddling ZIP (owner ruling 2026-10-05)", () => {
    expect(codes(mn("55416"))).toEqual(["SALES", "MPLS_ENTERTAINMENT"]);
  });

  it("does not match Bloomington (55420) or Maple Grove (55311)", () => {
    expect(codes(mn("55420"))).toEqual(["SALES"]);
    expect(codes(mn("55311"))).toEqual(["SALES"]);
  });

  it("does not match 55403 in another state", () => {
    expect(
      codes({ countryCode: "US", region: "WI", postalCode: "55403" }),
    ).toEqual(["SALES"]);
  });

  it("RESALE at 55403 → SALES only (owner ruling 2026-10-05, counsel pending)", () => {
    expect(codes(mn("55403"), "RESALE")).toEqual(["SALES"]);
  });

  it("no postal code → no Minneapolis line (current behaviour; owner Q4 open)", () => {
    expect(codes(mn(null))).toEqual(["SALES"]);
    expect(codes(mn(""))).toEqual(["SALES"]);
  });
});
