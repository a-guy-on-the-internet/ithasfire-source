import { allocateProportionalCents } from "./allocate-proportional-cents";
import { computeExpectedPaymentAmount } from "./compute-expected-payment-amount";
import { refundWeightCents } from "./refund-weight";

/**
 * The per-item REFUNDABLE TICKET-PRICE BASE — the one definition of "how much
 * of the ticket price this item is worth on a refund", shared by the quote
 * (`quoteItemRefund`) and, through it, the execution (`refundOrderItems`).
 *
 * ## The bug this exists to kill
 *
 * An order's discount is a separate NEGATIVE line item (`platform_credit`,
 * `discount`, …), NOT a reduction of each ticket item's
 * `meta.buyerTotalCents`. So `computeItemBuyerPaid(item)` is that item's
 * PRE-discount figure, and on a discounted order the per-item figures sum to
 * MORE than the buyer was actually charged.
 *
 * Using it as an item's own absolute base therefore over-refunds by the whole
 * discount: two 2,750¢ tickets less a 1,000¢ credit is a 4,500¢ charge, but
 * refunding them one at a time returned 2,750 + 2,750 = 5,500. The platform
 * ate the 1,000. (Stripe's charge-level cap bounded the buyer-side total, so
 * the loss landed on us, not as a visible failure.)
 *
 * `computeItemBuyerPaid` stays correct as an allocation WEIGHT for splitting a
 * known order-level total. It is only wrong as an item's own absolute amount.
 * That is the distinction: weight, not amount.
 *
 * ## The weight
 *
 * `refundWeightCents` (`refund-weight.ts`) is the one definition of what a
 * ticket weighs in a refund, read here and by `allocateRefundTaxShares`,
 * `allocateRefundFeeShares`, `allocateRefundPlatformFeeShares`,
 * `allocateFullRefundShares` and `getRefundEligibility`. It is
 * `computeItemBuyerPaid(item)` for every ticket except one a discount brought
 * down to $0 (`meta.discountedToZero`), which weighs 0.
 *
 * Owner ruling, 2026-10-11: "yeah it should refund 0 because that's what it
 * cost. Otherwise we will get taken advantage of". So refunding a ticket a
 * promo code or membership benefit made free returns $0, and the paid tickets
 * beside it carry the whole charge. An order priced before 2026-10-10 has no
 * `meta.discountedToZero` and keeps the buyer-paid weighting for such a
 * ticket.
 *
 * ## The definition
 *
 * `base_i = allocateProportionalCents(ticketItems, orderTotal − tax, weight =
 * refundWeightCents)`.
 *
 * Deliberately phrased in terms of the ORDER TOTAL
 * (`computeExpectedPaymentAmount`, which already folds in every negative line
 * item) MINUS `Order.taxAmountCents` — NOT in terms of an enumeration of
 * negative `kind` values. A discount kind invented tomorrow is handled
 * automatically the moment it lands in the order total; nothing here needs to
 * learn its name.
 *
 * Properties, all pinned by tests:
 *
 * - **Exact.** `Σ base_i === computeExpectedPaymentAmount(order) −
 *   (order.taxAmountCents ?? 0)` — the post-discount, pre-tax cents the buyer
 *   actually paid. Largest-remainder rounding (the same
 *   `allocateProportionalCents` every other share uses, same tie-break by item
 *   id), so no cent is lost or invented when a discount does not divide evenly.
 * - **Bounded.** Since a refund is `base + taxShare − feeShare` and the three
 *   allocations are each exact over the same item set,
 *   `Σ refunds === orderTotal − stripeFee` exactly when every item is
 *   refunded, and `≤` it for any subset. Refunding item-by-item can no longer
 *   exceed the charge.
 * - **Path-independent.** An item's base is a function of the WHOLE order, so
 *   it is the same whether the item is refunded alone or alongside siblings,
 *   and an already-refunded or transferred sibling neither inflates nor
 *   shrinks the others'.
 * - **Undiscounted orders are unchanged.** With no negative line item the
 *   order total is Σ `buyerTotalCents` + tax, so `base_i` collapses back to
 *   `computeItemBuyerPaid(item)` exactly.
 * - **A ticket discounted to $0 is worth 0.** Its weight is 0, so its base is
 *   0 and the bases of the other tickets still sum to the whole basis.
 *
 * ## Buyer-facing consequence
 *
 * On a DISCOUNTED order, a buyer refunding one item now gets proportionally
 * less than before — their share of what was actually charged rather than the
 * ticket's pre-discount sticker price. That is the amount they paid. A ticket
 * discounted to an amount above $0 is still weighed by its pre-discount buyer
 * total, whichever ticket type a scoped code came off; only a ticket brought
 * all the way to $0 is treated differently (it weighs 0).
 */

type TicketItemLike = { id: string; amountCents: number; meta: unknown };

type OrderLike = {
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents?: number | null;
  items: Array<{ amountCents: number; meta: unknown; kind?: string }>;
};

/**
 * The post-discount, PRE-TAX cents the buyer actually paid for the whole
 * order — the exact sum the per-item bases must add up to.
 */
export function computeOrderTicketPriceBasis(order: OrderLike): number {
  const totalPaidCents = computeExpectedPaymentAmount({
    ...order,
    taxAmountCents: order.taxAmountCents ?? 0,
  });
  return Math.max(0, totalPaidCents - (order.taxAmountCents ?? 0));
}

/**
 * Each ticket item's refundable ticket-price base. Pass EVERY ticket item of
 * the order, not just the ones being refunded — the allocation is over the
 * whole order so an item's base does not depend on who it is refunded with.
 *
 * Returns a map keyed by order-item id; an id absent from the map is worth 0,
 * which is correct — an item outside the allocation was not paid for here.
 */
export function allocateRefundItemBases(
  ticketItems: TicketItemLike[],
  order: OrderLike,
): Map<string, number> {
  return allocateProportionalCents(
    ticketItems,
    computeOrderTicketPriceBasis(order),
    (item) => refundWeightCents(item),
  );
}
