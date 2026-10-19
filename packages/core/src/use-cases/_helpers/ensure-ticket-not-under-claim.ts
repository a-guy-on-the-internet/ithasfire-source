import type { TxRepos } from "@th/ports/repos";
import type { ClaimStatus } from "@th/ports/repos/claims";
import { fail } from "@th/errors";

/**
 * The claim statuses where support has not decided yet. They always freeze
 * the ticket (owner ruling 2026-10-04: "transfers should be frozen"). An
 * `approved` claim also freezes it until its refund lands; see
 * {@link ensureTicketNotUnderClaim}. `denied` and `expired` free it.
 */
export const UNRESOLVED_CLAIM_STATUSES = [
  "open",
  "under_review",
] as const satisfies readonly ClaimStatus[];

export function isClaimUnresolved(status: ClaimStatus): boolean {
  return (UNRESOLVED_CLAIM_STATUSES as readonly ClaimStatus[]).includes(status);
}

/**
 * Refuse to move a ticket while a resale claim on its order item is
 * unresolved, or approved with its refund not yet landed.
 *
 * Why: a buyer who opened a claim against their seller could otherwise hand
 * the ticket on (gift, email invite, organizer `admin` move) or relist it,
 * and a later `full_refund` approval would take back a ticket someone else
 * now holds (`unwindResaleOrderAfterRefund` finds the ticket by the claimed
 * order item, whoever owns it).
 *
 * The approved case (owner ruling 2026-10-05): approval commits before the
 * refund does. A refund left `pending`/`requires_action`, or an attempt that
 * failed and awaits a retry, leaves the claim `approved` with the order not
 * yet REFUNDED, and the webhook or the retry still runs that unwind. So the
 * ticket stays frozen until the resale order is REFUNDED. A missing order
 * counts as not refunded. A refund that fails for good (Stripe `failed`/
 * `canceled`, no payment intent) keeps the freeze until an operator refunds
 * the order; that is intended, and each of those arms is reported. The
 * buyer still holds a valid ticket meanwhile, they just can't move it.
 *
 * Takes `claims.lockOrderItem` BEFORE reading the claim, the same lock
 * `createClaim` takes before its existing-claim check, so a claim committed
 * concurrently is always seen. Call it inside the move's `repos.tx()` before
 * that transaction's first row write (see the port JSDoc for lock order).
 *
 * Only for moves the ticket's holder starts. Never call it on a path that
 * runs after a payment is captured (`finalizeResalePurchase`) or that unwinds
 * a refund: refusing there strands money that has already moved.
 *
 * A ticket with no order item (fixture/legacy data) cannot carry a claim and
 * passes without a lock.
 */
export async function ensureTicketNotUnderClaim(
  tx: Pick<TxRepos, "claims" | "orders">,
  ticket: { orderItemId: string | null },
): Promise<void> {
  const orderItemId = ticket.orderItemId;
  if (!orderItemId) {
    return;
  }

  await tx.claims.lockOrderItem(orderItemId);
  const claim = await tx.claims.getByOrderItemId(orderItemId);
  if (!claim) {
    return;
  }
  const frozen =
    isClaimUnresolved(claim.status) ||
    (claim.status === "approved" &&
      (await tx.orders.getById(claim.orderId))?.status !== "REFUNDED");
  if (frozen) {
    // No meta: the email-invite recipient sees this refusal too, and the
    // claim's state is between the buyer, the seller and support.
    throw fail("TICKET_UNDER_CLAIM");
  }
}
