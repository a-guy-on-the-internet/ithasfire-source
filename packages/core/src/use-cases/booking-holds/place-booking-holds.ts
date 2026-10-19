import { z } from "zod";

import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";
import type { ReporterPort } from "@th/ports/reporter";
import { isAppError } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
  type BookingHoldNotificationIntent,
} from "./_shared/booking-hold-intents";
import {
  bookingHoldOutputSchema,
  isoCalendarDateSchema,
  staffRecipientHintFor,
  toBookingHoldOutput,
  type BookingHoldDeps,
} from "./_shared/hold-context";
import { isHoldLineChangedConflict } from "./_shared/hold-line";
import {
  checkHoldDate,
  isHoldExistsConflict,
  isHoldLineAlreadyConfirmed,
  placeHoldOnLine,
  resolveHoldPlacementContext,
} from "./_shared/place-hold-on-line";

// ─────────────────────────────────────────────────────────────────────────────
// placeBookingHolds (FR-002, batch): staff pencil an act in for SEVERAL dates
// in one action — the common case when a venue offers a run of nights.
//
// ONE resolve/gate up front, then ONE TRANSACTION PER DATE, in ascending date
// order. The per-date transaction is deliberate: each line takes its own
// advisory lock inside `settleLine`, and a single transaction spanning many
// lines invites the deadlock the lock ordering exists to prevent. The cost is
// that PARTIAL SUCCESS is a real outcome — dates that could not be held come
// back in `failed` while the rest stand. That is the designed behaviour, not
// a bug, and it is why the output is a pair of lists rather than a throw.
//
// INVARIANT: this use case NEVER throws once a hold is durable — the whole
// CALL, not merely the loop (the tail at the bottom is guarded too). A throw
// after a commit would discard the `notificationIntents` for the dates that
// DID land, and the act would end up holding dates with no email and no push
// — silently, since the ledger entries still render in-thread. So every
// post-commit failure lands in `failed[]` (and an unrecognised one is
// reported through `reportError`). The single throwing case is
// `placed.length === 0`, where nothing is committed and nothing is lost.
//
// STALE GATE (accepted, by design): the request-status check in
// `resolveHoldPlacementContext` runs ONCE, up front, and is the one thing
// here that genuinely goes stale — the batch stretches the TOCTOU window
// from roughly one transaction to as many as twelve. If the act withdraws or
// staff decline mid-loop, the remaining dates get holds on a request that is
// already terminal, and the closure path has run and cannot see them. This
// SELF-HEALS: `settleLapsedHolds` releases any live hold whose request is
// DECLINED / WITHDRAWN / EXPIRED as `REQUEST_CLOSED` the next time anyone
// touches that line (the FR-009 backstop), so the reconciliation is the
// design, not an accident. Deliberately NOT fixed with a per-date status
// re-read: a query per date does not buy enough to be worth it, and the same
// window shape already exists on the single-date path.
//
// LEDGER STAYS PER DATE — one `booking_hold.placed` system entry per hold.
// A system entry renders as an unboxed hairline line (not a chat bubble), and
// `booking_hold.released` / `.challenged` / `.confirmed` are already per hold,
// so a "released Fri 16" line with no matching "placed Fri 16" would read as
// a hole in the thread's history.
//
// NOTIFICATION IS A DIGEST — ONE `hold.placed_batch` intent for 2+ holds, so
// three dates are one email and one push rather than three of each. Exactly
// one hold falls back to the plain `hold.placed` intent, leaving the
// single-date copy untouched. Zero placed → nothing owed.
// ─────────────────────────────────────────────────────────────────────────────

/** Hard cap on one batch — a staff pencil-in, not a bulk import. */
export const MAX_BOOKING_HOLD_BATCH_DATES = 12;

/**
 * Why a date in the batch got no hold. Closed set: anything else rethrows, so
 * an unknown failure is never quietly downgraded to "one date didn't work".
 */
export const BOOKING_HOLD_BATCH_FAILURE_CODES = [
  /** This request is already live in that line (the live partial unique). */
  "booking_hold_exists",
  /** The night already went to another act — a new hold could never win. */
  "HOLD_LINE_ALREADY_CONFIRMED",
  /** Place-local past date (FR-010 would kill it on the next read anyway). */
  "hold_date_in_past",
  /** Not a real calendar day in the place's zone. */
  "invalid_calendar_date",
  /**
   * The line moved under us (a stale renumber set, or a deadlock /
   * serialization failure the adapter folded into the same shape). The
   * transaction rolled back, so NO hold exists for this date — reporting it
   * as failed is accurate, and it is per-line and retryable, so it must not
   * take the rest of the batch down with it.
   */
  "HOLD_LINE_CHANGED",
  /**
   * Something we do not recognise went wrong on this date. Only ever
   * RECORDED once an earlier date is already durable — see the loop below;
   * with nothing committed the batch throws instead, so this code never
   * hides a systemic failure.
   */
  "unknown_error",
] as const;

export type BookingHoldBatchFailureCode =
  (typeof BOOKING_HOLD_BATCH_FAILURE_CODES)[number];

export const placeBookingHoldsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    calendarId: z.uuid(),
    /**
     * 1..12 ISO `YYYY-MM-DD` days, place-local. Deduped and sorted ascending
     * before anything is written, so the caller's ordering never decides who
     * gets which position.
     */
    dates: z
      .array(isoCalendarDateSchema)
      .min(1)
      .max(MAX_BOOKING_HOLD_BATCH_DATES),
  })
  .strict();

export const placeBookingHoldsOutputSchema = z
  .object({
    /** The holds actually written, ascending by date. */
    placed: z.array(bookingHoldOutputSchema),
    /** The dates that got no hold, ascending, with the reason. */
    failed: z.array(
      z
        .object({
          date: isoCalendarDateSchema,
          code: z.enum(BOOKING_HOLD_BATCH_FAILURE_CODES),
        })
        .strict(),
    ),
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema,
  })
  .strict();

/** What transport puts on the wire: the intents + routing hint stay server-side. */
export const placeBookingHoldsWireOutputSchema = z.object(
  placeBookingHoldsOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type PlaceBookingHoldsInput = z.infer<
  typeof placeBookingHoldsInputSchema
>;
export type PlaceBookingHoldsOutput = z.infer<
  typeof placeBookingHoldsOutputSchema
>;
export type PlaceBookingHoldsWireOutput = z.infer<
  typeof placeBookingHoldsWireOutputSchema
>;
export type PlaceBookingHoldsDeps = BookingHoldDeps & {
  /**
   * ReporterPort convention (CLAUDE.md): this use case CATCHES a per-date
   * failure and returns a degraded result once anything is committed, so the
   * swallow must be reported, not just logged. Guarded at the call site so a
   * throwing reporter can never change the outcome.
   */
  reportError?: ReporterPort;
};

/**
 * Map a per-date failure onto the closed set, or return null when the error
 * is something else entirely (caller rethrows).
 */
function batchFailureCode(error: unknown): BookingHoldBatchFailureCode | null {
  if (isHoldExistsConflict(error)) return "booking_hold_exists";
  if (isHoldLineAlreadyConfirmed(error)) return "HOLD_LINE_ALREADY_CONFIRMED";
  // TWO shapes reach here, both verified against the adapter (which maps a
  // deadlock / serialization failure to `booking_hold_line_changed` on
  // `create`, `updateStatus` AND `renumberLine`):
  //   - the RAW adapter conflict, straight out of `tx.bookingHolds.create`;
  //   - the TYPED AppError, from `settleLine`'s release/renumber path, which
  //     already ran it through `rethrowHoldLineConflict`.
  if (isHoldLineChangedConflict(error)) return "HOLD_LINE_CHANGED";
  if (isAppError(error) && error.code === "HOLD_LINE_CHANGED") {
    return "HOLD_LINE_CHANGED";
  }
  return null;
}

export async function placeBookingHolds(
  deps: PlaceBookingHoldsDeps,
  rawInput: unknown,
): Promise<PlaceBookingHoldsOutput> {
  const input = parseInput(placeBookingHoldsInputSchema, rawInput);
  const now = deps.clock.now();

  const { request, place, ownership, placeTz, calendarId } =
    await resolveHoldPlacementContext(deps.repos, {
      bookingRequestId: input.bookingRequestId,
      calendarId: input.calendarId,
      actorHumanId: input.actorHumanId,
      now,
    });

  // Dedupe + ascending: the same date twice is one hold, and the earliest
  // night is placed first so a partially-full run reads left to right.
  const dates = [...new Set(input.dates)].sort();

  const placed: BookingHoldRecord[] = [];
  const failed: Array<{ date: string; code: BookingHoldBatchFailureCode }> = [];
  const intents: BookingHoldNotificationIntent[] = [];

  for (const date of dates) {
    const dateIssue = checkHoldDate(date, now, placeTz);
    if (dateIssue) {
      failed.push({ date, code: dateIssue });
      continue;
    }

    try {
      // ONE TRANSACTION PER DATE — see the header. Each line takes its own
      // advisory lock; spanning them would invite a deadlock.
      const outcome = await deps.repos.tx(async (tx) =>
        placeHoldOnLine(tx, {
          request,
          calendarId,
          date,
          now,
          placeTz,
          actorHumanId: input.actorHumanId,
        }),
      );
      placed.push(outcome.hold);
      intents.push(...outcome.intents);
    } catch (error) {
      const known = batchFailureCode(error);
      if (known) {
        failed.push({ date, code: known });
        continue;
      }

      // ── Unknown failure ────────────────────────────────────────────────
      // THE RULE: never throw once a hold in this batch is durable. Each
      // date commits in its own transaction, so by the time date 3 blows up
      // dates 1-2 already exist in the DB — and a throw would take their
      // `notificationIntents` with it, leaving the act holding two dates
      // with no email and no push. The ledger entries would still render
      // in-thread, so the loss is silent. `failed[]` exists precisely so
      // the loop has somewhere to put this.
      deps.logger?.error("booking_holds.place_many.date_failed", {
        bookingRequestId: request.id,
        calendarId,
        date,
        placedSoFar: placed.length,
        err: error,
      });

      if (placed.length === 0) {
        // Nothing is committed, so a throw loses nothing and is the honest
        // signal for a systemic failure (the DB is down, not "this one date
        // didn't work"). Known failures recorded so far are re-derivable on
        // retry — no bookkeeping needed to preserve them. Thrown errors ride
        // the transport/Sentry backstops, so no reportError here.
        throw error;
      }

      // Committed work exists: degrade instead of throwing, and REPORT the
      // swallow (ReporterPort convention — the log line above stays, the
      // report is additive). Guarded: a throwing reporter must not turn a
      // degraded result back into a failed batch.
      try {
        deps.reportError?.(error, {
          tags: { useCase: "placeBookingHolds", step: "place_date" },
          extra: {
            bookingRequestId: request.id,
            calendarId,
            date,
            placedSoFar: placed.length,
          },
        });
      } catch {
        // Best-effort reporting only.
      }
      failed.push({ date, code: "unknown_error" });
    }
  }

  // ONE digest for 2+, the unchanged single-date copy for exactly one.
  if (placed.length >= 2) {
    intents.push({
      kind: "hold.placed_batch",
      bookingRequestId: request.id,
      // The first hold anchors the fingerprint / push collapse key; the
      // idempotency key hashes the whole `holdIds` set.
      holdId: placed[0]!.id,
      audience: "act",
      date: placed[0]!.date,
      dates: placed.map((hold) => ({
        date: hold.date,
        position: hold.position,
      })),
      holdIds: placed.map((hold) => hold.id),
    });
  } else if (placed.length === 1) {
    const only = placed[0]!;
    intents.push({
      kind: "hold.placed",
      bookingRequestId: request.id,
      holdId: only.id,
      audience: "act",
      date: only.date,
      position: only.position,
    });
  }

  // Pure projection over rows already in hand — field copying, no I/O and no
  // validation, so this is the one part of the tail that cannot fail on data.
  const payload: PlaceBookingHoldsOutput = {
    placed: placed.map((hold) => toBookingHoldOutput(hold, now, placeTz)),
    failed,
    notificationIntents: intents,
    staffRecipientHint: staffRecipientHintFor({
      // Nominal placer: this actor wrote every row in the batch. When nothing
      // was placed the hint still has to name someone for FR-016 routing.
      hold: { placedByHumanId: input.actorHumanId },
      request,
      place,
      ownership,
    }),
  };

  // ── The tail is inside the invariant too ──────────────────────────────────
  // "Never throw once a hold is durable" is a property of the CALL, not just
  // of the loop. These last two statements can throw as well — a throwing
  // logger, or a schema miss — and a throw HERE would discard the intents for
  // already-committed holds exactly as surely as one from inside the loop.
  //
  // Neither has a constructible failing input today: `failed[].date` is
  // regex-validated on the way in, `placed` fields come straight off DB rows,
  // and the hint reads UUID columns. So this is a latent contract gap rather
  // than a live bug — closed anyway, because "nothing reaches it today" is
  // not a guarantee, and the whole point of `failed[]` is that committed work
  // is never lost on the way out.
  //
  // Degrading returns the UNPARSED payload, which does NOT put unvalidated
  // data on the wire: the router fires the notifier and only THEN runs
  // `placeBookingHoldsWireOutputSchema.parse(result)`. So the notification for
  // the committed holds survives and the wire contract is still enforced at
  // the transport boundary — the validation moves, it does not disappear.
  try {
    deps.logger?.info("booking_holds.placed_many", {
      bookingRequestId: request.id,
      calendarId,
      requested: dates.length,
      placed: placed.length,
      failed: failed.length,
      actorHumanId: input.actorHumanId,
    });
    return placeBookingHoldsOutputSchema.parse(payload);
  } catch (error) {
    if (placed.length === 0) {
      // Nothing committed: a throw loses nothing, and a malformed empty
      // result is a bug worth surfacing loudly.
      throw error;
    }
    try {
      deps.reportError?.(error, {
        tags: { useCase: "placeBookingHolds", step: "finalize" },
        extra: {
          bookingRequestId: request.id,
          calendarId,
          placed: placed.length,
          failed: failed.length,
        },
      });
    } catch {
      // Best-effort reporting only.
    }
    return payload;
  }
}
