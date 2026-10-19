/**
 * A ticket that had already admitted someone when a refund voided it.
 *
 * `admittedAt` is the ticket's `scannedAt` as an ISO string, the form audit
 * data is stored in. It is `null` only for a SCANNED ticket whose `scannedAt`
 * is missing (a data fault): the ticket still admitted someone, so it is still
 * listed, and the null says the time is unknown rather than inventing one.
 */
export type TicketLeavingOnRefund = {
  ticketId: string;
  admittedAt: string | null;
};

/** The only fields this reads off a ticket. */
type RefundVoidedTicket = {
  id: string;
  status: string;
  scannedAt?: Date | null;
};

/**
 * Of the tickets a refund is about to void, the ones that are SCANNED right
 * now: each admitted a person, and the refund means that person left (owner
 * ruling 2026-10-10: a refund of a scanned-in ticket is granted at the door,
 * and it marks them as having left).
 *
 * Every refund path sets `status = REFUNDED` and nulls `scannedAt` (a resale
 * refund instead hands the ticket back to its seller VALID, `scannedAt` nulled
 * the same way), so after that write the ticket row no longer says it was ever
 * used. This list, written into the refund's audit row under `leftOnRefund`,
 * is the record.
 *
 * CALL IT BEFORE THAT WRITE, with the tickets as read in the same transaction.
 * Afterwards the status has moved on and `scannedAt` is gone, so a late call
 * returns nothing (and a repo that hands back the row it then updates in place
 * would lose the answer the same way).
 *
 * Input order is kept. VALID, LISTED and already-dead tickets are left out.
 */
export function ticketsLeavingOnRefund(
  tickets: ReadonlyArray<RefundVoidedTicket>,
): TicketLeavingOnRefund[] {
  return tickets
    .filter((ticket) => ticket.status === "SCANNED")
    .map((ticket) => ({
      ticketId: ticket.id,
      admittedAt: ticket.scannedAt ? ticket.scannedAt.toISOString() : null,
    }));
}

/**
 * The audit-data fragment for that list: `{ leftOnRefund }`, or nothing at
 * all when no voided ticket had been scanned. Spread it into the refund's
 * audit `data`, so the key has one spelling across every refund path and an
 * unscanned refund's audit row is byte-for-byte what it was before.
 */
export function leftOnRefundAuditData(
  leaving: ReadonlyArray<TicketLeavingOnRefund>,
): { leftOnRefund?: TicketLeavingOnRefund[] } {
  return leaving.length > 0 ? { leftOnRefund: [...leaving] } : {};
}
