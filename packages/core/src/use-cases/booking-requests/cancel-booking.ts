import { z } from "zod";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";
import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";
import type { ToVenueBookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import { fail, isAppError } from "@th/errors";

import { parseInput } from "../../lib/io";
import { normalizeCancellerSide } from "../../lib/legacy-place-values";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import { ORG_ADMIN_ROLES, requireOrgMembership } from "../../lib/rbac";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
  type BookingHoldNotificationIntent,
} from "../booking-holds/_shared/booking-hold-intents";
import {
  anchorBookingNight,
  assertBookingEventOnNight,
  bookingNightOf,
  failBookingHasMultipleEvents,
  isBookingCancelled,
  listLiveBookingEvents,
  bookingEventOwningSide,
} from "../booking-holds/_shared/booking-night";
import { staffRecipientHintFor } from "../booking-holds/_shared/hold-context";
import {
  assertLineSetCovered,
  casHoldStatus,
  isHoldStatusConflict,
  lineKeysOf,
  lockLines,
  releaseHoldCas,
  renumberLinesOf,
} from "../booking-holds/_shared/hold-line";
import {
  cancelEventForBooking,
  type CancelEventDeps,
} from "../events/cancel-event";
import { ensureBookingThreadParticipant } from "./messages/_shared/thread-access";
import {
  BOOKING_REASON_MAX,
  appendBookingSystemEntry,
} from "./messages/_shared/system-entries";
import {
  fireBookingLineupRequestClosed,
  type NotifyBookingLineupRequestClosedFn,
} from "./notify-booking-lineup-request-closed";
import {
  fireBookingCancelled,
  type NotifyBookingCancelledFn,
} from "./notify-booking-cancelled";
import {
  requirePlaceBookingAuthority,
  type PlaceBookingAuthorityResult,
} from "./_shared/place-access";

// ─────────────────────────────────────────────────────────────────────────────
// cancelBooking — "Cancel booking" (booking-the-night N13 / FR-009): the ONE
// undo for a booked night. The terms, the booked hold and the event live and
// die together (CONTEXT.md "Booking").
//
// WHO (review round 1, orchestrator ruling): the venue side (the place's
// STAFF booking authority: owner / edit-role member) or the sender pair (the human act, or the act org's edit-role
// members — the thread's PERFORMER participant gate) — EXCEPT that:
//   - whichever side OWNS the live event is held to cancelEvent's own bar
//     for it (owner ruling 2026-09-28, refunds included): OWNER / ADMIN of
//     the event's org, or the event's human owner or their OWNER / ADMIN
//     delegate. An EDITOR of the owning org cannot refund its sales by way of
//     a booking. The NON-owning side keeps its booking gate (N13: either side
//     may cancel);
//   - a booking GRANT holder is not the venue side (holds-without-a-request
//     FR-002: the staff gate has no grant arm), so it cancels nothing here
//     unless it is also the sender pair, and then as the sender: cancelling
//     can refund sales that are not theirs.
//
// THE EVENT MUST SIT ON THE BOOKED NIGHT (review round 1). Finalize can link
// the terms to any event the finalizer can edit; cancelling the booking must
// never cancel (and refund) an event on another night or calendar. Checked
// read-only before anything moves (venue: HOLD_DATE_MISMATCHES_EVENT /
// EVENT_ON_ANOTHER_CALENDAR with meta; sender: EVENT_ON_ANOTHER_NIGHT, no
// meta) and again under the locks, against the event the pre-flight saw.
//
// WHEN: the request has a CONFIRMED hold (the night is booked) and is ACCEPTED
// — or still PENDING / VIEWED (an event-first request whose hold a venue
// confirm made CONFIRMED before anyone answered it: Withdraw and Decline
// refuse that state with BOOKING_NIGHT_BOOKED and point here, so this is its
// undo; FR-009's "allowed once the night is booked" covers it, and the request
// then stays as it was — "as history", closed for new holds — still open to
// the venue's decline or the sender's withdraw) — the booking was never
// cancelled before, and the event has not started (its `startsAt`; with no
// live event, the terms' instant on the night, else the night at 19:00 place
// time). Anything else is BOOKING_NOT_CANCELLABLE.
//
// ONE EVENT (review round 2): the booking may point at several events — the
// event-first origin, the finalized link, a legacy draft anchor. Cancelling
// one would leave another live and on sale on the freed night, and which one a
// retry resolves could differ from the one the pre-flight picked. So the
// booking must have AT MOST ONE live event; with more, it is refused before
// money moves (BOOKING_HAS_MULTIPLE_EVENTS — venue side carries the ids, the
// sender's is bare) rather than cancelling several events' sales in one
// request: cancelEvent's refunds stay one event per call, and the venue
// decides which show stands.
//
// ONE TRANSACTION for the booking's writes, under the request's booking lock
// and the night's line lock (`cancelBookingInTx`):
//   - the terms → CANCELLED from any live status, ACCEPTED and FINALIZED
//     included (the only path that cancels finalized terms), and their own
//     payout terms (a per-agreement clone, never an org / place / human
//     default) → ARCHIVED, so no payout line stays in force on a cancelled
//     event;
//   - the booked hold CONFIRMED → RELEASED (BOOKING_CANCELLED) — the ONE path
//     that releases a CONFIRMED hold (the release use case still refuses it),
//     plus any live hold the request still had (same reason);
//   - ledger `booking_request.booking_cancelled {by, reason}` + audit.
// The request stays ACCEPTED as history and is CLOSED for new holds: a hold
// released BOOKING_CANCELLED is the derived marker every placement and take
// refuses on (BOOKING_CANCELLED).
//
// THE EVENT goes CANCELLED through the existing cancelEvent use case — its
// refunds, resale settling, media cleanup and change-notice outbox, never
// reimplemented here. cancelEvent issues its Stripe refunds BEFORE its own
// transaction (they are external calls), so it cannot run inside ours;
// instead OURS runs inside ITS transaction (`cancelEventForBooking`'s
// `withinTx`, right after the event row is cancelled). One commit therefore
// carries the event's CANCELLED and the night's release:
//   - commits → event CANCELLED, refunds marked, terms CANCELLED and
//     archived, night free. Never a live event on a freed night; never a
//     cancelled event on a booked night.
//   - fails before commit (a refusal under our locks, a lost CAS, a DB
//     error) → NOTHING of either commits: the event is still live and the
//     night still booked. Refunds Stripe already issued are the cancelEvent
//     failure mode it documents (the refund metadata lets the charge.refunded
//     reconciler mark the items); a retry — by either side — runs under the
//     SAME booking-scoped idempotency key, so the Stripe refund keys are the
//     same and Stripe returns the refunds it already made, never a second.
//     The error propagates (a thrown Error reaches the tRPC backstop).
//   - some orders' refunds fail → the cancellation still commits (cancelEvent's
//     rule); `failedRefundCount` says so, and cancelEvent reports each.
// With no live event (the mint never landed, or the event was cancelled /
// archived directly first) there is nothing to refund: our transaction runs
// alone. Either way the booking's writes re-check under the locks that no
// live event appeared since the pre-flight (a mint that landed in between) —
// HOLD_LINE_CHANGED, retryable, nothing written.
//
// CONCURRENCY: the request's booking lock (`bookingHolds.lockRequestBooking`)
// is taken first by every path that books, un-books or closes the request —
// agree & book, book without terms, the manual "Create event", Withdraw,
// Close request, hold placement — so each one decides on committed state:
//   - cancel vs agree: an agree that commits first booked a night this cancel
//     then undoes (it saw the CONFIRMED hold); a cancel that commits first
//     leaves the agree finding its terms CANCELLED (AGREEMENT_NOT_PROPOSED)
//     and the booking cancelled (BOOKING_CANCELLED) — nothing booked;
//   - cancel vs book without terms: the same, through tx1's lock;
//   - cancel twice: the second finds the hold RELEASED (BOOKING_NOT_
//     CANCELLABLE); two concurrent ones with a live event meet first in the
//     booking-scoped idempotency envelope (IDEMPOTENCY_LOCK_IN_PROGRESS, or a
//     replay of the first — answered BOOKING_NOT_CANCELLABLE, since this
//     call cancelled nothing).
//   - a post-commit mint (agree / book without terms) still running when the
//     cancel commits: its anchor CAS needs open terms, so it cannot anchor
//     an event to the cancelled booking; the draft it saved is left an
//     unanchored orphan on no calendar line, logged and reported by the mint.
//
// AFTER COMMIT, best-effort (each swallow logged at error and reported):
// both sides hear it in-app, by email and push, with the reason
// (`booking.booking-cancelled`; everyone but the canceller), and every act
// that JOINED the bill hears it isn't going ahead — never the reason (lineup
// v3 L7). Ticket buyers hear through cancelEvent's outbox.
// ─────────────────────────────────────────────────────────────────────────────

export const cancelBookingInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    /**
     * Required (N18: wherever something ends). Sanitized FIRST (tags,
     * entities, bidi / zero-width controls), then the 3-character floor on
     * the cleaned value, bounded by the one booking reason cap.
     */
    reason: plainTextMultilineRequired(BOOKING_REASON_MAX).pipe(
      z.string().min(3),
    ),
  })
  .strict();

export const cancelBookingOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
    /** The hold the night was booked on, now RELEASED (BOOKING_CANCELLED). */
    holdId: z.uuid(),
    cancelledBy: z.enum(["place", "sender"]),
    /** The terms this cancelled (null: the request had none). */
    agreementId: z.uuid().nullable(),
    /**
     * The event cancelled with the booking; null when none was live. VENUE
     * side only (review round 2): the sender never learns the venue's event
     * id — absent when the sender cancelled.
     */
    eventId: z.uuid().nullable().optional(),
    /**
     * The event's refund counts — VENUE side only (review W5): the sender
     * never learns the venue's sales. Absent when the sender cancelled.
     */
    refundedOrderCount: z.number().int().nonnegative().optional(),
    failedRefundCount: z.number().int().nonnegative().optional(),
    /** Move-up notices owed in the lines the request's live holds left. */
    holdNotificationIntents: z.array(bookingHoldNotificationIntentSchema),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema.nullable(),
  })
  .strict();

/** What transport puts on the wire: the intents + routing stay server-side. */
export const cancelBookingWireOutputSchema = z.object(
  cancelBookingOutputSchema.omit({
    holdNotificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type CancelBookingInput = z.infer<typeof cancelBookingInputSchema>;
export type CancelBookingOutput = z.infer<typeof cancelBookingOutputSchema>;

/** cancelEvent's bag (refunds need the payment port) plus the notices. */
export type CancelBookingDeps = CancelEventDeps & {
  repos: Repos;
  /**
   * Both sides hear it — in-app, email and push (`booking.booking-cancelled`,
   * the reason included; review W4). Best-effort, swallowed + reported.
   */
  notifyBookingCancelled?: NotifyBookingCancelledFn;
  /** Joined acts hear it isn't going ahead (lineup v3 L7). */
  notifyBookingLineupRequestClosed?: NotifyBookingLineupRequestClosedFn;
};

const AGREEMENT_LIVE_STATUSES = [
  "DRAFT",
  "PROPOSED",
  "COUNTERED",
  "ACCEPTED",
] as const;

/**
 * Request statuses a booked night can be cancelled from: ACCEPTED, or still
 * open (PENDING | VIEWED) when a venue confirm booked the night first. An
 * open request with a booked night is never EXPIRED by the sweep
 * (`bookingRequests.expireIfDue` skips a CONFIRMED hold; round-3 B1),
 * so a closed status here always means the exits ran — and they refuse a
 * booked night — or a legacy row; refused as not cancellable either way.
 */
const CANCELLABLE_REQUEST_STATUSES: readonly string[] = [
  "ACCEPTED",
  "PENDING",
  "VIEWED",
];

/** ACTIVE | CHALLENGED — a hold still in its line. */
const isLiveHold = (hold: Pick<BookingHoldRecord, "status">) =>
  (LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(hold.status);

type CancellerSide = {
  side: "venue" | "sender";
  /** The venue actor's booking authority; null for the sender side. */
  authority: PlaceBookingAuthorityResult | null;
};

export async function cancelBooking(
  deps: CancelBookingDeps,
  rawInput: unknown,
): Promise<CancelBookingOutput> {
  const input = parseInput(cancelBookingInputSchema, rawInput);
  const logger = deps.logger?.child({ useCase: "cancelBooking" });
  const now = deps.clock.now();

  // ── Load + authorize (no writes) ──────────────────────────────────────────
  const request = await deps.repos.bookingRequests.getById(
    input.bookingRequestId,
  );
  if (!request) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }
  if (request.direction !== "TO_VENUE") {
    // Only a request to a venue books a night.
    throw fail("BOOKING_NOT_CANCELLABLE");
  }
  const place = await deps.repos.places.getById(request.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  const requestHolds = await deps.repos.bookingHolds.listForRequest(request.id);
  const booked = requestHolds.find((h) => h.status === "CONFIRMED") ?? null;
  // Authority BEFORE anything about the booking's state is said: a non-party
  // learns nothing from the refusal it gets.
  const canceller = await resolveCanceller(deps.repos, {
    request,
    place,
    actorHumanId: input.actorHumanId,
  });

  // ── The booking must be booked, alive, and not started ───────────────────
  if (
    !booked ||
    !CANCELLABLE_REQUEST_STATUSES.includes(request.status) ||
    isBookingCancelled(requestHolds)
  ) {
    throw fail("BOOKING_NOT_CANCELLABLE");
  }
  const placeTz = resolveBookingTimezone(place.timezone);
  const agreement = request.agreementId
    ? await deps.repos.agreements.getById(request.agreementId)
    : null;
  // EVERY live event the booking points at (origin, finalized link, legacy
  // draft) — not just the one a resolver would pick.
  const liveEvents = await listLiveBookingEvents(deps.repos, {
    agreement,
    request,
  });
  if (liveEvents.some((e) => e.status === "COMPLETED")) {
    // The show happened.
    throw fail("BOOKING_NOT_CANCELLABLE");
  }
  if (liveEvents.length > 1) {
    // Ambiguous: cancelling one would leave the other live on the freed
    // night. Refused before anything moves.
    failBookingHasMultipleEvents({
      side: canceller.side,
      bookingRequestId: request.id,
      eventIds: liveEvents.map((e) => e.id),
    });
  }
  const liveEvent = liveEvents[0] ?? null;
  // The live event must be THIS booking's: on the booked night, on its
  // calendar — never another show the terms were finalized against.
  if (liveEvent) {
    assertBookingEventOnNight(
      { kind: "event", event: liveEvent },
      {
        night: booked.date,
        placeTz,
        side: canceller.side,
        agreementId: agreement?.id ?? null,
        calendarId: booked.calendarId,
      },
    );
  }
  const startsAt = bookingStartOf(liveEvent, agreement, booked, placeTz);
  if (!startsAt || startsAt.getTime() <= now.getTime()) {
    throw fail("BOOKING_NOT_CANCELLABLE");
  }

  // The side that OWNS the live event cancels it — and refunds its sales —
  // only on cancelEvent's own bar (OWNER / ADMIN; owner ruling 2026-09-28).
  // Defence in depth (review round 3, W1b): finalize refuses to link an
  // event owned by neither party, but a row that reached here anyway (a
  // legacy link, an ownership change) is a THIRD PARTY's sales — then every
  // canceller, whichever side, must hold that owner's OWNER / ADMIN role.
  if (liveEvent) {
    const owningSide = bookingEventOwningSide(liveEvent, place, request);
    if (owningSide === "neither" || canceller.side === owningSide) {
      await requireEventOwnerCancelRole(deps.repos, liveEvent, input.actorHumanId);
    }
  }

  // ── Cancel ────────────────────────────────────────────────────────────────
  const inTxArgs: CancelBookingInTxArgs = {
    request,
    holdId: booked.id,
    side: canceller.side,
    actorHumanId: input.actorHumanId,
    reason: input.reason,
    now,
    placeTz,
    expectedEventId: liveEvent?.id ?? null,
  };
  let written: CancelBookingInTxResult | null = null;
  let eventId: string | null = null;
  let refundedOrderCount = 0;
  let failedRefundCount = 0;

  const cancelWithoutEvent = async () => {
    written = await deps.repos.tx((tx) =>
      cancelBookingInTx(tx, { ...inTxArgs, expectedEventId: null }),
    );
  };

  if (liveEvent && (liveEvent.status === "DRAFT" || liveEvent.status === "PUBLISHED")) {
    try {
      const cancelled = await cancelEventForBooking(deps, {
        actorHumanId: input.actorHumanId,
        eventId: liveEvent.id,
        // Booking-scoped, never actor-scoped: both sides' retries converge on
        // one record and on the same Stripe refund keys.
        idempotencyKey: `bookingRequest:cancelBooking:${request.id}:${booked.id}`,
        // The deterministic refusals, re-run read-only BEFORE any refund is
        // issued: the common race (the event moved, re-finalized or
        // re-linked during the pre-flight) is then refused with the money
        // still in place. `cancelBookingInTx` re-checks under the locks.
        preRefundCheck: async (event) => {
          await recheckBookingOnReader(deps.repos, {
            ...inTxArgs,
            expectedEventId: event.id,
          });
        },
        withinTx: async (tx) => {
          written = await cancelBookingInTx(tx, inTxArgs);
        },
      });
      eventId = cancelled.eventId;
      refundedOrderCount = cancelled.refundedOrderCount;
      failedRefundCount = cancelled.failedRefundCount;
    } catch (error) {
      if (isAppError(error) && error.code === "EVENT_ALREADY_CANCELLED") {
        // Cancelled directly between our read and cancelEvent's: nothing is
        // left to refund — free the night alone.
        await cancelWithoutEvent();
      } else if (isAppError(error) && error.code === "EVENT_NOT_CANCELLABLE") {
        // Completed or archived in between.
        throw fail("BOOKING_NOT_CANCELLABLE");
      } else {
        throw error;
      }
    }
    if (written === null && eventId !== null) {
      // cancelEvent REPLAYED a cancellation another call committed (with
      // its own booking writes): this call cancelled nothing.
      throw fail("BOOKING_NOT_CANCELLABLE");
    }
  } else {
    await cancelWithoutEvent();
  }
  const result = written as CancelBookingInTxResult | null;
  if (!result) {
    // Both branches above either set it or threw.
    throw new Error("cancel_booking_without_writes");
  }

  // ── After commit (best-effort) ────────────────────────────────────────────
  // Both sides hear it, the reason included (review W4); never the canceller.
  await fireBookingCancelled(
    { ...deps, logger },
    {
      bookingRequest: request,
      holdId: booked.id,
      night: booked.date,
      cancelledBy: canceller.side,
      reason: input.reason,
      eventCancelled: eventId !== null,
      actorHumanId: input.actorHumanId,
    },
    "cancelBooking",
  );
  await fireBookingLineupRequestClosed(
    { ...deps, logger },
    {
      bookingRequest: request,
      closedBy: "booking_cancelled",
      actorHumanId: input.actorHumanId,
    },
    "cancelBooking",
  );

  logger?.info("booking_requests.booking_cancelled", {
    bookingRequestId: request.id,
    holdId: booked.id,
    cancelledBy: canceller.side,
    agreementId: result.agreement?.id ?? null,
    archivedPayoutTermsId: result.archivedPayoutTermsId,
    eventId,
    refundedOrderCount,
    failedRefundCount,
    actorHumanId: input.actorHumanId,
  });

  return cancelBookingOutputSchema.parse({
    bookingRequestId: request.id,
    holdId: booked.id,
    cancelledBy: normalizeCancellerSide(canceller.side),
    agreementId: result.agreement?.id ?? null,
    // The venue's event and sales are the venue's: the sender gets neither
    // the event id nor the refund counts.
    ...(canceller.side === "venue"
      ? { eventId, refundedOrderCount, failedRefundCount }
      : {}),
    holdNotificationIntents: result.intents,
    staffRecipientHint:
      result.intents.length > 0
        ? staffRecipientHintFor({
            hold: booked,
            request,
            place,
            ownership: canceller.authority,
          })
        : null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The booking's writes, in the caller's transaction
// ─────────────────────────────────────────────────────────────────────────────

export type CancelBookingInTxArgs = {
  request: ToVenueBookingRequestRecord;
  /** The booked (CONFIRMED) hold the pre-flight found. */
  holdId: string;
  side: "venue" | "sender";
  actorHumanId: string;
  reason: string;
  now: Date;
  placeTz: string;
  /**
   * The live event the pre-flight saw and is cancelling in this same
   * transaction (event path), or null (no live event). Re-checked here: it
   * must still be the booking's event and still sit on the booked line.
   */
  expectedEventId: string | null;
};

export type CancelBookingInTxResult = {
  /** The terms as cancelled (null: the request had none). */
  agreement: AgreementRecord | null;
  archivedPayoutTermsId: string | null;
  intents: BookingHoldNotificationIntent[];
};

/**
 * Un-book the night, in the caller's transaction (see the module doc): the
 * request's booking lock, then every line it touches; the refusals re-read
 * under them; then the terms, their payout terms, the holds, the ledger and
 * the audit. Throws — writing nothing — when the booking is no longer
 * cancellable (BOOKING_NOT_CANCELLABLE: the hold is no longer CONFIRMED, the
 * booking was cancelled meanwhile, the request is no longer ACCEPTED) or a
 * live event appeared since the pre-flight (HOLD_LINE_CHANGED, retryable).
 * When it runs inside cancelEvent's transaction the booking's event is
 * already CANCELLED in it, so "no live event" holds there too.
 */
export async function cancelBookingInTx(
  tx: TxRepos,
  args: CancelBookingInTxArgs,
): Promise<CancelBookingInTxResult> {
  const { request, now } = args;

  // ── Locks: the booking lock, then the lines (global order) ───────────────
  await tx.bookingHolds.lockRequestBooking(request.id);
  const before = await tx.bookingHolds.listForRequest(request.id);
  const bookedBefore = before.find((h) => h.id === args.holdId);
  const lockedKeys = lineKeysOf([
    ...(bookedBefore ? [bookedBefore] : []),
    ...before.filter(isLiveHold),
  ]);
  await lockLines(tx, lockedKeys);
  const holds = await tx.bookingHolds.listForRequest(request.id);
  const live = holds.filter(isLiveHold);
  try {
    assertLineSetCovered(lockedKeys, live);
  } catch (error) {
    // The sender's refusals carry nothing (review W5): not the venue's line.
    if (args.side === "sender" && isAppError(error) && error.code === "HOLD_LINE_CHANGED") {
      throw fail("HOLD_LINE_CHANGED");
    }
    throw error;
  }

  // ── Refusals, re-read under the locks ─────────────────────────────────────
  const { booked, agreement } = await recheckBookingOnReader(tx, args, holds);

  // ── The terms (any live status, finalized included) + their payout terms ─
  let cancelledAgreement = agreement;
  if (
    agreement &&
    (AGREEMENT_LIVE_STATUSES as readonly string[]).includes(agreement.status)
  ) {
    cancelledAgreement = await tx.agreements.updateStatus({
      id: agreement.id,
      status: "CANCELLED",
      expectedFrom: AGREEMENT_LIVE_STATUSES,
    });
    await tx.audit.log({
      entity: "booking_agreement",
      entityId: agreement.id,
      action: "booking_agreement.cancelled",
      data: {
        actorHumanId: args.actorHumanId,
        fromStatus: agreement.status,
        finalizedEventId: agreement.eventId,
        via: "cancel_booking",
        bookingRequestId: request.id,
        reason: args.reason,
      },
      at: now,
    });
  }
  // The agreement's OWN payout terms (cloned per agreement at accept; when
  // finalized, also the event's PRIMARY terms) go out of force. Never an
  // org / place / human default: a booking without terms points its event
  // at the organiser's own terms, which other events share.
  let archivedPayoutTermsId: string | null = null;
  if (agreement?.payoutTermsId) {
    const archived = await tx.payoutTerms.archive({
      payoutTermsId: agreement.payoutTermsId,
      expectedFrom: ["PENDING", "ACTIVE"],
    });
    if (archived) {
      archivedPayoutTermsId = archived.id;
      await tx.audit.log({
        entity: "payoutTerms",
        entityId: archived.id,
        action: "archived",
        data: {
          reason: "booking_cancelled",
          agreementId: agreement.id,
          bookingRequestId: request.id,
          eventId: agreement.eventId,
        },
        at: now,
      });
    }
  }

  // ── The booked hold: CONFIRMED → RELEASED, the one path that may ─────────
  try {
    await casHoldStatus(tx, {
      id: booked.id,
      status: "RELEASED",
      expectedFrom: ["CONFIRMED"],
      releasedAt: now,
      releasedReason: "BOOKING_CANCELLED",
      // History: when the night was booked stays on the row.
      confirmedAt: booked.confirmedAt,
    });
  } catch (error) {
    if (isHoldStatusConflict(error)) {
      throw fail("BOOKING_NOT_CANCELLABLE");
    }
    throw error;
  }
  // Any live hold the request still had: the booking is over, so are they.
  const released: BookingHoldRecord[] = [];
  for (const hold of live) {
    const row = await releaseHoldCas(tx, hold, {
      reason: "BOOKING_CANCELLED",
      now,
    });
    if (!row) continue;
    released.push(row);
    await appendBookingSystemEntry(tx, {
      bookingRequestId: request.id,
      kind: "booking_hold.released",
      data: { holdId: row.id, reason: "BOOKING_CANCELLED" },
      actorHumanId: args.actorHumanId,
    });
  }
  const intents =
    released.length > 0
      ? await renumberLinesOf(
          tx,
          released,
          args.side === "sender"
            ? { humanId: args.actorHumanId, kind: "act", ownRequestId: request.id }
            : { humanId: args.actorHumanId, kind: "staff" },
          now,
        )
      : [];

  // ── Ledger + audit ────────────────────────────────────────────────────────
  await appendBookingSystemEntry(tx, {
    bookingRequestId: request.id,
    kind: "booking_request.booking_cancelled",
    data: { by: args.side, reason: args.reason },
    actorHumanId: args.actorHumanId,
  });
  await tx.audit.log({
    entity: "booking_request",
    entityId: request.id,
    action: "booking_request.booking_cancelled",
    data: {
      actorHumanId: args.actorHumanId,
      by: normalizeCancellerSide(args.side),
      reason: args.reason,
      holdId: booked.id,
      calendarId: booked.calendarId,
      date: booked.date,
      agreementId: agreement?.id ?? null,
      agreementFromStatus: agreement?.status ?? null,
      archivedPayoutTermsId,
      releasedHoldIds: released.map((h) => h.id),
    },
    at: now,
  });

  return { agreement: cancelledAgreement, archivedPayoutTermsId, intents };
}

/**
 * The booking's deterministic refusals, on whatever reader is handed in: the
 * ROOT repos as the read-only re-check just before cancelEvent issues a
 * refund (`preRefundCheck`), the TRANSACTION under the locks as the
 * authoritative one. One function, so the early exit and the guard cannot
 * drift:
 *   - the hold is still CONFIRMED and the booking was not cancelled meanwhile;
 *   - the request is still in a cancellable status;
 *   - the event being cancelled is still one of the booking's (origin,
 *     finalized link, draft anchor), still exists and still sits on the booked
 *     night and calendar;
 *   - NO OTHER live event remains. In the transaction the expected event is
 *     already CANCELLED, so "none" is exact; before the refunds the expected
 *     one is excluded by id. Another live event is one that appeared (a mint,
 *     a finalize to another event) since the pre-flight picked its event —
 *     HOLD_LINE_CHANGED, retryable: the retry's pre-flight then sees the whole
 *     picture (and refuses an ambiguous booking by name).
 * `holds` are the request's holds when the caller already read them under its
 * locks. The sender's refusals carry no meta (review W5).
 */
async function recheckBookingOnReader(
  reader: Pick<Repos, "bookingHolds" | "bookingRequests" | "agreements" | "events">,
  args: CancelBookingInTxArgs,
  holds: BookingHoldRecord[] | null = null,
): Promise<{
  booked: BookingHoldRecord;
  agreement: AgreementRecord | null;
}> {
  const { request } = args;
  const heldRows = holds ?? (await reader.bookingHolds.listForRequest(request.id));
  const booked = heldRows.find((h) => h.id === args.holdId);
  if (!booked || booked.status !== "CONFIRMED" || isBookingCancelled(heldRows)) {
    throw fail("BOOKING_NOT_CANCELLABLE");
  }
  const fresh = await reader.bookingRequests.getById(request.id);
  if (!fresh || !CANCELLABLE_REQUEST_STATUSES.includes(fresh.status)) {
    throw fail("BOOKING_NOT_CANCELLABLE");
  }
  const agreement = fresh.agreementId
    ? await reader.agreements.getById(fresh.agreementId)
    : null;
  const changed = (message: string, meta: Record<string, unknown>): never => {
    if (args.side === "sender") throw fail("HOLD_LINE_CHANGED");
    throw fail("HOLD_LINE_CHANGED", { message, meta });
  };
  if (args.expectedEventId) {
    const linked = [
      fresh.originEventId,
      agreement?.eventId ?? null,
      agreement?.draftEventId ?? null,
    ];
    if (!linked.includes(args.expectedEventId)) {
      changed("booking_event_changed", {
        bookingRequestId: request.id,
        eventId: args.expectedEventId,
      });
    }
    const row = await reader.events.getById(args.expectedEventId);
    if (!row) {
      changed("booking_event_changed", {
        bookingRequestId: request.id,
        eventId: args.expectedEventId,
      });
    }
    assertBookingEventOnNight(
      { kind: "event", event: row! },
      {
        night: booked.date,
        placeTz: args.placeTz,
        side: args.side,
        agreementId: agreement?.id ?? null,
        calendarId: booked.calendarId,
      },
    );
  }
  const others = (
    await listLiveBookingEvents(reader, { agreement, request: fresh })
  ).filter((e) => e.id !== args.expectedEventId);
  if (others.length > 0) {
    changed("booking_event_appeared", {
      bookingRequestId: request.id,
      eventIds: others.map((e) => e.id),
    });
  }
  return { booked, agreement };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canceller's side: the venue (the place's staff booking authority) is
 * tried first, then the sender pair. Only the
 * two "no access" denials fall through; anything else propagates. Neither →
 * the venue gate's denial.
 */
async function resolveCanceller(
  repos: Repos,
  args: {
    request: ToVenueBookingRequestRecord;
    place: PlaceRecord;
    actorHumanId: string;
  },
): Promise<CancellerSide> {
  const asSender = async (): Promise<boolean> => {
    try {
      await ensureBookingThreadParticipant(
        repos,
        args.request,
        args.actorHumanId,
        "PERFORMER",
      );
      return true;
    } catch (senderDenial) {
      if (!isAccessDenial(senderDenial)) throw senderDenial;
      return false;
    }
  };
  let authority: PlaceBookingAuthorityResult;
  try {
    authority = await requirePlaceBookingAuthority(
      repos,
      args.place,
      args.actorHumanId,
    );
  } catch (venueDenial) {
    if (!isAccessDenial(venueDenial)) throw venueDenial;
    if (await asSender()) return { side: "sender", authority: null };
    throw venueDenial;
  }
  return { side: "venue", authority };
}

/**
 * cancelEvent's own bar for its owner (`ensureEventAccessible`, owner ruling
 * 2026-09-28: refunds included): an org event needs OWNER / ADMIN of that
 * org; a human event needs its owner or their OWNER / ADMIN delegate. An
 * ownerless row cannot be cancelled through a booking.
 */
async function requireEventOwnerCancelRole(
  repos: Repos,
  event: Pick<EventRecord, "orgId" | "humanId">,
  actorHumanId: string,
): Promise<void> {
  if (event.orgId) {
    await requireOrgMembership({
      repos,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_ADMIN_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
    return;
  }
  if (event.humanId) {
    await ensureActorHoldsHumanEventRole(
      repos.authz,
      event.humanId,
      actorHumanId,
      ORG_ADMIN_ROLES,
    );
    return;
  }
  throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
}

function isAccessDenial(error: unknown): boolean {
  return (
    isAppError(error) &&
    (error.code === "NOT_RESOURCE_OWNER" || error.code === "INSUFFICIENT_ROLE")
  );
}

/**
 * When the booked show starts: the live event's own start; else the terms'
 * instant when it falls on the booked night; else the night at the default
 * evening start (19:00 place time). Null for an impossible night.
 */
function bookingStartOf(
  liveEvent: EventRecord | null,
  agreement: AgreementRecord | null,
  booked: BookingHoldRecord,
  placeTz: string,
): Date | null {
  if (liveEvent) return liveEvent.startsAt;
  if (
    agreement?.proposedDate &&
    bookingNightOf(agreement.proposedDate, placeTz) === booked.date
  ) {
    return agreement.proposedDate;
  }
  return anchorBookingNight(booked.date, placeTz, null, null);
}
