import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { appendBookingSystemEntry } from "./messages/_shared/system-entries";
import { messagesIn } from "./messages/_shared/thread-access";
import {
  bookingHoldNotificationIntentSchema,
  type BookingHoldNotificationIntent,
} from "../booking-holds/_shared/booking-hold-intents";
import { releaseHoldsForClosedRequest } from "../booking-holds/_shared/release-for-request";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import {
  fireBookingLineupRequestClosed,
  type NotifyBookingLineupRequestClosedFn,
} from "./notify-booking-lineup-request-closed";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const expireBookingRequestsInputSchema = z.object({}).strict();

export const expireBookingRequestsOutputSchema = z
  .object({
    expiredCount: z.number().int().nonnegative(),
    /**
     * Booking-holds FR-009: move-up notifications owed to the other acts in
     * the lines the expired requests' holds left. The job (step 3) sends
     * them; core returns data only.
     */
    holdNotificationIntents: z.array(bookingHoldNotificationIntentSchema),
  })
  .strict();

/** What a transport/job puts on the wire: the hold intents stay server-side. */
export const expireBookingRequestsWireOutputSchema = z.object(
  expireBookingRequestsOutputSchema.omit({ holdNotificationIntents: true })
    .shape,
);

export type ExpireBookingRequestsInput = z.infer<
  typeof expireBookingRequestsInputSchema
>;
export type ExpireBookingRequestsOutput = z.infer<
  typeof expireBookingRequestsOutputSchema
>;
export type ExpireBookingRequestsWireOutput = z.infer<
  typeof expireBookingRequestsWireOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type ExpireBookingRequestsDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "bookingRequests"
    | "bookingRequestMessages"
    | "audit"
    // FR-009: each swept request's live holds are released in its own tx,
    // under its booking lock (`lockRequestBooking`, P2d-2 carry a).
    | "bookingHolds"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Deliberate swallow reporter for one request's expiry transaction (house
   * ReporterPort convention). See {@link expireOneRequest} for why a failure
   * is scoped to that request instead of failing the sweep.
   */
  reportError?: ReporterPort;
  /**
   * Lineup v3 (L7 / FR-012b): every act that JOINED an expired request's
   * bill hears it isn't going ahead — once, from the run that wrote the
   * request's `booking_request.expired` entry (an overlapping or later run
   * that finds the entry already there sends nothing). Post-commit per
   * request, swallowed + reported.
   */
  notifyBookingLineupRequestClosed?: NotifyBookingLineupRequestClosedFn;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scheduled-job entry point: flip every open (PENDING | VIEWED) booking
 * request whose `expiresAt` has passed to EXPIRED (spec FR-003 — default TTL
 * is stamped at creation by `create-booking-request`), release its live
 * holds (booking-holds FR-009) and append a `booking_request.expired` entry
 * to its ledger — ONE small transaction per request (see
 * {@link expireOneRequest} for why, and for the lock that makes it safe
 * against a venue confirm still in flight).
 */
/**
 * How many requests one run expires at most (P2d-2 review nit). Each is its
 * own small transaction under its booking lock, so a run is bounded in time
 * and connections; a larger backlog drains over the following runs, oldest
 * deadline first (`listExpiryCandidates` orders by `expiresAt`).
 */
export const EXPIRY_SWEEP_BATCH_LIMIT = 500;

export async function expireBookingRequests(
  deps: ExpireBookingRequestsDeps,
  rawInput: unknown = {},
): Promise<ExpireBookingRequestsOutput> {
  parseInput(expireBookingRequestsInputSchema, rawInput);

  const now = deps.clock.now();
  // A pre-filter, read without locks; each candidate is re-checked under its
  // own booking lock before anything is written.
  const candidates = await deps.repos.bookingRequests.listExpiryCandidates({
    cutoff: now,
    limit: EXPIRY_SWEEP_BATCH_LIMIT,
  });

  const intents: BookingHoldNotificationIntent[] = [];
  const newlyExpired: BookingRequestRecord[] = [];
  let expiredCount = 0;
  for (const id of candidates) {
    const outcome = await expireOneRequest(deps, id, now);
    if (!outcome) continue;
    expiredCount += 1;
    intents.push(...outcome.intents);
    if (outcome.logged) newlyExpired.push(outcome.logged);
  }

  // Joined acts hear the request isn't going ahead (v3 L7), one request at
  // a time, each in its own swallow — one failure never stops the rest.
  for (const request of newlyExpired) {
    await fireBookingLineupRequestClosed(
      deps,
      { bookingRequest: request, closedBy: "expired", actorHumanId: null },
      "expireBookingRequests",
    );
  }

  deps.logger?.info("booking_requests.expired", {
    expiredCount,
    candidateCount: candidates.length,
    holdIntentCount: intents.length,
  });

  return expireBookingRequestsOutputSchema.parse({
    expiredCount,
    holdNotificationIntents: intents,
  });
}

/**
 * Expire ONE request: flip, release its holds, write its entry — in ONE small
 * transaction of its own, so the request and its ledger can never disagree.
 * Returns null when the request was not expired (a guard failed, or the
 * transaction failed and was reported).
 *
 * WHY PER REQUEST (booking-the-night P2d-2, carry a — replaces the earlier
 * single bulk `updateMany`). The bulk flip filtered out booked nights with
 * `holds: { none: CONFIRMED }`, but under READ COMMITTED that filter cannot
 * see a venue confirm that is still in flight: the confirm writes a
 * CONFIRMED hold, never this row, so nothing made the bulk statement wait for
 * it, and the sweep could expire a request whose night was being booked —
 * stranding the CONFIRMED hold on an EXPIRED request that Cancel booking
 * refuses and Withdraw / Decline no longer reach. Now each candidate first
 * takes the request's booking lock (`lockRequestBooking`), the lock every
 * booking path takes before writing a CONFIRMED hold, and only then runs the
 * guarded flip (`expireIfDue`: still open, still due, still no CONFIRMED
 * hold). An in-flight confirm makes the flip wait, then the re-check sees its
 * hold and nothing is written; a confirm that comes after finds the request
 * closed and its holds released. Lock order: booking lock → lines (the
 * release below), the order every booking path uses.
 *
 * FAILURE IS SCOPED TO ONE REQUEST. A batch job must not lose a run to one
 * bad row: a throw rolls back only this request (it stays open; the next
 * tick retries it) and is `logger.error` AND `reportError` — a swallow
 * without the reporter would be the invisible kind of failure the house
 * convention exists to prevent. Because the flip, the hold release and the
 * entry now commit together, the old gap — EXPIRED with live holds, healed
 * later by `settleLapsedHolds`' REQUEST_CLOSED reconciliation — no longer
 * opens on this path (the reconciliation stays as a backstop for rows left
 * by the old sweep).
 *
 * AT MOST ONE ENTRY. The flip is the at-most-once fence: an overlapping run
 * re-checks under the same lock, finds the request EXPIRED, and writes
 * nothing. The `hasSystemEntry` read below stays as a belt-and-braces guard
 * for a row expired by the pre-P2d-2 sweep whose entry already exists.
 */
async function expireOneRequest(
  deps: ExpireBookingRequestsDeps,
  id: string,
  now: Date,
): Promise<{
  intents: BookingHoldNotificationIntent[];
  /** The request whose `expired` entry THIS run wrote (and committed). */
  logged: BookingRequestRecord | null;
} | null> {
  try {
    // Intents are collected from the tx's RETURN value, never pushed from
    // inside the callback: a rolled-back tx must not leave notifications for
    // releases that never committed.
    return await deps.repos.tx(async (tx) => {
      // The booking lock FIRST (before the release's line locks).
      await tx.bookingHolds.lockRequestBooking(id);
      const request = await tx.bookingRequests.expireIfDue({
        id,
        cutoff: now,
      });
      // Answered, withdrawn, booked or already expired since the candidate
      // read — nothing expired, nothing to log.
      if (!request) return null;

      await tx.audit.log({
        entity: "booking_request",
        entityId: request.id,
        action: "booking_request.expired",
        data: { expiresAt: request.expiresAt },
        at: now,
      });

      // FR-009 (booking-holds): an expired request leaves every line it was
      // in, in the same transaction as the flip.
      const holds = await releaseHoldsForClosedRequest(tx, {
        bookingRequestId: request.id,
        now,
        // Machine-caused: no human on any thread.
        actor: { humanId: null, kind: "staff" },
      });

      // A row with no TTL cannot have been swept; defensive, and the entry
      // schema requires the deadline.
      if (!request.expiresAt) return { intents: holds.intents, logged: null };
      if (
        await messagesIn(tx).hasSystemEntry({
          bookingRequestId: request.id,
          kind: "booking_request.expired",
        })
      ) {
        return { intents: holds.intents, logged: null };
      }

      await appendBookingSystemEntry(tx, {
        bookingRequestId: request.id,
        kind: "booking_request.expired",
        // ISO STRING, never a Date — `systemData` is a Json column.
        data: { expiresAt: request.expiresAt.toISOString() },
        // Machine-caused: no human pulled this.
        actorHumanId: null,
      });
      return { intents: holds.intents, logged: request };
    });
  } catch (error) {
    deps.logger?.error("booking_requests.expired_entry_failed", {
      bookingRequestId: id,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "expireBookingRequests" },
        extra: { bookingRequestId: id },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never abort the
      // rest of the sweep.
    }
    return null;
  }
}
