import { allocateProportionalCents } from "../../../lib/orders/allocate-proportional-cents";
import { extractNumber } from "../../../lib/orders/compute-expected-payment-amount";
import { refundWeightCents } from "../../../lib/orders/refund-weight";

/**
 * Platform-fee attribution for refunds — the single definition of "how much
 * of this item's refund was platform fee", stamped onto
 * `OrderItem.refundedPlatformFeeCents` beside `refundedTaxCents`.
 *
 * Why it exists (docs/decisions/absorb-refund-returns-platform-fee.md): a
 * refund returns everything the buyer paid except the processing fee, so the
 * platform fee ALWAYS comes back — buyer-funded in PASS_THROUGH, taken out of
 * the organiser's basis in ABSORB — yet nothing recorded how much. The
 * payee-side REFUND_DEBIT cannot carry it: it is the item's CREDITED share
 * (`computeAgreementBasis`, attributed by `attributeCreditToItems`:
 * `amountGrossCents − feesPlatformCents` on an order sold before the
 * 2026-10-11 ruling, `amountGrossCents` on a FULL_PRICE order), so by
 * construction it has no fee component.
 *
 * The cents are the same in both modes: the item's share of
 * `Order.feesPlatformCents`. The mode only decides whose pocket it left at
 * checkout, not how much the platform gives back at refund.
 *
 * ## Two sources, one rule
 *
 * 1. MEASURED — every ticket item carries `meta.platformFeePerTicketCents`
 *    (checkout writes one `OrderItem` per ticket, `qty: 1`, and asserts
 *    Σ per-item fee === `feesPlatformCents` before the order is written).
 *    When that invariant holds on the row we read, those ARE the cents the
 *    refund money contains: in PASS_THROUGH each item's `buyerTotalCents`
 *    includes exactly its own fee, and the refund allocators reproduce
 *    `buyerTotalCents` per item. A pro-rata split would be wrong here on
 *    mixed-price orders under the per-ticket cap ($10 → 33¢, $20 → 50¢: the
 *    ratio is not the price ratio).
 *
 * 2. ALLOCATED — legacy rows without per-item meta, or rows where the sum
 *    does not match (a waiver or cap applied after the meta was written).
 *    Then `feesPlatformCents` is split by `refundWeightCents` (buyer-paid;
 *    0 for a ticket a discount brought down to $0, owner ruling 2026-10-11)
 *    with `allocateProportionalCents` — the SAME allocator and weights the
 *    refund paths use for the money — so Σ over every ticket item is exact.
 *    (On the measured path such a ticket already reads 0: checkout zeroes
 *    its `platformFeePerTicketCents`.)
 *
 * Either way the map covers EVERY ticket item passed in and the shares sum to
 * `feesPlatformCents` (floored at 0). Pass ALL of the order's ticket items,
 * not only the ones being refunded now: an item's share must not move with
 * which siblings happened to be refundable, and stamps across a partial
 * refund and a later full refund then add up to the order fee exactly once.
 *
 * A zero fee yields measured zeros, never an empty map: "the platform gave
 * back 0¢" is a known value; NULL is reserved for "not attributed".
 */
export interface PlatformFeeShareItem {
  id: string;
  amountCents: number;
  meta: unknown;
}

export function allocateRefundPlatformFeeShares(
  ticketItems: ReadonlyArray<PlatformFeeShareItem>,
  orderPlatformFeeCents: number,
): Map<string, number> {
  const shares = new Map<string, number>();
  if (ticketItems.length === 0) return shares;

  const feeCents = Math.max(0, Math.trunc(orderPlatformFeeCents));

  // Source 1: the per-item fee checkout froze on the row.
  let measuredSum = 0;
  let allMeasured = true;
  for (const item of ticketItems) {
    const measured = extractNumber(
      (item.meta as Record<string, unknown> | null)?.platformFeePerTicketCents,
    );
    if (measured === null || measured < 0) {
      allMeasured = false;
      break;
    }
    shares.set(item.id, measured);
    measuredSum += measured;
  }
  if (allMeasured && measuredSum === feeCents) return shares;

  // Source 2: proportional allocation, exact in sum.
  shares.clear();
  const allocated = allocateProportionalCents(
    [...ticketItems],
    feeCents,
    (item) => refundWeightCents(item),
  );
  for (const item of ticketItems) {
    shares.set(item.id, allocated.get(item.id) ?? 0);
  }
  return shares;
}
