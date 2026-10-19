/**
 * TAX IMPOSITIONS — every tax an admission owes, one line each.
 *
 * An admission can owe more than one tax, and each has its own rate, its own
 * taxable base and its own collector: Chicago's amusement tax on top of
 * Illinois/Cook sales tax, Denver's seat tax at city-owned venues, Seattle's
 * admissions tax, Minneapolis's citywide entertainment tax. ZipTax (the source
 * of the stamped `Event.admissionTaxRateBps`) is a SALES-tax lookup and cannot
 * see any of them.
 *
 * So the model is a LIST. {@link resolveTaxImpositions} derives it from:
 *
 *  - the stamped sales-tax rate → the `SALES` line, whose base is
 *    `resolveTaxableBase(situs)` (the one base table — not duplicated here);
 *  - {@link LOCAL_TAX_IMPOSITION_RULES} → any local impositions for the situs.
 *
 * Like the taxable base, the list is DERIVED from the live situs at charge time
 * (owner ruling 2026-09-28): nothing is stamped on the Event. What an ORDER was
 * actually charged is persisted line by line as `OrderTaxLine` rows.
 *
 * `collector` decides who owes the money to the jurisdiction:
 *  - `PLATFORM`  — we collect it from the buyer and remit (the sales tax today,
 *                  as marketplace facilitator; charges run on the platform's
 *                  Stripe account). Part of `Order.taxAmountCents`.
 *  - `ORGANISER` — the duty sits on the venue / promoter. Recorded on the order
 *                  for disclosure, NOT added to the buyer's charge.
 *
 * Pure and dependency-free (same pattern as `taxable-base.ts`).
 */

import {
  resolveTaxableBase,
  type TaxableBase,
  type TaxableBaseSitus,
} from "./taxable-base";

/** Who owes an imposition to the jurisdiction. */
export type TaxCollector = "PLATFORM" | "ORGANISER";

/** One tax an admission owes. The unit the solver and `OrderTaxLine` share. */
export type TaxImposition = {
  /** Stable machine code: "SALES", "CHI_AMUSEMENT", … Persisted; never rename. */
  code: string;
  /** Human name for receipts / remittance reports. */
  label: string;
  /** "US/TN", "US/IL/Chicago", … ("UNKNOWN" when the situs did not resolve). */
  jurisdiction: string;
  /** Rate in basis points. Always > 0 on a resolved line. */
  rateBps: number;
  /** What the rate applies to (see `taxable-base.ts`). */
  base: TaxableBase;
  collector: TaxCollector;
};

/** The situs shape the resolver needs — `TaxSitus` satisfies it structurally. */
export type TaxImpositionSitus =
  | (NonNullable<TaxableBaseSitus> & { postalCode?: string | null })
  | null
  | undefined;

/**
 * One row of the local-imposition table.
 *
 * A row applies when the situs country matches, the region matches (or the row
 * is country-wide, `region: null`), and — when `postalCodes` is a list — the
 * situs postal code is in it. Situs carries no city, so a CITY tax is keyed on
 * its ZIP list.
 *
 * ROOM FOR A VENUE PREDICATE: some local taxes depend on the venue, not just
 * the address — Denver's seat tax applies only at city-OWNED venues. That needs
 * a venue attribute we do not model yet. When it exists, add a predicate field
 * here and check it in `ruleApplies`; until then do NOT add a row whose
 * applicability depends on one (it would charge every venue in the ZIP list).
 */
export type LocalTaxImpositionRule = {
  code: string;
  label: string;
  jurisdiction: string;
  /** ISO-3166-1 alpha-2, uppercase. */
  countryCode: string;
  /** Uppercase state/province code, or null for the whole country. */
  region: string | null;
  /** 5-digit ZIPs / postal codes the rule covers, or null for the whole region. */
  postalCodes: ReadonlyArray<string> | null;
  rateBps: number;
  base: TaxableBase;
  collector: TaxCollector;
  /**
   * Whether the rule applies to a RESALE (a secondary sale of an already-issued
   * ticket) as well as a primary sale. REQUIRED, so every row states it; a
   * resale skips any row that is not explicitly `true`.
   */
  appliesToResale: boolean;
  /** Citation (ordinance / ruling URL). REQUIRED — see the table's doc comment. */
  source: string;
};

/** Primary sale (an organiser's ticket) or resale (an attendee reselling one). */
export type TaxSaleKind = "PRIMARY" | "RESALE";

/**
 * Local impositions on top of the sales tax.
 *
 * A row here charges real buyers (a PLATFORM row) or tells an organiser what
 * they owe (an ORGANISER row). Add a row ONLY with a cited `source` — the
 * ordinance or a ruling — and a test pinning it (`tax-impositions.test.ts`).
 * Getting the base right matters as much as the rate: several of these are
 * levied on the full ticket charge, some on the face, and some put the duty on
 * the venue rather than the seller. The Chicago / Denver / Seattle rates we
 * have are research notes, not verified figures, so they are NOT here.
 *
 * Research (not legal advice): memory `project_tax_base_is_jurisdictional`.
 */
export const LOCAL_TAX_IMPOSITION_RULES: ReadonlyArray<LocalTaxImpositionRule> =
  [
    {
      // Persisted on OrderTaxLine.code — never rename.
      code: "MPLS_ENTERTAINMENT",
      label: "Minneapolis entertainment tax",
      jurisdiction: "US/MN/Minneapolis",
      countryCode: "US",
      region: "MN",
      // Situs carries no city, so the city is its ZIP list. Census 2020 ZCTAs
      // that intersect Minneapolis (place GEOID 2743000); PO-box ZIPs excluded.
      postalCodes: [
        // Inside the city.
        "55401", "55402", "55403", "55404", "55405", "55406", "55407",
        "55408", "55409", "55411", "55412", "55413", "55414", "55415",
        "55417", "55419", "55454", "55455",
        // Straddle the city limit. Charged per owner ruling 2026-10-05 ("Feels
        // like we should charge it" when city limits are unclear).
        "55410", "55416", "55418", "55421", "55423", "55430", "55450",
      ],
      rateBps: 300,
      // Levied on admission. We sell no delivery; the ordinance excludes
      // convenience fees, so the platform / processing fees are not in the base.
      base: "TICKET_FACE",
      collector: "PLATFORM",
      // Owner ruling 2026-10-05: "Assume not. We will seek counsel later."
      // Not charged on resale until counsel says otherwise.
      appliesToResale: false,
      source:
        "3% Minneapolis Entertainment Tax, applies city wide: MN Revenue Fact " +
        'Sheet 164M "Local Sales and Use Taxes", rev. Feb 2025 (the URL ' +
        "revenue.state.mn.us/sites/default/files/2023-01/fs164m.pdf returned " +
        "404 on 2026-10-05). Ticketmaster v. Commissioner of Revenue (Minn. " +
        "Tax Ct. 2008-03-06). ZIP list: Census 2020 " +
        "ZCTA-place relationship file, place GEOID 2743000 " +
        "(https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_place20_natl.txt), " +
        "cross-checked with MN Revenue's Q4-2026 ZIP+4 file " +
        "(https://www.revenue.state.mn.us/sites/default/files/2026-08/mn-zip-code-search-2026q4.xlsx); PO-box ZIPs " +
        "excluded. Owner rulings 2026-10-05: charge ZIPs straddling the city " +
        "limit; not on resale (counsel pending).",
    },
  ];

const SALES_CODE = "SALES";

function normalise(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toUpperCase();
  return trimmed ? trimmed : null;
}

/** US ZIP+4 → 5-digit ZIP; other postal codes lose their internal spaces. */
function normalisePostal(
  countryCode: string | null,
  postal: string | null | undefined,
): string | null {
  const value = normalise(postal)?.replace(/\s+/g, "") ?? null;
  if (!value) return null;
  return countryCode === "US" ? value.slice(0, 5) : value;
}

function ruleApplies(
  rule: LocalTaxImpositionRule,
  countryCode: string | null,
  region: string | null,
  postal: string | null,
): boolean {
  if (rule.countryCode !== countryCode) return false;
  if (rule.region !== null && rule.region !== region) return false;
  if (rule.postalCodes !== null) {
    if (!postal) return false;
    const wanted = rule.postalCodes.map((code) =>
      normalisePostal(countryCode, code),
    );
    if (!wanted.includes(postal)) return false;
  }
  return true;
}

function taxesAtRate(rateBps: number): boolean {
  return Number.isFinite(rateBps) && rateBps > 0;
}

/**
 * Every imposition an admission at `situs` owes, SALES first.
 *
 * - SALES appears iff `salesTaxRateBps > 0`; its base is
 *   `resolveTaxableBase(situs)`, so the unknown-situs rule (and its reporting at
 *   the checkout resolver) is unchanged.
 * - Local rows appear iff they match the situs and carry a positive rate. They
 *   are independent of the sales rate — a sales exemption does not exempt a
 *   city amusement tax.
 * - `sale: "RESALE"` drops every local row whose `appliesToResale` is not
 *   `true`. Omitted means PRIMARY. The SALES line is the same either way.
 *
 * `rules` is a test seam; production passes nothing and gets the shipped table.
 */
export function resolveTaxImpositions(
  args: {
    situs: TaxImpositionSitus;
    salesTaxRateBps: number;
    sale?: TaxSaleKind;
  },
  rules: ReadonlyArray<LocalTaxImpositionRule> = LOCAL_TAX_IMPOSITION_RULES,
): TaxImposition[] {
  const { situs, salesTaxRateBps } = args;
  const isResale = args.sale === "RESALE";
  const countryCode = normalise(situs?.countryCode);
  const region = normalise(situs?.region);
  const postal = normalisePostal(countryCode, situs?.postalCode);

  const lines: TaxImposition[] = [];

  if (taxesAtRate(salesTaxRateBps)) {
    lines.push({
      code: SALES_CODE,
      label: countryCode === "CA" ? "GST/HST" : "Sales tax",
      jurisdiction: countryCode
        ? region
          ? `${countryCode}/${region}`
          : countryCode
        : "UNKNOWN",
      rateBps: salesTaxRateBps,
      base: resolveTaxableBase(situs),
      collector: "PLATFORM",
    });
  }

  for (const rule of rules) {
    if (!taxesAtRate(rule.rateBps)) continue;
    if (isResale && rule.appliesToResale !== true) continue;
    if (!ruleApplies(rule, countryCode, region, postal)) continue;
    lines.push({
      code: rule.code,
      label: rule.label,
      jurisdiction: rule.jurisdiction,
      rateBps: rule.rateBps,
      base: rule.base,
      collector: rule.collector,
    });
  }

  return lines;
}
