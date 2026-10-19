import type { TxRepos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { BookingThreadSide } from "@th/types/repos/booking-request-messages";

import { partyOnSide, type AgreementSide } from "./agreement-access";

// ─────────────────────────────────────────────────────────────────────────────
// Agreement → booking-request LEDGER PLUMBING (step 2 of the booking timeline).
//
// The agreement use cases operate on an Agreement; the ledger lives on the
// BOOKING REQUEST. Two things have to be resolved before any agreement
// transition can append an entry, and both are non-obvious enough to live in
// one documented place rather than being re-derived at six call sites.
//
// 1. THE RELATION DIRECTION. `BookingRequest.agreementId` is the FK (unique,
//    nullable); `Agreement.bookingRequest` is only the Prisma back-relation —
//    there is NO `Agreement.bookingRequestId` column. So the lookup goes
//    `bookingRequests.findByAgreementId(agreement.id)`: ONE unique-index probe.
//
//    An Agreement can legitimately exist with NO booking request — legacy
//    rows from the since-deleted `upsertAgreementForEvent` path were never
//    asked for through the inbox. Every emit here is therefore a NO-OP
//    on a miss, never a throw: an agreement that has no thread has no ledger
//    to lie about.
//
// 2. THE SIDE. `AgreementSide` is proposer/counterparty; the thread's axis is
//    VENUE/PERFORMER, and the two do NOT line up the same way in both
//    directions (see `bookingThreadSideForAgreementSide`).
// ─────────────────────────────────────────────────────────────────────────────

/** The agreement fields the ledger plumbing needs — never the whole record. */
export type LedgerAgreementRef = Pick<
  AgreementRecord,
  "id" | "proposerType" | "proposerId" | "counterpartyType" | "counterpartyId"
>;

/**
 * The booking request whose thread is this agreement's ledger, or null when the
 * agreement was not born of a request.
 *
 * Cost: one unique-index lookup on `BookingRequest.agreementId`.
 */
export async function findLedgerRequestForAgreement(
  tx: TxRepos,
  agreementId: string,
): Promise<BookingRequestRecord | null> {
  return tx.bookingRequests.findByAgreementId(agreementId);
}

/**
 * Map an agreement SIDE (proposer / counterparty) onto the booking thread's
 * VENUE / PERFORMER axis.
 *
 * The mapping is NOT a constant, because the two mint sites lay the parties out
 * as mirrors of each other (`_shared/accept-agreement.ts`):
 *   - TO_VENUE     — proposer = the performer sender, counterparty = the venue;
 *   - TO_PERFORMER — proposer = the ORGANIZER org,    counterparty = the act.
 *
 * So this identifies the ACT by value (the request's `performerOwner*` pair is
 * the single source of truth for "who the act is", in both directions —
 * `_shared/thread-access.ts` header) and calls everything else VENUE, which is
 * exactly what the thread's `VENUE` slot means: "the non-act party".
 *
 * Falls back to the direction rule when the request carries no owner pair — an
 * unclaimed anonymous inquiry. Structurally unreachable today (an anonymous row
 * has no agreement until `claim-booking-request` backfills the pair in the same
 * tx that mints one), kept because a ledger write must never crash a
 * transition over a shape it can reason about.
 */
export function bookingThreadSideForAgreementSide(
  request: BookingRequestRecord,
  agreement: LedgerAgreementRef,
  side: AgreementSide,
): BookingThreadSide {
  const party = partyOnSide(agreement, side);
  const ownerType = request.performerOwnerType;
  const ownerId = request.performerOwnerId;

  if (ownerType !== null && ownerId !== null) {
    return party.type === ownerType && party.id === ownerId
      ? "PERFORMER"
      : "VENUE";
  }

  // Direction fallback (see the doc above).
  if (request.direction === "TO_PERFORMER") {
    return side === "proposer" ? "VENUE" : "PERFORMER";
  }
  return side === "proposer" ? "PERFORMER" : "VENUE";
}
