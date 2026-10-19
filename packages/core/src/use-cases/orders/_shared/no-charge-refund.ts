import { createHash } from "node:crypto";

/**
 * A refund that returns $0.
 *
 * Owner ruling, 2026-10-11: refunding a ticket that cost $0 returns $0
 * ("because that's what it cost"). The refund still has to HAPPEN: the ticket
 * goes REFUNDED, its seat and capacity come back, the order moves to
 * PART_REFUNDED / REFUNDED and the audit row is written. What must not happen
 * is a REFUND call to the payment processor: Stripe rejects a refund of
 * amount 0.
 *
 * So `refundOrderItems`, `refundFullOrder` and `cancelEvent` skip the
 * prior-refund lookup and the refund when the refund total is 0, and name the
 * refund with the id built here instead of a Stripe refund id.
 *
 * The TRANSFER REVERSAL is not skipped. It is keyed on what the payee was
 * paid for the item, not on what the buyer gets back: a paid-out ticket whose
 * refund clamps to $0 still has its payee share pulled back. A ticket a
 * discount brought down to $0 has no payee share, is never stamped
 * `paidOutAt`, and so is never reversed.
 *
 * It reaches a $0 total for a ticket a discount brought down to $0
 * (`meta.discountedToZero`), for a ticket priced at $0 inside a paid order,
 * and for a ticket so cheap that its share of the processing fee is at least
 * its price plus tax. Before this both paths refused all three with
 * `REFUND_AMOUNT_ZERO`, which left such a ticket with no refund path short of
 * refunding every ticket on the order.
 *
 * The id is deterministic in the order and the items refunded, so a retry of
 * the same refund writes the same ledger keys and the same notification key.
 * An item is refunded at most once, so two different $0 refunds on one order
 * never share an id.
 */
const NO_CHARGE_REFUND_ID_PREFIX = "nocharge_";

export function buildNoChargeRefundId(
  orderId: string,
  orderItemIds: readonly string[],
): string {
  const digest = createHash("sha256")
    .update([orderId, ...[...orderItemIds].sort()].join(":"))
    .digest("hex")
    .slice(0, 24);
  return `${NO_CHARGE_REFUND_ID_PREFIX}${digest}`;
}
