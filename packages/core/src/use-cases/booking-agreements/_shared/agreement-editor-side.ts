import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { fail } from "@th/errors";

import type { AgreementSide } from "./agreement-access";
import {
  bookingThreadSideForAgreementSide,
  type LedgerAgreementRef,
} from "./booking-ledger";

// ─────────────────────────────────────────────────────────────────────────────
// WHO MAY EDIT THE TERMS — owner decision 2026-08-25:
//
//   "Terms should only be editable by the venue/organizer side of the request."
//
// The agreement itself only knows proposer / counterparty, and the two mint
// sites lay those out as mirrors of each other (TO_VENUE: proposer = the act;
// TO_PERFORMER: proposer = the organizer org). So "which party is the act" is
// answered by the ORIGINATING BOOKING REQUEST — its `performerOwner*` pair is
// the single source of truth for the act in both directions, and the thread's
// VENUE slot is "the non-act party" (`_shared/thread-access.ts` header).
//
//   - editor — the non-act party (the venue for TO_VENUE, the organizer org
//              for TO_PERFORMER). May edit header + payout lines, send for
//              review, pull back, reopen, and CANCEL.
//   - act    — the performer side. May only ACCEPT or DECLINE a PROPOSED
//              agreement; never touches the terms.
//
// TERMINAL EXITS are split by side, never shared: the act's is DECLINE
// (`respond`, PROPOSED only); the editor's is `cancelBookingAgreement`
// (DRAFT | PROPOSED | ACCEPTED-unfinalized → CANCELLED, reason on the ledger).
// `respond` was deliberately NOT widened back to both sides for this.
//   - null   — the agreement has no originating request (legacy rows; the
//              since-deleted `upsertAgreementForEvent` path minted those). Neither party is
//              "the act", so the pre-decision rule stands: either party edits.
//
// Resolution reuses `bookingThreadSideForAgreementSide` rather than
// re-deriving the act-by-value match, so the ledger's "who did this" and the
// authz "who may do this" can never disagree.
//
// KNOWN LIMITATION — one human on both sides. `requireAgreementParty` checks
// the proposer slot first, so a human who IS the act AND holds an edit role on
// the venue/organizer org resolves as the act on a TO_VENUE agreement and is
// locked out of editing its terms. The mirror holds on TO_PERFORMER: a human
// who is the act (counterparty) AND holds an edit role on the proposer
// organizer org resolves as the EDITOR there, and may edit or cancel. Neither
// is exploitable (each only affects someone who already controls both
// parties — one loses an affordance, the other gains nothing it did not
// already have), and neither is fixed here. Two options if it ever matters: refuse the self-booking at request
// creation (`CANNOT_BOOK_OWN_ACT` already covers part of this), or let the
// resolver fall back to the counterparty side when the actor controls both.
// ─────────────────────────────────────────────────────────────────────────────

export type AgreementTermsSide = "editor" | "act";

export type AgreementTermsSideRepos = Pick<Repos, "bookingRequests">;

/**
 * Which terms-side the actor's (already authorized) agreement side maps to,
 * or null when the agreement is not linked to a booking request.
 *
 * Cost: one unique-index lookup on `BookingRequest.agreementId`.
 */
export async function resolveAgreementTermsSide(
  repos: AgreementTermsSideRepos,
  agreement: LedgerAgreementRef,
  side: AgreementSide,
): Promise<AgreementTermsSide | null> {
  const request = await repos.bookingRequests.findByAgreementId(agreement.id);
  return termsSideForRequest(request, agreement, side);
}

/** Pure half of {@link resolveAgreementTermsSide} for callers holding the request. */
export function termsSideForRequest(
  request: BookingRequestRecord | null,
  agreement: LedgerAgreementRef,
  side: AgreementSide,
): AgreementTermsSide | null {
  // INVARIANT: a linked agreement stays linked. No production path deletes a
  // BookingRequest or clears `agreementId` (withdraw only flips status, and
  // only from PENDING/VIEWED — never off an ACCEPTED row that owns an
  // agreement). Adding one would silently reopen the terms to the act.
  if (!request) return null;
  return bookingThreadSideForAgreementSide(request, agreement, side) ===
    "PERFORMER"
    ? "act"
    : "editor";
}

/**
 * Gate for every terms mutation (header, lines, send-for-review, pull-back,
 * reopen, cancel): the act side is refused with a stable, user-facing code.
 *
 * @throws `TERMS_EDITOR_ONLY` when the actor controls the act side.
 */
export async function requireAgreementTermsEditor(
  repos: AgreementTermsSideRepos,
  agreement: LedgerAgreementRef,
  side: AgreementSide,
): Promise<AgreementTermsSide | null> {
  const termsSide = await resolveAgreementTermsSide(repos, agreement, side);
  if (termsSide === "act") {
    throw fail("TERMS_EDITOR_ONLY");
  }
  return termsSide;
}

/**
 * The inverse gate, for `respond`: on a LINKED agreement only the act may
 * accept or decline — otherwise the editor could send for review and
 * self-accept with zero act involvement, which is the rule defeated. Unlinked
 * agreements (no act) keep either-party.
 *
 * @throws `ACT_RESPONSE_ONLY` when the actor controls the editor side of a
 *   linked agreement.
 */
export async function requireAgreementActSide(
  repos: AgreementTermsSideRepos,
  agreement: LedgerAgreementRef,
  side: AgreementSide,
): Promise<AgreementTermsSide | null> {
  const termsSide = await resolveAgreementTermsSide(repos, agreement, side);
  if (termsSide === "editor") {
    throw fail("ACT_RESPONSE_ONLY");
  }
  return termsSide;
}
