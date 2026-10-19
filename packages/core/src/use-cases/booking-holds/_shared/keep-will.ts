import type { Repos, TxRepos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type {
  BookingHoldRecord,
  RequestBookingHoldRecord,
} from "@th/ports/repos/booking-holds";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import { messagesIn } from "../../booking-requests/messages/_shared/thread-access";
import { bookingNightOf, resolveNightCalendarId } from "./booking-night";
import { areTermsAgreedForNight } from "./night-readiness";
import { NO_ACT_CHALLENGE_VIEW, type ActChallengeView } from "./hold-context";

// ─────────────────────────────────────────────────────────────────────────────
// KEEP = COMMIT (booking-the-night N19 / FR-014): what "Keep" on a challenged
// hold will do, decided the same way for the act's panel, the challenge
// notice and the answer itself.
//
//   book_now       the request's terms are PROPOSED (sent, waiting on the
//                  act) for THIS hold's night, on THIS hold's line — Keep is
//                  the same tap as "Agree & book" (FR-001) and books it;
//   ask_for_terms  no terms for the night are with the act — Keep records
//                  the commitment, asks the venue to send terms, and gives
//                  the act a new deadline (at least
//                  KEEP_AWAITING_TERMS_WINDOW_MS after the keep) to agree
//                  them; missing it lapses the hold through the existing
//                  challenge lapse;
//   (blocked)      the terms for this night are already AGREED (review W3):
//                  there is nothing to keep — the venue books the night
//                  (Create event). A new challenge on such a hold is refused
//                  (challengeBookingHold), so only an older challenge can get
//                  here; the keep then refuses (fail closed) instead of
//                  asking for terms that can never be sent. `keepWill` null.
//
// Everything here reads the act's OWN request and terms. Nothing about
// another party in the line is consulted, so the answer is safe on the act's
// side (booking-holds FR-013).
// ─────────────────────────────────────────────────────────────────────────────

export type KeepWill = "book_now" | "ask_for_terms";

/** How long a kept hold waits for terms to be agreed (FR-014 default). */
export const KEEP_AWAITING_TERMS_WINDOW_MS = 48 * 60 * 60 * 1000;

export type KeepPlan =
  | {
      keepWill: "book_now";
      /** The PROPOSED terms Keep agrees (their `proposedDate` is the expected one). */
      agreement: AgreementRecord & { proposedDate: Date };
    }
  | { keepWill: "ask_for_terms"; agreement: AgreementRecord | null }
  | {
      keepWill: null;
      /** Terms for this night are already agreed (review W3). */
      blocked: "terms_agreed";
      agreement: AgreementRecord;
    };

/**
 * What Keep on `hold` will do (see the module doc). Read-only; works on the
 * root repos or a transaction.
 */
export async function resolveKeepPlan(
  repos: Pick<Repos, "agreements" | "bookingHolds" | "calendars">,
  args: {
    hold: Pick<BookingHoldRecord, "calendarId" | "date">;
    request: Pick<BookingRequestRecord, "id" | "calendarId" | "agreementId">;
    placeId: string;
    placeTz: string;
  },
): Promise<KeepPlan> {
  const agreement = args.request.agreementId
    ? await repos.agreements.getById(args.request.agreementId)
    : null;
  if (
    agreement &&
    areTermsAgreedForNight(
      { status: agreement.status, proposedDate: agreement.proposedDate },
      args.hold.date,
      args.placeTz,
    )
  ) {
    return { keepWill: null, blocked: "terms_agreed", agreement };
  }
  if (
    !agreement ||
    agreement.status !== "PROPOSED" ||
    !agreement.proposedDate ||
    bookingNightOf(agreement.proposedDate, args.placeTz) !== args.hold.date
  ) {
    return { keepWill: "ask_for_terms", agreement };
  }
  // The agree books the line `resolveNightCalendarId` picks; Keep books now
  // only when that is THIS hold's line. Otherwise agreeing would book another
  // calendar's line and leave this challenge unanswered.
  const calendarId = await resolveNightCalendarId(repos, {
    request: args.request,
    placeId: args.placeId,
    night: args.hold.date,
  });
  if (calendarId !== args.hold.calendarId) {
    return { keepWill: "ask_for_terms", agreement };
  }
  return {
    keepWill: "book_now",
    agreement: { ...agreement, proposedDate: agreement.proposedDate },
  };
}

/**
 * The `booking_hold.kept` entry's match keys for THIS challenge of `hold`:
 * the hold, and the challenge's start (`challengedAt`, unchanged by an
 * extension), so a keep recorded in an earlier challenge round never counts
 * for a later one. Derived from the ledger, never a stored flag.
 */
export function keptEntryMatch(
  hold: Pick<BookingHoldRecord, "id" | "challengedAt">,
): { holdId: string; challengedAt?: string } {
  return {
    holdId: hold.id,
    ...(hold.challengedAt
      ? { challengedAt: hold.challengedAt.toISOString() }
      : {}),
  };
}

/**
 * Has the act already kept THIS challenge, waiting for terms? Only a
 * CHALLENGED hold can be "kept, awaiting terms" (a keep that booked the night
 * left it CONFIRMED). Inside a transaction, call it under the line lock so
 * two keeps cannot both read `false`.
 */
export async function isKeptAwaitingTerms(
  repos: Pick<TxRepos, "bookingRequestMessages">,
  hold: Pick<
    RequestBookingHoldRecord,
    "id" | "bookingRequestId" | "status" | "challengedAt"
  >,
): Promise<boolean> {
  if (hold.status !== "CHALLENGED") return false;
  // Fail closed (review nit): with no challenge start there is no way to tell
  // THIS challenge's keep from an earlier one — treat it as not kept.
  if (!hold.challengedAt) return false;
  // `messagesIn` only reads the one repo (and refuses a bag without it).
  return messagesIn(repos as TxRepos).hasSystemEntry({
    bookingRequestId: hold.bookingRequestId,
    kind: "booking_hold.kept",
    dataMatch: keptEntryMatch(hold),
  });
}

/**
 * The act-side challenge facts for one of the act's OWN holds (the act
 * projection's `keepWill` / `kept`): nothing for a hold that is not
 * CHALLENGED; otherwise what Keep will do and whether this challenge was
 * already kept. Reads only the act's own request, terms and thread.
 */
export async function resolveActChallengeView(
  repos: Pick<
    Repos,
    "agreements" | "bookingHolds" | "calendars" | "bookingRequestMessages"
  >,
  args: {
    /** An act's OWN hold: always a request hold (H20: no act side otherwise). */
    hold: RequestBookingHoldRecord;
    request: Pick<BookingRequestRecord, "id" | "calendarId" | "agreementId">;
    placeId: string;
    placeTz: string;
  },
): Promise<ActChallengeView> {
  if (args.hold.status !== "CHALLENGED") return NO_ACT_CHALLENGE_VIEW;
  const plan = await resolveKeepPlan(repos, args);
  return {
    keepWill: plan.keepWill,
    kept: await isKeptAwaitingTerms(repos, args.hold),
  };
}
