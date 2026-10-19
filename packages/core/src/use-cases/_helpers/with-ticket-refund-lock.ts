import { fail } from "@th/errors";
import type { Repos } from "@th/ports/repos";
import type { TicketRecord } from "@th/ports/repos/tickets";

import { isEventCancelInProgress } from "../events/_shared/event-cancel-mutex";
import {
  tryAcquireOrderRefundMutex,
  type OrderRefundMutexDeps,
} from "../orders/_shared/refund-mutex";

/**
 * How long a ticket move may hold its order's refund mutex. A move is one
 * short transaction (milliseconds), so a crashed mover must not lock refunds
 * out for the refund paths' 10 minutes. Long enough to cover a slow tx under
 * load; a move that overruns it is reported as `order_refund_mutex_lock_lost`
 * by the shared release.
 */
export const TICKET_MOVE_REFUND_LOCK_TTL_SECONDS = 60;

export type TicketRefundLockDeps = OrderRefundMutexDeps & {
  repos: Pick<Repos, "tickets" | "orderItems">;
};

/**
 * What the move's transaction needs to judge the lock. Pass it to
 * {@link ensureTicketRefundLockHeld} inside the tx, before the first write.
 */
export type TicketRefundLock = {
  /** The ticket's order item as read before the tx; the lock is its order's. */
  readonly orderItemId: string | null;
  /**
   * True when a refund holds the order's mutex, or a cancellation of the
   * ticket's event is in progress: the move must refuse.
   */
  readonly refundInProgress: boolean;
  /**
   * Set when the caller failed the site's `mayLock` pre-filter, so no lock
   * was taken. The tx's own authorization refuses such a caller first; if it
   * ever did not, {@link ensureTicketRefundLockHeld} refuses rather than
   * move a ticket with no lock held.
   */
  readonly skipped?: true;
};

export type TicketRefundLockOptions = {
  /**
   * Cheap pre-tx ownership filter: may this caller take the ticket's order
   * mutex at all? A caller who fails it takes no lock and reads nothing
   * more; `fn` still runs and the tx refuses on authorization with exactly
   * the code it returns today. Without it, anyone holding a public ticket id
   * (resale listings expose them) could spam moves and keep the seller's
   * order mutex busy, failing refunds with IDEMPOTENCY_LOCK_IN_PROGRESS.
   *
   * MUST admit every caller the tx would authorize (a superset), or that
   * caller is refused by the safety net above. It need not reject everyone
   * the tx rejects.
   */
  mayLock?: (ticket: TicketRecord) => boolean | Promise<boolean>;
};

/**
 * Runs a ticket move while holding the per-order refund mutex of the order
 * that owns the ticket's current order item (owner ruling 2026-10-05: "when
 * the refund is in process nothing can happen to the ticket"). Refunds and
 * moves then exclude each other; see the "Coverage" note in
 * `orders/_shared/refund-mutex.ts`.
 *
 * `fn` must run the move's whole `repos.tx` so the release (in `finally`)
 * comes after the commit: a refund that acquires afterwards reads the moved
 * ticket inside its own held section.
 *
 * Busy does NOT throw here. `fn` still runs, with `refundInProgress: true`,
 * and the move's tx refuses at {@link ensureTicketRefundLockHeld}, which sits
 * after the site's own authorization checks. Refusing up front would tell a
 * caller who does not own the ticket (or holds an invite link under the wrong
 * account) that a refund is running before they are told no.
 *
 * No lock is taken when the ticket is missing (the tx throws its own
 * not-found), has no order item (fixture/legacy data, no order to refund),
 * or its order item is missing.
 *
 * ## Event cancellation (`cancel-op:<eventId>`)
 *
 * The move also refuses while a cancellation of the ticket's event holds
 * `cancel-op:<eventId>` (`events/_shared/event-cancel-mutex.ts`), checked
 * read-only (`IdempotencyPort.status`) twice:
 *
 *   1. before taking the order mutex, so a move during a cancel never holds
 *      an order mutex the cancel is about to need;
 *   2. again AFTER taking it, inside the held section. This one is what
 *      makes the ordering airtight. Cancel acquires `cancel-op` BEFORE it
 *      takes any order's mutex and holds it until its marking tx commits;
 *      the move holds the order mutex across its whole tx. So for an order
 *      O of the event, either
 *        - the move took O's mutex before cancel did, and committed before
 *          releasing it; cancel then reloads O inside O's mutex and sees the
 *          move (`refundLoadedOrder`); or
 *        - the move took O's mutex after cancel took `cancel-op`, so check 2
 *          (which runs after that acquire) sees the key and the move
 *          refuses. Cancel holds `cancel-op` until after its marking tx, so
 *          there is no gap between O's refund and its marking.
 *      Check 1 alone would not do: a cancel could take `cancel-op` between
 *      it and the order-mutex acquire.
 *
 * A ticket with no order item gets check 1 only (there is no order mutex to
 * order against): it still never moves while its event is being cancelled.
 *
 * ## Not wrapped: `cancelResaleListing`
 *
 * Taking a ticket off resale (LISTED → VALID, same holder) does not take
 * this lock. It moves no ownership and no money: the seller keeps the
 * ticket they already hold, and a refund that races it voids or skips the
 * same ticket either way (refund paths treat LISTED as ineligible and VALID
 * by their usual rules). Locking it would only make "stop selling" fail
 * while a refund runs.
 */
export async function withTicketRefundLock<T>(
  deps: TicketRefundLockDeps,
  ticketId: string | null,
  fn: (lock: TicketRefundLock) => Promise<T>,
  options: TicketRefundLockOptions = {},
): Promise<T> {
  const ticket = ticketId ? await deps.repos.tickets.getById(ticketId) : null;
  const orderItemId = ticket?.orderItemId ?? null;
  if (ticket && options.mayLock && !(await options.mayLock(ticket))) {
    return fn({ orderItemId, refundInProgress: false, skipped: true });
  }
  const eventId = ticket?.eventId ?? null;
  const cancelling = async () =>
    eventId !== null &&
    (await isEventCancelInProgress(deps.idempotency, eventId));

  // Check 1 (see the JSDoc): before any order mutex.
  if (await cancelling()) {
    return fn({ orderItemId, refundInProgress: true });
  }

  const orderItem = orderItemId
    ? await deps.repos.orderItems.getById(orderItemId)
    : null;
  if (!orderItem) {
    return fn({ orderItemId, refundInProgress: false });
  }

  const held = await tryAcquireOrderRefundMutex(
    deps,
    orderItem.orderId,
    TICKET_MOVE_REFUND_LOCK_TTL_SECONDS,
  );
  if (!held) {
    return fn({ orderItemId, refundInProgress: true });
  }
  try {
    // Check 2: inside the held order mutex. Runs before `fn`'s tx, so a
    // refusal writes nothing; the order mutex is still released below.
    return await fn({ orderItemId, refundInProgress: await cancelling() });
  } finally {
    await held.release();
  }
}

/**
 * Call inside the move's tx, after its authorization checks and before its
 * first write. Refuses with `TICKET_REFUND_IN_PROGRESS` (CONFLICT, no meta:
 * an email-invite recipient sees it too) when:
 *
 *   - a refund holds the ticket's order, or a cancellation of its event is
 *     in progress, or
 *   - no lock was taken because the caller failed the site's `mayLock`
 *     pre-filter (a safety net: the site's authorization runs first and
 *     refuses such a caller with its own code), or
 *   - the ticket now points at a different order item than the one the lock
 *     was picked from (it was re-pointed, e.g. by a resale purchase, between
 *     the pre-tx read and this one). The mutex held is then the wrong order's,
 *     so a refund on the right one may be in flight. A retry picks the right
 *     order.
 */
export function ensureTicketRefundLockHeld(
  lock: TicketRefundLock,
  ticket: { orderItemId: string | null },
): void {
  if (
    lock.refundInProgress ||
    lock.skipped ||
    ticket.orderItemId !== lock.orderItemId
  ) {
    throw fail("TICKET_REFUND_IN_PROGRESS");
  }
}
