import { computeItemBuyerPaid } from "./compute-expected-payment-amount";

/**
 * What a ticket weighs in a refund. The ONE definition: every refund path
 * that splits an order-level amount over ticket items (the ticket-price base,
 * the tax, the processing fee, the platform fee, the organiser's credit) reads
 * its weight here, so the quote a buyer or staff member sees and the refund
 * that runs cannot disagree about a ticket.
 *
 * ## The rule
 *
 * Owner ruling, 2026-10-11: "yeah it should refund 0 because that's what it
 * cost. Otherwise we will get taken advantage of".
 *
 * A ticket a promo code or membership benefit brought down to $0
 * (`meta.discountedToZero`, stamped by `computeOrderAmounts`; the definition
 * is `discounted-to-zero.ts`) weighs 0. The buyer paid nothing for it, so
 * refunding it returns nothing: no ticket price, no tax, no processing-fee
 * share, no platform fee. The paid tickets beside it carry the whole charge,
 * so refunding every ticket still returns exactly `orderTotal − stripeFee`.
 *
 * Why the mark is needed: such a ticket keeps its PRE-discount price in
 * `amountCents` and `meta.buyerTotalCents` (the discount is a separate
 * negative `discount` line). Weighed by either, it took a share of money the
 * other tickets paid: on a $125 ticket freed by a code beside a paid $50
 * ticket, refunding the free one returned $38.71 of the $56.89 charged.
 *
 * Every other ticket keeps the weight it always had:
 *
 *  - `refundWeightCents`: what the buyer paid for it before tax
 *    (`computeItemBuyerPaid`).
 *  - `refundFaceWeightCents`: its face price (`amountCents`), for a tax line
 *    charged on `TICKET_FACE` and for the organiser's credit attribution.
 *
 * A ticket whose PRICE is $0 (a free tier, a seat overridden to $0) needs no
 * mark: its buyer total and its face are both 0, so both weights are already
 * 0.
 *
 * A ticket discounted to any amount above $0, and every ticket on an order
 * with a whole-order discount that does not zero it, is NOT changed by the
 * ruling: it keeps the buyer-paid weight, which does not look at which ticket
 * a scoped code came off.
 *
 * ## Orders priced before 2026-10-10
 *
 * `meta.discountedToZero` has been written since 2026-10-10. An order priced
 * before that carries no mark, so a ticket a code freed on it keeps the old
 * buyer-paid weighting. There is no backfill (production had no orders).
 */

type WeighedItem = { amountCents: number; meta: unknown };

/**
 * True for a ticket item a discount brought down to $0. Reads the mark
 * `computeOrderAmounts` wrote; never re-derives it from today's promo rules.
 */
export function isItemDiscountedToZero(item: { meta?: unknown }): boolean {
  return (
    (item.meta as Record<string, unknown> | null | undefined)
      ?.discountedToZero === true
  );
}

/**
 * The item's weight when an order-level amount is split by what the buyer
 * paid: 0 for a ticket a discount brought down to $0, its ex-tax buyer total
 * otherwise.
 */
export function refundWeightCents(item: WeighedItem): number {
  return isItemDiscountedToZero(item) ? 0 : computeItemBuyerPaid(item);
}

/**
 * The item's weight when an amount is split by FACE price (a `TICKET_FACE`
 * tax line, the organiser's credit attribution): 0 for a ticket a discount
 * brought down to $0, `amountCents` otherwise.
 */
export function refundFaceWeightCents(item: WeighedItem): number {
  return isItemDiscountedToZero(item)
    ? 0
    : Math.max(0, Math.trunc(item.amountCents));
}
