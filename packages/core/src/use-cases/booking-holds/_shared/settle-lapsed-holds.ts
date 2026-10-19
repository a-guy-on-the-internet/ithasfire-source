import type { TxRepos } from "@th/ports/repos";
import type {
  BookingHoldRecord,
  BookingHoldReleaseReason,
} from "@th/ports/repos/booking-holds";
import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import { appendBookingSystemEntry } from "../../booking-requests/messages/_shared/system-entries";
import type { BookingHoldNotificationIntent } from "./booking-hold-intents";
import { isHoldLapsed } from "./booking-hold-lapse";
import { releaseHoldCas, renumberLinesOf } from "./hold-line";

// ─────────────────────────────────────────────────────────────────────────────
// Write-on-read settlement (FR-007 / FR-010) — a shared helper, not a job.
//
// Given holds already read inside the caller's tx, persist every lapse the
// pure predicate finds: CAS to RELEASED (EXPIRED | PAST_DATE | GRANT_ENDED),
// renumber the lines they left, write the ledger, and return the
// notifications owed. GRANT_ENDED (holds-without-a-request FR-004, lazy
// half) only ever applies to a BOOKER hold, which has no thread: an audit
// row, and its move-ups like any release.
//
// RECONCILIATION (FR-009 backstop): a live hold whose REQUEST is already
// terminal (DECLINED | WITHDRAWN | EXPIRED) is released here too, as
// REQUEST_CLOSED. The closure paths release in-tx themselves; this heals the
// one that could miss — the pre-P2d-2 expiry sweep, whose release ran in a
// separate tx after a bulk status flip (the sweep now flips and releases in
// one per-request tx; see expire-booking-requests.ts). Silent for the closed
// act (its request is already over); the movers are notified as usual.
//
// IDEMPOTENT + RACE-SAFE: the CAS is on (id, status) — the loser of two
// concurrent settlements matches zero rows and is SKIPPED, so exactly one
// caller records the release and emits its intents (spec risk #2; the notify
// channel's idempotency keys are the backstop, not the mechanism).
//
// Every mutation calls this on the affected line(s) FIRST, as a
// precondition, so no transition ever reasons about a hold whose deadline
// has already passed.
// ─────────────────────────────────────────────────────────────────────────────

/** Request statuses under which no hold may stay live (FR-009). */
export const TERMINAL_BOOKING_REQUEST_STATUSES = [
  "DECLINED",
  "WITHDRAWN",
  "EXPIRED",
] as const satisfies readonly BookingRequestRecord["status"][];

export type SettleLapsedHoldsArgs = {
  /** Rows read inside the caller's tx (any status; non-live rows are ignored). */
  holds: readonly BookingHoldRecord[];
  now: Date;
  /** Resolved IANA zone of the place (see `resolveBookingTimezone`). */
  placeTz: string;
  /** Machine-caused: always null. Kept explicit so no caller stamps a human. */
  actorHumanId: null;
  /**
   * The grant being revoked in this transaction (revoke.ts): its holds are
   * NOT lapsed GRANT_ENDED here, the revoke releases or keeps each one itself.
   * See `booking-hold-lapse.ts` EXEMPTION.
   */
  exemptGrantId?: string;
};

export type SettleLapsedHoldsResult = {
  /** The rows THIS call released (CAS winners only). */
  settled: BookingHoldRecord[];
  intents: BookingHoldNotificationIntent[];
};

export async function settleLapsedHolds(
  tx: TxRepos,
  args: SettleLapsedHoldsArgs,
): Promise<SettleLapsedHoldsResult> {
  const { holds, now, placeTz, actorHumanId, exemptGrantId } = args;
  const settled: BookingHoldRecord[] = [];
  const intents: BookingHoldNotificationIntent[] = [];

  // One request read per DISTINCT request in the batch (lines are short).
  const requests = new Map<string, BookingRequestRecord | null>();
  const requestOf = async (id: string) => {
    if (!requests.has(id)) {
      requests.set(id, await tx.bookingRequests.getById(id));
    }
    return requests.get(id) ?? null;
  };

  for (const hold of holds) {
    if (
      !(LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(hold.status)
    ) {
      continue;
    }
    const lapse = isHoldLapsed(hold, now, placeTz, { exemptGrantId });
    let reason: BookingHoldReleaseReason | null = lapse;
    // The FR-009 backstop is about a request's closure; a request-less hold
    // has none to check.
    if (!reason && hold.ownerKind === "REQUEST") {
      const request = await requestOf(hold.bookingRequestId);
      if (
        request &&
        (TERMINAL_BOOKING_REQUEST_STATUSES as readonly string[]).includes(
          request.status,
        )
      ) {
        reason = "REQUEST_CLOSED";
      }
    }
    if (!reason) continue;

    const released = await releaseHoldCas(tx, hold, { reason, now });
    // CAS lost → another transaction settled (or otherwise moved) it. Its
    // ledger entry and notifications are that transaction's; nothing here.
    if (!released) continue;
    settled.push(released);

    // holds-without-a-request H20: a request-less hold has no thread and no
    // act; its history is the audit log. Who is told of its lapse is FR-013's
    // (later steps), not the request intents below.
    if (released.ownerKind !== "REQUEST") {
      await tx.audit.log({
        entity: "booking_hold",
        entityId: released.id,
        action: "booking_hold.released",
        data: { ownerKind: released.ownerKind, reason, actorHumanId },
        at: now,
      });
      continue;
    }
    // GRANT_ENDED is a BOOKER hold's alone (`isHoldGrantEnded`), handled
    // above; a request hold never lapses that way.
    if (reason === "GRANT_ENDED") continue;

    await appendBookingSystemEntry(tx, {
      bookingRequestId: released.bookingRequestId,
      kind: "booking_hold.released",
      data: { holdId: released.id, reason },
      actorHumanId,
    });

    // FR-010: a past-date death is silent, and so is the FR-009 backstop
    // (the request is already over). FR-007: an expired challenge notifies
    // like a manual release, plus an email to the assignee.
    if (reason === "EXPIRED") {
      const request = await requestOf(released.bookingRequestId);
      const staff = {
        assigneeHumanId: request?.assigneeHumanId ?? null,
        placedByHumanId: released.placedByHumanId,
      };
      intents.push(
        {
          kind: "hold.expired",
          bookingRequestId: released.bookingRequestId,
          holdId: released.id,
          audience: "act",
          date: released.date,
        },
        {
          kind: "hold.expired",
          bookingRequestId: released.bookingRequestId,
          holdId: released.id,
          audience: "staff",
          date: released.date,
          staff,
        },
      );
    }
  }

  if (settled.length > 0) {
    intents.push(
      ...(await renumberLinesOf(
        tx,
        settled,
        { humanId: actorHumanId, kind: "staff" },
        now,
      )),
    );
  }

  return { settled, intents };
}

/**
 * Settle the live line for one calendar+date and return it FRESH (post-
 * settlement, post-renumber) — the precondition read every line-scoped
 * mutation starts with.
 *
 * Takes the line's transaction advisory lock FIRST (`lockLine`, the same key
 * the adapter's `create`/`renumberLine` take), so the line counted here is
 * the line the caller then writes against; two placers on one date serialise
 * on it instead of both reading length n.
 */
export async function settleLine(
  tx: TxRepos,
  args: {
    calendarId: string;
    date: string;
    now: Date;
    placeTz: string;
    /** See {@link SettleLapsedHoldsArgs.exemptGrantId}: the revoke only. */
    exemptGrantId?: string;
  },
): Promise<{
  line: BookingHoldRecord[];
  intents: BookingHoldNotificationIntent[];
}> {
  const key = { calendarId: args.calendarId, date: args.date };
  await tx.bookingHolds.lockLine(key);
  const before = await tx.bookingHolds.listLine(key);
  const { settled, intents } = await settleLapsedHolds(tx, {
    holds: before,
    now: args.now,
    placeTz: args.placeTz,
    actorHumanId: null,
    exemptGrantId: args.exemptGrantId,
  });
  const line =
    settled.length === 0 ? before : await tx.bookingHolds.listLine(key);
  return { line, intents };
}
