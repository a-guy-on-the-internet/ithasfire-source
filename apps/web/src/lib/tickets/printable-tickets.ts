/**
 * WHICH TICKETS MAY BE PUT ON PAPER.
 *
 * A printed ticket is a bearer credential: whoever holds the paper can present
 * the code at the door. So the print sheet renders exactly the tickets that are
 * still the holder's to present, and nothing else — a refunded, scanned,
 * resale-listed, invalidated or transferred ticket must not produce a stub.
 *
 * The predicate is deliberately IDENTICAL to the one gating the Apple/Google
 * Wallet buttons on `OrderDetail` (`isUsable` — `!transferredAt && status ===
 * "VALID"`). Paper, wallet and screen must agree about what a live ticket is;
 * three surfaces with three predicates is how one of them ends up printing a
 * stub for a seat that was given away.
 *
 * Note what this canNOT do: a ticket transferred AFTER the sheet was printed
 * still has paper in the world. That is correct and unavoidable — the scanner
 * is the authority and will reject it. The sheet stamps its print time so door
 * staff can reason about stale paper.
 *
 * Pure and dependency-free so it can be unit-tested without a render.
 */

/** The minimum shape needed to decide. Structural, so callers can pass more. */
export type PrintableTicketInput = {
  status: string;
  /** The linked order item, when the join resolved. */
  item: { transferredAt: Date | string | null } | null;
};

export const isPrintableTicket = (ticket: PrintableTicketInput): boolean =>
  ticket.status === "VALID" && !ticket.item?.transferredAt;

export const selectPrintableTickets = <T extends PrintableTicketInput>(
  tickets: readonly T[],
): T[] => tickets.filter(isPrintableTicket);
