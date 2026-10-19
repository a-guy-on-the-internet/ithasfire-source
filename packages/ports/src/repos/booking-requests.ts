import type { SetNoteInput, SetNoteResult } from "@th/types/repos/notes";
import type {
  AddBookingRequestAttachmentInput,
  AttachInquirerOwnerInput,
  BookingRequestActOwnerKey,
  BookingRequestActRecord,
  BookingRequestAttachmentRecord,
  BookingRequestRecord,
  BookingRequestStatus,
  ClaimBookingRequestRecordInput,
  CreateBookingRequestActInput,
  CreateAnonymousBookingRequestRecordInput,
  CreateBookingRequestRecordInput,
  CreateOrganizerBookingRequestRecordInput,
  ListBookingRequestActsOptions,
  MarkInquirerEmailUndeliverableInput,
  PromoteBookingRequestActToSelfInput,
  RestoreBookingRequestActInput,
  SetBookingRequestActConfirmationInput,
  SetBookingRequestActNameInput,
  SetBookingRequestActRoleInput,
  SetBookingRequestActSortOrdersInput,
  SetBookingRequestAssigneeInput,
  SetBookingRequestClaimTokenInput,
  SetInquirerEmailMessageIdInput,
  SoftDeleteBookingRequestAttachmentInput,
  SoftDeleteBookingRequestAttachmentResult,
  SoftRemoveBookingRequestActInput,
  ToPerformerBookingRequestRecord,
  ToVenueBookingRequestRecord,
  UpdateBookingRequestStatusInput,
} from "@th/types/repos/booking-requests";
// ── P3b (asks) ──
import type {
  AnswerBookingRequestAskInput,
  BookingRequestAskRecord,
  CreateBookingRequestAskInput,
  StampBookingRequestAskEventImageInput,
  WithdrawBookingRequestAskInput,
} from "@th/types/repos/booking-requests";
import type { PerformerOwnerType } from "@th/types/repos/performer-profiles";

export interface BookingRequestsRepo {
  create(
    input:
      | CreateBookingRequestRecordInput
      | CreateAnonymousBookingRequestRecordInput,
  ): Promise<ToVenueBookingRequestRecord>;
  /**
   * Organizer org → act request (organizer-booking-requests FR-003). The
   * adapter stamps `direction: "TO_PERFORMER"` (placeId/claim columns null);
   * a P2002 from the SQL-only partial unique
   * "BookingRequest_open_organizer_pair_key" maps to `duplicate_open_request`
   * (race loser of the one-open-per-(org, act) rule).
   */
  createToPerformer(
    input: CreateOrganizerBookingRequestRecordInput,
  ): Promise<ToPerformerBookingRequestRecord>;
  getById(id: string): Promise<BookingRequestRecord | null>;
  /**
   * Venue inbox. Newest first. Direction-scoped to TO_VENUE at the WHERE
   * clause (NFR-001) — a TO_PERFORMER row can never surface here (its
   * placeId is also NULL by CHECK constraint; the filter is belt-and-braces).
   */
  listForPlace(input: {
    placeId: string;
    statuses?: BookingRequestStatus[];
  }): Promise<ToVenueBookingRequestRecord[]>;
  /**
   * SET-shaped twin of {@link listForPlace} — the org-wide venue inbox
   * (`listBookingRequests({ scope: "org-venues" })`), where an org reads every
   * venue it owns in one surface instead of drilling into each one.
   *
   * ONE query for the whole set (`placeId: { in: [...] }`), never a loop over
   * `listForPlace`: the caller's place set is already capped at 100, and a
   * hundred sequential round trips per inbox load is exactly the fan-out
   * `countOpenByPlace` was introduced to delete. `placeIds: []` short-circuits
   * to `[]` without touching the DB (same posture as {@link countForPerformer}).
   *
   * Same load-bearing `direction: "TO_VENUE"` scope as {@link listForPlace}
   * (NFR-001) — a TO_PERFORMER row can never surface here. CROSS-ORG
   * ISOLATION rests on the caller passing only places the org owns; this
   * method trusts `placeIds` exactly as `listForPlace` trusts `placeId`.
   *
   * Newest first with `id` as the tiebreaker: rows from different venues
   * interleave here, so `createdAt desc` alone would leave same-timestamp rows
   * in an order the DB is free to change between loads.
   */
  listForPlaces(input: {
    placeIds: readonly string[];
    statuses?: BookingRequestStatus[];
  }): Promise<ToVenueBookingRequestRecord[]>;
  /**
   * Performer "sent" list — requests the act SENT to venues. Newest first.
   * Direction-scoped to TO_VENUE at the WHERE clause (NFR-001): the act pair
   * also identifies the TARGET on TO_PERFORMER rows, so without the scope a
   * received organizer request would leak into the sent list.
   */
  listForPerformer(input: {
    ownerType: PerformerOwnerType;
    ownerId: string;
    statuses?: BookingRequestStatus[];
  }): Promise<ToVenueBookingRequestRecord[]>;
  /**
   * Organizer "sent to acts" list — outbound TO_PERFORMER requests by the
   * sender org. Newest first.
   */
  listForOrganizer(input: {
    organizerOrgId: string;
    statuses?: BookingRequestStatus[];
  }): Promise<ToPerformerBookingRequestRecord[]>;
  /**
   * Performer "requests to you" inbox — TO_PERFORMER requests targeting the
   * act. Newest first.
   */
  listForPerformerInbox(input: {
    ownerType: PerformerOwnerType;
    ownerId: string;
    statuses?: BookingRequestStatus[];
  }): Promise<ToPerformerBookingRequestRecord[]>;
  /**
   * Counting twin of {@link listForPerformer} — how many TO_VENUE requests the
   * given acts SENT. Takes the owner pairs as a SET (not one owner) because
   * the account-settings "sent" surface unions a human's own identity with
   * every group they administer; one `count` beats N round trips. An empty
   * `owners` array is a no-op that resolves to 0 without touching the DB.
   * Same load-bearing `direction: "TO_VENUE"` scope as the list (NFR-001).
   */
  countForPerformer(input: {
    owners: readonly { ownerType: PerformerOwnerType; ownerId: string }[];
    statuses?: BookingRequestStatus[];
  }): Promise<number>;
  /**
   * Counting twin of {@link listForPerformerInbox} — how many TO_PERFORMER
   * requests target the given acts. Same set-of-owners semantics and empty-set
   * short circuit as {@link countForPerformer}.
   */
  countForPerformerInbox(input: {
    owners: readonly { ownerType: PerformerOwnerType; ownerId: string }[];
    statuses?: BookingRequestStatus[];
  }): Promise<number>;
  /**
   * Grouped counting twin of {@link listForPlace} — how many TO_VENUE requests
   * each of the given places has, in ONE `groupBy` (booking-inbox-placement
   * FR-006). Deliberately COUNT-shaped: the org Bookings surface must never
   * derive its per-venue badges by fetching full lists (that was the old
   * capped fan-out, and it left orgs past the cap with no badge at all).
   *
   * Same load-bearing `direction: "TO_VENUE"` scope as the list, so a count
   * can never disagree with the inbox it summarizes.
   *
   * `statuses` DEFAULTS to {@link OPEN_BOOKING_REQUEST_STATUSES}: this finder
   * is open-count-shaped by name, so omitting the filter must never silently
   * fold EXPIRED/DECLINED/WITHDRAWN/ACCEPTED rows into a badge (the "counts
   * disagree with the list" risk). Pass an explicit set to narrow further.
   *
   * Returns ONLY places that have at least one matching row — `groupBy` emits
   * no group for an empty bucket. Callers that need a row per place (badges)
   * zero-fill from their own place list; `countOpenBookingRequests` does this
   * against the ORG-OWNED place records, which is why its `venues` array — not
   * this return value — is the authoritative venue list for the Bookings
   * surface. An empty `placeIds` short-circuits to `[]` without touching the
   * DB (same posture as {@link countForPerformer}).
   */
  countOpenByPlace(input: {
    placeIds: readonly string[];
    statuses?: BookingRequestStatus[];
  }): Promise<{ placeId: string; openCount: number }[]>;
  /**
   * The open (PENDING | VIEWED) request for a (performer, place) pair, if
   * any. Enforces the one-open-request-per-pair rule in `create-booking-request`.
   */
  findOpenByPerformerAndPlace(input: {
    ownerType: PerformerOwnerType;
    ownerId: string;
    placeId: string;
  }): Promise<ToVenueBookingRequestRecord | null>;
  /**
   * The open (PENDING | VIEWED) TO_PERFORMER request for an
   * (organizer org, act) pair, if any — pre-check for the
   * one-open-per-pair rule in `create-organizer-booking-request` (the
   * SQL-only partial unique index stays the authoritative race guard).
   */
  findOpenByOrganizerAndPerformer(input: {
    organizerOrgId: string;
    ownerType: PerformerOwnerType;
    ownerId: string;
  }): Promise<ToPerformerBookingRequestRecord | null>;
  /**
   * The open (PENDING | VIEWED) UNCLAIMED inquiry (`claimedAt IS NULL`)
   * for a (place, contactEmail) pair, if any — the anonymous analogue of
   * `findOpenByPerformerAndPlace` used by the embed inquiry pre-check
   * (booking-request-embed-button FR-005).
   *
   * Scoped by CLAIM STATE, not by a null owner pair: since
   * booking-inquirer-outreach an unclaimed inquiry the venue has replied to
   * carries a SHADOW owner pair, which drops it out of the SQL-only
   * "BookingRequest_open_anon_pair_key" (predicate: `performerOwnerId IS
   * NULL`) with no index taking over the address key. This pre-check is
   * therefore the only thing enforcing "one open inquiry per (place, email)"
   * in that window — and the thing that stops a later reply to a second
   * inquiry from colliding on "BookingRequest_open_pair_key".
   *
   * The adapter lowercases the
   * argument and matches by PLAIN EQUALITY (adapter-written rows are
   * lowercased at rest; never ILIKE — wildcard chars in an email must not
   * pattern-match another submitter's row). Best-effort pre-check only:
   * mixed-case out-of-band rows fall through to the authoritative
   * `lower(contactEmail)` unique index, which stays the race guard.
   */
  findOpenByContactEmailAndPlace(input: {
    placeId: string;
    contactEmail: string;
  }): Promise<ToVenueBookingRequestRecord | null>;
  /**
   * The request that produced an agreement, if any (`agreementId` is unique).
   * Used by the booking-agreement editor to show the originating pitch.
   */
  findByAgreementId(agreementId: string): Promise<BookingRequestRecord | null>;
  /**
   * Batch twin of {@link findByAgreementId}: the requests whose
   * `agreementId` is in `agreementIds`, in ONE query (`agreementId` is
   * unique, so at most one per id). Missing ids are omitted; order is
   * unspecified. `[]` → `[]` without a round trip. NOT an authorization
   * boundary.
   */
  findManyByAgreementIds(
    agreementIds: readonly string[],
  ): Promise<BookingRequestRecord[]>;
  /**
   * The request an EVENT-FIRST save created for an event (`originEventId`
   * is unique; venue-confirmation spec "Two entry paths, one request").
   * Null for request-first rows and for events that never produced one.
   * The idempotency read of `createBookingRequestFromEvent`: a second save
   * of the same event finds this row and creates nothing.
   */
  findByOriginEventId(
    originEventId: string,
  ): Promise<ToVenueBookingRequestRecord | null>;
  /**
   * Exact-equality lookup on the unique `claimTokenHash` column
   * (booking-request-embed-button FR-007). The argument is the sha256 hex of
   * the raw token — hashing happens in core; the raw token never reaches the
   * repo. An exact hash lookup is constant-time-safe here: the token is 256
   * bits of `randomBytes` entropy, so a timing oracle on the equality/index
   * probe gives an attacker nothing enumerable.
   */
  findByClaimTokenHash(
    claimTokenHash: string,
  ): Promise<BookingRequestRecord | null>;
  /**
   * Write/rotate the claim token — always an UPDATE, never part of `create`
   * (the blanket P2002→duplicate_open_request mapping on `create` depends on
   * that). CAS: status in `expectedFrom` AND `performerOwnerId IS NULL` AND
   * `claimedAt IS NULL`; zero rows → `{ code: "conflict", message:
   * "booking_request_status_changed" }`. A P2002 on the unique
   * `claimTokenHash` (256-bit collision — astronomically unlikely) maps to
   * `{ code: "conflict", message: "claim_token_hash_collision" }` so core can
   * retry once with a fresh token.
   */
  setClaimToken(
    input: SetBookingRequestClaimTokenInput,
  ): Promise<BookingRequestRecord>;
  /**
   * Redeem a claim token (single use). CAS on `claimTokenHash` still matching
   * + `claimedAt IS NULL` + status ACCEPTED — exactly one winner under
   * concurrent redeems; the loser gets `{ code: "conflict", message:
   * "booking_request_already_claimed" }`. Backfills the performer owner pair,
   * stamps `claimedAt`, and NULLs both token columns.
   */
  claim(input: ClaimBookingRequestRecordInput): Promise<BookingRequestRecord>;
  /**
   * Attach a SHADOW performer owner pair to an UNCLAIMED anonymous inquiry
   * (booking-inquirer-outreach, 2026-09-05) so the venue's reply has a
   * reachable identity instead of vanishing into the notifier's zero-recipient
   * branch. The row KEEPS `contactName`/`contactEmail` — the DB CHECK
   * "BookingRequest_sender_identity_check" only demands them on OWNERLESS
   * rows, and the venue inbox's `mailto:` affordance (embed spec FR-006) reads
   * them.
   *
   * This is NOT a claim. `claimedAt` stays null, so
   * {@link isUnclaimedBookingInquiry} still reports true and every
   * accept/mint/authorize path keeps treating the inquiry as unproven; only
   * the invite-to-claim token can attach a REAL party.
   *
   * IDEMPOTENT by CAS: the WHERE requires `performerOwnerId IS NULL`,
   * `claimedAt IS NULL` and a non-null `contactEmail`, so a second venue reply
   * matches zero rows. Returns `null` on a zero-match (already attached, or no
   * longer an unclaimed inquiry) — deliberately NOT a throw: the caller runs
   * post-commit behind the venue's already-durable message.
   *
   * P2002 HAZARD, mapped: while the row is open (PENDING | VIEWED) the flip
   * moves it out of the SQL-only "BookingRequest_open_anon_pair_key" and into
   * "BookingRequest_open_pair_key". If that shadow already holds an open
   * request at the same place the write violates the latter, and the adapter
   * maps it to `{ code: "conflict", message: "duplicate_open_request" }` —
   * the SAME shape `create` uses. The caller MUST catch it and still send the
   * email; a dedupe collision is not a reason to drop a venue's reply.
   */
  attachInquirerOwner(
    input: AttachInquirerOwnerInput,
  ): Promise<BookingRequestRecord | null>;
  /**
   * Record the FIRST venue→inquirer thread email's `Message-ID` (bare, no
   * angle brackets) so later sends can quote it in `In-Reply-To` +
   * `References` and the booking reads as ONE mail chain.
   *
   * FIRST-WRITE-WINS CAS (`inquirerEmailMessageId IS NULL`): two concurrent
   * replies must not leave the thread root flip-flopping between two ids —
   * the loser simply threads under the winner's root on its next send.
   * Returns true iff this call wrote the root.
   */
  setInquirerEmailMessageId(
    input: SetInquirerEmailMessageIdInput,
  ): Promise<boolean>;
  /**
   * Stamp "we could not reach this inquirer" on every inquiry THIS FEATURE
   * MAILED at that address and that is still open and unclaimed (provider
   * bounce/complaint fan-in).
   *
   * Address-keyed because that is ALL the provider webhook knows — it does not
   * echo our custom headers on bounce events — so the WHERE must do the
   * narrowing the provider cannot. Three scopes, each load-bearing:
   * - `inquirerEmailMessageId IS NOT NULL` — only rows we actually mailed.
   *   Otherwise one bounce stamps the same person's untouched inquiries at
   *   every other venue, and a bounced guest-ticket receipt stamps all of them.
   * - status in {@link INQUIRER_REACHABLE_BOOKING_REQUEST_STATUSES} — NOT the
   *   plain open set. DECLINED / WITHDRAWN / EXPIRED are finished
   *   conversations and "we could not reach them" is noise on them, but
   *   ACCEPTED is IN: the venue said yes and the invite-to-claim mail went to
   *   that same address, so a bounce there means the inquirer will never
   *   redeem the token — the case the venue most needs to see.
   * - `claimedAt IS NULL` — a claimed row has a real account and the
   *   platform's own deliverability machinery.
   * Two venues that both mailed the same still-open address are still stamped
   * together; that is irreducible without per-send correlation.
   *
   * Monotonic: an event older than the existing stamp is ignored, so an
   * out-of-order provider replay cannot resurrect a stale status.
   *
   * Returns the number of rows stamped (0 is normal and NOT an error: most
   * bounces belong to addresses no inquiry ever used).
   */
  markInquirerEmailUndeliverable(
    input: MarkInquirerEmailUndeliverableInput,
  ): Promise<number>;
  /**
   * Stamp → VIEWED. Guarded compare-and-swap: only applied when the row's
   * current status is in `expectedFrom`; otherwise throws
   * `{ code: "conflict", message: "booking_request_status_changed" }` so a
   * concurrent DECLINED/EXPIRED row can never be resurrected.
   */
  markViewed(input: {
    id: string;
    now: Date;
    expectedFrom: readonly BookingRequestStatus[];
  }): Promise<BookingRequestRecord>;
  /**
   * Guarded status transition (see `UpdateBookingRequestStatusInput.expectedFrom`).
   * Throws `{ code: "conflict", message: "booking_request_status_changed" }`
   * when the row already left the expected set (lost-update race).
   */
  updateStatus(
    input: UpdateBookingRequestStatusInput,
  ): Promise<BookingRequestRecord>;
  /**
   * Set or clear the venue-internal assignee (booking-holds FR-015). Not
   * status-guarded; idempotent. Throws
   * `{ code: "not_found", message: "booking_request_not_found" }` when the
   * id matches no row (updateMany count 0), so a stale id never resolves to
   * a silently-unchanged record.
   */
  setAssignee(input: SetBookingRequestAssigneeInput): Promise<BookingRequestRecord>;
  /**
   * The expiry sweep's CANDIDATES: ids of open (PENDING | VIEWED) requests
   * whose `expiresAt` is at or before `cutoff` and whose night is not BOOKED
   * (no CONFIRMED hold). A pre-filter only — read without any lock, so a
   * confirm still in flight is invisible to it; {@link expireIfDue} is the
   * authoritative, per-request check.
   *
   * At most `limit` ids, OLDEST deadline first (`expiresAt` asc, then id):
   * one run takes a bounded slice, and a backlog drains over several runs
   * in deadline order.
   */
  listExpiryCandidates(input: { cutoff: Date; limit: number }): Promise<string[]>;
  /**
   * Expire ONE request, guarded: status still open (PENDING | VIEWED),
   * `expiresAt` at or before `cutoff`, and no CONFIRMED hold. Returns the
   * EXPIRED row, or null when any guard failed (answered, withdrawn, booked
   * meanwhile — nothing written).
   *
   * MUST run inside `repos.tx()` AFTER `bookingHolds.lockRequestBooking(id)`
   * (booking-the-night P2d-2, carry a). Every path that books a request's
   * night — the venue confirm via publish (`settleHeldDatesForPublishedEvent`),
   * the takes, accept — takes that lock before writing a CONFIRMED hold, so
   * under READ COMMITTED this guarded write either waits for an in-flight
   * confirm to commit and then sees its CONFIRMED hold (no flip), or commits
   * first and the confirm then finds a closed request with no live hold. A
   * request whose night is BOOKED stays open until Cancel booking (P2c, W5 /
   * round-3 B1): expiry only releases LIVE holds, so flipping it would
   * strand the CONFIRMED hold on a request nothing can close.
   */
  expireIfDue(input: {
    id: string;
    cutoff: Date;
  }): Promise<BookingRequestRecord | null>;
  /**
   * Bump the denormalized `lastMessageAt` (booking-conversation FR-001).
   * MUST be called in the SAME transaction as the
   * `BookingRequestMessagesRepo.create` that motivated it — a thread whose
   * message committed without the bump sorts wrongly in every inbox forever.
   * Monotonic guard in the adapter: never moves the stamp backwards.
   */
  touchLastMessageAt(input: { id: string; at: Date }): Promise<void>;
  /**
   * Requests PARKED before the 2026-09-25 amendment (unclaimed venues take no
   * requests) that are still OPEN: TO_VENUE, `parkedUnclaimedAt` set, status
   * PENDING | VIEWED. Oldest first, at most `limit`. The candidate read of
   * the one-off cleanup (`expireParkedBookingRequests`); read without locks,
   * so {@link expireParked} is the authoritative check.
   */
  listOpenParked(input: {
    limit: number;
  }): Promise<ToVenueBookingRequestRecord[]>;
  /**
   * Expire ONE parked request, guarded: still OPEN (PENDING | VIEWED), still
   * parked (`parkedUnclaimedAt` set) and no CONFIRMED hold. Flips it to
   * EXPIRED and clears `parkedUnclaimedAt` in the same statement, so a second
   * run finds nothing. Returns the EXPIRED row, or null when any guard failed.
   *
   * Same contract as {@link expireIfDue}: MUST run inside `repos.tx()` AFTER
   * `bookingHolds.lockRequestBooking(id)`.
   */
  expireParked(input: { id: string }): Promise<BookingRequestRecord | null>;
  /**
   * Attach a stored object to a request (rider / stage plot, FR-008).
   *
   * CLAIM-ONCE contract (Step-6 review): `storageKey` is client-asserted
   * (no upload-session mint yet — Step 8 scopes keys server-side), so the
   * adapter MUST reject with `{ code: "conflict", message:
   * "attachment_key_taken" }` when ANY attachment row — live OR
   * soft-deleted, on ANY request — already carries that key. The check runs
   * in the SAME transaction as the insert (this method is invoked on the tx
   * client via `repos.tx()`). Without it, a participant could re-register
   * an already-claimed key and later have the soft-delete GC destroy bytes
   * they never uploaded.
   */
  addAttachment(
    input: AddBookingRequestAttachmentInput,
  ): Promise<BookingRequestAttachmentRecord>;
  /** Live (non-soft-deleted) attachments, oldest first. */
  listAttachments(
    bookingRequestId: string,
  ): Promise<BookingRequestAttachmentRecord[]>;
  /**
   * Soft-delete an attachment (stamps `deletedAt`; idempotent no-op if
   * already stamped). Scoped by BOTH `id` AND `bookingRequestId` in the
   * adapter's WHERE clause (IDOR backstop — a forged attachment id from
   * another request matches zero rows). Returns `null` when no row matches
   * the (id, bookingRequestId) pair.
   *
   * The caller MUST enqueue `record.storageKey` on the PendingObjectDeletion
   * outbox IN THE SAME TRANSACTION — the schema docstring promises the object
   * bytes get GC'd, and this port has no storage access, so skipping the
   * enqueue leaks the object forever. Enqueue ONLY when `didStamp` is true
   * (this call transitioned the row to deleted); a repeat call returns
   * `didStamp: false` and MUST NOT enqueue again (double-enqueue protection).
   */
  softDeleteAttachment(
    input: SoftDeleteBookingRequestAttachmentInput,
  ): Promise<SoftDeleteBookingRequestAttachmentResult | null>;
  // ── P3b (asks) ── venue-booking-standards v1.1 FR-009
  /**
   * One attachment by id, scoped to its request in the WHERE (IDOR backstop:
   * an id from another request reads as null). Soft-deleted rows ARE
   * returned (`deletedAt` set) — callers decide whether a deleted file still
   * counts.
   */
  getAttachment(input: {
    id: string;
    bookingRequestId: string;
  }): Promise<BookingRequestAttachmentRecord | null>;
  /** Insert an ask (status OPEN). */
  createAsk(input: CreateBookingRequestAskInput): Promise<BookingRequestAskRecord>;
  /** One ask, scoped to its request (an id from another request → null). */
  getAsk(input: {
    id: string;
    bookingRequestId: string;
  }): Promise<BookingRequestAskRecord | null>;
  /** Every ask on the request, oldest first (`askedAt`, then `id`). */
  listAsks(bookingRequestId: string): Promise<BookingRequestAskRecord[]>;
  /**
   * Save or replace the answer — a CAS, see
   * {@link AnswerBookingRequestAskInput}. Returns the updated row, or `null`
   * when the CAS matched nothing (withdrawn, or another answer landed first).
   */
  answerAsk(
    input: AnswerBookingRequestAskInput,
  ): Promise<BookingRequestAskRecord | null>;
  /** OPEN → WITHDRAWN CAS; `null` when the ask was not OPEN. */
  withdrawAsk(
    input: WithdrawBookingRequestAskInput,
  ): Promise<BookingRequestAskRecord | null>;
  /**
   * Record the V10 image copy for (ask, event) — a CAS, see
   * {@link StampBookingRequestAskEventImageInput}. `true` = this call won.
   */
  stampAskEventImage(
    input: StampBookingRequestAskEventImageInput,
  ): Promise<boolean>;

  // ── The bill (lineup-booking-requests v2, FR-001) ─────────────────────────
  /**
   * Insert the acts on a request's bill, in the given order, and return the
   * rows in that order. Call on the tx client (`repos.tx()`) in the SAME
   * transaction as the request create — a request must never commit without
   * its bill. `acts: []` returns `[]` without touching the DB.
   *
   * SELF rows take their owner pair from the REQUEST ROW (its
   * `performerOwnerType/Id`, read on this same client) — never from the
   * caller. Throws `{ code: "not_found", message: "booking_request_not_found" }`
   * when a SELF row is asked for on a missing request, and
   * `{ code: "invalid_input", message: "booking_request_self_act_without_sender" }`
   * when the request has no owner pair (an unclaimed anonymous inquiry).
   *
   * The adapter stamps `confirmation`: SELF / EXTERNAL → CONFIRMED, TAGGED →
   * PENDING (the SQL CHECK forbids a PENDING SELF/EXTERNAL row). A second
   * row for the same (request, actOwnerType, actOwnerId) — including a human
   * who already DECLINED on this request — throws
   * `{ code: "conflict", message: "booking_request_act_duplicate" }`.
   *
   * THAT CONFLICT ABORTS THE SURROUNDING TRANSACTION. It is a Postgres
   * unique violation, and after one every further statement in the same
   * transaction fails ("current transaction is aborted"). Callers MUST
   * dedupe first (read `listActsForRequests`, compare owner keys) and must
   * NEVER catch this error and continue inside `repos.tx()` — let it
   * propagate and roll the whole transaction back. It is a race backstop,
   * not a control-flow signal.
   */
  addActs(
    bookingRequestId: string,
    acts: readonly CreateBookingRequestActInput[],
  ): Promise<BookingRequestActRecord[]>;
  /**
   * Every LIVE act on the given requests in ONE query, ordered by
   * (bookingRequestId, sortOrder, createdAt, id) — deterministic, but core
   * must assign DISTINCT sortOrders so the order is the one it chose. No
   * confirmation filter — the venue-facing hide of DECLINED rows is a core
   * concern. `[]` → `[]`.
   *
   * LIVE = `removedAt IS NULL` (v3 FR-001): a sender-removed act is not on
   * the bill for any reader — inbox rows, the thread, the invite page, the
   * mint under the bill lock. `{ includeRemoved: true }` adds them (see
   * {@link ListBookingRequestActsOptions}) in the same order.
   */
  listActsForRequests(
    bookingRequestIds: readonly string[],
    options?: ListBookingRequestActsOptions,
  ): Promise<BookingRequestActRecord[]>;
  /**
   * The act owned by `actOwnerType/Id` on `bookingRequestId`, or null — looked
   * up by the platform-act unique key. There is deliberately NO get-by-act-id:
   * an act is reachable only by naming its owner, so an actor can only ever
   * read their own row (IDOR backstop). EXTERNAL rows have no owner and are
   * not addressable here. A REMOVED row reads as null unless
   * `{ includeRemoved: true }` (v3 FR-001).
   */
  getActForOwner(
    key: BookingRequestActOwnerKey,
    options?: ListBookingRequestActsOptions,
  ): Promise<BookingRequestActRecord | null>;
  /**
   * CAS the act's confirmation (FR-003). The WHERE carries bookingRequestId +
   * actOwnerType + actOwnerId + `source = TAGGED` (a SELF row is never
   * answerable) + `confirmation = expectedFrom`, so it applies
   * only to the acting human's OWN row, in the state core read (PENDING for
   * an answer; CONFIRMED for a consent withdrawal), and only while the row is
   * LIVE (`removedAt IS NULL` — a removed act cannot answer). A lost race, a
   * wrong owner, a removed or a missing row matches zero rows and throws
   * `{ code: "conflict", message: "booking_request_act_state_changed" }`,
   * exactly like `updateStatus`. Idempotency on repeat is core's job (read
   * with `getActForOwner` first, no-op when already in the target state).
   * Returns the updated row.
   */
  setActConfirmation(
    input: SetBookingRequestActConfirmationInput,
  ): Promise<BookingRequestActRecord>;
  /**
   * Take the bill's TRANSACTION advisory lock
   * (`pg_advisory_xact_lock(hashtext('booking_request_bill:' || id))`),
   * held until the surrounding transaction ends. MUST be called on the tx
   * client (`repos.tx()`) — outside one it is released at once and
   * serializes nothing.
   *
   * What it serializes: an artist answering their spot
   * (`confirm/declineBookingRequestAct`) against the event mint that reads
   * the bill (`createEventFromAgreement`). Both take this lock BEFORE
   * reading the state they decide on, so a consent withdrawal and a mint can
   * never both see the other's pre-commit state — without it, a DECLINED act
   * could flow onto the event (write skew under READ COMMITTED).
   */
  lockBill(bookingRequestId: string): Promise<void>;
  /**
   * Turn one EXTERNAL row into the SENDER's SELF row — see
   * {@link PromoteBookingRequestActToSelfInput}. Call on the tx client, in
   * the same transaction as the claim that set the request's owner pair.
   *
   * The adapter copies `performerOwnerType/Id` off the request row (read on
   * this same client), nulls `externalName`/`externalUrl` and stamps
   * CONFIRMED — the shape the SQL CHECKs require of a SELF row. Throws the
   * SELF-insert errors (`booking_request_not_found`,
   * `booking_request_self_act_without_sender`) for a missing / sender-less
   * request, `{ code: "conflict", message: "booking_request_act_state_changed" }`
   * when no LIVE EXTERNAL row with that id is on that request, and
   * `booking_request_act_duplicate` when the sender already has a platform
   * row on it (a unique violation — it ABORTS the transaction, see
   * {@link addActs}). Returns the updated row.
   */
  promoteActToSelf(
    input: PromoteBookingRequestActToSelfInput,
  ): Promise<BookingRequestActRecord>;

  // ── Bill editing (lineup-booking-requests v3, FR-009) ─────────────────────
  // All four: call on the tx client after `lockBill`; the WHERE scopes by
  // `bookingRequestId` + act id; authority and the "no event yet" rule
  // (BILL_LOCKED) are core's. See each input type for the exact contract.
  /**
   * Soft-remove one live act — {@link SoftRemoveBookingRequestActInput}.
   * Returns the row with `removedAt` set.
   */
  softRemoveAct(
    input: SoftRemoveBookingRequestActInput,
  ): Promise<BookingRequestActRecord>;
  /**
   * Put a removed, non-DECLINED act back on the bill —
   * {@link RestoreBookingRequestActInput}. Returns the live row.
   */
  restoreAct(
    input: RestoreBookingRequestActInput,
  ): Promise<BookingRequestActRecord>;
  /**
   * Reorder the whole live bill — {@link SetBookingRequestActSortOrdersInput}.
   * Returns the live bill in its new order (same shape as
   * `listActsForRequests([bookingRequestId])`).
   */
  setActSortOrders(
    input: SetBookingRequestActSortOrdersInput,
  ): Promise<BookingRequestActRecord[]>;
  /**
   * Change one live act's role — {@link SetBookingRequestActRoleInput}.
   * Returns the updated row.
   */
  setActRole(
    input: SetBookingRequestActRoleInput,
  ): Promise<BookingRequestActRecord>;
  /**
   * Rewrite the request's display `actName` — {@link SetBookingRequestActNameInput}.
   * Only the bill edit calls it (v3 FR-009 / NFR-002): when the sender goes
   * on the bill, an `actName` defaulted from a by-name act gives way to the
   * sender. Call on the tx client after `lockBill`. A missing row throws
   * `{ code: "not_found", message: "booking_request_not_found" }`.
   */
  setActName(
    input: SetBookingRequestActNameInput,
  ): Promise<BookingRequestRecord>;
  /**
   * Write the request's shared note (holds-without-a-request FR-012), whatever
   * its status. With `expectedUpdatedAt` the write lands only while
   * `noteUpdatedAt` still equals it (`conflict`, nothing written,
   * otherwise). Never gates: core decides who may edit first.
   */
  setNote(input: SetNoteInput): Promise<SetNoteResult>;
}

export type {
  AddBookingRequestAttachmentInput,
  AnonymousBookingRequestSender,
  AttachInquirerOwnerInput,
  BookingRequestActConfirmation,
  BookingRequestActOwnerKey,
  BookingRequestActRecord,
  BookingRequestActRole,
  BookingRequestActSource,
  BookingRequestAttachmentRecord,
  BookingInquirerEmailFailure,
  BookingRequestDirection,
  BookingRequestRecord,
  BookingRequestSender,
  BookingRequestSource,
  BookingRequestStatus,
  BookingIntent,
  BookingTaxFormStatus,
  ClaimBookingRequestRecordInput,
  CreateAnonymousBookingRequestRecordInput,
  CreateBookingRequestActInput,
  CreateBookingRequestRecordInput,
  CreateOrganizerBookingRequestRecordInput,
  ListBookingRequestActsOptions,
  MarkInquirerEmailUndeliverableInput,
  OwnedBookingRequestSender,
  PromoteBookingRequestActToSelfInput,
  RestoreBookingRequestActInput,
  SetBookingRequestActConfirmationInput,
  SetBookingRequestActNameInput,
  SetBookingRequestActRoleInput,
  SetBookingRequestActSortOrdersInput,
  SetBookingRequestAssigneeInput,
  SetBookingRequestClaimTokenInput,
  SetInquirerEmailMessageIdInput,
  SoftDeleteBookingRequestAttachmentInput,
  SoftDeleteBookingRequestAttachmentResult,
  SoftRemoveBookingRequestActInput,
  ToPerformerBookingRequestRecord,
  ToVenueBookingRequestRecord,
  UpdateBookingRequestStatusInput,
} from "@th/types/repos/booking-requests";
// ── P3b (asks) ──
export type {
  AnswerBookingRequestAskInput,
  BookingRequestAskKind,
  BookingRequestAskRecord,
  BookingRequestAskStatus,
  CreateBookingRequestAskInput,
  StampBookingRequestAskEventImageInput,
  WithdrawBookingRequestAskInput,
} from "@th/types/repos/booking-requests";
export { BOOKING_REQUEST_ASK_KINDS } from "@th/types/repos/booking-requests";
export {
  getBookingRequestSender,
  INQUIRER_REACHABLE_BOOKING_REQUEST_STATUSES,
  isAnonymousBookingRequestCreateInput,
  isUnclaimedBookingInquiry,
  OPEN_BOOKING_REQUEST_STATUSES,
} from "@th/types/repos/booking-requests";
