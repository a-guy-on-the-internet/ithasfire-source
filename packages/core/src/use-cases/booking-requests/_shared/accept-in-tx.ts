import type { TxRepos } from "@th/ports/repos";
import type {
  BookingRequestRecord,
  ToVenueBookingRequestRecord,
} from "@th/ports/repos/booking-requests";
import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
  OPEN_BOOKING_REQUEST_STATUSES,
} from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";
import { fail } from "@th/errors";

import { defaultEventOwnerSideForIntent } from "../../booking-agreements/_shared/event-owner-side";
import { appendBookingSystemEntry } from "../messages/_shared/system-entries";
import {
  createAcceptAgreement,
  deriveVenueCounterpartyFromPlace,
  type AcceptAgreementPitchContext,
  type BookingAgreementCounterparty,
} from "./accept-agreement";
import type { PlaceBookingAuthorityResult } from "./place-access";
import {
  failBookingCancelled,
  isBookingCancelled,
} from "../../booking-holds/_shared/booking-night";
// ── P3b (asks) ──
import { effectiveSetLengthMinutes } from "../asks/map-ask-answers";

// ─────────────────────────────────────────────────────────────────────────────
// The OWNED TO_VENUE accept, as a transaction participant.
//
// Extracted verbatim from `respond-to-booking-request.ts`'s `respondInternal`
// (booking-holds spec 2026-08-25, step 2) so that `confirm-booking-hold` can
// accept a still-open request INSIDE ITS OWN transaction — "one transaction"
// is the spec's HIGH risk, and the respond use case's Redis idempotency
// envelope sits OUTSIDE its tx, so confirm calls this inner body directly and
// never the transport-level wrapper. `respondInternal` still calls this for
// its own accept, so the two paths cannot drift.
//
// Behaviour is byte-identical to the closure it replaced: in-tx re-read +
// status guard, owned-sender re-narrow, Agreement DRAFT minted from the FRESH
// row, CAS to ACCEPTED, ONE `booking_request.accepted` ledger entry, audit.
// ─────────────────────────────────────────────────────────────────────────────

export type AcceptBookingRequestInTxArgs = {
  /** Loaded + venue-authorized by the caller; only `.id` is trusted here. */
  request: Pick<ToVenueBookingRequestRecord, "id">;
  place: PlaceRecord;
  counterparty: BookingAgreementCounterparty;
  /** Venue zone + routed calendar default — resolved OUTSIDE the tx. */
  pitchContext: AcceptAgreementPitchContext;
  actorHumanId: string;
  now: Date;
};

export type AcceptBookingRequestInTxResult = {
  request: BookingRequestRecord;
  agreementId: string;
};

export async function acceptBookingRequestInTx(
  tx: TxRepos,
  args: AcceptBookingRequestInTxArgs,
): Promise<AcceptBookingRequestInTxResult> {
  const { request, place, counterparty, pitchContext, actorHumanId, now } =
    args;

  // The request's booking lock first, like every other request-state writer
  // (decline, withdraw, close, the takes, Cancel booking): the holds read
  // below decides on committed state. Re-entrant for book-without-terms,
  // which already holds it (a transaction advisory lock).
  await tx.bookingHolds.lockRequestBooking(request.id);
  const fresh = await requireRespondableInTx(tx, request.id, now);
  // A request whose booking was CANCELLED (booking-the-night N13 / FR-009)
  // is closed for booking: it stays open as history but is never accepted
  // into new terms (review round 3, W4). The decline and withdraw remain.
  if (isBookingCancelled(await tx.bookingHolds.listForRequest(fresh.id))) {
    failBookingCancelled();
  }

  // Re-narrow inside the tx for the friendly error; the authoritative race
  // guard stays the updateStatus CAS below (a sender can't actually flip
  // while the row is OPEN — claiming requires ACCEPTED).
  //
  // `isUnclaimedBookingInquiry` guards the OTHER direction: since
  // booking-inquirer-outreach an unclaimed inquiry the venue replied to reads
  // as OWNED (a shadow pair) but has no real counterparty to mint an Agreement
  // against. Those rows belong on the invite-to-claim fork, and this is the
  // last gate before `createAcceptAgreement`.
  const freshSender = getBookingRequestSender(fresh);
  if (freshSender.kind !== "owned" || isUnclaimedBookingInquiry(fresh)) {
    throw fail("INVALID_STATUS", {
      message: "sender_changed",
      meta: { bookingRequestId: fresh.id },
    });
  }

  const agreement = await createAcceptAgreement(tx, {
    place,
    proposerType: freshSender.performerOwnerType,
    proposerId: freshSender.performerOwnerId,
    counterparty,
    // Seed the header from the FRESH row read inside the tx — the pitch is
    // what the venue just read in the inbox, and `fresh` is the version the
    // accept is actually committing against.
    // ── P3b (asks) ── a SET_LENGTH ask answered before the accept fills the
    // set length the pitch left empty (venue-booking-standards V10), so the
    // draft terms' end is start + minutes.
    pitch: await withAnsweredSetLength(tx, fresh),
    pitchContext,
    // Owner-side terms (venue-confirmation spec): RENT / USE seed
    // requester-only terms; PERFORM clones the venue default as before.
    eventOwnerSide: defaultEventOwnerSideForIntent(fresh.intent),
  });

  const updated = await tx.bookingRequests.updateStatus({
    id: fresh.id,
    status: "ACCEPTED",
    expectedFrom: OPEN_BOOKING_REQUEST_STATUSES,
    respondedAt: now,
    agreementId: agreement.agreementId,
  });

  // Ledger, same tx as the accept. ONE entry, not two: `agreementId` on
  // `booking_request.accepted` already links the draft the accept minted
  // (the renderer turns it into the agreement link), so a companion
  // `booking_agreement.drafted` would say nothing new — and it CANNOT be
  // ordered against its own cause. `createdAt` defaults to
  // CURRENT_TIMESTAMP, which in PostgreSQL is the TRANSACTION timestamp and
  // therefore identical for every row written here; the thread reads
  // `[createdAt asc, id asc]` and `id` is a random uuid v4, so the tie-break
  // is a coin flip. Two entries in one tx = a thread that shows "Draft
  // agreement created" ABOVE "Request accepted" about half the time, both
  // stamped the same minute.
  //
  // `claim-booking-request` is the path that genuinely needs
  // `booking_agreement.drafted`: there the draft arrives LATER, in its own
  // transaction, long after the accept — and it writes exactly one entry.
  await appendBookingSystemEntry(tx, {
    bookingRequestId: updated.id,
    kind: "booking_request.accepted",
    data: { agreementId: agreement.agreementId },
    actorHumanId,
  });

  await tx.audit.log({
    entity: "booking_request",
    entityId: updated.id,
    action: "booking_request.accepted",
    data: {
      actorHumanId,
      placeId: place.id,
      agreementId: agreement.agreementId,
      payoutTermsId: agreement.payoutTermsId,
      counterpartyType: counterparty.type,
      counterpartyId: counterparty.id,
      clonedFromDefaultTerms: agreement.clonedFromDefaultTerms,
      eventOwnerSide: defaultEventOwnerSideForIntent(fresh.intent),
      requesterLineSeeded: agreement.requesterLineSeeded,
    },
    at: now,
  });

  return { request: updated, agreementId: agreement.agreementId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared guards
// ─────────────────────────────────────────────────────────────────────────────

export function assertRespondable(
  request: Pick<BookingRequestRecord, "status" | "expiresAt">,
  now: Date,
): void {
  if (request.status === "PENDING" || request.status === "VIEWED") {
    // A TTL that lapsed but hasn't been swept by the expiry job yet is still
    // expired — don't allow accepts in the window before the next sweep.
    if (request.expiresAt && request.expiresAt.getTime() <= now.getTime()) {
      throw fail("BOOKING_REQUEST_EXPIRED");
    }
    return;
  }

  if (request.status === "EXPIRED") {
    throw fail("BOOKING_REQUEST_EXPIRED");
  }
  throw fail("INVALID_STATUS");
}

/**
 * Re-read + status-guard inside the tx for friendly errors; the *authoritative*
 * race guard is `updateStatus.expectedFrom` at write time (an in-tx re-read
 * takes no lock under READ COMMITTED).
 */
export async function requireRespondableInTx(
  tx: TxRepos,
  bookingRequestId: string,
  now: Date,
): Promise<BookingRequestRecord> {
  const fresh = await tx.bookingRequests.getById(bookingRequestId);
  if (!fresh) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }
  assertRespondable(fresh, now);
  return fresh;
}

/**
 * The Agreement's venue-side counterparty — the party the venue's event will
 * be minted under.
 *
 * REVERSED 2026-09-08 (booking-accept-is-the-mint-point spec, FR-006
 * "Revised 2026-09-08"): a `PlaceBookingGrant` holder accepting / confirming
 * an act on the venue's behalf used to "act in their own name" and fall
 * through to the actor here — so a grantee became the counterparty and the
 * venue's show was minted under the grantee personally. The owner's ruling
 * is that a grantee booking an act FOR the venue is never the venue side;
 * the venue's owner (org, or direct human owner) is. A grantee booking
 * THEMSELVES (RENT / USE, requester-owned) never reaches this derivation's
 * result as an owner, so it is unaffected.
 *
 * Precedence, in order:
 *   1. access via an org membership → that org;
 *   2. access as a DIRECT human owner → the actor. Not the smallest owner id:
 *      on a co-owned place co-owner B must get B, or B's later mint fails
 *      `NOT_RESOURCE_OWNER`. Checked BEFORE the place's org list so a
 *      dual-access actor (direct owner who is also an owning-org member)
 *      keeps today's HUMAN counterparty — `requirePlaceOwnership` resolves
 *      `humanIdsWithAccess` first, and `deriveVenueCounterpartyFromPlace`'s
 *      docblock relies on exactly that;
 *   3. an org owns the place (the actor came in some other way) →
 *      the org, via `deriveVenueCounterpartyFromPlace`'s deterministic pick;
 *   4. (retired, holds-without-a-request FR-002: a grantee no longer passes
 *      the staff gate, so the grantee-at-a-human-owned-place rule is gone);
 *   5. anything else → `NOT_RESOURCE_OWNER`.
 *
 * Rule 3 checks the org list is non-empty before delegating, so
 * `deriveVenueCounterpartyFromPlace`'s own `place_has_no_owner` throw is
 * unreachable from here — an ownerless place is rule 5's typed refusal, the
 * one the confirm / accept transports already map.
 *
 * Accepts either ownership shape (`PlaceOwnershipResult` is a subset).
 */
export function deriveCounterparty(
  ownership: Pick<PlaceBookingAuthorityResult, "via" | "orgId">,
  place: Pick<PlaceRecord, "id" | "orgIdsWithAccess" | "humanIdsWithAccess">,
  actorHumanId: string,
): BookingAgreementCounterparty {
  if (ownership.via === "org" && ownership.orgId) {
    return { type: "organization", id: ownership.orgId };
  }
  if (ownership.via === "human") {
    return { type: "human", id: actorHumanId };
  }
  if (place.orgIdsWithAccess.length > 0) {
    return deriveVenueCounterpartyFromPlace(place);
  }
  throw fail("NOT_RESOURCE_OWNER", {
    meta: {
      entity: "place",
      reason: "no_venue_counterparty",
      placeId: place.id,
      via: ownership.via,
    },
  });
}

// ── P3b (asks) ──
async function withAnsweredSetLength<T extends { id: string; setLengthMinutes: number | null }>(
  tx: TxRepos,
  request: T,
): Promise<T> {
  if (request.setLengthMinutes !== null) return request;
  const minutes = await effectiveSetLengthMinutes(tx, request);
  return minutes === null ? request : { ...request, setLengthMinutes: minutes };
}
