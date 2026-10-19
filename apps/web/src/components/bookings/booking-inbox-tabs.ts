import type { BookingRequestStatus } from "@/lib/booking-requests";

// ─────────────────────────────────────────────────────────────────────────────
// WHERE A BOOKING IS — the five views of the venue-side inbox.
//
// The inbox used to be filtered by the REQUEST's status alone (Open / Accepted /
// All), which stops describing anything once a request is accepted: an
// "Accepted" row might have a draft nobody has sent, terms both sides signed,
// or a show already on sale. The owner's ask, verbatim: "the tabs should be
// about what state the booking request is within — open, agreement,
// finalized/event created."
//
//   open      — PENDING / VIEWED. Waiting on the venue. This is the ONLY view
//               `bookingRequests.countOpen` and the admin-rail badge count.
//   holds     — the request has at least one LIVE hold (booking-holds
//               FR-011): a place in a line for a date, ACTIVE or CHALLENGED
//               and not lapsed. Evaluated AFTER open — an unanswered request
//               with a hold is still an unanswered request, and the Open
//               count must keep meaning Open — and BEFORE the terminal /
//               event rules, because a live hold is the thing the booker is
//               managing right now. (A terminal request never carries a live
//               hold: decline / withdraw / expire release them, FR-009; and a
//               confirmed hold is CONFIRMED, not live, so an event row still
//               lands on Event.)
//   agreement — accepted, terms in play, no event yet.
//   event     — an event exists. The stage rail on the row says whether it is
//               a draft, published, cancelled or completed.
//   closed    — the arc ended: the request was declined, withdrawn or expired,
//               or the agreement it produced was declined, cancelled or
//               expired before an event came of it.
//
// PURE ON PURPOSE. The rule lives here so the panel filter and the tab counts
// read one function and cannot drift — "Agreement (3)" over a list of two rows
// is the bug the counts exist to prevent.
//
// NOT `agreementStatus` ALONE. `resolveBookingStages` drops every row's
// projected stage fields to null when its batched lookup fails, so a null
// `agreementStatus` means "not there yet OR we could not tell". The request's
// own `status` and the `eventId` decide first; the agreement status only ever
// moves a row from `agreement` to `closed`, and only when it is a KNOWN
// terminal value. A degraded row therefore lands on Agreement, which is the
// truthful "we know it was accepted, nothing more" answer, never on Closed.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingInboxTab = "open" | "holds" | "agreement" | "event" | "closed";

/** Slot order — also the precedence for the default landing tab. */
export const BOOKING_INBOX_TABS: readonly BookingInboxTab[] = [
  "open",
  "holds",
  "agreement",
  "event",
  "closed",
];

/** The subset of a hold summary the classifier reads. */
export type BookingInboxHoldInput = {
  status: string;
  /** Lazy-expiry projection — a lapsed CHALLENGED hold is not live. */
  lapsed: boolean;
};

/** The subset of a list row the classifier reads. */
export type BookingInboxTabInput = {
  status: BookingRequestStatus;
  /** Null = no agreement yet, OR the stage projection degraded. */
  agreementStatus: string | null;
  eventId: string | null;
  /**
   * The request's holds. Optional so callers that predate holds (and test
   * fixtures) keep compiling; absent reads as "no live hold".
   */
  holds?: readonly BookingInboxHoldInput[];
};

const OPEN_REQUEST: ReadonlySet<string> = new Set(["PENDING", "VIEWED"]);
const TERMINAL_REQUEST: ReadonlySet<string> = new Set([
  "DECLINED",
  "WITHDRAWN",
  "EXPIRED",
]);
/** Agreement states after which no event will ever come of the booking. */
const TERMINAL_AGREEMENT: ReadonlySet<string> = new Set([
  "DECLINED",
  "CANCELLED",
  "EXPIRED",
]);
/** Hold statuses that occupy a slot in a line (mirrors LIVE_BOOKING_HOLD_STATUSES). */
const LIVE_HOLD: ReadonlySet<string> = new Set(["ACTIVE", "CHALLENGED"]);

/** ONE predicate for "this hold is live" — the row cell, the strip and the calendar overlay all read it. */
export function isLiveBookingHold(hold: BookingInboxHoldInput): boolean {
  return LIVE_HOLD.has(hold.status) && !hold.lapsed;
}

export function hasLiveBookingHold(row: BookingInboxTabInput): boolean {
  return (row.holds ?? []).some(isLiveBookingHold);
}

export function bookingInboxTabOf(row: BookingInboxTabInput): BookingInboxTab {
  if (OPEN_REQUEST.has(row.status)) return "open";
  if (hasLiveBookingHold(row)) return "holds";
  if (TERMINAL_REQUEST.has(row.status)) return "closed";
  // From here the request is ACCEPTED (or a status this build has never seen —
  // treated as accepted-and-in-progress rather than hidden on Closed, because a
  // row that vanishes is worse than a row on a slightly wrong tab).
  if (row.eventId) return "event";
  if (row.agreementStatus && TERMINAL_AGREEMENT.has(row.agreementStatus)) {
    return "closed";
  }
  return "agreement";
}

/** Single source for tab filtering AND tab counts. */
export function rowsForBookingInboxTab<T extends BookingInboxTabInput>(
  rows: readonly T[],
  tab: BookingInboxTab,
): T[] {
  return rows.filter((row) => bookingInboxTabOf(row) === tab);
}

export function countBookingInboxTabs<T extends BookingInboxTabInput>(
  rows: readonly T[],
): Record<BookingInboxTab, number> {
  const counts: Record<BookingInboxTab, number> = {
    open: 0,
    holds: 0,
    agreement: 0,
    event: 0,
    closed: 0,
  };
  for (const row of rows) counts[bookingInboxTabOf(row)] += 1;
  return counts;
}

/**
 * The tab a venue LANDS on: the first non-empty view in slot order, so an
 * inbox with something waiting opens on it and an inbox with only history
 * opens on the history. `open` when every view is empty — the onboarding
 * empty state belongs there.
 *
 * A LANDING decision, taken once. The caller latches the first non-null
 * answer and never re-derives it: answering the last open request must not
 * move the user (see the latch note in BookingsWorkspace.tsx — observed there,
 * declining the final request flipped the page mid-task with no interaction).
 */
export function defaultBookingInboxTab(
  counts: Record<BookingInboxTab, number>,
): BookingInboxTab {
  return BOOKING_INBOX_TABS.find((tab) => counts[tab] > 0) ?? "open";
}
