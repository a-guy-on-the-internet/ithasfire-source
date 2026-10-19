import type { TxRepos } from "@th/ports/repos";

import { releaseSeatsForVoidedTickets } from "./_shared/release-seats-for-voided-tickets";
import {
  ticketsLeavingOnRefund,
  type TicketLeavingOnRefund,
} from "./_shared/tickets-leaving-on-refund";

export type MarkOrderTicketsRefundedOptions = {
  /**
   * Clock reading for the seat release this write performs. Required, not
   * defaulted: the seats freed here are stamped with it, and `new Date()`
   * inside a use case is exactly the untestable drift the clock port exists
   * to prevent.
   */
  at: Date;
  /**
   * Also flip LISTED tickets. Default `false`: the refund paths treat a
   * listed ticket as ineligible upstream (`listing_active`), so a LISTED
   * ticket reaching them is a bug to surface, not silently refund. ONLY
   * `cancelEvent` passes `true` — it cancels every open listing of the event
   * in the same transaction first, so the LISTED ticket has no live listing
   * left and must go REFUNDED with its order (money audit 2026-09-08 #22).
   * That is also why freeing its seat below is safe: no open listing can
   * still sell the ticket that was sitting in it.
   */
  includeListed?: boolean;
  /**
   * Also kill the tickets of items this order has already TRANSFERRED away
   * (gift / email claim). Default `false`, and the default is the safe one —
   * a new caller that forgets this flag cannot burn a stranger's pass.
   *
   * A transfer moves only `Ticket.ownerHumanId`: the ticket keeps this
   * order's `orderId` and stays VALID, so `listByOrderId` still returns it.
   * The sender's item goes `transferred`, which every refund quote treats as
   * ineligible (`already_transferred`) — so the sender is NOT refunded for
   * it. Voiding it anyway killed the recipient's pass, and (once seats came
   * back) put an occupied seat back on sale for a third buyer: two people
   * with a claim on one seat, the org paid twice, nobody refunded.
   *
   * ONLY `cancelEvent` passes `true`, deliberately: cancelling a show voids
   * the whole house, gifted passes included, because there is no show to
   * attend and the seat map is being emptied on purpose.
   */
  voidTransferred?: boolean;
};

export type MarkOrderTicketsRefundedResult = {
  /** Seat ids released, for the caller's audit row. */
  releasedSeatIds: string[];
  /**
   * The voided tickets that were SCANNED when this call read them: each had
   * admitted someone, and the refund means they left. For the caller's audit
   * row (`leftOnRefundAuditData`); empty when nothing voided had been scanned.
   */
  leftOnRefund: TicketLeavingOnRefund[];
};

/**
 * Flip an order's live tickets to REFUNDED and give their reserved seats back.
 *
 * Returns what the caller's audit row needs: the seats released, and the
 * tickets that had already admitted someone.
 */
export async function markOrderTicketsRefunded(
  tx: TxRepos,
  orderId: string,
  options: MarkOrderTicketsRefundedOptions,
): Promise<MarkOrderTicketsRefundedResult> {
  const includeListed = options.includeListed === true;
  const voidTransferred = options.voidTransferred === true;
  const tickets = await tx.tickets.listByOrderId(orderId);

  // Items this order gave away. Read only when they matter, so the whole-house
  // cancel path pays nothing for a lookup whose answer it would ignore.
  const transferredItemIds = new Set<string>();
  if (!voidTransferred && tickets.length > 0) {
    const items = await tx.orderItems.listByOrderId(orderId);
    for (const item of items) {
      if (item.status === "transferred" || item.transferredAt) {
        transferredItemIds.add(item.id);
      }
    }
  }

  const voided = tickets.filter((ticket) => {
    if (
      ticket.orderItemId != null &&
      transferredItemIds.has(ticket.orderItemId)
    ) {
      return false;
    }
    return (
      ticket.status === "VALID" ||
      ticket.status === "SCANNED" ||
      (includeListed && ticket.status === "LISTED")
    );
  });

  // Taken BEFORE the write: it clears `scannedAt` and the status with it.
  const leftOnRefund = ticketsLeavingOnRefund(voided);

  await Promise.all(
    voided.map(async (ticket) => {
      await tx.tickets.setStatus(ticket.id, "REFUNDED", { scannedAt: null });
    }),
  );

  // Only the tickets THIS call just killed — a ticket left alive (already
  // REFUNDED/INVALID, a transferred item's pass now held by someone else, or
  // LISTED under a live listing when `includeListed` is false) keeps its seat.
  const releasedSeatIds = await releaseSeatsForVoidedTickets(
    tx,
    voided,
    options.at,
  );
  return { releasedSeatIds, leftOnRefund };
}
