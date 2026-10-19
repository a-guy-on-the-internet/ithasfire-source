import type { TxRepos } from "@th/ports/repos";
import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";
import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { fail } from "@th/errors";

import { appendBookingSystemEntry } from "../../booking-requests/messages/_shared/system-entries";
import type { BookingHoldNotificationIntent } from "./booking-hold-intents";
import {
  casHoldStatus,
  lineKeyOf,
  releaseHoldCas,
  renumberLinesOf,
  type HoldLineKey,
} from "./hold-line";

// ─────────────────────────────────────────────────────────────────────────────
// "Take" a line — the ONE place a calendar+date stops being open (FR-008
// confirm, FR-018 date taken by a published event).
//
// The caller has ALREADY locked every line this call may touch (the line
// itself plus every line a sibling of the winner sits in — see
// hold-line.ts for the global order) and settled the line (`settleLine`), so
// `line` is the fresh post-settle membership and a CHALLENGED row in it is an
// OPEN challenge. From there:
//
//   guard      an open challenge on a hold OTHER than the winner refuses the
//              take (HOLD_LINE_HAS_OPEN_CHALLENGE, owner ruling 2026-08-27):
//              the act on the clock gets their answer first. Confirming the
//              challenged hold itself is the venue saying yes early.
//   winner     CAS → CONFIRMED (clears a challenge clock); the winner's
//              SIBLING holds (same request, other lines) → SIBLING_CONFIRMED;
//              every COMPETITOR in the line → CONFIRMED_OTHER; the sibling
//              lines are renumbered (the taken line has no live member left).
//   no winner  every live hold in the line → RELEASED with `releaseReason`
//              (the line empties; nothing to renumber). Each act is told, and
//              so is the request's assignee (in-app), like an expiry.
//
// The winner's own `booking_hold.confirmed` ledger entry and audit row stay
// with the caller: confirm writes it AFTER the accept body (so the thread
// reads in order) and with `eventId: null`; a publish writes it with the
// event id it already has.
// ─────────────────────────────────────────────────────────────────────────────

export type TakeLineWinner = {
  /** The winning row, as read from the settled line. */
  hold: BookingHoldRecord;
  /**
   * The winner's request's OTHER holds (any line, post-lock read). Non-live
   * rows are ignored; the caller must hold every line they sit in.
   */
  requestHolds: readonly BookingHoldRecord[];
};

type TakeLineBaseArgs = {
  key: HoldLineKey;
  /** The settled line (post-`settleLine`), used as the competitor set. */
  line: readonly BookingHoldRecord[];
  now: Date;
  /**
   * Staff-side actor stamped on the losers' ledger entries (the venue side
   * sees every thread). Null when machine-caused (a scheduled job).
   */
  actorHumanId: string | null;
};

/**
 * Either somebody wins the line, or nobody does and every live hold is
 * released with `releaseReason` — the reason only exists in the second
 * shape, so a caller with a winner cannot hand over a dead one.
 */
export type TakeLineArgs =
  | (TakeLineBaseArgs & { winner: TakeLineWinner })
  | (TakeLineBaseArgs & {
      winner: null;
      /** Reason stamped on every live hold when nobody wins. */
      releaseReason: "EVENT_SCHEDULED";
    });

export type TakeLineResult = {
  /** The CONFIRMED row, when there was a winner. */
  confirmed: BookingHoldRecord | null;
  /** Every row THIS call released (CAS winners only). */
  released: BookingHoldRecord[];
  /**
   * `hold.confirmed` (winner) → `hold.released` / `hold.lost_date` per loser
   * → `hold.position_changed` per mover, in that order.
   */
  intents: BookingHoldNotificationIntent[];
};

function isLive(hold: Pick<BookingHoldRecord, "status">): boolean {
  return (LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(
    hold.status,
  );
}

/**
 * The released row's history: its request's thread for a REQUEST hold; the
 * audit log for a request-less one, which has no thread and no act to tell
 * (holds-without-a-request H20). Returns the request id when the caller owes
 * the request intents, else null.
 */
async function recordLoser(
  tx: TxRepos,
  row: BookingHoldRecord,
  args: {
    reason: "EVENT_SCHEDULED" | "SIBLING_CONFIRMED" | "CONFIRMED_OTHER";
    actorHumanId: string | null;
    now: Date;
  },
): Promise<string | null> {
  if (row.ownerKind !== "REQUEST") {
    await tx.audit.log({
      entity: "booking_hold",
      entityId: row.id,
      action: "booking_hold.released",
      data: {
        ownerKind: row.ownerKind,
        reason: args.reason,
        actorHumanId: args.actorHumanId,
      },
      at: args.now,
    });
    return null;
  }
  await appendBookingSystemEntry(tx, {
    bookingRequestId: row.bookingRequestId,
    kind: "booking_hold.released",
    data: { holdId: row.id, reason: args.reason },
    actorHumanId: args.actorHumanId,
  });
  return row.bookingRequestId;
}

export async function takeLine(
  tx: TxRepos,
  args: TakeLineArgs,
): Promise<TakeLineResult> {
  const { key, line, winner, now, actorHumanId } = args;
  const winnerId = winner?.hold.id ?? null;

  const openChallenge = line.find(
    (h) => h.id !== winnerId && h.status === "CHALLENGED",
  );
  if (openChallenge) {
    throw fail("HOLD_LINE_HAS_OPEN_CHALLENGE", {
      meta: {
        holdId: winnerId,
        challengedHoldId: openChallenge.id,
        calendarId: key.calendarId,
        date: key.date,
      },
    });
  }

  const released: BookingHoldRecord[] = [];
  const intents: BookingHoldNotificationIntent[] = [];

  if (!winner) {
    const { releaseReason } = args;
    // One request read per DISTINCT request, for the assignee routing hint.
    const requests = new Map<string, BookingRequestRecord | null>();
    for (const hold of line) {
      if (!isLive(hold)) continue;
      const row = await releaseHoldCas(tx, hold, {
        reason: releaseReason,
        now,
      });
      if (!row) {
        // `line` was read under this tx's line lock, so nobody else can have
        // moved a live member of it. A lost CAS here is the lock's contract
        // broken (a caller that never locked, an adapter that released the
        // lock early) — never "someone else already did it". Surface it as
        // the retryable shape rather than assume the line emptied.
        throw fail("HOLD_LINE_CHANGED", {
          meta: {
            calendarId: key.calendarId,
            date: key.date,
            holdId: hold.id,
            reason: "locked_line_member_moved",
          },
        });
      }
      released.push(row);
      const bookingRequestId = await recordLoser(tx, row, {
        reason: releaseReason,
        actorHumanId,
        now,
      });
      if (bookingRequestId === null) continue;
      if (!requests.has(bookingRequestId)) {
        requests.set(
          bookingRequestId,
          await tx.bookingRequests.getById(bookingRequestId),
        );
      }
      const request = requests.get(bookingRequestId) ?? null;
      intents.push(
        {
          kind: "hold.released",
          bookingRequestId,
          holdId: row.id,
          audience: "act",
          date: row.date,
          reason: releaseReason,
        },
        {
          kind: "hold.released",
          bookingRequestId,
          holdId: row.id,
          audience: "staff",
          date: row.date,
          reason: releaseReason,
          staff: {
            assigneeHumanId: request?.assigneeHumanId ?? null,
            placedByHumanId: row.placedByHumanId,
          },
        },
      );
    }
    // The line is empty now; a renumber would be a no-op by contract.
    return { confirmed: null, released, intents };
  }

  const confirmed = await casHoldStatus(tx, {
    id: winner.hold.id,
    status: "CONFIRMED",
    expectedFrom: LIVE_BOOKING_HOLD_STATUSES,
    confirmedAt: now,
    // A CHALLENGED hold confirmed early: clear its clock the way answer's
    // "keep" does (the adapter nulls respondBy itself).
    challengedAt: null,
  });

  // A request-less winner has no act to tell; who is told when one is
  // booked is FR-013's (the booking use case), not this request intent.
  if (confirmed.ownerKind === "REQUEST") {
    intents.push({
      kind: "hold.confirmed",
      bookingRequestId: confirmed.bookingRequestId,
      holdId: confirmed.id,
      audience: "act",
      date: confirmed.date,
    });
  }

  // Losers: the request's other holds (any line, from the post-lock read) +
  // this line's others.
  const siblings = winner.requestHolds.filter(
    (h) => h.id !== confirmed.id && isLive(h),
  );
  const competitors = line.filter((h) => h.id !== confirmed.id);

  for (const sibling of siblings) {
    const row = await releaseHoldCas(tx, sibling, {
      reason: "SIBLING_CONFIRMED",
      now,
    });
    if (!row) continue;
    released.push(row);
    const bookingRequestId = await recordLoser(tx, row, {
      reason: "SIBLING_CONFIRMED",
      actorHumanId,
      now,
    });
    if (bookingRequestId === null) continue;
    intents.push({
      kind: "hold.released",
      bookingRequestId,
      holdId: row.id,
      audience: "act",
      date: row.date,
      reason: "SIBLING_CONFIRMED",
    });
  }
  for (const competitor of competitors) {
    const row = await releaseHoldCas(tx, competitor, {
      reason: "CONFIRMED_OTHER",
      now,
    });
    if (!row) continue;
    released.push(row);
    // A request-less loser's holder is told of the lost date by the
    // existing lost-date notices once FR-013 routes them (later step).
    const bookingRequestId = await recordLoser(tx, row, {
      reason: "CONFIRMED_OTHER",
      actorHumanId,
      now,
    });
    if (bookingRequestId === null) continue;
    intents.push({
      kind: "hold.lost_date",
      bookingRequestId,
      holdId: row.id,
      audience: "act",
      date: row.date,
      reason: "CONFIRMED_OTHER",
    });
  }

  // Renumber the SIBLING lines only — the taken line has no live members
  // left (every competitor was just released), and the renumber of an
  // emptied line is a no-op by contract.
  const siblingLines = released.filter(
    (h) => lineKeyOf(h) !== lineKeyOf(confirmed),
  );
  if (siblingLines.length > 0) {
    intents.push(
      ...(await renumberLinesOf(
        tx,
        siblingLines,
        { humanId: actorHumanId, kind: "staff" },
        now,
      )),
    );
  }

  return { confirmed, released, intents };
}
