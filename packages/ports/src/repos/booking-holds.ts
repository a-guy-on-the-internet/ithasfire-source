import type {
  BookingHoldCalendarRangeInput,
  BookingHoldLineEntry,
  BookingHoldLineKey,
  BookingHoldPlaceRangeInput,
  BookingHoldRecord,
  BookerBookingHoldRecord,
  BookingHoldStatus,
  ClearPlaceHoldHolderInput,
  ConvertBookerHoldToPlaceInput,
  CreateBookingHoldInput,
  CreateRequestlessBookingHoldInput,
  ListBookingHoldsForRequesterInput,
  PlaceBookingHoldRecord,
  RenumberBookingHoldLineInput,
  RequestBookingHoldRecord,
  RequesterBookingHoldRecord,
  SetBookingHoldRespondByInput,
  UpdateBookingHoldStatusInput,
} from "@th/types/repos/booking-holds";
import type { SetNoteInput, SetNoteResult } from "@th/types/repos/notes";

/**
 * Venue calendar holds (booking-holds spec 2026-08-25), on booking requests
 * and, since holds-without-a-request (spec 2026-09-30, FR-001), without one:
 * a BOOKER hold rides a booking grant, a PLACE hold is the place's own. The
 * record is a union on `ownerKind`. LINE and RANGE reads (`listLine*`,
 * `listLiveFor*Range`, `getById`, `renumberLine`, `updateStatus`) return
 * every kind, because a line is shared; REQUEST-scoped reads
 * (`listForRequest`, `listLiveForRequests`, `listRequestIdsWithConfirmedHold`,
 * `listForRequester`) return REQUEST holds only.
 *
 * READ SCOPE (NFR-001): only the surfaces in FR-011..014 may depend on this
 * port — booking inbox, thread, sent-request view, admin calendar overlay.
 * Public place page, embeds, search, stats, availability and sitemap never
 * read holds. A guard test greps for the port outside the allow-list.
 *
 * LAZY EXPIRY (FR-007/010) is NOT applied here: every method returns rows as
 * stored. Core runs `isHoldLapsed` + `settle-lapsed-booking-holds` on top.
 *
 * All mutations are CAS-guarded and meant to run inside `repos.tx()`
 * (NFR-002); the line renumber (`renumberLine`) MUST be called on the tx
 * client after the transition that changed the line's membership.
 *
 * NO METHOD IS ORG-SCOPED. The holder columns of a request-less hold name
 * whose hold it is, not who may see it; every caller must
 * resolve hold → calendar → place → owner and gate (ORG_EDIT_ROLES / direct
 * human owner) BEFORE returning anything from these reads, and the
 * act-facing projection must never expose sibling rows from `listLine` — an
 * act sees its own hold's date and position only (FR-013).
 */
export interface BookingHoldsRepo {
  /**
   * Insert at the given position (the use case computes `line.length + 1`).
   * MUST run inside `repos.tx()`: the adapter takes the line-scoped
   * transaction advisory lock (`pg_advisory_xact_lock` keyed on
   * calendarId|date — same lock `renumberLine` takes) so an insert can't
   * interleave with a renumber and leave a gap or duplicate position; the
   * use case reads the line for `position` under that same lock.
   * A P2002 on the LIVE-only partial unique "BookingHold_live_request_date_key"
   * maps to `{ code: "conflict", message: "booking_hold_exists" }` (a
   * released/confirmed hold on the same date does NOT block). A P2003 (the
   * request, calendar or space vanished between the caller's check and the
   * insert) maps to `{ code: "conflict", message: "booking_hold_target_missing" }`.
   */
  create(input: CreateBookingHoldInput): Promise<RequestBookingHoldRecord>;
  /**
   * Insert a request-less hold (FR-005) — same lock, position and P2003
   * contract as {@link create}. The holder partial uniques
   * ("BookingHold_live_holder_org_line_key" / "_human_line_key": one LIVE
   * hold per holder per line) map to `{ code: "conflict", message:
   * "booking_hold_holder_exists" }`. The CHECK "BookingHold_owner_kind_shape"
   * backstops the per-kind columns.
   */
  createRequestless(
    input: CreateRequestlessBookingHoldInput,
  ): Promise<BookerBookingHoldRecord | PlaceBookingHoldRecord>;
  getById(id: string): Promise<BookingHoldRecord | null>;
  /** Every hold on a request, any status, position asc then createdAt asc. */
  listForRequest(bookingRequestId: string): Promise<RequestBookingHoldRecord[]>;
  /**
   * Live (ACTIVE | CHALLENGED) holds across a SET of requests in ONE query —
   * the inbox projection (FR-011) groups the result by `bookingRequestId`.
   * `[]` short-circuits without touching the DB.
   */
  listLiveForRequests(
    bookingRequestIds: readonly string[],
  ): Promise<RequestBookingHoldRecord[]>;
  /**
   * The ids, among a SET of requests, that hold a CONFIRMED hold — a booked
   * night (one per request) — in ONE query, each id at most once. The inbox
   * projection (booking-the-night P5-fixes, `hasBookedNight`): the live read
   * above never returns CONFIRMED rows. `[]` short-circuits without the DB.
   */
  listRequestIdsWithConfirmedHold(
    bookingRequestIds: readonly string[],
  ): Promise<string[]>;
  /**
   * Take the line's TRANSACTION advisory lock — the same key `create` and
   * `renumberLine` take (`pg_advisory_xact_lock(hashtext('booking_hold_line:'
   * || calendarId || '|' || date))`). Core calls this at the TOP of every
   * line-scoped mutation tx, BEFORE its settle/`listLine` precondition read,
   * so the line it counts is the line it writes (a `create` that only locks
   * inside the adapter would let two placers both read length n and both
   * insert at n+1). Released on commit; meaningless outside `repos.tx()`.
   */
  lockLine(input: BookingHoldLineKey): Promise<void>;
  /**
   * Take ONE request's booking lock — a transaction advisory lock
   * (`pg_advisory_xact_lock(hashtext('booking_request_booking:' || id))`),
   * held until the surrounding transaction ends (booking-the-night P2c).
   *
   * What it serializes: everything that books, un-books or closes a
   * request's night — the takes (agree & book, book without terms, the
   * manual "Create event"), Cancel booking, Withdraw and Close request, and
   * hold placement. Each one reads "is the night booked? was the booking
   * cancelled? is the request still ACCEPTED?" and then writes on that
   * answer; without one lock they could all read before any commits (write
   * skew under READ COMMITTED) — a withdraw closing a request whose night an
   * agree just booked, or a hold landing on a cancelled booking.
   *
   * LOCK ORDER: callers take it BEFORE any line lock (`lockLine`), so it
   * never closes a cycle with the line locks. MUST be called on the tx
   * client inside `repos.tx()`; outside one it is released at once and
   * serializes nothing. The key is a bound parameter, never interpolated.
   */
  lockRequestBooking(bookingRequestId: string): Promise<void>;
  /**
   * The line for one calendar+date, position asc. LIVE (ACTIVE | CHALLENGED)
   * by default; `statuses` widens the read (e.g. to see a CONFIRMED winner)
   * — never a substitute for the live default in a renumber.
   */
  listLine(
    input: BookingHoldLineKey & { statuses?: readonly BookingHoldStatus[] },
  ): Promise<BookingHoldRecord[]>;
  /**
   * {@link listLine} plus, per hold, its request's terms (agreement id,
   * status, proposedDate), read through BookingHold → BookingRequest →
   * Agreement (booking-the-night N6 / N20 / FR-015). Same order, same LIVE
   * default and `statuses` widener as `listLine`.
   *
   * Facts only. Whether a hold's act is "ready" (terms DRAFT or later dated
   * that night) and whether a hold is "ahead" of another are core's calls:
   * `proposedDate` is an instant and the hold's `date` a place-local day, so
   * matching them needs the place's zone, which this repo does not hold.
   *
   * Not org-scoped (see the port doc): the caller gates the line first, and
   * an act-facing projection must not expose sibling rows or their terms.
   */
  listLineWithTerms(
    input: BookingHoldLineKey & { statuses?: readonly BookingHoldStatus[] },
  ): Promise<BookingHoldLineEntry[]>;
  /**
   * Holds for every calendar of a place in an inclusive date range — the
   * admin place day view overlay (FR-014). Joins through `Calendar.placeId`;
   * date asc, calendarId asc, position asc. LIVE (ACTIVE | CHALLENGED) by
   * default; `statuses` widens it, exactly like `listLine`.
   */
  listLiveForPlaceRange(
    input: BookingHoldPlaceRangeInput,
  ): Promise<BookingHoldRecord[]>;
  /**
   * Holds for one calendar in an inclusive date range (FR-014). LIVE
   * (ACTIVE | CHALLENGED) by default; `statuses` widens it, exactly like
   * `listLine`. The admin overlay passes CONFIRMED too — a night already won
   * must not render as open.
   */
  listLiveForCalendarRange(
    input: BookingHoldCalendarRangeInput,
  ): Promise<BookingHoldRecord[]>;
  /**
   * Holds placed by the booking requests ONE requester owns — the org or
   * human dashboard's "where am I in line" read (event-calendar-redesign
   * FR-004). Joins BookingHold → BookingRequest on the performer owner pair
   * AND `direction = TO_VENUE` (the pair names the TARGET on TO_PERFORMER
   * rows, which own no holds anyway), then → Calendar → Place for the venue
   * context. The owner pair is in the WHERE — a caller can never receive
   * another requester's rows, whatever it does with the result. Date asc,
   * calendarId asc, position asc. LIVE (ACTIVE | CHALLENGED) by default;
   * `statuses` widens it (the dashboard passes CONFIRMED too).
   */
  listForRequester(
    input: ListBookingHoldsForRequesterInput,
  ): Promise<RequesterBookingHoldRecord[]>;
  /**
   * Guarded status transition — see {@link UpdateBookingHoldStatusInput}.
   * Throws `{ code: "conflict", message: "booking_hold_status_changed" }`
   * when the row already left `expectedFrom` (same-row CAS: two concurrent
   * confirms on ONE row → one winner), and
   * `{ code: "conflict", message: "booking_hold_line_confirmed" }` when a
   * DIFFERENT hold in the same calendar+date line is already CONFIRMED
   * (line-level NFR-002, enforced by the partial unique
   * "BookingHold_confirmed_line_key"). Nulls state-coupled fields per the
   * input doc.
   */
  updateStatus(input: UpdateBookingHoldStatusInput): Promise<BookingHoldRecord>;
  /**
   * Rewrite positions 1..n for a line from a single ordered list — see
   * {@link RenumberBookingHoldLineInput}. MUST be called on the tx client
   * inside `repos.tx()` — it takes the line's transaction advisory lock
   * (shared with `create`) and then `SELECT … FOR UPDATE` on the live rows,
   * which only serialise concurrent work if the locks outlive the statement.
   * Rejects with
   * `{ code: "conflict", message: "booking_hold_line_changed" }` if
   * `orderedIds` is not exactly the line's live set. Returns the line in its
   * new order.
   */
  renumberLine(
    input: RenumberBookingHoldLineInput,
  ): Promise<BookingHoldRecord[]>;
  /**
   * Extend a challenge deadline (FR-005). Guarded on status CHALLENGED; zero
   * rows → `{ code: "conflict", message: "booking_hold_status_changed" }`.
   */
  setRespondBy(input: SetBookingHoldRespondByInput): Promise<BookingHoldRecord>;
  /**
   * The LIVE (ACTIVE | CHALLENGED) BOOKER holds riding one booking grant
   * (holds-without-a-request FR-003: the revoke preview and the revoke),
   * date asc, calendarId asc, position asc. As stored: lazy expiry is core's.
   * Not place-scoped: the caller has already resolved the grant at its place.
   */
  listLiveForGrant(grantId: string): Promise<BookerBookingHoldRecord[]>;
  /**
   * A kept hold on revoke becomes a PLACE hold naming the booker — see
   * {@link ConvertBookerHoldToPlaceInput}. Null when the CAS lost (the row is
   * no longer a live BOOKER hold on that grant). MUST run inside
   * `repos.tx()` under the hold's line lock.
   */
  convertBookerHoldToPlace(
    input: ConvertBookerHoldToPlaceInput,
  ): Promise<PlaceBookingHoldRecord | null>;
  /**
   * A named party passes (FR-007): clear a PLACE hold's holder — see
   * {@link ClearPlaceHoldHolderInput}. Null when the CAS lost (the row is no
   * longer a live PLACE hold naming that holder). MUST run inside
   * `repos.tx()` under the hold's line lock.
   */
  clearPlaceHolder(
    input: ClearPlaceHoldHolderInput,
  ): Promise<PlaceBookingHoldRecord | null>;
  /**
   * Write the hold's shared note (FR-012), any kind, any status. With
   * `expectedUpdatedAt` the write lands only while `noteUpdatedAt` still
   * equals it (`conflict` otherwise, nothing written). Never gates: core
   * decides who may edit first.
   */
  setNote(input: SetNoteInput): Promise<SetNoteResult>;
}

export type {
  BookerBookingHoldRecord,
  BookingHoldCalendarRangeInput,
  BookingHoldHolder,
  BookingHoldLineEntry,
  BookingHoldLineKey,
  BookingHoldLineTerms,
  BookingHoldOwnerKind,
  BookingHoldPlaceRangeInput,
  BookingHoldRecord,
  BookingHoldReleaseReason,
  BookingHoldStatus,
  ClearPlaceHoldHolderInput,
  ConvertBookerHoldToPlaceInput,
  CreateBookingHoldInput,
  CreateRequestlessBookingHoldInput,
  ListBookingHoldsForRequesterInput,
  PlaceBookingHoldRecord,
  RenumberBookingHoldLineInput,
  RequestBookingHoldRecord,
  RequesterBookingHoldRecord,
  SetBookingHoldRespondByInput,
  UpdateBookingHoldStatusInput,
} from "@th/types/repos/booking-holds";
export {
  bookingRequestIdOf,
  isRequestBookingHold,
  LIVE_BOOKING_HOLD_STATUSES,
} from "@th/types/repos/booking-holds";
export type { NoteRecord, SetNoteInput, SetNoteResult } from "@th/types/repos/notes";
