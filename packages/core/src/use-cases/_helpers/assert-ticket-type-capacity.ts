import type { TicketsRepo } from "@th/ports/repos/tickets";
import { fail } from "@th/errors";

import {
  CART_REAPER_PERIOD_SECONDS,
  DEFAULT_CART_TTL_SECONDS,
} from "../orders/release-expired-carts";

/**
 * How far back a PENDING order still counts as reserving capacity.
 *
 * NOT a hold duration anyone chose — derived from how long a PaymentIntent can
 * still be confirmed, which is owned entirely by `releaseExpiredCarts`. That
 * job cancels the order AND the PI, but it is a cron: an order becomes
 * ELIGIBLE at `DEFAULT_CART_TTL_SECONDS` and is only actually REAPED on the
 * next successful pass. Eligibility is not reaping.
 *
 * Two earlier attempts got this wrong and both reopened the same money bug:
 *   - a 5-minute per-line stamp: the ticket was resold ~15 minutes before the
 *     PI stopped being confirmable.
 *   - a stamp pinned to exactly the reaper TTL: still wrong, because the job
 *     runs on a cron, so a reservation could lapse a full cron period before
 *     the charge it protected actually died.
 *
 * Hence TTL + one cron period, plus a second period of slack for a lagging or
 * backlogged run (the job pages at 100 orders). Over-reserving briefly is
 * cheap; under-reserving charges a card for a ticket that no longer exists.
 *
 * With the reaper every 30 minutes (`orders/_shared/cart-reaper-cycle.ts`)
 * this is 20 + 2 × 30 = 80 minutes: an abandoned cart holds its tickets
 * against other buyers for up to 80 minutes after it was opened.
 */
export const CAPACITY_HELD_WINDOW_SECONDS =
  DEFAULT_CART_TTL_SECONDS + 2 * CART_REAPER_PERIOD_SECONDS;

/** The instant before which PENDING orders no longer reserve. */
export function heldSinceFor(now: Date): Date {
  return new Date(now.getTime() - CAPACITY_HELD_WINDOW_SECONDS * 1000);
}

/**
 * All this guard needs to know about a ticket type. Structural rather than
 * `TicketTypeRecord` so callers can pass the lighter `EventTicketTypeSummary`
 * that `events.listTicketTypes` already returns, without a lookup round-trip.
 */
export type CapacityBearingTicketType = { capacity: number };

/**
 * The narrowest handle this guard needs. Deliberately NOT `Repos` — the root
 * repos object has no open transaction, and the lock this takes is worthless
 * outside one. Accepting only the piece it uses keeps `Repos` from being
 * passed by habit.
 */
export type CapacityCountingRepos = {
  tickets: Pick<TicketsRepo, "lockAndCountCapacityForTicketType">;
};

export type TicketTypeCapacityRequest = {
  ticketTypeId: string;
  qty: number;
};

/**
 * THE inventory rule. One implementation, shared by every pre-charge caller:
 * POS (`startPosSale`, `recordCashSale`) and web/embed checkout
 * (`createPaidCheckout`, `claimFreeTickets`, `updateOrderItems`).
 *
 * Why it exists: capacity used to be enforced only by `mintTickets`, which
 * counts issued Tickets. On every card path minting happens in the
 * `payment_intent.succeeded` webhook — long after the buyer's card is charged.
 * So the last ticket going to someone else mid-checkout produced a charge with
 * no ticket and a manual refund. This moves the decision to before the charge.
 *
 * Basis: `capacity - issued - held`, NOT issued alone. Counting issued only
 * would let two buyers mid-checkout both pass this gate for the same last
 * ticket and both be charged; the loser then fails SOLD_OUT in the webhook,
 * which is the exact bug this closes.
 *
 * `held` is qty on ticket lines of PENDING orders young enough that their
 * PaymentIntent can still be confirmed — derived from the ORDER'S OWN AGE
 * (`CAPACITY_HELD_WINDOW_SECONDS`), not from a per-line expiry stamp. That is
 * load-bearing: a stamp is a second clock, and it drifts against the reaper
 * that actually cancels the PI, reopening the window where a ticket is resold
 * while the first buyer's charge can still land. One clock, no drift. It also
 * means no caller has to remember to stamp anything to be counted, and a
 * malformed `meta` value cannot break the query.
 *
 * Callers that mint inline (`claimFreeTickets`, `recordCashSale`) need no
 * special handling — their tickets land in `issued` before the transaction
 * commits, and their order is no longer PENDING.
 *
 * Serialisation: `lockAndCountCapacityForTicketType` takes a transaction-scoped
 * advisory lock per ticket type, so concurrent buyers queue rather than both
 * reading the same count. That only holds if `tx` here is a TRANSACTION handle
 * and the caller's order insert happens in the same transaction — pass `tx`,
 * never the root `repos`.
 *
 * Lock ORDER matters and is fixed: capacity locks are taken here, before any
 * caller touches Seats. Every call site must keep that order (capacity → seats)
 * or two paths locking in opposite orders can deadlock.
 *
 * `mintTickets` keeps its own issued-only check as a backstop. This does not
 * replace it; it makes it stop being the first line of defence.
 *
 * @throws `TICKET_TYPE_SOLD_OUT` when the request exceeds capacity outright.
 * @throws `TICKET_TYPE_TEMPORARILY_HELD` when it only exceeds it because of
 *   someone else's in-flight hold.
 */
export async function assertTicketTypeCapacity(
  tx: CapacityCountingRepos,
  input: {
    requests: readonly TicketTypeCapacityRequest[];
    ticketTypesById: ReadonlyMap<string, CapacityBearingTicketType>;
    now: Date;
    /**
     * An order whose own PENDING ticket lines must NOT count against this
     * request.
     *
     * Required by the cart paths: `updateOrderItems` re-prices an order that is
     * already holding its own stock, and `createCheckout` converts a cart whose
     * `pendingOrderId` still holds it. Without the exclusion a buyer holding the
     * last two tickets is refused their own cart.
     *
     * Callers MUST validate ownership (buyer + event + PENDING) before passing
     * an id here — an unvalidated id would let a buyer discount someone else's
     * hold and oversell past it.
     */
    excludeOrderId?: string | null;
  },
): Promise<void> {
  // Collapse duplicate lines for the same type first — a cart holding two
  // separate lines of the same ticket type must be judged on the total, and
  // locking the same row twice in one transaction is pointless work.
  const wanted = new Map<string, number>();
  for (const req of input.requests) {
    wanted.set(req.ticketTypeId, (wanted.get(req.ticketTypeId) ?? 0) + req.qty);
  }

  // Deterministic lock order. Two buyers taking the same two ticket types in
  // opposite order would otherwise be able to deadlock each other.
  const ticketTypeIds = [...wanted.keys()].sort();

  for (const ticketTypeId of ticketTypeIds) {
    const qty = wanted.get(ticketTypeId)!;
    const ticketType = input.ticketTypesById.get(ticketTypeId);
    if (!ticketType) {
      throw fail("TICKET_TYPE_NOT_FOUND");
    }

    const { issued, held } = await tx.tickets.lockAndCountCapacityForTicketType(
      {
        ticketTypeId,
        heldSince: heldSinceFor(input.now),
        excludeOrderId: input.excludeOrderId ?? null,
      },
    );

    const remaining = ticketType.capacity - issued - held;
    if (qty <= remaining) {
      continue;
    }

    // Separate "there are none" from "there are none RIGHT NOW". Both refuse
    // the sale, but only one is worth waiting out — and at a door, telling a
    // manager a half-empty room is sold out because of a tap in progress is
    // how you get someone overriding the system by hand.
    const wouldFitWithoutHolds = qty <= ticketType.capacity - issued;
    throw fail(
      wouldFitWithoutHolds
        ? "TICKET_TYPE_TEMPORARILY_HELD"
        : "TICKET_TYPE_SOLD_OUT",
    );
  }
}
