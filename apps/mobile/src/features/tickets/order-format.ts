/**
 * Buyer-facing money math for an order.
 *
 * Mirrors `apps/web/src/app/my-tickets/[orderId]/_components/OrderDetail.tsx`
 * exactly — the two surfaces show the same order to the same person, so a
 * divergence here reads to the buyer as one of the two screens lying.
 */

export type OrderChargeInput = {
  /** Face value of the tickets, before any fee or tax. */
  amountGrossCents: number;
  /** Ithas Fire's platform fee. */
  feesPlatformCents: number;
  /** What the buyer's card was actually charged. Tax is folded into this. */
  buyerTotalCents: number;
  /** Sales tax, when the event's situs required it. */
  taxAmountCents: number | null | undefined;
};

export type OrderCharges = {
  subtotalCents: number;
  platformFeeCents: number;
  taxCents: number;
  processingFeeCents: number;
  totalCents: number;
};

/**
 * Split the buyer's total into its four display rows.
 *
 * The processing (Stripe) fee is not stored — it is what the buyer paid over
 * subtotal once the platform fee and tax are removed. **Tax must be subtracted
 * here.** It is already folded into `buyerTotalCents`, so omitting it lets the
 * processing row silently absorb the tax and overstate the fee, which is the
 * one number in this breakdown a buyer is most likely to dispute.
 *
 * Invariant: `subtotal + platformFee + tax + processing === total`.
 */
export const computeOrderCharges = (order: OrderChargeInput): OrderCharges => {
  const taxCents = order.taxAmountCents ?? 0;
  const processingFeeCents =
    order.buyerTotalCents -
    order.amountGrossCents -
    order.feesPlatformCents -
    taxCents;

  return {
    subtotalCents: order.amountGrossCents,
    platformFeeCents: order.feesPlatformCents,
    taxCents,
    processingFeeCents,
    totalCents: order.buyerTotalCents,
  };
};

/**
 * Whether a charge row is worth rendering.
 *
 * Zero rows are noise — a $0 tax line on an untaxed event invites the question
 * it exists to answer. Negative values are not silently hidden: they mean the
 * order's stored amounts disagree, and the screen surfaces them so the
 * discrepancy is visible rather than swallowed.
 */
export const shouldShowChargeRow = (cents: number): boolean => cents !== 0;
