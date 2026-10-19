/**
 * Jurisdictional TAXABLE BASE for admission tax.
 *
 * The rate is not the only thing a jurisdiction decides — it also decides WHAT
 * the rate applies to. Two answers matter to us:
 *
 *  - `TICKET_FACE`  — tax the (post-discount) admission price only. Fees passed
 *                     to the buyer sit outside the base. This is what every
 *                     call site did unconditionally before this table existed.
 *  - `BUYER_TOTAL`  — tax everything the buyer pays for admission: face +
 *                     platform fee + processing fee, whether or not those are
 *                     separately stated.
 *
 * Tennessee is `BUYER_TOTAL`: a 2019 TN ruling on online ticketing puts
 * platform and processing fees passed through to the buyer inside the taxable
 * admission charge whether or not they are itemised. Charging TN tax on the
 * face alone under-collects `rate × (platformFee + processorFee)` on every
 * taxable pass-through sale (~15¢ on a $25 Nashville ticket).
 *
 * Minnesota (US/MN) is `BUYER_TOTAL` for the same reason as TN (owner ruling
 * 2026-10-05): MN Revenue Notice 16-02 puts every charge the seller requires
 * for admission inside the sales price, and Fact Sheet 164M says "the entire
 * charge, including the convenience fee, is subject to the rest of the
 * applicable taxes" (state and local general sales tax). The Minneapolis 3%
 * Entertainment Tax is a separate local tax on face (+delivery) only and is NOT
 * part of that row.
 *
 * ── The unknown path shouts ──────────────────────────────────────────────────
 * A situs that is NOT in {@link TAXABLE_BASE_RULES} resolves to `TICKET_FACE`
 * so nothing silently changes price — but when it also carries a NON-ZERO rate
 * that silence is a liability, so the caller must report it
 * ({@link isUnknownTaxableBaseSitus} / {@link reportUnknownTaxableBaseSitus}).
 *
 * **Deliberately absent:** US/NY (concerts exempt, comedy/variety unresolved),
 * US/TX (unconfirmed), US/GA, US/NC and Chicago (research says mandatory fees
 * are taxable either way, but "probably" is not a ruling), and US/CA / US/CO
 * (no state-level admission tax at all — a non-zero stamped rate there is
 * itself worth a look). Each must hit the unknown path and shout rather than
 * inherit a guess. Add a row here ONLY with a ruling behind it.
 *
 * Research: memory `project_tax_base_is_jurisdictional` (2026-09-22; MN
 * researched and ruled 2026-10-05). Research, not legal advice.
 */

import type { ReporterPort } from "@th/ports/reporter";

/** What a jurisdiction applies its admission tax rate to. */
export type TaxableBase = "TICKET_FACE" | "BUYER_TOTAL";

/**
 * The minimal situs shape the base resolver needs — `TaxSitus`
 * (`use-cases/events/_shared/resolve-event-tax-rate`) satisfies it
 * structurally, so this file stays pure and dependency-free (same pattern as
 * `lib/tax/instruction-exemption.ts`).
 */
export type TaxableBaseSitus =
  | { countryCode: string | null; region: string | null }
  | null
  | undefined;

/**
 * One row of the base table. `region: null` means the rule covers the whole
 * country; a region-specific row always wins over its country row.
 */
export type TaxableBaseRule = {
  /** ISO-3166-1 alpha-2, uppercase. */
  countryCode: string;
  /** Uppercase two-letter state/province, or null for "whole country". */
  region: string | null;
  base: TaxableBase;
  /** Why — kept in the table so the ruling travels with the rule. */
  note: string;
};

/**
 * The taxable-base table. Exported so a test can assert every entry and prove
 * which jurisdictions are deliberately absent.
 */
export const TAXABLE_BASE_RULES: ReadonlyArray<TaxableBaseRule> = [
  {
    countryCode: "US",
    region: "TN",
    base: "BUYER_TOTAL",
    note: "2019 TN ruling on online ticketing: platform + processing fees passed to the buyer are part of the taxable admission charge whether or not separately stated.",
  },
  {
    countryCode: "US",
    region: "MN",
    base: "BUYER_TOTAL",
    note:
      "MN Revenue Notice 16-02: every charge the seller requires to purchase admission is part of the sales price; Fact Sheet 164M (rev. Feb 2025): \"the entire charge, including the convenience fee, is subject to the rest of the applicable taxes\" (state and local general sales tax) (owner ruling 2026-10-05). " +
      "NOT this row: the Minneapolis 3% Entertainment Tax is a separate local tax on face (+delivery) only, never convenience fees.",
  },
  {
    countryCode: "US",
    region: "FL",
    base: "TICKET_FACE",
    note:
      "FL excludes a ticketing SERVICE CHARGE from the taxable admission price when it is separately stated on top of a stated ticket price — so face-only is correct WHILE WE ITEMISE. " +
      "WARNING: bundling the fee into one all-in price would make it taxable in Florida (~6.5% of the fee). If the one-price model ships, Florida must stay itemised or this row becomes BUYER_TOTAL.",
  },
  {
    countryCode: "CA",
    region: null,
    base: "TICKET_FACE",
    note: "Canada: GST/HST applies to the organiser's admission charge, which we collect as billing agent. Our fee to the organiser is a SEPARATE taxable supply, not part of the admission base.",
  },
] as const;

/**
 * Resolve the taxable base for a situs. Unknown / absent situs → `TICKET_FACE`
 * (today's behaviour, so nothing silently reprices). Pair with
 * {@link isUnknownTaxableBaseSitus} at any site that charges money.
 */
export function resolveTaxableBase(situs: TaxableBaseSitus): TaxableBase {
  return findTaxableBaseRule(situs)?.base ?? "TICKET_FACE";
}

/**
 * The matching rule, or null when the jurisdiction has no ruling in the table.
 * Region-specific rows beat the country-wide row.
 */
export function findTaxableBaseRule(
  situs: TaxableBaseSitus,
): TaxableBaseRule | null {
  const countryCode = situs?.countryCode?.trim().toUpperCase() || null;
  if (!countryCode) return null;
  const region = situs?.region?.trim().toUpperCase() || null;

  const inCountry = TAXABLE_BASE_RULES.filter(
    (rule) => rule.countryCode === countryCode,
  );
  if (inCountry.length === 0) return null;

  if (region) {
    const exact = inCountry.find((rule) => rule.region === region);
    if (exact) return exact;
  }
  return inCountry.find((rule) => rule.region === null) ?? null;
}

/**
 * Does this situs collect tax under a base we have NOT ruled on?
 *
 * True only when the rate is non-zero — a 0-rate situs collects nothing, so
 * there is no liability to shout about and no Sentry noise to create.
 */
export function isUnknownTaxableBaseSitus(
  situs: TaxableBaseSitus,
  rateBps: number,
): boolean {
  if (!Number.isFinite(rateBps) || rateBps <= 0) return false;
  return findTaxableBaseRule(situs) === null;
}

/** Sentry tag/extra shape for an unruled taxable base. */
export type UnknownTaxableBaseContext = {
  situs: TaxableBaseSitus;
  rateBps: number;
  /** Extra breadcrumbs from the caller (eventId, orderId, use case …). */
  extra?: Record<string, unknown>;
};

/**
 * Report a taxing situs with no base ruling, per the project's ReporterPort
 * convention (CLAUDE.md): this IS a deliberate swallow — we keep charging
 * `TICKET_FACE` rather than blocking the sale — so it has to reach Sentry
 * explicitly.
 *
 * CALL ONCE PER TAX RESOLUTION, never per ticket line. That is once per
 * `resolveCheckoutTax`, which is coarser than per ticket but NOT once per
 * purchase: a buyer who edits their cart three times before paying resolves tax
 * four times, so one US/TX sale emits four reports. Acceptable, because the
 * Error message carries the situs and Sentry groups one ISSUE per jurisdiction —
 * the signal is "TX is unruled", and its event count is not a sale count.
 *
 * The Error message carries the situs so Sentry groups one issue per
 * jurisdiction instead of one firehose. Guarded: a throwing reporter can never
 * change the price.
 */
export function reportUnknownTaxableBaseSitus(
  reportError: ReporterPort | undefined,
  context: UnknownTaxableBaseContext,
): void {
  if (!reportError) return;
  const situsLabel = `${context.situs?.countryCode ?? "??"}/${
    context.situs?.region ?? "??"
  }`;
  try {
    reportError(
      new Error(`unknown_taxable_base_situs ${situsLabel}`),
      {
        tags: { area: "tax", step: "resolveTaxableBase" },
        extra: {
          ...context.extra,
          situs: context.situs ?? null,
          rateBps: context.rateBps,
        },
      },
    );
  } catch {
    // ignored on purpose — reporting a tax gap must never create a new one.
  }
}
