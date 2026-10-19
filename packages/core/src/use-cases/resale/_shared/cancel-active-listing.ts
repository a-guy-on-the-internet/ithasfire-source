import type { TxRepos } from "@th/ports/repos";
import type { ResaleListingRecord } from "@th/ports/repos/resale-listings";

import { setListedNowPointer } from "../../_helpers/order-item-listing-pointer";

/**
 * Cancel an ACTIVE listing inside the caller's transaction: the one way a
 * listing that has not sold is taken off sale and its ticket handed back.
 * Used by the seller's own cancel (`cancelResaleListing`) and by the cancel
 * of listings priced under the removed markup split
 * (`cancelLegacyResaleListings`).
 *
 * Returns false, having changed nothing, when the listing is no longer
 * ACTIVE (a buyer's `hold` got there first, or it is already closed). Each
 * caller decides what that means.
 *
 * The audit row is the caller's: it names who cancelled and why.
 */
export async function cancelActiveListingInTx(
  tx: Pick<TxRepos, "tickets" | "resaleListings" | "orderItems" | "orders">,
  listing: Pick<ResaleListingRecord, "id" | "ticketId" | "sellerHumanId">,
): Promise<boolean> {
  // Lock the ticket BEFORE the listing: ticket, then listing is the order
  // `commit`, `lockHold`, `releaseHold` and the comp revoke take, so this
  // cannot deadlock against them.
  const ticket = await tx.tickets.getByIdForUpdate(listing.ticketId);

  // Cancel the listing as a compare-and-swap. The caller's read was
  // unlocked: a buyer's `hold` may have flipped it to HELD since. Putting the
  // ticket back to VALID under a HELD listing would make that buyer's paid
  // finalize fail (`reassignForResale` only moves a LISTED ticket), so a lost
  // CAS stops here, before the ticket is touched.
  const cancelled = await tx.resaleListings.cancel(
    listing.id,
    listing.sellerHumanId,
  );
  if (!cancelled) return false;

  // Restore the ticket to VALID, but ONLY from LISTED. A ticket voided while
  // its listing stayed open (a refund heal, a pre-fix comp revoke) is
  // REFUNDED or INVALID: it has given its capacity place back, and putting it
  // back to VALID would retake that place without the capacity lock and
  // oversell the tier (refunds-restock spec 2026-10-09). The listing is still
  // cancelled either way; a `false` here just leaves the ticket be.
  await tx.tickets.setStatus(listing.ticketId, "VALID", {
    expectedStatus: "LISTED",
  });

  // Clear the purchase item's "listed now" pointer. Skipped for a ticket
  // bought on resale: that item's column is the listing it was BOUGHT
  // through, which a refund of the purchase still needs
  // (`_helpers/order-item-listing-pointer.ts`).
  if (ticket?.orderItemId) {
    await setListedNowPointer(tx, {
      orderItemId: ticket.orderItemId,
      listingId: null,
    });
  }

  return true;
}
