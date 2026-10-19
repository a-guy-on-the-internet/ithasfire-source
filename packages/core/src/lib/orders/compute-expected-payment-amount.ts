/**
 * Computes the total amount the buyer actually paid for an order.
 *
 * Prefers summing per-item `buyerTotalCents` from item metadata (set at checkout),
 * which includes the ticket face value + platform fee + processor fee in PASS_THROUGH mode.
 *
 * Falls back to `amountGrossCents + feesPlatformCents` for orders that
 * don't have per-item metadata, though this under-counts by the processor fee.
 *
 * Tax is an order-level charge (not per-item), so it is always added on top.
 */
export function computeExpectedPaymentAmount(order: {
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents?: number;
  items: Array<{ amountCents: number; meta: unknown; kind?: string }>;
}): number {
  let hasBuyerTotals = false;
  let total = 0;

  for (const item of order.items) {
    const buyerTotal = extractNumber(
      (item.meta as Record<string, unknown> | null)?.buyerTotalCents,
    );
    if (buyerTotal !== null) {
      total += buyerTotal;
      hasBuyerTotals = true;
    } else {
      total += item.amountCents;
    }
  }

  if (!hasBuyerTotals) {
    total = order.amountGrossCents + order.feesPlatformCents;
    // Platform credits are negative `platform_credit` line items that reduce
    // the buyer's charge but not the gross/fees basis. In the buyerTotals
    // branch above they are folded in via item.amountCents; here we subtract
    // them explicitly so the buyer-paid total reflects the reduced charge.
    for (const item of order.items) {
      if (item.kind === "platform_credit") {
        total += item.amountCents; // amountCents is negative
      }
    }
  }

  // Tax is an order-level charge added to the PaymentIntent in create-checkout
  // but not included in per-item buyerTotalCents, so it must be added here.
  total += order.taxAmountCents ?? 0;

  return Math.max(0, Math.trunc(total));
}

/**
 * Computes the amount the buyer paid for a single order item.
 * Prefers `buyerTotalCents` from item metadata; falls back to `amountCents`.
 */
export function computeItemBuyerPaid(item: {
  amountCents: number;
  meta: unknown;
}): number {
  const buyerTotal = extractNumber(
    (item.meta as Record<string, unknown> | null)?.buyerTotalCents,
  );
  return Math.max(0, Math.trunc(buyerTotal ?? item.amountCents));
}

/**
 * Safely extracts a finite integer from an unknown value.
 * Handles both numeric and string representations (e.g. from JSON metadata).
 */
export function extractNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}
