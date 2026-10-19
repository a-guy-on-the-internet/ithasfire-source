/**
 * Step 1 (before the hold) shows the SAME rows as step 2: each line at its
 * face × qty, a Subtotal, the platform fee, the processing fee, tax, the
 * discount(s) and the total. The figures come from ONE `estimateCartTotal`
 * result — the object whose `totalCents` is also the visible total, the
 * mobile button and the live region — so the rows add up to the total by
 * construction:
 *
 *   gross + platform + processing + tax − discount = totalCents
 *
 * (`estimateOrderTotal` builds `totalCents` from exactly these parts; in
 * ABSORB the platform and processing parts are 0 because the buyer funds
 * neither, and their rows read "Included".)
 *
 * The step-2 markup reads an order and a held charge. This module turns the
 * step-1 estimate into those two shapes so the same rows render it; no second
 * pricing path.
 */

/** The parts of an `estimateCartTotal` result the rows read. */
export type PreHoldEstimate = {
  /** Σ face × qty, pre-discount — the Subtotal row. */
  grossCents: number;
  /** Buyer-funded platform fee (0 in ABSORB). */
  platformFeeCents: number;
  taxCents: number;
  /** Buyer-funded processing fee (0 in ABSORB). */
  processorFeeCents: number;
  totalCents: number;
};

/**
 * Whether the estimate gets the full row set. A free cart (nothing to pay,
 * whether its tickets cost nothing or a discount cleared them) keeps the
 * existing single "Estimated total — Free" row instead: there is no fee or
 * tax to show.
 */
export function preHoldHasRows(
  estimate: PreHoldEstimate | null | undefined,
): estimate is PreHoldEstimate {
  return estimate != null && estimate.grossCents > 0 && estimate.totalCents > 0;
}

/** The step-1 estimate as the order fields the step-2 rows read. */
export function preHoldRowsOrder(
  estimate: PreHoldEstimate,
  feeMode: "ABSORB" | "PASS_THROUGH" | null | undefined,
) {
  const passThrough = feeMode === "PASS_THROUGH";
  return {
    amountGrossCents: estimate.grossCents,
    feesPlatformCents: estimate.platformFeeCents,
    buyerFeesCents: passThrough ? estimate.platformFeeCents : 0,
    processorFeeCents: estimate.processorFeeCents,
    taxAmountCents: estimate.taxCents,
  };
}

/** The step-1 estimate as the held charge the step-2 rows read. */
export function preHoldRowsCharge(
  estimate: PreHoldEstimate,
  feeMode: "ABSORB" | "PASS_THROUGH" | null | undefined,
) {
  return {
    taxCents: estimate.taxCents,
    processorFeeCents:
      feeMode === "PASS_THROUGH" ? estimate.processorFeeCents : null,
    totalCents: estimate.totalCents,
  };
}

/**
 * A line before the hold: face × qty — the buyer's amount on a
 * pay-what-you-want tier, the ticket price otherwise. With seats picked,
 * `shownLineCents` (each seat at the price the map shows it, an override
 * included) is the line, so a $50 seat on a $35 tier reads $50 here as it
 * does once held. Fees and tax sit in their own rows below, as on step 2.
 */
export function preHoldLineCents(
  ticketType: {
    priceCents: number;
    chosenAmountCents?: number | null;
    shownLineCents?: number | null;
  },
  qty: number,
): number {
  return (
    ticketType.shownLineCents ??
    (ticketType.chosenAmountCents ?? ticketType.priceCents) * qty
  );
}

/**
 * The discount the rows show before the hold: the previewed discount, never
 * more than the subtotal (a code worth more than the cart clears it; the
 * estimate's total stops at 0, and so must the rows).
 */
export function preHoldDiscountCents(
  promoDiscountCents: number,
  estimate: PreHoldEstimate | null | undefined,
): number {
  const discount = Math.max(0, promoDiscountCents);
  return estimate ? Math.min(discount, estimate.grossCents) : discount;
}
