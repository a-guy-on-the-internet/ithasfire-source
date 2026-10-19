/**
 * Buyer-facing price lines for an order.
 *
 * The money is split on the server (`getMyOrder().charges`, built by
 * `computeBuyerChargeBreakdown` in core) — the same object the web order page
 * renders, so the two screens cannot disagree. This file only decides which
 * of those lines to show, in what order, and what to call them.
 *
 * The server guarantees
 * `subtotal + platformFee + processingFee + tax + credit === total`, and an
 * ABSORB order (the organiser absorbed the fees; the buyer paid face + tax)
 * carries zero platform and processing fees.
 */

export type BuyerCharges = {
  subtotalCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  taxCents: number;
  /** Platform credit applied; zero or negative. */
  creditCents: number;
  totalCents: number;
};

export type ChargeLine = {
  id: "subtotal" | "platformFee" | "tax" | "processingFee" | "credit";
  label: string;
  cents: number;
};

/**
 * The lines between Subtotal and Total paid. Subtotal always shows; a fee,
 * tax or credit line shows only when it is non-zero, because a $0 tax line on
 * an untaxed event invites the question it exists to answer. Hiding a zero
 * line never breaks the sum.
 */
export const buyerChargeLines = (charges: BuyerCharges): ChargeLine[] => {
  const lines: ChargeLine[] = [
    { id: "subtotal", label: "Subtotal", cents: charges.subtotalCents },
  ];
  if (charges.platformFeeCents !== 0) {
    lines.push({
      id: "platformFee",
      label: "Platform fee",
      cents: charges.platformFeeCents,
    });
  }
  if (charges.taxCents !== 0) {
    lines.push({ id: "tax", label: "Tax", cents: charges.taxCents });
  }
  if (charges.processingFeeCents !== 0) {
    lines.push({
      id: "processingFee",
      label: "Processing fee",
      cents: charges.processingFeeCents,
    });
  }
  if (charges.creditCents !== 0) {
    lines.push({
      id: "credit",
      label: "Credit applied",
      cents: charges.creditCents,
    });
  }
  return lines;
};
