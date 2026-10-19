import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  BookingRequestRecord,
  ToVenueBookingRequestRecord,
} from "@th/ports/repos/booking-requests";

import { parseInput } from "../../lib/io";
import {
  bookingHoldNotificationIntentSchema,
  type BookingHoldNotificationIntent,
} from "../booking-holds/_shared/booking-hold-intents";
import { releaseHoldsForClosedRequest } from "../booking-holds/_shared/release-for-request";
import { appendBookingSystemEntry } from "./messages/_shared/system-entries";
import {
  fireBookingLineupRequestClosed,
  type NotifyBookingLineupRequestClosedFn,
} from "./notify-booking-lineup-request-closed";

// ─────────────────────────────────────────────────────────────────────────────
// expireParkedBookingRequests — the one-off cleanup of the 2026-09-25
// amendment to the venue-confirmation spec ("no requests to unclaimed
// venues", step 3): "Any request still parked when this ships is expired with
// one thread note to the sender: '{place} isn't on Ithas Fire yet, so this
// request can't reach them.'"
//
// Driven by `apps/api/src/scripts/ops/expire-parked-booking-requests.ts`.
// Nothing parks a request any more, so once a run has found nothing this has
// nothing to do, ever again.
//
// THE EXPIRY MACHINERY, keyed on the stamp. Each candidate is expired the way
// `expireBookingRequests` expires one (`expireOneRequest`): its own small
// transaction, the request's booking lock first, a guarded flip
// (`expireParked`: still open, still parked, no CONFIRMED hold), its live
// holds released in the same transaction, the ledger entry and the audit row.
// The flip is keyed on `parkedUnclaimedAt` rather than `expiresAt` because a
// parked row's deadline may be in the future (or, for a seeded row, absent),
// and it clears the stamp in the same statement — the fence that makes a
// second run a no-op, and what lets the column be dropped once no row has it.
//
// ONE NOTE, not two: the entry is `booking_request.expired_unclaimed` (the
// amendment's sentence, venue name snapshotted) INSTEAD of
// `booking_request.expired` — the sender gets one line saying why.
//
// IDEMPOTENT. A re-run lists only rows still stamped and open; a row taken by
// an overlapping run fails its guard and writes nothing.
//
// FAILURE IS SCOPED TO ONE REQUEST (deliberate swallow): a throw rolls back
// that request only, is logged at error AND reported (ReporterPort
// convention), and the run carries on.
// ─────────────────────────────────────────────────────────────────────────────

/** One run's ceiling. The population is a handful at most (no web path parked). */
export const EXPIRE_PARKED_BATCH_LIMIT = 500;

/** Bound of the place-name snapshot (the entry schema's `.max(200)`). */
const PLACE_NAME_MAX = 200;

export const expireParkedBookingRequestsInputSchema = z
  .object({
    /** List what WOULD be expired and write nothing. */
    dryRun: z.boolean(),
  })
  .strict();

const candidateSchema = z
  .object({
    bookingRequestId: z.uuid(),
    placeId: z.uuid(),
    placeName: z.string().nullable(),
    status: z.string(),
    source: z.string(),
    parkedUnclaimedAt: z.string().nullable(),
    /**
     * `would_expire` (dry run); `expired` (this run expired it and wrote the
     * note); `skipped` (its guard failed under the lock — answered, booked
     * or taken by another run); `failed` (its transaction threw — reported).
     */
    outcome: z.enum(["would_expire", "expired", "skipped", "failed"]),
  })
  .strict();

export const expireParkedBookingRequestsOutputSchema = z
  .object({
    dryRun: z.boolean(),
    candidates: z.array(candidateSchema),
    expiredCount: z.number().int().nonnegative(),
    /** Move-up notices owed to other acts in lines the expired holds left. */
    holdNotificationIntents: z.array(bookingHoldNotificationIntentSchema),
  })
  .strict();

export type ExpireParkedBookingRequestsInput = z.infer<
  typeof expireParkedBookingRequestsInputSchema
>;
export type ExpireParkedBookingRequestsOutput = z.infer<
  typeof expireParkedBookingRequestsOutputSchema
>;

export type ExpireParkedBookingRequestsDeps = {
  repos: Pick<
    Repos,
    "tx" | "bookingRequests" | "bookingRequestMessages" | "audit" | "bookingHolds"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Per-request swallow reporter (ReporterPort convention). */
  reportError?: ReporterPort;
  /**
   * Acts that JOINED an expired request's bill hear it isn't going ahead
   * (lineup v3 L7), exactly as on a normal expiry. Post-commit, swallowed +
   * reported by `fireBookingLineupRequestClosed`.
   */
  notifyBookingLineupRequestClosed?: NotifyBookingLineupRequestClosedFn;
};

export async function expireParkedBookingRequests(
  deps: ExpireParkedBookingRequestsDeps,
  rawInput: unknown,
): Promise<ExpireParkedBookingRequestsOutput> {
  const input = parseInput(expireParkedBookingRequestsInputSchema, rawInput);
  const now = deps.clock.now();

  // A pre-filter read without locks; each one is re-checked under its own
  // booking lock before anything is written.
  const parked = await deps.repos.bookingRequests.listOpenParked({
    limit: EXPIRE_PARKED_BATCH_LIMIT,
  });

  const candidates: ExpireParkedBookingRequestsOutput["candidates"] = [];
  const intents: BookingHoldNotificationIntent[] = [];
  const newlyExpired: BookingRequestRecord[] = [];

  for (const request of parked) {
    const row = describe(request);
    if (input.dryRun) {
      candidates.push({ ...row, outcome: "would_expire" });
      continue;
    }
    const outcome = await expireOneParked(deps, request, now);
    if (outcome === "failed" || outcome === null) {
      candidates.push({ ...row, outcome: outcome ?? "skipped" });
      continue;
    }
    candidates.push({ ...row, outcome: "expired" });
    intents.push(...outcome.intents);
    newlyExpired.push(outcome.expired);
  }

  // Joined acts hear it isn't going ahead, one request at a time, each in its
  // own swallow (inside `fireBookingLineupRequestClosed`).
  for (const request of newlyExpired) {
    await fireBookingLineupRequestClosed(
      deps,
      { bookingRequest: request, closedBy: "expired", actorHumanId: null },
      "expireParkedBookingRequests",
    );
  }

  deps.logger?.info("booking_requests.expired_parked", {
    dryRun: input.dryRun,
    candidateCount: parked.length,
    expiredCount: newlyExpired.length,
    holdIntentCount: intents.length,
  });

  return expireParkedBookingRequestsOutputSchema.parse({
    dryRun: input.dryRun,
    candidates,
    expiredCount: newlyExpired.length,
    holdNotificationIntents: intents,
  });
}

/**
 * Expire ONE parked request in its own transaction: lock, guarded flip,
 * release its live holds, the one note, the audit row. Null when the guard
 * failed (nothing written); `"failed"` when the transaction threw (rolled
 * back, logged and reported).
 */
async function expireOneParked(
  deps: ExpireParkedBookingRequestsDeps,
  candidate: ToVenueBookingRequestRecord,
  now: Date,
): Promise<
  | { expired: BookingRequestRecord; intents: BookingHoldNotificationIntent[] }
  | null
  | "failed"
> {
  try {
    // Intents come back from the tx's RETURN value, so a rolled-back tx
    // leaves no notifications for releases that never committed.
    return await deps.repos.tx(async (tx) => {
      // The booking lock FIRST (before the release's line locks) — the lock
      // every booking path takes before writing a CONFIRMED hold.
      // 08-27 amendment point 3: expire parked requests, releasing their holds
      await tx.bookingHolds.lockRequestBooking(candidate.id);
      const expired = await tx.bookingRequests.expireParked({
        id: candidate.id,
      });
      if (!expired) return null;

      const holds = await releaseHoldsForClosedRequest(tx, {
        bookingRequestId: expired.id,
        now,
        // Machine-caused: no human on any thread.
        actor: { humanId: null, kind: "staff" },
      });

      await appendBookingSystemEntry(tx, {
        bookingRequestId: expired.id,
        kind: "booking_request.expired_unclaimed",
        data: { placeName: clipPlaceName(expired.placeName) },
        actorHumanId: null,
      });

      await tx.audit.log({
        entity: "booking_request",
        entityId: expired.id,
        action: "booking_request.expired_unclaimed",
        data: {
          placeId: candidate.placeId,
          parkedUnclaimedAt:
            candidate.parkedUnclaimedAt?.toISOString() ?? null,
          releasedHolds: holds.released.length,
        },
        at: now,
      });

      return { expired, intents: holds.intents };
    });
  } catch (error) {
    deps.logger?.error("booking_requests.expire_parked_failed", {
      bookingRequestId: candidate.id,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "expireParkedBookingRequests" },
        extra: { bookingRequestId: candidate.id },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never abort the
      // rest of the run.
    }
    return "failed";
  }
}

function describe(
  request: ToVenueBookingRequestRecord,
): Omit<ExpireParkedBookingRequestsOutput["candidates"][number], "outcome"> {
  return {
    bookingRequestId: request.id,
    placeId: request.placeId,
    placeName: request.placeName,
    status: request.status,
    source: request.source,
    parkedUnclaimedAt: request.parkedUnclaimedAt?.toISOString() ?? null,
  };
}

/** The entry's venue snapshot; null when the place row is gone or unnamed. */
function clipPlaceName(name: string | null): string | null {
  const trimmed = name?.trim().slice(0, PLACE_NAME_MAX).trim();
  return trimmed ? trimmed : null;
}
