import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { OrderItemRecord, OrderRecord } from "@th/ports/repos/orders";
import type { ReporterPort } from "@th/ports/reporter";

import { getMetaString } from "../../lib/orders/meta";
import { generateTicketCode } from "../../lib/tickets/generate-ticket-code";
import { setListedNowPointer } from "../_helpers/order-item-listing-pointer";
import {
  leftOnRefundAuditData,
  ticketsLeavingOnRefund,
} from "../orders/_shared/tickets-leaving-on-refund";
import { fail } from "@th/errors";

type ResaleUnwindRepos = Pick<Repos, "orders" | "tickets" | "resaleListings">;
/** A seller's order that could not be read: not RESALE as far as we know. */
const UNKNOWN_ORDER_SOURCE = "UNKNOWN";
type ResaleListingUnwindDisposition = "restore_active" | "cancel";
type AssertResaleOrderCanBeUnwoundOptions = {
  allowAlreadyUnwound?: boolean;
  /**
   * Pass a ticket that has been SOLD ON (the buyer listed it again and a
   * later buyer holds it now). The unwind does not throw for it: it leaves
   * the ticket with its holder and lets the refund commit, reported.
   *
   * Only for a caller whose money has ALREADY moved (the Stripe refund
   * webhook), where refusing means a rollback after the buyer was paid back.
   * A caller that can still refuse before it pays anyone leaves this off and
   * gets `TICKET_NOT_FOUND` (`meta.reason: "sold_on"`).
   */
  allowSoldOn?: boolean;
  /**
   * Items of THIS order whose ticket was sold on to a later buyer, where the
   * caller has refunded that later purchase and unwinds it BEFORE this
   * order, in the same transaction (an event cancellation walking a resale
   * chain back, last buyer first). By this order's turn the ticket is back
   * on the item, so the unwind finds it there.
   *
   * Unlike `allowSoldOn`, this is for a caller that has NOT moved this
   * order's money yet: a sold-on item it does not name is still refused.
   */
  soldOnItemIdsUnwoundFirst?: ReadonlySet<string>;
};

/**
 * The refunded buyer's own listing for the ticket was HELD by a third
 * person's checkout when the refund landed (case b). What a person needs to
 * settle that checkout.
 */
type CheckoutInFlight = {
  listingId: string;
  /** False only if the HELD → CANCELLED close flipped nothing. */
  listingClosed: boolean;
  listingStatusAfter: string;
  holdBuyerHumanId: string | null;
  heldUntil: string | null;
  /** The hold's buyer's orders for that listing, with their status. */
  orders: Array<{ id: string; status: string }>;
};

/**
 * The pre-check a refund path runs BEFORE it moves money. It must never pass
 * a state the unwind below then throws on (that would roll the refund's
 * transaction back after Stripe has paid the buyer), so the two are kept in
 * step:
 *
 * - ticket still on this order item, whatever its status, the refunded
 *   buyer's own live listing included (ACTIVE or HELD) → passes; the unwind
 *   closes that listing and hands the ticket back.
 * - ticket gone and the sale already unwound → passes with
 *   `allowAlreadyUnwound`.
 * - ticket gone because it was sold on → passes with `allowSoldOn`, or for
 *   an item named in `soldOnItemIdsUnwoundFirst`.
 * - anything else → `TICKET_NOT_FOUND`.
 */
export async function assertResaleOrderCanBeUnwound(
  repos: ResaleUnwindRepos,
  order: OrderRecord,
  options: AssertResaleOrderCanBeUnwoundOptions = {},
): Promise<void> {
  const {
    allowAlreadyUnwound = false,
    allowSoldOn = false,
    soldOnItemIdsUnwoundFirst,
  } = options;

  if (order.source !== "RESALE") {
    return;
  }

  for (const ticketItem of order.items.filter(
    (item) => item.kind === "ticket",
  )) {
    const listingId =
      ticketItem.resaleListingId ??
      getMetaString(ticketItem.meta, "resaleListingId");
    if (!listingId) {
      throw fail("RESALE_UNWIND_MISSING_LISTING_ID");
    }

    const listing = await repos.resaleListings.getById(listingId);
    if (!listing) {
      throw fail("LISTING_NOT_FOUND", { meta: { via: "unwind" }, category: "CONFLICT" });
    }

    const ticket = await repos.tickets.getByOrderItemId(ticketItem.id);
    if (!ticket) {
      const gone = await classifyTicketGoneFromResaleItem(repos, {
        listingId,
        orderId: order.id,
        resaleOrderItemId: ticketItem.id,
        sellerHumanId: listing.sellerHumanId,
      });
      if (gone.kind === "already_unwound" && allowAlreadyUnwound) {
        continue;
      }
      if (
        gone.kind === "sold_on" &&
        (allowSoldOn || soldOnItemIdsUnwoundFirst?.has(ticketItem.id))
      ) {
        continue;
      }

      throw fail("TICKET_NOT_FOUND", {
        meta:
          gone.kind === "sold_on"
            ? { via: "unwind", reason: "sold_on" }
            : { via: "unwind" },
        category: "CONFLICT",
      });
    }
  }
}

/**
 * A seller to tell, after the refund commits, that their listing was closed
 * because it was priced under the removed markup split
 * (organiser-resale-share FR-015). Sent by `sendLegacyRelistNotices`.
 */
export type LegacyRelistNotice = {
  sellerHumanId: string;
  listingId: string;
  eventId: string;
  askPriceCents: number;
  currency: string;
  /** The seller's order that holds the ticket again: the relist link opens on it. */
  sellerOrderId: string | null;
  refundedOrderId: string;
};

export type UnwindResaleOrderAfterRefundResult = {
  /**
   * Only from an unwind that ran: a replay that finds the order already
   * unwound returns none, so a seller is told once.
   */
  relistNotices: LegacyRelistNotice[];
};

export async function unwindResaleOrderAfterRefund(
  tx: TxRepos,
  params: {
    order: OrderRecord;
    clock: ClockPort;
    logger?: LoggerPort;
    listingDisposition?: ResaleListingUnwindDisposition;
    /**
     * Reports a refunded resale ticket that was NOT handed back to its
     * seller (the degraded branches below): it was already REFUNDED /
     * INVALID, or it had been sold on to a later buyer. Also reports two
     * hand-backs a person has to follow up: one that ended a third person's
     * checkout on the refunded buyer's own listing, and one to a seller
     * whose own resale purchase had already been refunded.
     */
    reportError?: ReporterPort | null;
  },
): Promise<UnwindResaleOrderAfterRefundResult> {
  const {
    order,
    clock,
    logger,
    listingDisposition = "restore_active",
    reportError,
  } = params;
  const relistNotices: LegacyRelistNotice[] = [];

  if (order.source !== "RESALE") {
    return { relistNotices };
  }

  const now = clock.now();

  for (const ticketItem of order.items.filter(
    (item) => item.kind === "ticket",
  )) {
    const listingId =
      ticketItem.resaleListingId ??
      getMetaString(ticketItem.meta, "resaleListingId");
    if (!listingId) {
      throw fail("RESALE_UNWIND_MISSING_LISTING_ID");
    }

    const listing = await tx.resaleListings.getById(listingId);
    if (!listing) {
      throw fail("LISTING_NOT_FOUND", { meta: { via: "unwind" }, category: "CONFLICT" });
    }

    // What the sold-on branch needs to leave a ticket where it is.
    const leaveWithHolder = (heldTicket: {
      id: string;
      orderItemId: string | null;
      ownerHumanId: string;
      status: string;
    }) =>
      leaveTicketWithHolder(tx, {
        order,
        ticketItem,
        listing,
        ticket: heldTicket,
        now,
        logger,
        reportError,
      });

    let ticket = await tx.tickets.getByOrderItemId(ticketItem.id);
    if (!ticket) {
      const gone = await classifyTicketGoneFromResaleItem(tx, {
        listingId,
        orderId: order.id,
        resaleOrderItemId: ticketItem.id,
        sellerHumanId: listing.sellerHumanId,
      });
      if (gone.kind === "already_unwound") {
        logger?.info("unwindResaleOrderAfterRefund.already_unwound", {
          orderId: order.id,
          orderItemId: ticketItem.id,
          listingId,
        });
        continue;
      }
      if (gone.kind === "sold_on") {
        // ── The ticket has been sold on (case c) ──────────────────────
        // The refunded buyer listed it again and a later buyer holds it.
        // Nothing is taken from that holder. Reported: see
        // `leaveTicketWithHolder`.
        await leaveWithHolder(gone.ticket);
        continue;
      }

      throw fail("TICKET_NOT_FOUND", { meta: { via: "unwind" }, category: "CONFLICT" });
    }

    // ── The refunded buyer has listed the ticket again ────────────────
    // A ticket can be resold any number of times (owner ruling 2026-10-11),
    // so the buyer being refunded may have a listing of their own open on
    // it. LISTED is the one status such a ticket has, and the only one from
    // which a later buyer's finalize can take it (`reassignForResale`).
    //
    // Lock the ticket row and read it again before deciding: ticket first,
    // then listing, the order `commit`, `releaseHold`, `cancelOpenForEvent`
    // and the seller's own cancel take. A later buyer's finalize writes the
    // ticket first too, so it has either committed (the ticket is no longer
    // on this item: sold on) or waits for this transaction.
    //
    // Taken for every ticket that is not already dead, not only a LISTED
    // one: a ticket whose status has drifted from its listing (VALID or
    // SCANNED with a live listing row still open) is closed out below the
    // same way, and that decision needs the same lock.
    if (ticket.status !== "REFUNDED" && ticket.status !== "INVALID") {
      const locked = await tx.tickets.getByIdForUpdate(ticket.id);
      if (!locked) {
        throw fail("TICKET_NOT_FOUND", { meta: { via: "unwind" }, category: "CONFLICT" });
      }
      if (locked.orderItemId !== ticketItem.id) {
        // Sold on between the read above and the lock.
        await leaveWithHolder(locked);
        continue;
      }
      ticket = locked;
    }

    // ── The ticket is already dead (REFUNDED / INVALID) ───────────────
    // Voided some other way while the buyer held it (a comp revoked before
    // the revoke learned to leave a resold comp alone, say). It has given its
    // capacity place back and is terminal: there is nothing to hand back to
    // the seller, and `restoreAfterResale` refuses it. Throwing here would
    // roll back the CALLER's transaction, after Stripe has already refunded
    // the buyer: no `markRefunded`, no REFUND_DEBIT, the seller keeping
    // credit for a refunded sale, and the webhook replaying the same throw
    // into the DLQ. So: leave the ticket as it is, close the sale's listing,
    // and let the refund commit. Reported, because the seller gets no ticket
    // back and a person should know why.
    if (ticket.status === "REFUNDED" || ticket.status === "INVALID") {
      const saleStillOpen =
        listing.status === "SOLD" && listing.buyerOrderId === order.id;
      if (saleStillOpen) {
        await tx.resaleListings.unwindSale(listingId, order.id, "CANCELLED");
      }
      await tx.audit.log({
        entity: "resale_listing",
        entityId: listingId,
        action: "purchase_unwound_after_refund",
        data: {
          refundedOrderId: order.id,
          refundedOrderItemId: ticketItem.id,
          ticketId: ticket.id,
          buyerHumanId: order.buyerHumanId,
          sellerHumanId: listing.sellerHumanId,
          ticketAlreadyTerminal: ticket.status,
          ticketRestoredToSeller: false,
          listingStatusAfterRefund: saleStillOpen ? "CANCELLED" : listing.status,
        },
        at: now,
      });
      logger?.error("unwindResaleOrderAfterRefund.ticket_already_terminal", {
        orderId: order.id,
        orderItemId: ticketItem.id,
        listingId,
        ticketId: ticket.id,
        ticketStatus: ticket.status,
      });
      try {
        reportError?.(new Error("resale_unwind_ticket_already_terminal"), {
          tags: {
            useCase: "unwindResaleOrderAfterRefund",
            ticketStatus: ticket.status,
          },
          extra: {
            orderId: order.id,
            orderItemId: ticketItem.id,
            listingId,
            ticketId: ticket.id,
          },
        });
      } catch {
        // A throwing reporter must never change behaviour.
      }
      continue;
    }

    // ── Close the refunded buyer's own listing first (cases a and b) ──
    // The sale being undone is `listing`; `getByTicketId` returns the
    // ticket's LIVE listing when it has one, which can only be a later one
    // the refunded buyer opened. The ticket is about to leave that buyer, so
    // their listing cannot be honoured, and it has to go before `listing`
    // can come back to ACTIVE: one ticket has one live listing (index
    // "Listing_ticketId_live_key").
    //
    // Looked up whatever the ticket's status (dead tickets left above). A
    // LISTED ticket is the expected case, but the index is on the LISTING
    // rows: a VALID or SCANNED ticket with a live row left behind by drift
    // would otherwise reach `unwindSale(…, "ACTIVE")` and fail on that
    // index after Stripe has paid the refund.
    let closedBuyerListingId: string | null = null;
    let checkoutInFlight: CheckoutInFlight | null = null;
    {
      const live = await tx.resaleListings.getByTicketId(ticket.id);
      if (
        live &&
        live.id !== listingId &&
        (live.status === "ACTIVE" || live.status === "HELD")
      ) {
        // (a) ACTIVE → CANCELLED as a compare-and-swap. A buyer's `hold`
        // takes only the listing row, so whichever flips it first wins.
        const cancelled =
          live.status === "ACTIVE" &&
          (await tx.resaleListings.cancel(
            live.id,
            // `cancel` is seller-scoped and there is no seller actor here:
            // pass the listing's own seller, as the refund heal does.
            live.sellerHumanId,
          ));
        if (cancelled) {
          closedBuyerListingId = live.id;
          await tx.audit.log({
            entity: "resale_listing",
            entityId: live.id,
            action: "cancelled",
            data: {
              ticketId: ticket.id,
              sellerHumanId: live.sellerHumanId,
              reason: "seller_purchase_refunded",
              refundedOrderId: order.id,
              refundedOrderItemId: ticketItem.id,
              purchasedListingId: listingId,
            },
            at: now,
          });
        } else {
          // (b) HELD: a third person's checkout is in flight and may already
          // be paid. It cannot complete either way: every refund path has
          // marked this buyer's item refunded before calling the unwind, and
          // `finalizeResalePurchase` refuses a refunded seller item. So the
          // ticket still goes back to the seller it was bought from, who has
          // been debited for this refund, and the held listing is closed
          // here so it does not sit on sale for a ticket its seller no
          // longer holds.
          //
          // Safe under the ticket row lock taken above: `commit` writes the
          // ticket first, so the checkout's finalize has either committed
          // (the ticket was then no longer on this item: sold on, handled
          // above) or waits for this transaction, and then meets a CANCELLED
          // listing and throws (`resale_listing_not_sellable`). It can never
          // take the ticket. Same thing `cancelOpenForEvent` does to a HELD
          // listing. A close that flips nothing is recorded, never thrown:
          // the sale below goes to CANCELLED, which needs no live slot.
          const closed = await tx.resaleListings.closeHeld(live.id);
          const after = await tx.resaleListings.getById(live.id);
          const afterStatus = after?.status ?? live.status;
          if (closed.closed || afterStatus === "HELD" || afterStatus === "ACTIVE") {
            const holdOrders = closed.hold
              ? await tx.resaleListings.listOrdersForHold(
                  live.id,
                  closed.hold.buyerHumanId,
                )
              : [];
            checkoutInFlight = {
              listingId: live.id,
              listingClosed: closed.closed,
              listingStatusAfter: afterStatus,
              holdBuyerHumanId: closed.hold?.buyerHumanId ?? null,
              heldUntil: closed.hold?.heldUntil.toISOString() ?? null,
              orders: holdOrders.map((held) => ({
                id: held.id,
                status: held.status,
              })),
            };
            if (closed.closed) {
              await tx.audit.log({
                entity: "resale_listing",
                entityId: live.id,
                action: "cancelled",
                data: {
                  ticketId: ticket.id,
                  sellerHumanId: live.sellerHumanId,
                  reason: "seller_purchase_refunded_checkout_in_flight",
                  refundedOrderId: order.id,
                  refundedOrderItemId: ticketItem.id,
                  purchasedListingId: listingId,
                  holdBuyerHumanId: checkoutInFlight.holdBuyerHumanId,
                  heldUntil: checkoutInFlight.heldUntil,
                  inFlightOrders: checkoutInFlight.orders,
                },
                at: now,
              });
            }
          }
          // Otherwise it was closed by someone else since the read (expired,
          // or the seller cancelled it): nothing live is left, carry on.
        }
      }
    }

    // The buyer may have been scanned in on this ticket; refunding them means
    // they left (owner ruling 2026-10-10). Taken from the ticket as read
    // above, BEFORE the writes below: `restoreAfterResale` sets it VALID and
    // clears `scannedAt`, so afterwards nothing on the row says it was used.
    // This only records it; what the unwind does to the ticket is unchanged.
    const leftOnRefund = ticketsLeavingOnRefund([ticket]);

    const restoredOrderId =
      order.parentOrderId ??
      getMetaString(ticketItem.meta, "resaleOriginalOrderId") ??
      null;
    const restoredOrderItemId = await resolveRestoredOrderItemId(tx, {
      restoredOrderId,
      resaleOrderItem: ticketItem,
    });
    if (restoredOrderId && !restoredOrderItemId) {
      logger?.warn(
        "unwindResaleOrderAfterRefund.original_order_item_ambiguous",
        {
          orderId: order.id,
          orderItemId: ticketItem.id,
          listingId,
          restoredOrderId,
        },
      );
    }

    if (ticket.ownerHumanId !== listing.sellerHumanId) {
      // Deliberately NO `expectedStatus`: this hands a refunded resale ticket
      // back to its seller and must do so whatever status the buyer left it
      // in — a SCANNED ticket still goes home. Pinning VALID here would strand
      // the seller's ticket with the refunded buyer.
      //
      // The owner predicate is still there, and a `false` means the same thing
      // the adapter's old `throw new Error("not owner")` did: somebody already
      // moved this ticket. On a replay of a completed unwind that somebody was
      // us, which is what `wasResaleRefundAlreadyUnwound` checks.
      const transferred = await tx.tickets.transfer({
        ticketId: ticket.id,
        fromHumanId: ticket.ownerHumanId,
        toHumanId: listing.sellerHumanId,
        reason: "admin",
        orderId: order.id,
      });

      if (!transferred) {
        if (
          await wasResaleRefundAlreadyUnwound(tx, {
            listingId,
            orderId: order.id,
            resaleOrderItemId: ticketItem.id,
            sellerHumanId: listing.sellerHumanId,
          })
        ) {
          logger?.info(
            "unwindResaleOrderAfterRefund.transfer_already_replayed",
            {
              orderId: order.id,
              orderItemId: ticketItem.id,
              listingId,
              ticketId: ticket.id,
            },
          );
          continue;
        }

        // Not a replay: the ticket moved out from under us for some other
        // reason. Same refusal as before — never a silent skip, because
        // continuing would unwind the listing and the money while leaving the
        // ticket with the refunded buyer.
        throw new Error("not owner");
      }
    }

    // The seller's own order. In a chain the seller bought the ticket on
    // resale too, and that purchase may ALREADY have been refunded while
    // the ticket was out of reach (it had been sold on: see
    // `leaveTicketWithHolder`). The ticket is still handed back to them,
    // since this refund has to commit and they are who this sale bought it
    // from, but their listing is not put back on sale (they would be paid
    // for it a second time) and a person is told: the ticket belongs one
    // step further up the chain.
    const sellerOrder =
      restoredOrderItemId && restoredOrderId
        ? await tx.orders.getById(restoredOrderId)
        : null;
    const sellerPurchaseAlreadyRefunded =
      sellerOrder?.source === "RESALE" && sellerOrder.status === "REFUNDED";

    // With a checkout in flight on the refunded buyer's listing the sale is
    // never put back on sale: CANCELLED needs no live slot, so this cannot
    // hit the index whatever became of that listing.
    const nextListingStatus =
      sellerPurchaseAlreadyRefunded || checkoutInFlight
        ? "CANCELLED"
        : resolveListingStatusAfterRefund(listing, now, listingDisposition);
    // Closed ONLY because it has no event share: it would otherwise have
    // gone back on sale, so the seller is told to list it again.
    const legacyListingClosed =
      nextListingStatus === "CANCELLED" &&
      !sellerPurchaseAlreadyRefunded &&
      !checkoutInFlight &&
      listing.eventShareCents == null &&
      resolveListingStatusAfterRefund(
        { ...listing, eventShareCents: 0 },
        now,
        listingDisposition,
      ) === "ACTIVE";

    await tx.tickets.restoreAfterResale({
      ticketId: ticket.id,
      restoredOrderId: restoredOrderId ?? null,
      restoredOrderItemId,
      newCode: generateTicketCode(),
    });

    if (restoredOrderItemId) {
      await tx.orderItems.updateStatus(restoredOrderItemId, "active", now);
      // The seller's item gets its "listed now" pointer back, unless the
      // seller bought the ticket on resale too (a chain): that item's
      // column is the listing IT was bought through and is never rewritten.
      // The seller's order is named by the refunded order; when it cannot
      // be read the pointer is written as it always was. With no order
      // named at all, the helper finds it through the item.
      const restoredOrderSource = restoredOrderId
        ? (sellerOrder?.source ?? UNKNOWN_ORDER_SOURCE)
        : null;
      await setListedNowPointer(tx, {
        orderItemId: restoredOrderItemId,
        listingId: nextListingStatus === "ACTIVE" ? listingId : null,
        orderSource: restoredOrderSource,
      });
    }

    if (nextListingStatus === "ACTIVE") {
      // VALID → LISTED, guarded like every write into a place-holding status
      // (refunds-restock spec 2026-10-09). `restoreAfterResale` just set VALID
      // in this tx and holds the row lock, so `false` means a broken
      // invariant, not a race: fail loudly rather than relist a dead ticket.
      const relisted = await tx.tickets.setStatus(ticket.id, "LISTED", {
        expectedStatus: "VALID",
      });
      if (!relisted) {
        throw fail("TICKET_NOT_ELIGIBLE_FOR_RESALE", {
          meta: { via: "unwind", ticketId: ticket.id },
        });
      }
    }

    await tx.resaleListings.unwindSale(listingId, order.id, nextListingStatus);

    await tx.audit.log({
      entity: "resale_listing",
      entityId: listingId,
      action: "purchase_unwound_after_refund",
      data: {
        refundedOrderId: order.id,
        refundedOrderItemId: ticketItem.id,
        ticketId: ticket.id,
        buyerHumanId: order.buyerHumanId,
        sellerHumanId: listing.sellerHumanId,
        restoredOrderId: restoredOrderId ?? null,
        restoredOrderItemId,
        listingStatusAfterRefund: nextListingStatus,
        // The refunded buyer's own listing for the ticket, closed above.
        ...(closedBuyerListingId
          ? { closedBuyerListingId }
          : {}),
        ...(sellerPurchaseAlreadyRefunded
          ? { sellerPurchaseAlreadyRefunded: true, sellerRefundedOrderId: restoredOrderId }
          : {}),
        // A third person's checkout held the refunded buyer's listing.
        ...(checkoutInFlight
          ? { ticketRestoredToSeller: true, checkoutInFlight }
          : {}),
        // The refunded buyer had been scanned in on it: they left.
        ...leftOnRefundAuditData(leftOnRefund),
        ...(legacyListingClosed ? { legacyListingClosed: true } : {}),
      },
      at: now,
    });

    if (legacyListingClosed) {
      // Data only: the caller tells the seller AFTER its transaction commits,
      // so a notice can never undo or block the refund.
      relistNotices.push({
        sellerHumanId: listing.sellerHumanId,
        listingId,
        eventId: listing.eventId,
        askPriceCents: listing.askPriceCents,
        currency: listing.currency,
        sellerOrderId: restoredOrderId ?? null,
        refundedOrderId: order.id,
      });
    }

    // Still a degraded result, though the ticket went home: somebody's
    // checkout was ended under them and may have been paid. Their finalize
    // throws and their order lands in the webhook DLQ; a person settles it.
    if (checkoutInFlight) {
      const details = {
        orderId: order.id,
        orderItemId: ticketItem.id,
        listingId,
        ticketId: ticket.id,
        buyerHumanId: order.buyerHumanId,
        sellerHumanId: listing.sellerHumanId,
        ticketRestoredToSeller: true,
        purchasedListingId: listingId,
        purchasedListingStatusAfter: nextListingStatus,
        checkoutInFlight,
      };
      logger?.error(
        "unwindResaleOrderAfterRefund.relisted_checkout_in_flight",
        details,
      );
      try {
        reportError?.(
          new Error("resale_unwind_ticket_relisted_checkout_in_flight"),
          {
            tags: {
              useCase: "unwindResaleOrderAfterRefund",
              reason: "relisted_checkout_in_flight",
            },
            extra: details,
          },
        );
      } catch {
        // A throwing reporter must never change behaviour.
      }
    }

    if (sellerPurchaseAlreadyRefunded) {
      const details = {
        orderId: order.id,
        orderItemId: ticketItem.id,
        listingId,
        ticketId: ticket.id,
        sellerHumanId: listing.sellerHumanId,
        sellerRefundedOrderId: restoredOrderId,
        sellerRefundedOrderItemId: restoredOrderItemId,
      };
      logger?.error(
        "unwindResaleOrderAfterRefund.ticket_returned_to_refunded_buyer",
        details,
      );
      try {
        reportError?.(
          new Error("resale_unwind_ticket_returned_to_refunded_buyer"),
          {
            tags: {
              useCase: "unwindResaleOrderAfterRefund",
              reason: "seller_purchase_already_refunded",
            },
            extra: details,
          },
        );
      } catch {
        // A throwing reporter must never change behaviour.
      }
    }
  }

  return { relistNotices };
}

function resolveListingStatusAfterRefund(
  listing: {
    expiresAt: Date | null;
    saleCutoffAt: Date | null;
    eventShareCents?: number | null;
  },
  now: Date,
  listingDisposition: ResaleListingUnwindDisposition,
): "ACTIVE" | "CANCELLED" {
  if (listingDisposition === "cancel") {
    return "CANCELLED";
  }

  // A listing priced under the removed markup split (no event share,
  // organiser-resale-share FR-014/FR-015). Checkout refuses it, so back on
  // sale it could never sell: it is closed, the ticket goes home VALID, and
  // the seller is told to list again (see `legacyListingClosed` below).
  if (listing.eventShareCents == null) {
    return "CANCELLED";
  }

  if (listing.expiresAt && listing.expiresAt <= now) {
    return "CANCELLED";
  }

  if (listing.saleCutoffAt && listing.saleCutoffAt <= now) {
    return "CANCELLED";
  }

  return "ACTIVE";
}

type TicketGoneFromResaleItem =
  | { kind: "already_unwound" }
  | {
      kind: "sold_on";
      ticket: {
        id: string;
        orderItemId: string | null;
        ownerHumanId: string;
        status: string;
      };
    }
  | { kind: "unknown" };

/**
 * No ticket hangs off the refunded resale order item. Why?
 *
 * The two answers that are not corruption are told apart by ONE fact, the
 * sale's own listing row, and cannot both be true:
 *
 * - `already_unwound`: the listing is NO LONGER sold to this order. The
 *   unwind's last write (`unwindSale`) takes it out of SOLD and clears
 *   `buyerOrderId` in the same transaction that moved the ticket, so a
 *   completed unwind always reads this way. Confirmed structurally: the
 *   ticket is back with the seller, on another item.
 * - `sold_on`: the listing is STILL sold to this order, so nothing has been
 *   unwound, and the ticket hangs off a different order item. Only a later
 *   resale purchase (`reassignForResale`) moves a ticket off its buyer's
 *   item while that buyer's purchase stands.
 *
 * Anything else (no ticket row, a ticket on no item, a sale that is gone
 * with the ticket not back at the seller) is `unknown`, and is refused.
 */
async function classifyTicketGoneFromResaleItem(
  repos: Pick<Repos, "tickets" | "resaleListings">,
  params: {
    listingId: string;
    orderId: string;
    resaleOrderItemId: string;
    sellerHumanId: string;
  },
): Promise<TicketGoneFromResaleItem> {
  const listing = await repos.resaleListings.getById(params.listingId);
  if (!listing) {
    return { kind: "unknown" };
  }

  const currentTicket = await repos.tickets.getById(listing.ticketId);
  if (!currentTicket) {
    return { kind: "unknown" };
  }

  const saleStands =
    listing.status === "SOLD" && listing.buyerOrderId === params.orderId;

  if (saleStands) {
    return currentTicket.orderItemId &&
      currentTicket.orderItemId !== params.resaleOrderItemId
      ? { kind: "sold_on", ticket: currentTicket }
      : { kind: "unknown" };
  }

  return currentTicket.ownerHumanId === params.sellerHumanId &&
    currentTicket.orderItemId !== params.resaleOrderItemId
    ? { kind: "already_unwound" }
    : { kind: "unknown" };
}

async function wasResaleRefundAlreadyUnwound(
  repos: Pick<Repos, "tickets" | "resaleListings">,
  params: {
    listingId: string;
    orderId: string;
    resaleOrderItemId: string;
    sellerHumanId: string;
  },
): Promise<boolean> {
  return (
    (await classifyTicketGoneFromResaleItem(repos, params)).kind ===
    "already_unwound"
  );
}

/**
 * The degraded result for a refunded resale ticket that has been SOLD ON
 * (case c): it cannot go back to the seller it was bought from without
 * taking it from the later buyer who holds it now.
 *
 * Same shape as the "ticket is already dead" branch, for the same reason:
 * the caller's transaction marks the order refunded and writes REFUND_DEBIT
 * AFTER Stripe has refunded the buyer, so throwing would roll all of that
 * back and send the webhook to the DLQ on every replay. Instead:
 *
 * - the ticket is not moved, restored or relisted;
 * - the sale's listing is left as it is (still SOLD to the refunded order),
 *   and the seller's original item stays `transferred`;
 * - an audit row and a report say what a person needs to act on it.
 *
 * Nothing is recovered from the refunded buyer here (no clawback, no payout
 * hold): that is an open owner question.
 *
 * DEFENCE ONLY: no refund path reaches this today. The Stripe webhook
 * (`reconcileStripeFullRefund`) locks the ticket row, reads the order again
 * and sends a ticket sold on to manual review before it writes anything,
 * and the paths that refund before money moves refuse it in
 * `assertResaleOrderCanBeUnwound`. An event cancellation refunds a sold-on
 * purchase only after the later one, and unwinds the later one first, so
 * the ticket is back on the item before this is asked. Kept so that a caller
 * that does arrive here with money already moved does not throw.
 */
async function leaveTicketWithHolder(
  tx: TxRepos,
  params: {
    order: OrderRecord;
    ticketItem: OrderItemRecord;
    listing: { id: string; sellerHumanId: string; status: string };
    ticket: {
      id: string;
      orderItemId: string | null;
      ownerHumanId: string;
      status: string;
    };
    now: Date;
    logger?: LoggerPort;
    reportError?: ReporterPort | null;
  },
): Promise<void> {
  const { order, ticketItem, listing, ticket, now, logger, reportError } =
    params;
  const reason = "sold_on";

  // Who holds it now, and through which listing. The holder's item is a
  // later resale purchase and its own pointer names the listing it was
  // bought through (the LAST hop of the chain, which is the refunded
  // buyer's own listing when the chain is two hops long).
  let laterListing: { id: string; status: string } | null = null;
  let currentHolderOrderId: string | null = null;
  if (ticket.orderItemId) {
    const holderItem = await tx.orderItems.getById(ticket.orderItemId);
    currentHolderOrderId = holderItem?.orderId ?? null;
    const holderListingId = holderItem
      ? (holderItem.resaleListingId ??
        getMetaString(holderItem.meta, "resaleListingId") ??
        null)
      : null;
    if (holderListingId && holderListingId !== listing.id) {
      const holderListing = await tx.resaleListings.getById(holderListingId);
      laterListing = {
        id: holderListingId,
        status: holderListing?.status ?? "UNKNOWN",
      };
    }
  }

  const details = {
    refundedOrderId: order.id,
    refundedOrderItemId: ticketItem.id,
    ticketId: ticket.id,
    ticketStatus: ticket.status,
    buyerHumanId: order.buyerHumanId,
    sellerHumanId: listing.sellerHumanId,
    purchasedListingId: listing.id,
    laterListingId: laterListing?.id ?? null,
    laterListingStatus: laterListing?.status ?? null,
    currentHolderHumanId: ticket.ownerHumanId,
    currentHolderOrderItemId: ticket.orderItemId,
    currentHolderOrderId,
  };

  await tx.audit.log({
    entity: "resale_listing",
    entityId: listing.id,
    action: "purchase_unwound_after_refund",
    data: {
      ...details,
      ticketRestoredToSeller: false,
      ticketNotRestoredReason: reason,
      listingStatusAfterRefund: listing.status,
    },
    at: now,
  });
  logger?.error("unwindResaleOrderAfterRefund.ticket_left_with_holder", {
    orderId: order.id,
    orderItemId: ticketItem.id,
    listingId: listing.id,
    reason,
    ...details,
  });
  try {
    reportError?.(new Error("resale_unwind_ticket_sold_on"), {
      tags: { useCase: "unwindResaleOrderAfterRefund", reason },
      extra: {
        orderId: order.id,
        orderItemId: ticketItem.id,
        listingId: listing.id,
        ...details,
      },
    });
  } catch {
    // A throwing reporter must never change behaviour.
  }
}

async function resolveRestoredOrderItemId(
  tx: TxRepos,
  params: {
    restoredOrderId: string | null;
    resaleOrderItem: OrderItemRecord;
  },
): Promise<string | null> {
  const metaOrderItemId = getMetaString(
    params.resaleOrderItem.meta,
    "resaleOriginalOrderItemId",
  );
  if (metaOrderItemId) {
    return metaOrderItemId;
  }

  if (!params.restoredOrderId) {
    return null;
  }

  const originalOrder = await tx.orders.getById(params.restoredOrderId);
  if (!originalOrder) {
    return null;
  }

  const candidates = originalOrder.items.filter((item) => {
    if (item.kind !== "ticket") return false;
    if (item.status !== "transferred" && !item.transferredAt) return false;
    if (
      params.resaleOrderItem.ticketTypeId &&
      item.ticketTypeId &&
      item.ticketTypeId !== params.resaleOrderItem.ticketTypeId
    ) {
      return false;
    }
    return true;
  });

  return candidates.length === 1 ? candidates[0]!.id : null;
}
