import type { TxRepos } from "@th/ports/repos";

/**
 * The one rule for `OrderItem.resaleListingId` (owner ruling 2026-10-11:
 * a ticket can change hands on resale any number of times).
 *
 * The column means one of two things, decided by the item's ORDER:
 *
 * - an item of a RESALE order: the listing that item was BOUGHT THROUGH. It
 *   is written once, by `createResaleCheckout`, and is never rewritten, and
 *   never cleared while that sale stands. The refund unwind, the seller
 *   split, claims and the hold release all read it to find the sale behind
 *   the item.
 *
 *   Two adapter operations do null it, by listing id and whatever the
 *   item's order: `cancelOpenForEvent` (every ACTIVE or HELD listing of a
 *   cancelled event) and `closeListing` (a HELD listing closed when its
 *   hold is released on a cancelled event). Both close a
 *   listing that never sold, so the only RESALE item that can name it is a
 *   checkout that did not complete. That is safe: there is no sale to find,
 *   and `meta.resaleListingId` still names the listing. The adapter's other
 *   clears do not reach a RESALE item: `expireStale` and a released hold
 *   clear only the listed ticket's own current item, and only when it names
 *   that listing; `unwindSale` touches no order item at all. Nothing clears
 *   the column for a listing that is SOLD to the item's order.
 * - an item of any other order (PRIMARY, COMP, ...): the listing the ticket
 *   is on sale through NOW. Written when the holder lists, cleared when the
 *   listing is cancelled, expires or sells.
 *
 * So no "listed now" write may land on a RESALE item: when a resale buyer
 * lists the ticket again, overwriting the column would make a refund of
 * their purchase unwind the wrong listing, and clearing it (on cancel or on
 * the next sale) would lose the sale the item came from. Whether such a
 * ticket is listed now is read from the ticket (`status === "LISTED"`, or
 * `resaleListings.getByTicketId`), never from this column.
 */
export function itemPointerIsBoughtThrough(
  orderSource: string | null | undefined,
): boolean {
  return orderSource === "RESALE";
}

/**
 * Write (or clear, with `null`) the "listed now" pointer of the order item
 * behind a ticket, unless the item belongs to a RESALE order, in which case
 * nothing is written and the bought-through pointer stays.
 *
 * Pass `orderSource` when the caller already holds the item's order; without
 * it the item and its order are read here. An item whose order cannot be
 * read is written as before: a stale "listed now" pointer left on a PRIMARY
 * item would block that item's refunds (`classifyRefundItem` reads it as
 * `listing_active`), while a RESALE item that lost its column still carries
 * the same id in `meta.resaleListingId`, which every reader falls back to.
 *
 * Returns whether the column was written.
 */
export async function setListedNowPointer(
  tx: Pick<TxRepos, "orderItems" | "orders">,
  params: {
    orderItemId: string;
    listingId: string | null;
    orderSource?: string | null;
  },
): Promise<boolean> {
  let orderSource = params.orderSource ?? null;
  if (orderSource === null) {
    const item = await tx.orderItems.getById(params.orderItemId);
    const order = item ? await tx.orders.getById(item.orderId) : null;
    orderSource = order?.source ?? null;
  }

  if (itemPointerIsBoughtThrough(orderSource)) {
    return false;
  }

  await tx.orderItems.setResaleListingId(params.orderItemId, params.listingId);
  return true;
}
