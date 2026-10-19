import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { TxRepos } from "@th/ports/repos";
import type { OrderRecord } from "@th/ports/repos/orders";
import { fail } from "@th/errors";
import { getMetaString } from "../../lib/orders/meta";
import { generateTicketCode } from "../../lib/tickets/generate-ticket-code";
import { setListedNowPointer } from "../_helpers/order-item-listing-pointer";

/**
 * Post-finalization steps specific to resale orders.
 *
 * Called from `finalize-from-payment-intent` AFTER the order has been
 * marked SUCCEEDED, splits computed, and settlements created. This function
 * handles the resale-specific side effects:
 *
 *  1. Commit the resale listing (status → SOLD)
 *  2. Reassign the ticket to the resale order item and regenerate its QR code
 *  3. Mark the original seller's OrderItem as "transferred"
 */
export async function finalizeResalePurchase(
  tx: TxRepos,
  params: {
    order: OrderRecord;
    clock: ClockPort;
    logger?: LoggerPort;
  },
): Promise<void> {
  const { order, clock, logger } = params;
  const now = clock.now();

  // Every early exit below THROWS rather than returning: this runs inside the
  // finalize transaction that also marks the order SUCCEEDED and writes the
  // seller's split, so a quiet return would leave a paid order "succeeded"
  // with no ticket transferred and the seller credited. (finalize's
  // `resolveResaleSellerSplit` already refuses these three shapes first, so
  // they are unreachable from finalize; the throws keep this function safe
  // on its own.)

  // Resale orders have exactly one ticket item, with resaleListingId in meta
  const ticketItem = order.items.find((item) => item.kind === "ticket");
  if (!ticketItem) {
    logger?.error("finalizeResalePurchase.no_ticket_item", {
      orderId: order.id,
    });
    throw fail("TICKET_NOT_FOUND", {
      meta: { orderId: order.id, reason: "resale_order_no_ticket_item" },
    });
  }

  // During rollout, prefer the canonical relation field and fall back to legacy meta.
  const listingId =
    ticketItem.resaleListingId ??
    getMetaString(ticketItem.meta, "resaleListingId");
  if (!listingId) {
    logger?.error("finalizeResalePurchase.no_listing_id", { orderId: order.id });
    throw fail("LISTING_NOT_FOUND", {
      meta: { orderId: order.id, reason: "resale_order_missing_listing_id" },
    });
  }

  const listing = await tx.resaleListings.getById(listingId);
  if (!listing) {
    logger?.error("finalizeResalePurchase.listing_not_found", {
      orderId: order.id,
      listingId,
    });
    throw fail("LISTING_NOT_FOUND", {
      meta: {
        orderId: order.id,
        listingId,
        reason: "resale_listing_not_found_at_finalize",
      },
    });
  }

  // ── 1. Commit the listing ──────────────────────────────────────────
  const commitResult = await tx.resaleListings.commit(
    listingId,
    order.buyerHumanId,
    order.id,
  );

  if (!commitResult.ok) {
    // `ok: false` = no hold, or a hold owned by another buyer. Harmless ONLY
    // when the listing is already sold to THIS order (a duplicate run of the
    // same finalize). Anything else means the ticket went (or is going) to
    // someone else: returning would mark this paid order SUCCEEDED with no
    // ticket while the seller is credited for it (finalize writes the
    // seller's split in this same transaction). Throw so the whole finalize
    // rolls back and the paid order goes to manual review.
    if (listing.buyerOrderId === order.id) {
      logger?.info("finalizeResalePurchase.listing_already_committed", {
        orderId: order.id,
        listingId,
      });
      return;
    }
    logger?.error("finalizeResalePurchase.listing_commit_refused", {
      orderId: order.id,
      listingId,
      listingStatus: listing.status,
      listingBuyerOrderId: listing.buyerOrderId,
    });
    throw fail("LISTING_NOT_ACTIVE", {
      meta: {
        orderId: order.id,
        listingId,
        reason: "resale_listing_commit_refused",
        listingStatus: listing.status,
        listingBuyerOrderId: listing.buyerOrderId,
      },
    });
  }

  // A committed listing with no ticket (id or row) has transferred nothing.
  // Same reasoning as above: never let the order succeed and the seller be
  // credited without the buyer holding the ticket.
  const ticketId = commitResult.ticketId;
  if (!ticketId) {
    logger?.error("finalizeResalePurchase.commit_missing_ticket_id", {
      orderId: order.id,
      listingId,
    });
    throw fail("TICKET_NOT_FOUND", {
      meta: {
        orderId: order.id,
        listingId,
        reason: "resale_commit_missing_ticket_id",
      },
    });
  }

  // ── 2. Load the committed ticket so we can reassign it to the resale order ──
  const ticket = await tx.tickets.getById(ticketId);
  if (!ticket) {
    logger?.error("finalizeResalePurchase.ticket_not_found", {
      orderId: order.id,
      ticketId,
    });
    throw fail("TICKET_NOT_FOUND", {
      meta: {
        orderId: order.id,
        listingId,
        ticketId,
        reason: "resale_committed_ticket_row_missing",
      },
    });
  }

  const sellerHumanId = listing.sellerHumanId;
  const originalOrderItemId = ticket.orderItemId;

  // ── Defence in depth: the seller must still hold an unrefunded item ──
  // The refund paths refuse a listed ticket (`listing_active`), so this
  // should be unreachable. If it is reached anyway — a refund landed while
  // the listing stayed live — step 4 below would rewrite `refunded` as
  // `transferred` and the seller would keep the refund AND the proceeds.
  // Throwing here aborts the enclosing finalize transaction, listing commit
  // included; the paid order is left for manual review rather than paying
  // twice. A missing item row is not this failure and is left to step 4.
  if (originalOrderItemId) {
    const originalItem = await tx.orderItems.getById(originalOrderItemId);
    if (
      originalItem &&
      (originalItem.status === "refunded" || originalItem.refundedAt)
    ) {
      logger?.error("finalizeResalePurchase.original_item_refunded", {
        orderId: order.id,
        listingId,
        ticketId,
        originalOrderItemId,
      });
      throw fail("RESALE_ORIGINAL_ITEM_REFUNDED", {
        meta: { orderId: order.id, listingId, ticketId, originalOrderItemId },
      });
    }
  }

  // ── 3. Reassign ticket to the resale order + regenerate QR code ─────
  // Listing commit already transferred ownership to the buyer. We now:
  //   a) Point the ticket at the new resale order / order-item
  //   b) Generate a fresh `code` so the seller's old QR is invalidated
  //   c) Flip status back to VALID (it was LISTED during the sale)
  const newCode = generateTicketCode();
  await tx.tickets.reassignForResale({
    ticketId,
    newOrderId: order.id,
    newOrderItemId: ticketItem.id,
    newCode,
  });

  // ── 4. Mark the seller's original OrderItem as transferred ─────────
  // Find the original order item that the seller purchased the ticket with.
  if (originalOrderItemId) {
    await tx.orderItems.updateStatus(originalOrderItemId, "transferred", now);
    // The listing has sold: clear the seller item's "listed now" pointer.
    // Skipped when the seller bought the ticket on resale themselves (a
    // chain): that item's column is the listing IT was bought through, and
    // a refund of the seller's own purchase still reads it
    // (`_helpers/order-item-listing-pointer.ts`).
    await setListedNowPointer(tx, {
      orderItemId: originalOrderItemId,
      listingId: null,
    });
  }

  // ── Audit ──────────────────────────────────────────────────────────
  await tx.audit.log({
    entity: "resale_listing",
    entityId: listingId,
    action: "purchase_finalized",
    data: {
      orderId: order.id,
      ticketId,
      sellerHumanId,
      buyerHumanId: order.buyerHumanId,
    },
    at: now,
  });

  logger?.info("finalizeResalePurchase.succeeded", {
    orderId: order.id,
    listingId,
    ticketId,
    sellerHumanId,
    buyerHumanId: order.buyerHumanId,
  });
}
