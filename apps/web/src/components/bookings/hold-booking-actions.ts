import type { BookingHoldSummary } from "./booking-holds";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE VENUE MAY DO WITH ONE HOLD (booking-the-night FR-003 / FR-004 /
// FR-005, board W1 "two actions").
//
// The hold "Confirm" left the request flow: `confirmBookingHold` refuses every
// request-linked hold with HOLD_CONFIRM_RETIRED, and today every hold hangs
// off a request. A request's night is now booked one of two ways from the
// venue's line:
//   · "Send terms"         `bookingAgreements.sendTerms` (send-booking-terms.ts)
//   · "Book without terms" `bookingHolds.bookNightWithoutTerms`
//                          (book-night-without-terms.ts)
//
// This decides which of the two a row offers and mirrors the server's
// refusals, so neither button is offered only to be refused, and every
// withheld one says why. It derives NOTHING the server can say itself: the
// list row carries the server's answers (list-booking-requests.ts, P5-fixes):
//   · hold.askedFor        `isAskedForNight` (preferred dates AND, for RENT /
//                          USE, the requested window) — DATE_NOT_ASKED_FOR;
//   · row.bookingEvent     the booking paths' own `resolveBookingEvent`, its
//                          night in the PLACE's zone and its calendar —
//                          HOLD_DATE_MISMATCHES_EVENT / EVENT_ON_ANOTHER_
//                          CALENDAR / a gone origin or link. Null = the stage
//                          read degraded: fail closed;
//   · row.termsNight       the night of terms the sender has seen or agreed —
//                          TERMS_SENT_FOR_ANOTHER_NIGHT / _AGREED_FOR_…;
//   · row.hasBookedNight   the request already booked its one night (a
//                          CONFIRMED hold, which `holds` never carries) —
//                          BOOKING_ALREADY_HAS_NIGHT. Null = could not tell.
// ─────────────────────────────────────────────────────────────────────────────

/** Why a row offers fewer than both actions — each maps to one sentence. */
export type HoldBookingReason =
  /** The row could not tell what the request's event is (degraded read). */
  | "unknown"
  /** The request already booked its night (BOOKING_ALREADY_HAS_NIGHT). */
  | "booked"
  /** Another hold is ahead on the line: N6, NIGHT_TAKEN for both actions. */
  | "behind"
  /** Not a night the request asked for: DATE_NOT_ASKED_FOR (book only). */
  | "not_asked"
  /** Open request, no draft terms yet: sendTerms needs the accept's agreement. */
  | "accept_first"
  /** ACCEPTED with no agreement: nothing to send or book from. */
  | "no_terms"
  /** Terms are with the sender: sendTerms needs DRAFT. */
  | "terms_out"
  /** Terms the sender has seen are for another night: booking refused. */
  | "terms_other_night"
  /** Terms are agreed: sendTerms refused (and booking off their night). */
  | "terms_agreed"
  /**
   * Agreed terms with no terms night on the row (finalized, no proposed date,
   * or the night couldn't be resolved): booking is not offered here. A row
   * limit, not a server refusal; the copy must not claim finalization.
   */
  | "terms_finalized"
  /** The sender countered: sendTerms needs DRAFT; booking still works. */
  | "terms_countered"
  /** Any other agreement status (declined, cancelled...): nothing here the server takes. */
  | "terms_in_progress"
  /** The request's event (origin or finalized link) is cancelled / archived. */
  | "event_gone"
  /** The request's event sits on another night (N11). */
  | "event_other_night"
  /** The request's event sits on another calendar (the line is calendar + day). */
  | "event_other_calendar";

export type HoldBookingActions = {
  sendTerms: boolean;
  bookWithoutTerms: boolean;
  reasons: HoldBookingReason[];
};

/** The server's `bookingEvent` (list-booking-requests.ts). */
export type BookingEventState =
  | { state: "none" }
  | { state: "live"; night: string; calendarId: string | null }
  | { state: "gone" };

const OPEN_REQUEST = new Set(["PENDING", "VIEWED"]);

export type HoldBookingActionsInput = {
  hold: Pick<BookingHoldSummary, "date" | "position" | "status" | "lapsed" | "calendarId"> & {
    /** Server-derived; absent reads as unknown (booking withheld). */
    askedFor?: boolean;
  };
  /** The server's `hasBookedNight`; null / absent = could not tell. */
  hasBookedNight?: boolean | null;
  requestStatus: string;
  agreementId: string | null;
  agreementStatus: string | null;
  bookingEvent: BookingEventState | null;
  termsNight: string | null;
  /** An unclaimed embed inquiry (HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST). */
  unclaimed: boolean;
};

const result = (
  sendTerms: boolean,
  bookWithoutTerms: boolean,
  reasons: HoldBookingReason[] = [],
): HoldBookingActions => ({ sendTerms, bookWithoutTerms, reasons });

export function holdBookingActions(input: HoldBookingActionsInput): HoldBookingActions {
  const { hold } = input;
  const live = (hold.status === "ACTIVE" || hold.status === "CHALLENGED") && !hold.lapsed;
  const open = OPEN_REQUEST.has(input.requestStatus);
  // Nothing to book, and nothing to explain on the row: the hold is gone, the
  // request is closed, or the sender is unclaimed — the strip's own note
  // says why for that one.
  if (!live || (!open && input.requestStatus !== "ACCEPTED") || input.unclaimed) {
    return result(false, false);
  }

  // One night per request (BOOKING_ALREADY_HAS_NIGHT, both use cases).
  if (input.hasBookedNight === true) return result(false, false, ["booked"]);
  // Fail closed when the row could not tell what the event is, or whether a
  // night is already booked.
  const event = input.bookingEvent;
  if (event === null || input.hasBookedNight == null) return result(false, false, ["unknown"]);

  // N6: another hold is ahead on this night. Both use cases refuse
  // NIGHT_TAKEN; the challenged hold at 1st may itself be booked.
  if (hold.position > 1) return result(false, false, ["behind"]);

  // N11 / the line: the booking's event must be live, on this night, on
  // this calendar. Both use cases run the same check.
  if (event.state === "gone") return result(false, false, ["event_gone"]);
  if (event.state === "live") {
    if (event.night !== hold.date) return result(false, false, ["event_other_night"]);
    if (event.calendarId && hold.calendarId && event.calendarId !== hold.calendarId) {
      return result(false, false, ["event_other_calendar"]);
    }
  }

  const askedFor = hold.askedFor === true;
  // Booking on a night the request did not ask for: DATE_NOT_ASKED_FOR. An
  // unknown `askedFor` withholds silently rather than claim either answer.
  const notAsked: HoldBookingReason[] = hold.askedFor === false ? ["not_asked"] : [];

  if (input.agreementId === null) {
    // ACCEPTED with no agreement: both refuse (no counterparty to mint for).
    if (!open) return result(false, false, ["no_terms"]);
    // Open: the accept drafts the terms, so only booking (which accepts) is here.
    return result(false, askedFor, ["accept_first", ...notAsked]);
  }

  switch (input.agreementStatus) {
    case "DRAFT":
      return result(true, askedFor, notAsked);
    case "COUNTERED":
      // Not terms the sender has "seen" in the server's sense: booking may
      // move the header onto the night (HEADER_REWRITABLE_STATUSES). Only
      // the send needs DRAFT.
      return result(false, askedFor, ["terms_countered", ...notAsked]);
    case "PROPOSED":
    case "ACCEPTED": {
      // The header update + send both need DRAFT. Booking keeps terms the
      // sender has seen or agreed, so it works only on THEIR night.
      const why: HoldBookingReason = input.agreementStatus === "PROPOSED" ? "terms_out" : "terms_agreed";
      if (input.termsNight === null) {
        return result(false, false, input.agreementStatus === "ACCEPTED" ? [why, "terms_finalized"] : [why]);
      }
      if (input.termsNight !== hold.date) return result(false, false, [why, "terms_other_night"]);
      return result(false, askedFor, [why, ...notAsked]);
    }
    default:
      return result(false, false, ["terms_in_progress"]);
  }
}
