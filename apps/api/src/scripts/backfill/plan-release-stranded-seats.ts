/**
 * plan-release-stranded-seats.ts — the pure decision layer of the one-off
 * backfill that gives back seats stranded by the pre-0c77c77c refund bug.
 *
 * Everything here is database-free on purpose: the classification is a pure
 * function over rows, and the write routine takes a structural `tx` so it can
 * be driven by a plain object of spies. The CLI
 * (`./release-stranded-seats.ts`) owns paging, flags and printing.
 *
 * ── The rule this file exists to hold ───────────────────────────────────────
 * `Ticket.seatId` is `@unique` (packages/db/prisma/ticket.prisma). A seat that
 * is AVAILABLE while a terminal ticket still points at it is WORSE than the
 * dead-inventory bug: checkout's gates pass, and the next buyer's
 * `tickets.create` throws P2002 -> `seat_taken` AFTER their card is charged.
 * `mintTickets` has a pre-flight that refuses first, but that is a net, not a
 * licence (see the ORDERING REQUIREMENT comment in
 * packages/core/src/use-cases/orders/__tests__/seat-release-on-refund.test.ts).
 *
 * So: CLEAR THE LINK, THEN FLIP THE SEAT. Never the other way round. The order
 * is enforced three ways, deliberately over-determined the same way the
 * forward fix was:
 *
 *   1. statement order inside `releaseStrandedSeat`;
 *   2. the flip is gated on an in-transaction `ticket.count({ seatId })` of 0
 *      — a re-read that can only be satisfied by our own preceding clear;
 *   3. a failed/partial clear returns `refused` and the flip never runs.
 *
 * "Terminal" is never spelled out here. It is `NOT SEAT_OWNING_TICKET_STATUSES`
 * (@th/types), the same list the Prisma adapter filters `findBySeatIds` with,
 * so this script cannot drift from the runtime definition of "occupied".
 */

import { SEAT_OWNING_TICKET_STATUSES, ticketOwnsSeat } from "@th/types";
import type { TicketStatus } from "@th/types";

/** Mirrors `SeatStatus` in packages/db/prisma/enums.prisma. */
export type SeatStatus = "AVAILABLE" | "HELD" | "SOLD" | "BLOCKED";

/** The seat statuses this backfill is allowed to write AVAILABLE over. */
export const FLIPPABLE_SEAT_STATUSES: readonly SeatStatus[] = ["SOLD", "HELD"];

/**
 * The status list handed to Prisma's `notIn`. Derived from the owning triple —
 * the terminal set is never enumerated, so a new `TicketStatus` lands on the
 * correct side of this by default.
 */
export const TERMINAL_TICKET_STATUS_FILTER: TicketStatus[] = [
  ...SEAT_OWNING_TICKET_STATUSES,
];

/** A ticket row whose `seatId` points at the seat under examination. */
export type ClaimingTicket = {
  id: string;
  status: TicketStatus;
  orderItemId: string | null;
};

/** A seat row plus every ticket claiming it — read WITHOUT assuming at most one. */
export type SeatCandidate = {
  seatId: string;
  seatStatus: SeatStatus;
  label: string;
  sectionName: string;
  eventId: string;
  eventTitle: string;
  /**
   * Read with `ticket.findMany({ where: { seatId } })`, deliberately not via
   * the `Seat.ticket` to-one relation. `Ticket.seatId` is `@unique`, so today
   * this can only hold 0 or 1 row — but the whole point of the refusal branch
   * below is not to make a double-sell depend on a schema constraint holding.
   */
  tickets: readonly ClaimingTicket[];
};

export type SeatClassification =
  | {
      kind: "eligible";
      /**
       * False when the seat row itself needs no write: it is already
       * AVAILABLE (a seats-first hand repair — the dangerous state) or it is
       * BLOCKED (an operator put it out of service; the dead link is still
       * worth clearing, the block is not ours to lift).
       */
      flipSeat: boolean;
      ticketIds: string[];
      history: Array<{ orderItemId: string; seatId: string }>;
      note?: string;
    }
  | { kind: "refused-live-ticket"; liveTicketIds: string[]; reason: string }
  | { kind: "ambiguous"; reason: string }
  /** Nothing to do — the shape a released seat has on the second run. */
  | { kind: "already-released" };

/**
 * Decide what, if anything, to do with one seat. Pure.
 *
 * A live claim wins over everything: a VALID/SCANNED/LISTED ticket is somebody's
 * pass, and putting its seat back on the map is a double-sell. Such a seat is
 * refused WHOLE — not "clear the dead sibling and keep the seat" — because the
 * state is already impossible under the unique index, so it means something
 * about the row is not what this script assumes, and guessing is how the
 * post-charge failure gets created.
 */
export function classifySeat(candidate: SeatCandidate): SeatClassification {
  const live = candidate.tickets.filter((t) => ticketOwnsSeat(t.status));
  if (live.length > 0) {
    return {
      kind: "refused-live-ticket",
      liveTicketIds: live.map((t) => t.id),
      reason:
        `${live.length} live ticket(s) still hold this seat ` +
        `(${live.map((t) => t.status).join(", ")}) — freeing it would double-sell`,
    };
  }

  if (candidate.tickets.length === 0) {
    if (candidate.seatStatus === "AVAILABLE") {
      // Already done, or never broken. The post-state of this very script.
      return { kind: "already-released" };
    }
    return {
      kind: "ambiguous",
      reason:
        `seat is ${candidate.seatStatus} but NO ticket claims it — stranded by ` +
        `some other cause (an abandoned mint, a hand edit). This backfill ` +
        `unlocks refunded seats and will not guess at this one`,
    };
  }

  const history = candidate.tickets
    .filter(
      (t): t is ClaimingTicket & { orderItemId: string } =>
        typeof t.orderItemId === "string" && t.orderItemId.length > 0,
    )
    .map((t) => ({ orderItemId: t.orderItemId, seatId: candidate.seatId }));

  const ticketIds = candidate.tickets.map((t) => t.id);

  if (candidate.seatStatus === "AVAILABLE") {
    return {
      kind: "eligible",
      flipSeat: false,
      ticketIds,
      history,
      note:
        "seat is ALREADY AVAILABLE with a dead ticket still linked — this is " +
        "the post-charge P2002 state a seats-first repair leaves behind. " +
        "Clearing the link only.",
    };
  }

  if (candidate.seatStatus === "BLOCKED") {
    return {
      kind: "eligible",
      flipSeat: false,
      ticketIds,
      history,
      note:
        "seat is BLOCKED (operator-held). Clearing the dead link; the block " +
        "is left in place — unblocking is not this script's call.",
    };
  }

  return { kind: "eligible", flipSeat: true, ticketIds, history };
}

/** An `eligible` classification bound to its seat, ready to execute. */
export type SeatReleasePlan = {
  seatId: string;
  seatStatus: SeatStatus;
  label: string;
  sectionName: string;
  eventId: string;
  eventTitle: string;
  flipSeat: boolean;
  ticketIds: string[];
  history: Array<{ orderItemId: string; seatId: string }>;
  note?: string;
};

export function planFor(
  candidate: SeatCandidate,
  classification: Extract<SeatClassification, { kind: "eligible" }>,
): SeatReleasePlan {
  return {
    seatId: candidate.seatId,
    seatStatus: candidate.seatStatus,
    label: candidate.label,
    sectionName: candidate.sectionName,
    eventId: candidate.eventId,
    eventTitle: candidate.eventTitle,
    flipSeat: classification.flipSeat,
    ticketIds: classification.ticketIds,
    history: classification.history,
    note: classification.note,
  };
}

/**
 * The slice of the Prisma client (or transaction client) the writes need.
 * Structural so a unit test can hand in plain spies and never load the
 * generated client — and narrow so this module cannot quietly grow a write
 * nobody reviewed.
 */
export type SeatBackfillTx = {
  ticket: {
    updateMany(args: {
      where: {
        id: { in: string[] };
        seatId: string;
        status: { notIn: TicketStatus[] };
      };
      data: { seatId: null };
    }): Promise<{ count: number }>;
    count(args: { where: { seatId: string } }): Promise<number>;
  };
  seat: {
    updateMany(args: {
      where: { id: string; status: { in: SeatStatus[] } };
      data: { status: "AVAILABLE" };
    }): Promise<{ count: number }>;
  };
};

/**
 * Seat history, injected. The CLI passes the REAL forward-path implementation
 * (`makeOrderItemsRepo(tx).recordReleasedSeats`) so a backfilled row carries
 * exactly the same `meta.releasedSeatId` a refund written today does, and
 * `getOrgOrder` reads both back the same way.
 */
export type SeatBackfillDeps = {
  recordReleasedSeats(
    entries: ReadonlyArray<{ orderItemId: string; seatId: string }>,
  ): Promise<void>;
};

export type SeatReleaseOutcome =
  | { kind: "released"; seatId: string; ticketIds: string[]; flippedSeat: boolean }
  | { kind: "refused"; seatId: string; reason: string };

/**
 * Execute one plan. CALL INSIDE A TRANSACTION.
 *
 * Order is the whole point:
 *
 *   1. stamp the seat onto the order item — `Ticket.seatId` is about to become
 *      the only lost record of which seat this order sold;
 *   2. clear the dead ticket -> seat link, guarded on the ticket still being
 *      terminal AND still pointing at this seat;
 *   3. ONLY THEN flip the seat, and only after an in-transaction re-read says
 *      nothing claims it.
 *
 * Any surprise between the steps refuses and leaves the seat alone. The
 * half-done state that produces (link cleared, seat still SOLD) is the
 * pre-fix state — safe, pre-charge, and re-runnable — whereas the mirror image
 * (seat freed, link kept) is the post-charge failure. That asymmetry is why
 * the order is what it is.
 */
export async function releaseStrandedSeat(
  tx: SeatBackfillTx,
  deps: SeatBackfillDeps,
  plan: SeatReleasePlan,
): Promise<SeatReleaseOutcome> {
  if (plan.ticketIds.length === 0) {
    return {
      kind: "refused",
      seatId: plan.seatId,
      reason: "nothing to clear (no claiming ticket)",
    };
  }

  if (plan.history.length > 0) {
    await deps.recordReleasedSeats(plan.history);
  }

  const cleared = await tx.ticket.updateMany({
    where: {
      id: { in: plan.ticketIds },
      // Both guards re-assert, in SQL, what the classifier decided off a read
      // taken outside this transaction.
      seatId: plan.seatId,
      status: { notIn: TERMINAL_TICKET_STATUS_FILTER },
    },
    data: { seatId: null },
  });

  if (cleared.count !== plan.ticketIds.length) {
    return {
      kind: "refused",
      seatId: plan.seatId,
      reason:
        `expected to clear ${plan.ticketIds.length} ticket link(s), cleared ` +
        `${cleared.count} — the row moved under us (re-run to re-examine). ` +
        `Seat left ${plan.seatStatus}.`,
    };
  }

  if (!plan.flipSeat) {
    return {
      kind: "released",
      seatId: plan.seatId,
      ticketIds: plan.ticketIds,
      flippedSeat: false,
    };
  }

  // The ordering guard, in the database. Reads its own transaction's writes,
  // so a zero here means the clear above really happened. A seats-first
  // variant of this script could not get past this line.
  const stillClaimed = await tx.ticket.count({ where: { seatId: plan.seatId } });
  if (stillClaimed > 0) {
    return {
      kind: "refused",
      seatId: plan.seatId,
      reason:
        `${stillClaimed} ticket(s) still claim this seat after the clear — ` +
        `NOT freeing it (an AVAILABLE seat under a live @unique link fails the ` +
        `next buyer's mint after they are charged). Seat left ${plan.seatStatus}.`,
    };
  }

  const flipped = await tx.seat.updateMany({
    where: {
      id: plan.seatId,
      // Never write AVAILABLE over BLOCKED, and never over a seat someone
      // legitimately re-held while we worked.
      status: { in: [...FLIPPABLE_SEAT_STATUSES] },
    },
    data: { status: "AVAILABLE" },
  });

  if (flipped.count !== 1) {
    return {
      kind: "refused",
      seatId: plan.seatId,
      reason:
        "seat status moved under us — link cleared but the seat was NOT " +
        "freed. Safe (this is the pre-fix state); re-run to re-examine.",
    };
  }

  return {
    kind: "released",
    seatId: plan.seatId,
    ticketIds: plan.ticketIds,
    flippedSeat: true,
  };
}

// ── Argument parsing ────────────────────────────────────────────────────────
//
// Pure, exported, and unit-tested: a script whose only safety rail is "you
// passed --apply on purpose" must not have a flag parser nobody exercised.

export const DEFAULT_BATCH_SIZE = 50;
export const MAX_BATCH_SIZE = 500;

export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  // A NaN limit must NOT fall through to `undefined` and mean "the whole
  // table", and a negative one must not invert the slice.
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--limit must be a positive integer (got "${raw}")`);
  }
  return n;
}

export function parseBatchSize(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BATCH_SIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--batch-size must be a positive integer (got "${raw}")`);
  }
  // The bound is the transaction bound: every seat in a batch is written in
  // ONE interactive transaction, and an unbounded batch is an unbounded lock
  // hold on live seat rows.
  if (n > MAX_BATCH_SIZE) {
    throw new Error(
      `--batch-size must be <= ${MAX_BATCH_SIZE} (got ${n}) — each batch is ` +
        `one transaction, and a bigger one holds row locks on live seats`,
    );
  }
  return n;
}

export function parseOptionalId(
  raw: string | undefined,
  flag: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  // `--event-id=` parses as an empty string and would silently widen the run
  // to the WHOLE table — the opposite of what an operator scoping to one show
  // asked for.
  if (value === "") {
    throw new Error(`${flag} needs a value (got an empty string)`);
  }
  return value;
}
