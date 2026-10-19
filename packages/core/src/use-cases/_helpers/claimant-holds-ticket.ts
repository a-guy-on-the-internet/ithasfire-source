import type { TxRepos } from "@th/ports/repos";
import type { TicketStatus } from "@th/types";

/**
 * Ticket statuses a claimant may hold a resale claim on. VALID and SCANNED (a
 * wrong seat is found after entry) are held tickets. INVALID is allowed
 * defensively: no path voids a resale ticket today, but if one does, a voided
 * ticket is what a claim is for. LISTED is refused (cancel the listing first)
 * and REFUNDED is refused (the item is no longer active).
 */
const CLAIMABLE_TICKET_STATUSES: ReadonlySet<TicketStatus> = new Set([
  "VALID",
  "SCANNED",
  "INVALID",
]);

/**
 * Whether the claimant still holds the ticket on a resale order item: the item
 * is still `active`, it has a ticket, and that ticket is owned by the claimant
 * in a claimable status. A gift, email transfer or completed resale flips the
 * item to `transferred` and moves the owner; a relist makes the ticket LISTED.
 *
 * Owner rulings 2026-10-04/05: a buyer who no longer holds the ticket can't
 * file a claim on it (`createClaim`), and such a claim can't be approved
 * (`reviewClaim`): approval's unwind takes the ticket from whoever holds it.
 *
 * Call it under `claims.lockOrderItem(orderItemId)` so a move can't land
 * between the read and the caller's write.
 */
export async function claimantHoldsTicket(
  tx: TxRepos,
  orderItemId: string,
  claimantHumanId: string,
): Promise<boolean> {
  const item = await tx.orderItems.getById(orderItemId);
  if (!item || item.status !== "active") {
    return false;
  }
  const ticket = await tx.tickets.getByOrderItemId(orderItemId);
  return (
    ticket !== null &&
    ticket.ownerHumanId === claimantHumanId &&
    CLAIMABLE_TICKET_STATUSES.has(ticket.status)
  );
}
