import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
} from "@th/ports/repos/booking-requests";

import { parseInput } from "../../lib/io";
import {
  ORG_EDIT_ROLES,
  requireOrgMembership,
  requireOwnerAccess,
} from "../../lib/rbac";
import { bookingRequestStatusSchema } from "./list-booking-requests";
import { appendBookingSystemEntry } from "./messages/_shared/system-entries";
import { fail } from "@th/errors";
import { bookingHoldNotificationIntentSchema } from "../booking-holds/_shared/booking-hold-intents";
import type { ReporterPort } from "@th/ports/reporter";
import {
  fireBookingLineupRequestClosed,
  type NotifyBookingLineupRequestClosedFn,
} from "./notify-booking-lineup-request-closed";
import { releaseHoldsForClosedRequest } from "../booking-holds/_shared/release-for-request";
import {
  assertAcceptedRequestCanExitInTx,
  assertNoBookedNightAfterReleaseInTx,
  assertNoBookedNightInTx,
  assertNoNewExitDraftInTx,
  cancelExitTermsInTx,
  exitDraftEventIdOf,
  runExitWithDraftCancel,
  type ExitEventCancellationDeps,
} from "./_shared/accepted-request-exit";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const withdrawBookingRequestInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
  })
  .strict();

export const withdrawBookingRequestOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
    status: bookingRequestStatusSchema,
    /**
     * Booking-holds FR-009: move-up notifications owed to the other acts in
     * every line this request's released holds left (same tx as the CAS).
     * Empty on the idempotent already-WITHDRAWN paths; step 3 sends them.
     */
    holdNotificationIntents: z.array(bookingHoldNotificationIntentSchema),
  })
  .strict();

/**
 * What transport puts on the wire for the SENDER (the act, on TO_VENUE).
 * `holdNotificationIntents` name OTHER requests' holds (the movers in the
 * lines this request left) and exist for the post-commit dispatcher only —
 * the act must never learn who else is in line (booking-holds FR-013).
 */
export const withdrawBookingRequestWireOutputSchema = z.object(
  withdrawBookingRequestOutputSchema.omit({ holdNotificationIntents: true })
    .shape,
);

export type WithdrawBookingRequestInput = z.infer<
  typeof withdrawBookingRequestInputSchema
>;
export type WithdrawBookingRequestOutput = z.infer<
  typeof withdrawBookingRequestOutputSchema
>;
export type WithdrawBookingRequestWireOutput = z.infer<
  typeof withdrawBookingRequestWireOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type WithdrawBookingRequestDeps = {
  /**
   * The full bag: withdrawing an ACCEPTED request may cancel its still-DRAFT
   * event, through cancelEvent's body (review round 1, nit).
   */
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * cancelEvent's ports, for an ACCEPTED request's still-DRAFT event (no
   * orders, so nothing is refunded). Required only when there is one — a
   * missing wiring refuses NOT_CONFIGURED rather than strand the draft.
   */
  eventCancellation?: ExitEventCancellationDeps;
  /**
   * Lineup v3 (L7 / FR-012b): every act that JOINED the bill hears the
   * request isn't going ahead. Post-commit, swallowed + reported.
   */
  notifyBookingLineupRequestClosed?: NotifyBookingLineupRequestClosedFn;
  /** Swallow reporter for that notice (ReporterPort convention). */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The SENDER pulls back an open (PENDING | VIEWED) request (spec FR-003) —
 * or, on a request to a VENUE, an ACCEPTED one whose night is not booked yet
 * (booking-the-night N14 / FR-010): its holds are released (REQUEST_CLOSED)
 * and its draft terms CANCELLED in the same transaction. Once the night is
 * booked the refusal is BOOKING_NIGHT_BOOKED (the undo is Cancel booking);
 * a cancelled booking is BOOKING_CANCELLED; finalized terms are
 * AGREEMENT_FINALIZED. All three are decided under the request's booking
 * lock, so a concurrent agree / book-without-terms either commits first (and
 * this is refused) or waits and then finds the request WITHDRAWN.
 * Sender control follows the direction (organizer-booking-requests FR-004):
 * - TO_VENUE — the performer sender: self for a human, org EDIT roles for an
 *   org act;
 * - TO_PERFORMER — the ORGANIZER org's EDIT roles (the act is the TARGET
 *   here and can never withdraw — it declines instead).
 * Idempotent: withdrawing an already-WITHDRAWN request is a success no-op;
 * other terminal states throw `invalid_status`.
 */
export async function withdrawBookingRequest(
  deps: WithdrawBookingRequestDeps,
  rawInput: unknown,
): Promise<WithdrawBookingRequestOutput> {
  const input = parseInput(withdrawBookingRequestInputSchema, rawInput);

  const request = await deps.repos.bookingRequests.getById(
    input.bookingRequestId,
  );
  if (!request) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }

  if (request.direction === "TO_PERFORMER") {
    // Sender = the organizer org. The performer owner pair identifies the
    // TARGET in this direction — deliberately not consulted here.
    await requireOrgMembership({
      repos: deps.repos,
      orgId: request.organizerOrgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
  } else {
    // Sender control. Anonymous inquiries have no on-platform sender — no
    // signed-in actor can ever be their owner, so withdrawing one is always
    // NOT_RESOURCE_OWNER (the anonymous exit paths are venue decline, expiry,
    // or claim-then-withdraw as the claimed owner).
    //
    // THE `isUnclaimedBookingInquiry` GUARD IS THE ONE THAT ENFORCES THAT,
    // not the sender narrowing below (booking-inquirer-outreach, 2026-09-05):
    // venue outreach now attaches a SHADOW owner pair to an unclaimed inquiry
    // on the venue's first reply, so `getBookingRequestSender` reports it as
    // `owned` and `requireOwnerAccess` reduces to
    // `actorHumanId === shadowHumanId`. That shadow IS reachable — signing up
    // with the address upgrades it (`apps/api/src/auth/shadow-upgrade.ts`)
    // and `requireEmailVerification` is false, so a sign-up proves nothing
    // about mailbox control. Redeeming the invite-to-claim token is what
    // proves it; that stamps `claimedAt`, and this guard opens. Identical
    // guard and rationale in `messages/_shared/thread-access.ts` — keep the
    // two consistent.
    if (isUnclaimedBookingInquiry(request)) {
      throw fail("NOT_RESOURCE_OWNER");
    }
    const sender = getBookingRequestSender(request);
    if (sender.kind !== "owned") {
      throw fail("NOT_RESOURCE_OWNER");
    }
    await requireOwnerAccess({
      repos: deps.repos,
      ownerType:
        sender.performerOwnerType === "human" ? "HUMAN" : "ORGANIZATION",
      ownerId: sender.performerOwnerId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
  }

  // Idempotent no-op.
  if (request.status === "WITHDRAWN") {
    return withdrawBookingRequestOutputSchema.parse({
      bookingRequestId: request.id,
      status: request.status,
      holdNotificationIntents: [],
    });
  }

  if (!isWithdrawable(request)) {
    throw fail("INVALID_STATUS");
  }

  const now = deps.clock.now();

  // An ACCEPTED request's still-DRAFT event ends with it (review round 1):
  // the withdraw then runs INSIDE that event's cancellation transaction.
  const preTerms =
    request.status === "ACCEPTED" && request.agreementId
      ? await deps.repos.agreements.getById(request.agreementId)
      : null;
  const draftEventId = await exitDraftEventIdOf(deps.repos, preTerms, request);

  const body = async (tx: TxRepos) => {
    // The request's booking lock first (before any line lock): every take,
    // Cancel booking and Close request serialize on it, so the reads below
    // decide on committed state (booking-the-night FR-010).
    await tx.bookingHolds.lockRequestBooking(request.id);
    const fresh = await tx.bookingRequests.getById(request.id);
    if (!fresh) {
      throw fail("BOOKING_REQUEST_NOT_FOUND");
    }
    if (fresh.status === "WITHDRAWN") {
      return {
        request: fresh,
        holdIntents: [],
        closed: false,
        cancelledAgreementId: null,
      };
    }
    if (!isWithdrawable(fresh)) {
      throw fail("INVALID_STATUS");
    }
    // N14: an ACCEPTED request may be withdrawn only while no night is
    // booked (and its booking was never cancelled, its terms never
    // finalized). Read under the booking lock.
    // An open request whose hold a venue confirm already made CONFIRMED is
    // refused the same way (the venue's decline refuses it too): the undo is
    // Cancel booking (review round 2, W5).
    let terms: Awaited<ReturnType<typeof assertAcceptedRequestCanExitInTx>> =
      null;
    if (fresh.status === "ACCEPTED") {
      terms = await assertAcceptedRequestCanExitInTx(tx, fresh);
    } else {
      await assertNoBookedNightInTx(tx, fresh.id);
    }
    // The draft the pre-flight chose (already CANCELLED in this tx on the
    // event path) must be the only one: a draft minted since → retry.
    await assertNoNewExitDraftInTx(tx, terms, fresh);

    // Write-time CAS: a concurrent accept/decline/expire that committed
    // after our re-read makes this a conflict instead of clobbering the
    // committed state. ACCEPTED is expected only when the re-read saw it
    // (an open request accepted under us is not withdrawn blind).
    const updated = await tx.bookingRequests.updateStatus({
      id: fresh.id,
      status: "WITHDRAWN",
      expectedFrom: fresh.status === "ACCEPTED" ? ["ACCEPTED"] : ["PENDING", "VIEWED"],
    });

    // Ledger entry, same tx as the CAS. The idempotent already-WITHDRAWN
    // paths (pre-tx short-circuit and the in-tx re-read above) both return
    // before this line, so a repeat withdraw never doubles the entry.
    await appendBookingSystemEntry(tx, {
      bookingRequestId: updated.id,
      kind: "booking_request.withdrawn",
      data: {},
      actorHumanId: input.actorHumanId,
    });

    // FR-009 (booking-holds): a withdrawn request leaves every line it was
    // in. TO_PERFORMER rows own no holds, so this is a no-op read there.
    // The sender is the ACT: it is stamped on its own thread only — the
    // movers' `booking_hold.reordered` entries carry no author (FR-013).
    const holds = await releaseHoldsForClosedRequest(tx, {
      bookingRequestId: updated.id,
      now,
      actor: {
        humanId: input.actorHumanId,
        kind: "act",
        ownRequestId: updated.id,
      },
    });
    // Defence (review W1): nothing booked the night between the first read
    // and the line locks the release just took.
    await assertNoBookedNightAfterReleaseInTx(tx, updated.id);

    // N14: the request's draft terms end with it.
    const cancelledAgreementId = await cancelExitTermsInTx(tx, {
      agreement: terms,
      bookingRequestId: updated.id,
      actorHumanId: input.actorHumanId,
      via: "withdraw",
      reason: null,
      now,
    });

    await tx.audit.log({
      entity: "booking_request",
      entityId: updated.id,
      action: "booking_request.withdrawn",
      data: {
        actorHumanId: input.actorHumanId,
        direction: fresh.direction,
        organizerOrgId: fresh.organizerOrgId,
        performerOwnerType: fresh.performerOwnerType,
        performerOwnerId: fresh.performerOwnerId,
        releasedHoldIds: holds.released.map((hold) => hold.id),
        fromStatus: fresh.status,
        cancelledAgreementId,
        cancelledDraftEventId: draftEventId,
      },
      at: now,
    });

    return {
      request: updated,
      holdIntents: holds.intents,
      closed: true,
      cancelledAgreementId,
    };
  };

  const withdrawn = draftEventId
    ? await runExitWithDraftCancel(deps, deps.eventCancellation, {
        bookingRequestId: request.id,
        draftEventId,
        actorHumanId: input.actorHumanId,
        body,
      })
    : await deps.repos.tx(body);

  // Joined acts hear it isn't going ahead (v3 L7) — only from the call that
  // actually withdrew it, never from an idempotent repeat.
  if (withdrawn.closed) {
    await fireBookingLineupRequestClosed(
      deps,
      {
        bookingRequest: withdrawn.request,
        closedBy: "withdrawn",
        actorHumanId: input.actorHumanId,
      },
      "withdrawBookingRequest",
    );
  }

  deps.logger?.info("booking_requests.withdrawn", {
    bookingRequestId: withdrawn.request.id,
    actorHumanId: input.actorHumanId,
    cancelledAgreementId: withdrawn.cancelledAgreementId,
  });

  return withdrawBookingRequestOutputSchema.parse({
    bookingRequestId: withdrawn.request.id,
    status: withdrawn.request.status,
    holdNotificationIntents: withdrawn.holdIntents,
  });
}

/**
 * Withdrawable: still open (PENDING | VIEWED), or — on a request to a venue —
 * ACCEPTED (N14; the night-not-booked rule is checked under the lock). An
 * organiser's ACCEPTED request to an act keeps no exit here (out of scope:
 * booking-the-night is TO_VENUE).
 */
function isWithdrawable(
  request: Pick<BookingRequestRecord, "status" | "direction">,
): boolean {
  return (
    request.status === "PENDING" ||
    request.status === "VIEWED" ||
    (request.status === "ACCEPTED" && request.direction === "TO_VENUE")
  );
}
