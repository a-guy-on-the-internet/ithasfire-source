import { uniformPlatformTaxBase } from "@th/core/use-cases/events/_shared/tax-imposition-schema";

/** The slice of a quoted tax line (`taxImpositionSchema`) the label needs. */
export type TaxLineForLabel = {
  rateBps: number;
  base: "TICKET_FACE" | "BUYER_TOTAL";
  collector: "PLATFORM" | "ORGANISER";
};

/**
 * The rate a Taxes row may print beside its amount ("Taxes (9.03%)"), in
 * basis points — or null, and the row shows the amount alone.
 *
 * The rate is the sum of the PLATFORM lines (the ones the buyer is charged;
 * ORGANISER lines are the venue's to remit). It is printed only when every
 * PLATFORM line shares one base (`uniformPlatformTaxBase`, the same
 * derivation as `getCheckoutFeeRates.uniformTaxBase`):
 *  - all `TICKET_FACE`: the rate is of the subtotal row;
 *  - all `BUYER_TOTAL`: the rate is of the subtotal plus the fee rows above
 *    it, which the summary itemises — so the figure is still checkable.
 * When the bases differ (Minneapolis: Minnesota sales tax on the buyer total,
 * the 3% entertainment tax on the face) no single percentage produces the
 * amount: "12.03%" beside $3.16 on a $25 ticket was 12.64% of the face. So
 * no percentage at all.
 *
 * Null too when nothing is charged, or the payload predates impositions.
 */
export function taxRateLabelBps(
  impositions: ReadonlyArray<TaxLineForLabel> | null | undefined,
): number | null {
  if (!impositions) return null;
  if (uniformPlatformTaxBase(impositions) === null) return null;
  const sum = impositions
    .filter((line) => line.collector === "PLATFORM")
    .reduce((total, line) => total + line.rateBps, 0);
  return sum > 0 ? sum : null;
}
