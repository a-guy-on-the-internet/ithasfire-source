import type {
  BookingMessageAuthorSide,
  BookingRequestMessageRow,
  BookingSystemEntryKind,
  BookingThreadSide,
  CountUnreadByRequestInput,
  CreateBookingRequestMessageInput,
  CursorResult,
  HasBookingSystemEntryInput,
  ListBookingRequestMessagesInput,
  MarkBookingRequestMessagesReadInput,
} from "@th/types/repos/booking-request-messages";

/**
 * Two-party conversation on a booking request (booking-conversation FR-001),
 * and since the system-entry migration the booking's LEDGER: human messages
 * interleaved with SYSTEM entries for every lifecycle transition (see
 * {@link BookingSystemEntryKind}).
 *
 * The request IS the thread — no thread row exists; inbox recency lives on
 * the denormalized `BookingRequest.lastMessageAt`.
 */
export interface BookingRequestMessagesRepo {
  /**
   * Append a message OR a system entry. The use case (Step 4) MUST also bump
   * `BookingRequest.lastMessageAt` in the SAME transaction via
   * `BookingRequestsRepo.touchLastMessageAt` — deliberately a separate call on
   * the booking-requests repo (the denormalized column is that aggregate's
   * data), so this repo never reaches across into the request row. That
   * applies to SYSTEM entries too: an entry IS activity on the booking and
   * must move it up the inbox.
   *
   * SYSTEM entries are written EXCLUSIVELY through
   * `appendBookingSystemEntry` in core, which validates `systemData` against
   * the kind's schema. Nothing else may pass `systemKind`.
   */
  create(
    input: CreateBookingRequestMessageInput,
  ): Promise<BookingRequestMessageRow>;
  /**
   * Thread page, oldest first (createdAt asc, id asc — the chat reading
   * order; matches the [bookingRequestId, createdAt] index). Cursor is the
   * message id, same convention as `EventSavesRepo.listForHuman`.
   */
  listForRequest(
    input: ListBookingRequestMessagesInput,
  ): Promise<CursorResult<BookingRequestMessageRow>>;
  /**
   * Stamp `readAt` on the thread's unread COUNTERPARTY messages with
   * `createdAt <= upToCreatedAt`. Idempotent — already-read rows are
   * untouched. Returns the number of rows stamped.
   *
   * SYSTEM entries are excluded, matching {@link countUnreadByRequest} — a
   * row that can never be unread must never wear a read receipt. See the
   * input type for the full rationale.
   */
  markRead(input: MarkBookingRequestMessagesReadInput): Promise<number>;
  /**
   * BATCH unread counts for a list surface, keyed by `bookingRequestId`.
   * Unread = COUNTERPARTY messages with `readAt IS NULL` — the exact
   * complement of what {@link markRead} stamps, so the badge can never
   * disagree with the thread. SYSTEM entries are excluded from BOTH: unread
   * means "a human is waiting on you" (see the input type).
   *
   * ONE query for the whole page (a grouped count, never a list-and-map) —
   * per-row counting is an N+1 and is not an acceptable implementation.
   *
   * NO TENANCY CHECK HAPPENS HERE: `bookingRequestIds` must ALREADY be
   * authorized by the caller (see the input type's warning). Ids straight off
   * the wire would make this a cross-org existence/count oracle.
   *
   * A request with ZERO unread messages is ABSENT from the map, not present
   * with `0`: `groupBy` emits no row for an empty group. Every consumer MUST
   * default a missing key to 0. An empty `bookingRequestIds` returns an empty
   * map without touching the database.
   */
  countUnreadByRequest(
    input: CountUnreadByRequestInput,
  ): Promise<Map<string, number>>;
  /**
   * Does this request's ledger already carry an entry of `kind`? EXISTENCE
   * only — never used to render anything, only to keep an at-most-once entry
   * from being written twice (see the input type for which kinds those are).
   *
   * Callers: the challenge answer's "kept, awaiting terms" check
   * (booking-the-night FR-014, with `dataMatch` on the hold + challenge, read
   * under the line's lock), and the expiry sweep, whose ledger append does NOT ride
   * its transition's transaction and can therefore be re-entered by an
   * overlapping run. Scoped to one request, so it rides the existing
   * `[bookingRequestId, createdAt]` index — no `systemKind` index is added or
   * needed.
   *
   * NOT A LOCK. Two concurrent transactions can both read `false` under READ
   * COMMITTED and both insert. It closes the realistic window (a re-entered
   * daily sweep, where the appends are seconds apart), not a theoretical one.
   * The airtight version is a partial unique index, which cannot be blanket —
   * see {@link HasBookingSystemEntryInput}.
   */
  hasSystemEntry(input: HasBookingSystemEntryInput): Promise<boolean>;
}

export type {
  BookingMessageAuthorSide,
  BookingRequestMessageRow,
  BookingSystemEntryKind,
  BookingThreadSide,
  CountUnreadByRequestInput,
  CreateBookingRequestMessageInput,
  HasBookingSystemEntryInput,
  ListBookingRequestMessagesInput,
  MarkBookingRequestMessagesReadInput,
} from "@th/types/repos/booking-request-messages";

export {
  BOOKING_SYSTEM_ENTRY_KINDS,
  isBookingSystemEntryKind,
} from "@th/types/repos/booking-request-messages";
