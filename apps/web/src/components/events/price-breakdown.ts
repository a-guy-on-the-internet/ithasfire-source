import type { TicketFeeEstimate } from "./event-content-types";

/**
 * The parts of the event page's all-in "from" price, named under the figure
 * ("$40.00 ticket + $2.12 fees + $3.55 tax" under "$45.67").
 *
 * What the buyer pays, per the server's estimator
 * (`packages/core/src/use-cases/events/_shared/estimate-buyer-ticket-pricing.ts`):
 *
 *  - PASS_THROUGH: face + platform fee + processor gross-up + tax. The row's
 *    `buyerUnitTotalCents` is exactly that sum.
 *  - ABSORB (and no resolvable fee policy): face + tax. The organiser funds
 *    the platform fee and there is no processor gross-up; the row reports both
 *    fees as 0 and `buyerUnitTotalCents` = face + tax.
 *
 * "fees" is platform + processor combined. Under ABSORB they are forced to 0
 * whatever the row says, so a populated platform fee can never be shown as a
 * buyer fee.
 */
export type PriceBreakdown = {
  ticketCents: number;
  feesCents: number;
  taxCents: number;
};

const isCents = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * The breakdown of one fixed-price tier's all-in figure, or null when there is
 * nothing honest to show:
 *
 *  - no estimate yet (the figure still reads "calculating"), or a free tier;
 *  - fees and tax are both 0 (the figure IS the ticket);
 *  - the parts do not add up to the figure. The ticket part is the tier's
 *    face (`priceCents`) and the other two come off the server row, so they
 *    agree unless the page and the estimate straddled a scheduled price flip.
 *    A caption that does not sum to the number above it is worse than none.
 *
 * A pay-what-you-want tier reaches here with its FLOOR as `priceCents` (its
 * row is priced at the floor), so "From $6.09" reads "$5.00 ticket + …".
 * RSVP events never reach here; the caller gates them.
 */
export function derivePriceBreakdown({
  priceCents,
  figureCents,
  estimate,
  feeMode,
}: {
  /** The tier's face: the effective online price at request time. */
  priceCents: number;
  /** The all-in figure the page prints. The parts must sum to exactly this. */
  figureCents: number | null;
  estimate: TicketFeeEstimate | undefined;
  feeMode: "ABSORB" | "PASS_THROUGH" | null | undefined;
}): PriceBreakdown | null {
  if (!estimate || figureCents == null) return null;
  if (!isCents(priceCents) || priceCents === 0) return null;
  if (!isCents(figureCents) || figureCents === 0) return null;
  // The row names the face it was priced at: if that is not the face the page
  // shows (a scheduled flip between the two reads), its fees and tax belong
  // to a different ticket price.
  if (
    estimate.unitPriceCents !== undefined &&
    estimate.unitPriceCents !== priceCents
  ) {
    return null;
  }

  const feesCents =
    feeMode === "ABSORB"
      ? 0
      : estimate.platformFeeCents + estimate.processorFeeCents;
  const taxCents = estimate.taxEstimateCents;
  if (!isCents(feesCents) || !isCents(taxCents)) return null;
  if (feesCents === 0 && taxCents === 0) return null;

  if (priceCents + feesCents + taxCents !== estimate.buyerUnitTotalCents) {
    return null;
  }
  if (estimate.buyerUnitTotalCents !== figureCents) return null;

  return { ticketCents: priceCents, feesCents, taxCents };
}

/**
 * The caption string. `long` names all three parts (the wide buy band and the
 * classic hero meta row); `short` names only what sits on top of the face
 * (the phone's 84px docked bar). A zero part is left out, never "+ $0.00".
 */
export function priceBreakdownCaption(
  breakdown: PriceBreakdown,
  form: "long" | "short",
  {
    formatPrice,
    t,
  }: {
    formatPrice: (cents: number) => string;
    t: (key: string, values?: Record<string, string | number>) => unknown;
  },
): string {
  const hasFees = breakdown.feesCents > 0;
  const hasTax = breakdown.taxCents > 0;
  const variant =
    hasFees && hasTax ? "Full" : hasFees ? "NoTax" : "NoFees";
  const key =
    form === "long"
      ? `eventDetail.priceBreakdown.long${variant}`
      : `eventDetail.priceBreakdown.short${variant}`;
  // Only the parts this variant prints: `formatPrice(0)` reads "Free", so a
  // zero part must never be formatted, let alone handed to the message.
  const values: Record<string, string> = {};
  if (form === "long") values.ticket = formatPrice(breakdown.ticketCents);
  if (hasFees) values.fees = formatPrice(breakdown.feesCents);
  if (hasTax) values.tax = formatPrice(breakdown.taxCents);
  return String(t(key, values));
}
