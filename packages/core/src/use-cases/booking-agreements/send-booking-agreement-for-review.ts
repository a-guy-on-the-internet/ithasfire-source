import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  otherSide,
  partyOnSide,
  requireAgreementParty,
} from "./_shared/agreement-access";
import { requireAgreementTermsEditor } from "./_shared/agreement-editor-side";
import {
  bookingThreadSideForAgreementSide,
  findLedgerRequestForAgreement,
} from "./_shared/booking-ledger";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import { notifyAgreementParty, type NotifyFn } from "./_shared/notify-party";
import { resolveBookingTimezone } from "./_shared/pitch-seed";
import { agreementStatusSchema } from "./list-booking-agreements";
import {
  assertBookingEventOnNight,
  assertTermsNightFreeInTx,
  bookingNightOf,
  resolveBookingEvent,
  resolveNightCalendarId,
  type TermsNightCheck,
} from "../booking-holds/_shared/booking-night";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const sendBookingAgreementForReviewInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
  })
  .strict();

export const sendBookingAgreementForReviewOutputSchema = z
  .object({
    agreementId: z.uuid(),
    status: agreementStatusSchema,
    proposedAt: z.date(),
  })
  .strict();

export type SendBookingAgreementForReviewInput = z.infer<
  typeof sendBookingAgreementForReviewInputSchema
>;
export type SendBookingAgreementForReviewOutput = z.infer<
  typeof sendBookingAgreementForReviewOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type BookingAgreementTransitionDeps = {
  /**
   * `bookingRequests` + `bookingRequestMessages` are consumed INSIDE the
   * transition tx to append the booking-timeline ledger entry — the agreement
   * transitions read their owning request through
   * `BookingRequest.agreementId` (see `_shared/booking-ledger.ts`).
   * `bookingHolds` / `places` / `calendars` / `events` answer "is this night
   * free, and is it the booking's event's day?" for request-linked terms
   * (booking-the-night N6, NFR-001).
   */
  repos: Pick<
    Repos,
    | "tx"
    | "agreements"
    | "authz"
    | "audit"
    | "organizations"
    | "bookingRequests"
    | "bookingRequestMessages"
    | "bookingHolds"
    | "places"
    | "calendars"
    | "events"
    // `sendBookingTerms` saves the header through
    // `updateBookingAgreementHeader`, whose frozen-change notice
    // (freeze-the-deal FR-006) names payees.
    | "payees"
    | "humans"
  >;
  clock: ClockPort;
  /** Optional — in-app pings are best-effort and never fail the mutation. */
  notify?: NotifyFn;
  logger?: LoggerPort;
  /** Swallowed notify failures report here (`_shared/notify-party.ts`). */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DRAFT → PROPOSED (spec FR-004 "send for review"), stamping `proposedAt` and
 * the sender (`sentForReviewByHumanId`, booking-the-night FR-002 — the
 * agree-time mint runs as this human, N10).
 *
 * Only the terms editor (the non-act party of the originating request — see
 * `_shared/agreement-editor-side.ts`) may send the draft for review; the act
 * side only ever accepts or declines. Unlinked agreements keep either-party.
 * The proposal freezes editing until accepted, declined, or pulled back. The
 * other party gets a best-effort in-app ping.
 *
 * N6 — request-linked TO_VENUE terms with a date: the terms' night (its
 * place-local night, `bookingNightOf`) must be free for THIS request. Another
 * party's hold ahead of this request's on that line, or another party's
 * CONFIRMED hold on it, refuses with NIGHT_TAKEN (venue side — its meta
 * points at the hold to challenge). Read UNDER THE LINE LOCK in the send's own
 * transaction: placements, reorders and confirms on that line take the same
 * lock, so the line read and the PROPOSED write are one consistent moment —
 * nobody can slip ahead between the check and the send. A request that has
 * already booked a DIFFERENT night is refused BOOKING_ALREADY_HAS_NIGHT (one
 * booked night per request). (Someone can still
 * move ahead AFTER the send, by a reorder; the sender's agree re-checks under
 * the lock for exactly that reason.) Lapses on the line are projected out,
 * not written — a refused send writes nothing. Terms with no date, unlinked
 * terms and TO_PERFORMER terms are not checked: there is no night to hold.
 *
 * Under the lock the terms are re-read: a concurrent book-without-terms may
 * have moved the DRAFT header onto the night it booked, and then the line
 * this send locked is the wrong one — refused with the send's own CAS-loser
 * conflict (`agreement_status_changed`). One interleaving remains and is
 * harmless: that booking commits AFTER this re-read and before the
 * DRAFT → PROPOSED write (the two lock different lines). The terms then go
 * out dated on the night this very request has booked, so agreeing them
 * books nothing new (the agree finds its own CONFIRMED hold).
 */
export async function sendBookingAgreementForReview(
  deps: BookingAgreementTransitionDeps,
  rawInput: unknown,
): Promise<SendBookingAgreementForReviewOutput> {
  const input = parseInput(sendBookingAgreementForReviewInputSchema, rawInput);

  const agreement = await deps.repos.agreements.getById(input.agreementId);
  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND");
  }
  if (agreement.status !== "DRAFT") {
    throw fail("AGREEMENT_NOT_DRAFT");
  }

  const party = await requireAgreementParty(deps.repos, {
    agreement,
    actorHumanId: input.actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  await requireAgreementTermsEditor(deps.repos, agreement, party.side);

  const now = deps.clock.now();
  const nightCheck = await resolveTermsNightCheck(deps.repos, agreement);

  const updated = await deps.repos.tx(async (tx) => {
    if (nightCheck) {
      await assertTermsNightFreeInTx(tx, nightCheck, now);
    }

    // Write-time CAS is the authoritative race guard.
    const next = await tx.agreements.updateStatus({
      id: agreement.id,
      status: "PROPOSED",
      expectedFrom: ["DRAFT"],
      proposedAt: now,
      sentForReviewByHumanId: input.actorHumanId,
    });

    // Ledger entry on the owning booking request, same tx as the CAS. No-op
    // when the agreement was minted outside the inbox (no thread to write to).
    const request = await findLedgerRequestForAgreement(tx, agreement.id);
    if (request) {
      await appendBookingSystemEntry(tx, {
        bookingRequestId: request.id,
        kind: "booking_agreement.sent_for_review",
        data: {
          agreementId: next.id,
          actorSide: bookingThreadSideForAgreementSide(
            request,
            agreement,
            party.side,
          ),
        },
        actorHumanId: input.actorHumanId,
      });
    }

    await tx.audit.log({
      entity: "booking_agreement",
      entityId: next.id,
      action: "booking_agreement.proposed",
      data: {
        actorHumanId: input.actorHumanId,
        actorSide: party.side,
      },
      at: now,
    });

    return next;
  });

  // Post-commit, best-effort (never fails the mutation).
  await notifyAgreementParty(deps, {
    party: partyOnSide(updated, otherSide(party.side)),
    actorHumanId: input.actorHumanId,
    agreementId: updated.id,
    eventKey: "proposed",
    title: "Agreement ready for review",
    body: `"${updated.title}" was sent for your review.`,
  });

  deps.logger?.info("booking_agreements.proposed", {
    agreementId: updated.id,
    actorHumanId: input.actorHumanId,
  });

  return sendBookingAgreementForReviewOutputSchema.parse({
    agreementId: updated.id,
    status: updated.status,
    proposedAt: updated.proposedAt,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// N6 for the send
// ─────────────────────────────────────────────────────────────────────────────


/**
 * The line the terms would book, or null when there is nothing to check (see
 * the use-case doc). Read before the transaction: the request, the place's
 * zone and the night's calendar do not move under a send.
 *
 * Also the EARLY, read-only refusal of terms whose night is not the day the
 * booking's event sits on (review B1b): an event this booking will hand back
 * (finalized link, live draft, live event-first origin) on another day
 * refuses HOLD_DATE_MISMATCHES_EVENT (venue side, with the event and both
 * days) before anything is written. The agree re-checks it under the lock.
 */
async function resolveTermsNightCheck(
  repos: BookingAgreementTransitionDeps["repos"],
  agreement: AgreementRecord,
): Promise<TermsNightCheck | null> {
  if (!agreement.proposedDate) return null;
  const request: BookingRequestRecord | null =
    await repos.bookingRequests.findByAgreementId(agreement.id);
  if (!request || request.direction !== "TO_VENUE") return null;
  const place = await repos.places.getById(request.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  const placeTz = resolveBookingTimezone(place.timezone);
  const night = bookingNightOf(agreement.proposedDate, placeTz);
  const calendarId = await resolveNightCalendarId(repos, {
    request,
    placeId: place.id,
    night,
  });
  if (!calendarId) {
    // A place with no calendar has no line to hold the night on.
    throw fail("CALENDAR_NOT_FOUND", {
      meta: { reason: "place_has_no_calendar", placeId: place.id },
    });
  }
  assertBookingEventOnNight(
    await resolveBookingEvent(repos, { agreement, request }),
    { night, placeTz, side: "venue", agreementId: agreement.id, calendarId },
  );
  return {
    key: { calendarId, date: night },
    bookingRequestId: request.id,
    placeTz,
    agreementId: agreement.id,
    expectedProposedDate: agreement.proposedDate,
  };
}
