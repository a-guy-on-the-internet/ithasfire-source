import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import { bookingHoldNotificationIntentSchema } from "../booking-holds/_shared/booking-hold-intents";
import { releaseHoldsForClosedRequest } from "../booking-holds/_shared/release-for-request";
import {
  assertAcceptedRequestCanExitInTx,
  assertNoBookedNightAfterReleaseInTx,
  assertNoNewExitDraftInTx,
  cancelExitTermsInTx,
  exitDraftEventIdOf,
  runExitWithDraftCancel,
  type ExitEventCancellationDeps,
} from "./_shared/accepted-request-exit";
import { requirePlaceOwnership } from "./_shared/place-access";
import { bookingRequestStatusSchema } from "./list-booking-requests";
import {
  BOOKING_REASON_MAX,
  appendBookingSystemEntry,
} from "./messages/_shared/system-entries";
import {
  fireBookingLineupRequestClosed,
  type NotifyBookingLineupRequestClosedFn,
} from "./notify-booking-lineup-request-closed";
import {
  fireBookingRequestResponded,
  type NotifyBookingRequestRespondedFn,
} from "./notify-booking-request-responded";

// ─────────────────────────────────────────────────────────────────────────────
// closeBookingRequest — the venue's "Close request" (booking-the-night N14 /
// FR-010). An ACCEPTED request has exits until its night is booked; this is
// the venue's, with a reason (N18: required wherever something ends). Before
// accept the venue's "no" is a decline (`respondToBookingRequest`); after the
// night is booked the one undo is Cancel booking.
//
//   gates (read-only): a request to a VENUE; the actor is the venue side with
//     an edit role — the same bar as accept / decline
//     (`requirePlaceOwnership` + ORG_EDIT_ROLES; a booking grant is not a
//     party to the conversation);
//   one transaction, after the request's booking lock (the lock every take,
//     Cancel booking, Withdraw and hold placement take first):
//     re-read — still ACCEPTED; refused BOOKING_NIGHT_BOOKED when a night is
//     booked (no meta), BOOKING_CANCELLED after a cancelled booking,
//     AGREEMENT_FINALIZED on finalized terms →
//     request ACCEPTED → DECLINED (CAS; the reason stored as its
//     declineReason) → ledger `booking_request.closed_by_place {reason}` →
//     every live hold released (REQUEST_CLOSED; the movers renumbered) →
//     the draft terms CANCELLED → audit.
//   post-commit, best-effort (swallowed + reported): the sender hears it with
//     the reason (`booking.request-responded`, action `closed`); every act
//     that JOINED the bill hears it isn't going ahead — never the reason
//     (lineup v3 L7).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `reason` is REQUIRED free text, sanitized at the boundary exactly like a
 * decline reason: tags / entities / bidi and zero-width controls stripped
 * FIRST, then the 3-character floor on the CLEANED value; bounded by the one
 * booking reason cap (BOOKING_REASON_MAX = 1000).
 */
export const closeBookingRequestInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    reason: plainTextMultilineRequired(BOOKING_REASON_MAX).pipe(
      z.string().min(3),
    ),
  })
  .strict();

export const closeBookingRequestOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
    status: bookingRequestStatusSchema,
    /** The draft terms this close cancelled; null when there were none. */
    cancelledAgreementId: z.uuid().nullable(),
    /** Move-up notices owed to the other acts in the lines it left. */
    holdNotificationIntents: z.array(bookingHoldNotificationIntentSchema),
  })
  .strict();

/** What transport puts on the wire: the hold intents stay server-side. */
export const closeBookingRequestWireOutputSchema = z.object(
  closeBookingRequestOutputSchema.omit({ holdNotificationIntents: true }).shape,
);

export type CloseBookingRequestInput = z.infer<
  typeof closeBookingRequestInputSchema
>;
export type CloseBookingRequestOutput = z.infer<
  typeof closeBookingRequestOutputSchema
>;

export type CloseBookingRequestDeps = {
  /** The full bag: the close may cancel the request's still-DRAFT event. */
  repos: Repos;
  clock: ClockPort;
  /**
   * cancelEvent's ports, for the request's still-DRAFT event (no orders, so
   * nothing is refunded). Required only when there is one.
   */
  eventCancellation?: ExitEventCancellationDeps;
  logger?: LoggerPort;
  /** The sender hears the close, with the reason (N9 / FR-008). */
  notifyBookingRequestResponded?: NotifyBookingRequestRespondedFn;
  /** Joined acts hear it isn't going ahead (lineup v3 L7). */
  notifyBookingLineupRequestClosed?: NotifyBookingLineupRequestClosedFn;
  /** Swallow reporter for both notices (ReporterPort convention). */
  reportError?: ReporterPort;
};

export async function closeBookingRequest(
  deps: CloseBookingRequestDeps,
  rawInput: unknown,
): Promise<CloseBookingRequestOutput> {
  const input = parseInput(closeBookingRequestInputSchema, rawInput);
  const logger = deps.logger?.child({ useCase: "closeBookingRequest" });

  const request = await deps.repos.bookingRequests.getById(
    input.bookingRequestId,
  );
  if (!request) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }
  if (request.direction !== "TO_VENUE") {
    throw fail("INVALID_INPUT", {
      message: "booking_request_not_venue_bound",
      meta: { bookingRequestId: request.id, direction: request.direction },
    });
  }
  const place = await deps.repos.places.getById(request.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  // The venue side with an edit role — the accept / decline bar.
  await requirePlaceOwnership(deps.repos, place, input.actorHumanId, {
    requiredOrgRoles: ORG_EDIT_ROLES,
  });
  if (request.status !== "ACCEPTED") {
    // Open requests are declined, closed ones are already over.
    throw fail("INVALID_STATUS", {
      message: "booking_request_not_accepted",
      meta: { bookingRequestId: request.id, status: request.status },
    });
  }

  const now = deps.clock.now();

  // The request's still-DRAFT event ends with it (review round 1): the close
  // then runs INSIDE that event's cancellation transaction.
  const preTerms = request.agreementId
    ? await deps.repos.agreements.getById(request.agreementId)
    : null;
  const draftEventId = await exitDraftEventIdOf(deps.repos, preTerms, request);

  const body = async (tx: TxRepos) => {
    // Booking lock first (before any line lock — the global order).
    await tx.bookingHolds.lockRequestBooking(request.id);
    const fresh = await tx.bookingRequests.getById(request.id);
    if (!fresh || fresh.status !== "ACCEPTED") {
      throw fail("INVALID_STATUS", {
        message: "booking_request_not_accepted",
        meta: { bookingRequestId: request.id, status: fresh?.status ?? null },
      });
    }
    const terms = await assertAcceptedRequestCanExitInTx(tx, fresh);
    await assertNoNewExitDraftInTx(tx, terms, fresh);

    const updated = await tx.bookingRequests.updateStatus({
      id: fresh.id,
      status: "DECLINED",
      expectedFrom: ["ACCEPTED"],
      declineReason: input.reason,
    });

    // Reason COPIED onto the entry (a ledger records what was said then).
    await appendBookingSystemEntry(tx, {
      bookingRequestId: updated.id,
      kind: "booking_request.closed_by_place",
      data: { reason: input.reason },
      actorHumanId: input.actorHumanId,
    });

    // A closed request keeps no place in any line (booking-holds FR-009).
    const holds = await releaseHoldsForClosedRequest(tx, {
      bookingRequestId: updated.id,
      now,
      actor: { humanId: input.actorHumanId, kind: "staff" },
    });
    // Defence (review W1): nothing booked the night meanwhile.
    await assertNoBookedNightAfterReleaseInTx(tx, updated.id);

    const cancelledAgreementId = await cancelExitTermsInTx(tx, {
      agreement: terms,
      bookingRequestId: updated.id,
      actorHumanId: input.actorHumanId,
      via: "close_request",
      reason: input.reason,
      now,
    });

    await tx.audit.log({
      entity: "booking_request",
      entityId: updated.id,
      action: "booking_request.closed_by_place",
      data: {
        actorHumanId: input.actorHumanId,
        placeId: place.id,
        reason: input.reason,
        releasedHoldIds: holds.released.map((hold) => hold.id),
        cancelledAgreementId,
        cancelledDraftEventId: draftEventId,
      },
      at: now,
    });

    return { request: updated, holdIntents: holds.intents, cancelledAgreementId };
  };

  const closed = draftEventId
    ? await runExitWithDraftCancel(deps, deps.eventCancellation, {
        bookingRequestId: request.id,
        draftEventId,
        actorHumanId: input.actorHumanId,
        body,
      })
    : await deps.repos.tx(body);

  // The sender hears it, with the reason (N9 / FR-008).
  await fireBookingRequestResponded(
    { ...deps, logger },
    {
      bookingRequest: closed.request,
      action: "closed",
      agreementId: closed.request.agreementId ?? null,
      reason: input.reason,
      actorHumanId: input.actorHumanId,
    },
    "closeBookingRequest",
  );
  // Joined acts hear it isn't going ahead (v3 L7) — never the reason.
  await fireBookingLineupRequestClosed(
    { ...deps, logger },
    {
      bookingRequest: closed.request,
      closedBy: "closed",
      actorHumanId: input.actorHumanId,
    },
    "closeBookingRequest",
  );

  logger?.info("booking_requests.closed_by_venue", {
    bookingRequestId: closed.request.id,
    actorHumanId: input.actorHumanId,
    cancelledAgreementId: closed.cancelledAgreementId,
  });

  return closeBookingRequestOutputSchema.parse({
    bookingRequestId: closed.request.id,
    status: closed.request.status,
    cancelledAgreementId: closed.cancelledAgreementId,
    holdNotificationIntents: closed.holdIntents,
  });
}
