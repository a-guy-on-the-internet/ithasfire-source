import type { OrderItemsRepo } from "@th/ports/repos/order-items";

/**
 * The minimal repo surface needed to reach a ticket's purchase snapshot.
 * Satisfied by both `Repos` and `TxRepos`.
 */
export type PurchasedUnitPriceRepos = {
  orderItems: Pick<OrderItemsRepo, "getById">;
};

/** The minimal Ticket shape needed to reach its originating OrderItem. */
export type PurchasedUnitPriceTicket = {
  id: string;
  orderItemId: string | null;
};

/**
 * This ticket's LIST PRICE at the moment of purchase, in cents — the correct
 * basis for "face value".
 *
 * `OrderItem.unitPriceCents` is the point-of-sale snapshot: it is written once
 * at purchase (checkout, POS cash/card, comp issuance, and resale finalization)
 * and never recomputed — one OrderItem per ticket, qty 1 each. `Ticket
 * .orderItemId` always points at the item that put the ticket in its holder's
 * hands: `reassignForResale` repoints it to the resale buyer's item, so a
 * ticket resold twice resolves to the list price of its second sale, not the
 * original face price.
 *
 * NOT the buyer's net outlay. Promo discounts are written as SEPARATE order
 * items (`create-checkout.ts`) and platform credits reduce only the Stripe
 * charge, so a buyer who used 50%-off on a $20 ticket has `unitPriceCents`
 * 2000, not 1000. That is deliberate for this use: face value is a property of
 * the ticket at sale time, not of one buyer's discount.
 *
 * This is the ONLY correct source for historical value. The live
 * `TicketType.priceCents` is a forward-looking POLICY number that the organizer
 * can edit at any time — reading it as "face value" after the fact silently
 * moves money (see FR-001, docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml:
 * a $12 early-bird ticket listed after the price rises to $20 records $0
 * markup, and the venue's markup share vanishes).
 *
 * Returns `null` when no OrderItem is reachable — legacy/fixture tickets minted
 * outside `mintTicketsForOrder`. Callers MUST treat `null` as "unknown" and
 * either refuse the operation or report it; never substitute the live price.
 *
 * Mirrors the established refund pattern (`quote-item-refund.ts`, which reads
 * `item.unitPriceCents` directly off the order).
 */
export async function resolvePurchasedUnitPriceCents(
  repos: PurchasedUnitPriceRepos,
  ticket: PurchasedUnitPriceTicket,
): Promise<number | null> {
  if (!ticket.orderItemId) return null;

  const orderItem = await repos.orderItems.getById(ticket.orderItemId);
  if (!orderItem) return null;

  return orderItem.unitPriceCents;
}
