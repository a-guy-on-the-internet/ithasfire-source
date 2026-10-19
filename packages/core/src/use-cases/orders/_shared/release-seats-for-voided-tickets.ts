import type { TxRepos } from "@th/ports/repos";

/** The only fields a voided ticket needs for the seat to come back. */
type VoidedTicket = {
  id: string;
  seatId?: string | null;
  /**
   * Where the seat history goes once the ticket's own link is gone. Optional:
   * a ticket with no order item (a comp grant, a legacy row) simply keeps no
   * history — it is not worth failing a refund over.
   */
  orderItemId?: string | null;
};

/**
 * Give the reserved seats of tickets VOIDED in this transaction back to the
 * pool, and drop the dead tickets' claim on them.
 *
 * Both halves are load-bearing, and neither one alone fixes anything:
 *
 *  1. `Seat.status` — `mintTickets` stamped it SOLD and, before this helper
 *     existed, NOTHING ever set it back. Every refund path (`refundFullOrder`,
 *     `refundOrderItems`, `cancelEvent`, `reconcileStripeFullRefund`,
 *     `refundCashSale`) flipped the ticket to REFUNDED and left the seat SOLD
 *     forever, so a refunded reserved seat could never be sold again — and a
 *     whole-house event cancellation bricked every seat in the layout.
 *  2. `Ticket.seatId` — it is `@unique` (packages/db/prisma/ticket.prisma). A
 *     dead ticket still pointing at the seat makes the NEXT buyer's mint fail
 *     with P2002 → `seat_taken` AFTER their card is charged. Freeing the seat
 *     row without clearing the link just moves the failure from checkout to
 *     mint, which is strictly worse.
 *
 * WHY `seats.updateStatuses` AND NOT `seats.releaseSeats`: `releaseSeats` is
 * HELD-gated in the adapter (packages/adapters/src/db/prisma/seats.ts) and
 * these seats are SOLD, so it would silently no-op and leave the seat locked.
 * The unguarded write is correct HERE — and the reason is specific, not
 * general: every id comes from a ticket row this same transaction just read
 * and voided, so it cannot be stale the way a cart reaper's minutes-old hold
 * can. Do not "helpfully" swap this for `releaseSeats`; do not copy the
 * pattern to code that acts on ids it did not just void.
 *
 * (If seats ever gain an operator-set BLOCKED state that can coexist with a
 * sold ticket, this needs a status guard so a release cannot unblock one.)
 *
 * The caller passes ONLY the tickets it actually voided — never one it kept
 * (partial refunds), never a ticket the order GAVE AWAY (a transferred item is
 * not refunded, so its recipient's pass and its seat are not the sender's to
 * surrender), and never a resale unwind, where the ticket goes back to the
 * seller alive and rightly keeps its seat.
 *
 * SEAT HISTORY: clearing `Ticket.seatId` erases the only record of which seat
 * the order sold, so the former seat is stamped onto the order item's
 * `meta.releasedSeatId` first (`orderItems.recordReleasedSeats`), and
 * `getOrgOrder` reads it back. A ticket with no order item keeps no history.
 *
 * POLICY, stated because it is easy to reach by accident: a SCANNED ticket
 * voided on the org/staff refund path frees its seat like any other. Mid-show,
 * with door sales open, that puts a seat someone is physically sitting in back
 * on the map. It is the deliberate reading — the pass is dead, so the attendee
 * has no claim to the seat — but it is a POLICY, not a mechanical consequence.
 * A refund path that wants the opposite must keep the ticket out of this list.
 *
 * Returns the seat ids released, for the caller's audit row.
 */
export async function releaseSeatsForVoidedTickets(
  tx: TxRepos,
  voidedTickets: readonly VoidedTicket[],
  at: Date,
): Promise<string[]> {
  const seated = voidedTickets.filter(
    (ticket): ticket is VoidedTicket & { seatId: string } =>
      typeof ticket.seatId === "string" && ticket.seatId.length > 0,
  );
  if (seated.length === 0) {
    return [];
  }

  const seatIds = [...new Set(seated.map((ticket) => ticket.seatId))];

  // Seat history, before it is destroyed. Clearing `Ticket.seatId` below is
  // forced (see 2. above) and it is the ONLY record of which seat this order
  // sold — without this stamp the org's order detail shows a refunded line
  // with no seat at all. Copied onto the order item, which outlives the link.
  const withItem = seated.filter(
    (ticket): ticket is typeof ticket & { orderItemId: string } =>
      typeof ticket.orderItemId === "string" && ticket.orderItemId.length > 0,
  );
  await tx.orderItems.recordReleasedSeats(
    withItem.map((ticket) => ({
      orderItemId: ticket.orderItemId,
      seatId: ticket.seatId,
    })),
  );

  // Clear the ticket → seat link first, then free the seat: never leave an
  // AVAILABLE seat that a ticket still claims, because that is the state the
  // unique index turns into a post-payment mint failure.
  await tx.tickets.clearSeatAssignments(seated.map((ticket) => ticket.id));
  await tx.seats.updateStatuses({
    seatIds,
    status: "AVAILABLE",
    updatedAt: at,
  });

  return seatIds;
}
