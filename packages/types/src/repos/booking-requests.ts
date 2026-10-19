import type { PerformerOwnerType } from "./performer-profiles";
import type { VerifiedStatsSnapshot } from "./human-stats";
import type { BookingThreadSide } from "./booking-request-messages";
import type { EventHumanRole } from "./event-humans";
import type { BookingStandardField } from "./booking-standards";

export type BookingRequestStatus =
  | "PENDING"
  | "VIEWED"
  | "ACCEPTED"
  | "DECLINED"
  | "WITHDRAWN"
  | "EXPIRED";

/** Fee-ask type on a booking-request pitch. */
export type BookingFeeType = "GUARANTEE" | "DOOR_SPLIT" | "NEGOTIABLE";

/** Where a booking request was submitted from. */
export type BookingRequestSource = "PLATFORM" | "EMBED";

/**
 * Why the inquirer's `contactEmail` is undeliverable. Mirrors the two
 * suppressing values of the platform `EmailDeliveryStatus` enum (BOUNCED |
 * COMPLAINED) — DELIVERABLE is not a failure and is never stamped here.
 */
export type BookingInquirerEmailFailure = "BOUNCED" | "COMPLAINED";

/**
 * Tax-form paperwork FLAG on a booking request (venue-hierarchy FR-008). A
 * workflow marker ONLY — the platform never stores TINs or identity
 * documents; identity collection stays deferred to Stripe Connect onboarding.
 */
export type BookingTaxFormStatus = "NONE" | "REQUESTED" | "RECEIVED";

/**
 * Which way the request flows (organizer-booking-requests FR-001):
 * - TO_VENUE — performer pitches a venue (the original flow);
 * - TO_PERFORMER — an organizer ORG requests an act.
 * The performer owner pair is the SENDER in TO_VENUE (the organizer of the
 * ask; the acts are `BookingRequestActRecord` rows — lineup v2, D3b) and the
 * TARGET act in TO_PERFORMER (the sender there is `organizerOrgId`).
 */
export type BookingRequestDirection = "TO_VENUE" | "TO_PERFORMER";

/**
 * What the request asks the venue for (venue-confirmation-and-booking-intents
 * spec, docs/specs/2026-08-27). Picks the form variant and the default event
 * owner at accept: PERFORM → venue owns the minted event (today's flow);
 * RENT / USE → the requester owns it. USE is non-transactional and always
 * produces an event. Existing rows are PERFORM.
 */
export type BookingIntent = "PERFORM" | "RENT" | "USE";

/** Statuses still awaiting a response from the receiving side. */
export const OPEN_BOOKING_REQUEST_STATUSES = [
  "PENDING",
  "VIEWED",
] as const satisfies readonly BookingRequestStatus[];

/**
 * Statuses where reaching the inquirer STILL MATTERS — the open set PLUS
 * ACCEPTED (booking-inquirer-outreach, 2026-09-05).
 *
 * DELIBERATELY NOT {@link OPEN_BOOKING_REQUEST_STATUSES}. "Open" answers
 * "is anyone owed a response"; this answers "would we lose something if mail
 * to this address vanished", and those come apart at exactly one status.
 * ACCEPTED is neither terminal nor claimed: the venue said yes and the
 * invite-to-claim mail went to that address, so if it hard-bounces the
 * inquirer will never redeem the token and never appear — the case where the
 * venue MOST needs to be told the address is dead. DECLINED / WITHDRAWN /
 * EXPIRED stay out: those conversations are finished and "we could not reach
 * them" is noise on them.
 */
export const INQUIRER_REACHABLE_BOOKING_REQUEST_STATUSES = [
  ...OPEN_BOOKING_REQUEST_STATUSES,
  "ACCEPTED",
] as const satisfies readonly BookingRequestStatus[];

/**
 * Fields present on BOTH directions. `BookingRequestRecord` narrows this via
 * the `direction` discriminant — venue-side code paths MUST narrow to
 * {@link ToVenueBookingRequestRecord} (getting a non-null `placeId` for free)
 * and organizer paths to {@link ToPerformerBookingRequestRecord}; unguarded
 * `record.placeId` reads are `string | null` on purpose so the compiler
 * surfaces every venue path that skipped its direction guard (NFR-001).
 */
export interface BookingRequestRecordCommon {
  id: string;
  direction: BookingRequestDirection;
  /** Venue (TO_VENUE only; always null for TO_PERFORMER). */
  placeId: string | null;
  /** Denormalized for inbox / sent-list display. Null if the place is gone. */
  placeName: string | null;
  /** Sender org (TO_PERFORMER only; always null for TO_VENUE). */
  organizerOrgId: string | null;
  /** Denormalized organizer-org display name (TO_PERFORMER only). */
  organizerOrgName: string | null;
  /** Optional attached event (TO_PERFORMER only) — id only; rendered live. */
  attachedEventId: string | null;
  /** Denormalized live title of the attached event, when still present. */
  attachedEventTitle: string | null;
  /** Denormalized live start of the attached event, when still present. */
  attachedEventStartsAt: Date | null;
  // ── Intent + the room + the window (venue-confirmation spec) ──────────────
  /** See {@link BookingIntent}. Pre-spec rows read PERFORM. */
  intent: BookingIntent;
  /**
   * The Space the request wants, if the sender named one. OPTIONAL for EVERY
   * intent since the 2026-09-22 ruling (migration
   * 20260922120000_booking_request_space_optional dropped the `spaceId IS NOT
   * NULL` conjunct from "BookingRequest_intent_shape_check"): a request routes
   * to a CALENDAR and a window, and the room is chosen at accept/confirm on
   * the draft event.
   *
   * So a null here means EITHER "no room asked" OR "the room was deleted"
   * (SetNull) — and the two are NOT distinguishable, on a RENT row or any
   * other. Do not infer "room gone" from a null; rows written before
   * 2026-09-22 are the only ones for which that inference ever held.
   */
  spaceId: string | null;
  /** RENT/USE booking window. PERFORM rows keep using `preferredDates`. */
  requestedStartsAt: Date | null;
  requestedEndsAt: Date | null;
  /** "What is it" — the RENT/USE one-liner in place of the performer pitch. */
  purpose: string | null;
  expectedAttendance: number | null;
  /**
   * Event-first: the event whose save auto-created this request. Null for
   * request-first rows and after the event is deleted (SetNull).
   */
  originEventId: string | null;
  /**
   * READ-ONLY HISTORY. Set on requests made to an unclaimed venue before the
   * 2026-09-25 amendment (unclaimed venues take no requests), when such a
   * request was parked until the place was claimed. Nothing writes it now;
   * `expireParked` clears it as it expires the leftovers, and the column
   * goes in a later migration once no row has it.
   */
  parkedUnclaimedAt: Date | null;
  /**
   * The request was created WITH a bill (lineup v3 L12): its act rows —
   * possibly none — are the proposed lineup. False for rows that predate
   * bills and for directions / intents that never carry one. The event mint
   * gives the pre-bill "sender headlines" fallback only to a FALSE request
   * with no act rows; a TRUE request with no live acts mints an empty lineup.
   */
  billRecorded: boolean;
  /**
   * Denormalized name of {@link BookingRequestRecordCommon.calendarId}, for
   * the venue inbox's calendar filter. Null when the request is unrouted, when
   * the calendar has since been deleted (SetNull), or on TO_PERFORMER rows —
   * so a null name never means "the calendar is called nothing".
   */
  calendarName: string | null;
  /**
   * The named Calendar this request routes to (venue-hierarchy FR-008).
   * Required app-side for TO_VENUE requests (defaulted when the place has one
   * calendar) but nullable here for TO_PERFORMER rows and pre-hierarchy data;
   * SetNull on calendar deletion, so treat null as "unrouted", never an error.
   */
  calendarId: string | null;
  /**
   * Polymorphic owner pair. TO_VENUE: the SENDER (organizer of the ask) —
   * the acts live in {@link BookingRequestActRecord} rows (lineup v2, D3b).
   * TO_PERFORMER: the target act. Null only for ANONYMOUS TO_VENUE embed inquiries
   * (booking-request-embed-button FR-005) until the submitter claims the
   * request. Prefer narrowing via {@link getBookingRequestSender} over reading
   * these directly.
   */
  performerOwnerType: PerformerOwnerType | null;
  performerOwnerId: string | null;
  // ── Anonymous sender contact (embed inquiries, 2026-07-13) ─────────────────
  /** Required (app-enforced) when the performer owner pair is null. */
  contactName: string | null;
  /**
   * Stored LOWERCASED at rest — the anonymous open-pair dedupe index
   * (`BookingRequest_open_anon_pair_key`) matches on `lower(email)`.
   */
  contactEmail: string | null;
  /** Submission provenance. Existing/platform rows default to "PLATFORM". */
  source: BookingRequestSource;
  /** Originating embed for EMBED submissions, when known. */
  embedId: string | null;
  // ── Invite-to-claim (FR-007) ────────────────────────────────────────────────
  /** Single-use claim token, hashed at rest (raw token lives only in email). */
  claimTokenHash: string | null;
  claimTokenExpiresAt: Date | null;
  /** Set when a signed-in performer claimed an anonymous request. */
  claimedAt: Date | null;
  // ── Venue → inquirer outreach (booking-inquirer-outreach, 2026-09-05) ──────
  /**
   * RFC 5322 `Message-ID` of the FIRST venue→inquirer thread email we sent for
   * this request. Every later send quotes it in `In-Reply-To` + `References`
   * so the whole booking reads as ONE chain in the inquirer's mailbox. Null
   * until the venue's first reply to an anonymous inquiry.
   */
  inquirerEmailMessageId: string | null;
  /**
   * Set when the provider told us the inquirer's `contactEmail` is
   * undeliverable (bounce/complaint, ingested by the Resend webhook).
   *
   * This column exists because the platform-wide deliverability state lives on
   * `AuthUser.emailDeliveryStatus`, and that flag is DELIBERATELY never set for
   * an unverified account (`PrismaEmailDeliverabilityAdapter`: an unverified
   * user may have fat-fingered their address at sign-up, and suppressing them
   * would lock them out forever). Every shadow minted for an inquirer is
   * unverified by construction, so without this column a bounced venue reply
   * would leave no trace anywhere the venue can see.
   */
  inquirerEmailUndeliverableAt: Date | null;
  /** Which provider signal stamped {@link inquirerEmailUndeliverableAt}. */
  inquirerEmailUndeliverableStatus: BookingInquirerEmailFailure | null;
  message: string;
  /** ISO `YYYY-MM-DD` date strings. */
  preferredDates: string[];
  expectedDraw: number | null;
  genre: string | null;
  /** LEGACY generic pitch links — superseded by the typed link* fields below. */
  links: string[];
  // ── Expanded pitch fields (2026-07-11) ────────────────────────────────────
  actName: string | null;
  lineupSize: number | null;
  setLengthMinutes: number | null;
  contactPhone: string | null;
  techNeeds: string | null;
  feeType: BookingFeeType | null;
  /** Integer cents, interpreted in `feeCurrency`. */
  feeAmountCents: number | null;
  /** ISO 4217 currency for `feeAmountCents` (platform base at create time). */
  feeCurrency: string | null;
  linkMusic: string | null;
  linkVideo: string | null;
  linkSocial: string | null;
  linkEpk: string | null;
  /**
   * Triage labels (venue-hierarchy FR-008). SENDER-supplied at create time
   * (part of the pitch payload, sanitized/deduped by
   * `normalizeBookingTags`); a venue-side edit surface may manage them
   * later, but nothing restricts them to venue authorship today. Empty
   * array = none.
   */
  tags: string[];
  /**
   * Venue-internal assignee (booking-holds FR-015) — the staff human working
   * this request and the notification target for challenge answers and
   * expiries. Plain id, no FK. Null = unassigned (human-owned venues: the
   * owner is implicitly assigned and the field stays null).
   */
  assigneeHumanId: string | null;
  /** See {@link BookingTaxFormStatus} — a flag only, never identity storage. */
  taxFormStatus: BookingTaxFormStatus;
  /**
   * Denormalized from BookingRequestMessage for inbox recency ordering
   * (booking-conversation FR-001; mirrors SupportThread.lastMessageAt). Null
   * until the thread's first message.
   */
  lastMessageAt: Date | null;
  status: BookingRequestStatus;
  viewedAt: Date | null;
  respondedAt: Date | null;
  declineReason: string | null;
  agreementId: string | null;
  /**
   * Server-sourced, point-in-time snapshot of the sender's whitelisted stats
   * (FR-009). Null unless the human sender opted in AND met the eligibility
   * threshold at create time. Never populated from client-supplied numbers.
   */
  verifiedStatsSnapshot: VerifiedStatsSnapshot | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Performer → venue request (the original flow). `placeId` is guaranteed;
 * the organizer/attach columns are structurally absent (null).
 */
export interface ToVenueBookingRequestRecord extends BookingRequestRecordCommon {
  direction: "TO_VENUE";
  placeId: string;
  organizerOrgId: null;
  organizerOrgName: null;
  attachedEventId: null;
  attachedEventTitle: null;
  attachedEventStartsAt: null;
}

/**
 * Organizer org → act request (organizer-booking-requests FR-001). Always
 * OWNED (the act pair is DB-required — the anonymous embed machinery never
 * applies), never venue-anchored (`placeId` null; an attached event's venue
 * feeds the minted Agreement instead), and never claimable (token columns
 * stay null for the row's whole life).
 */
export interface ToPerformerBookingRequestRecord
  extends BookingRequestRecordCommon {
  direction: "TO_PERFORMER";
  placeId: null;
  placeName: null;
  /** Calendars route VENUE inboxes; organizer→act requests are never routed. */
  calendarId: null;
  calendarName: null;
  organizerOrgId: string;
  performerOwnerType: PerformerOwnerType;
  performerOwnerId: string;
  contactName: null;
  contactEmail: null;
  claimTokenHash: null;
  claimTokenExpiresAt: null;
  claimedAt: null;
  /** Organizer→act rows are never anonymous, so no inquirer outreach exists. */
  inquirerEmailMessageId: null;
  inquirerEmailUndeliverableAt: null;
  inquirerEmailUndeliverableStatus: null;
  verifiedStatsSnapshot: null;
}

/**
 * Discriminated on `direction` (the spec's HIGH-risk mitigation): venue-side
 * consumers must narrow before touching `placeId`, so a TO_PERFORMER row can
 * never silently ride a venue path.
 */
export type BookingRequestRecord =
  | ToVenueBookingRequestRecord
  | ToPerformerBookingRequestRecord;

// ─────────────────────────────────────────────────────────────────────────────
// Sender union — narrow a flat record into owned vs anonymous
// ─────────────────────────────────────────────────────────────────────────────

/** A signed-in, on-platform sender (human or organization). */
export interface OwnedBookingRequestSender {
  kind: "owned";
  performerOwnerType: PerformerOwnerType;
  performerOwnerId: string;
}

/** An anonymous embed-inquiry sender, identified only by contact details. */
export interface AnonymousBookingRequestSender {
  kind: "anonymous";
  contactName: string;
  /** Lowercased at rest. */
  contactEmail: string;
}

export type BookingRequestSender =
  | OwnedBookingRequestSender
  | AnonymousBookingRequestSender;

/**
 * Is this row an embed inquiry whose sender has NOT proven their identity yet?
 *
 * The authoritative predicate for every DECISION that used to be spelled
 * `getBookingRequestSender(row).kind === "anonymous"`. The two stopped being
 * the same thing when venue→inquirer outreach started attaching a SHADOW owner
 * pair to unclaimed inquiries (booking-inquirer-outreach, 2026-09-05): the
 * owner pair now answers "who do we notify", while THIS answers "has a real
 * party attached themselves to this booking".
 *
 * Derived, never a stored flag (feedback: derived-state-never-a-stored-flag) —
 * both columns are written by exactly one path each:
 * - `contactEmail` is written ONLY by the anonymous create path and retained
 *   forever after, so non-null ⇔ "this row started life as an anonymous
 *   inquiry" (signed-in EMBED submissions, FR-010, are owned and leave it
 *   null);
 * - `claimedAt` is stamped ONLY by `BookingRequestsRepo.claim`, the
 *   token-proved redeem, so null ⇔ "nobody has proved control of that
 *   mailbox".
 *
 * Before the shadow-owner flip existed this returned exactly the same answer
 * as the anonymous sender narrowing, because the only writer of the owner pair
 * on a contact-bearing row was `claim`, which stamps `claimedAt` in the same
 * update. Every call site that swapped to it therefore kept its behaviour.
 *
 * Fail-CLOSED bias: anything that mints an Agreement, grants sender authority,
 * or spends a bearer token must treat `true` as "no real counterparty yet".
 */
export function isUnclaimedBookingInquiry(
  record: Pick<BookingRequestRecordCommon, "contactEmail" | "claimedAt">,
): boolean {
  // `!= null` / `== null`, NOT `!==` / `===`. A projection or a test fixture
  // that OMITS either field yields `undefined`, and strict equality would then
  // read an unclaimed inquiry as `false` — the unsafe direction for a
  // predicate whose whole job is a fail-closed bias. Test files are excluded
  // from every tsconfig, so the compiler will not catch such a fixture.
  return record.contactEmail != null && record.claimedAt == null;
}

/**
 * Narrow a booking-request record's flat sender columns into the
 * owned | anonymous union so use cases can exhaustively switch.
 *
 * Precedence: a populated performer owner pair wins — a CLAIMED anonymous
 * request (owner backfilled at claim time, FR-007) is treated as owned from
 * then on. Rows with neither identity violate the app-enforced invariant
 * (contact fields required when the owner pair is null) and throw.
 *
 * CAUTION (booking-inquirer-outreach, 2026-09-05): "owned" no longer implies
 * "a real party is on the hook". An UNCLAIMED inquiry the venue has replied to
 * carries a SHADOW owner pair so the reply has somewhere to go, and this lens
 * reports it as owned. Use {@link isUnclaimedBookingInquiry} — not this — for
 * any decision about accepting, minting, authorizing or displaying the sender
 * as a platform party.
 */
export function getBookingRequestSender(
  record: Pick<
    BookingRequestRecord,
    "performerOwnerType" | "performerOwnerId" | "contactName" | "contactEmail"
  >,
): BookingRequestSender {
  if (record.performerOwnerType !== null && record.performerOwnerId !== null) {
    return {
      kind: "owned",
      performerOwnerType: record.performerOwnerType,
      performerOwnerId: record.performerOwnerId,
    };
  }
  if (record.contactName !== null && record.contactEmail !== null) {
    return {
      kind: "anonymous",
      contactName: record.contactName,
      contactEmail: record.contactEmail,
    };
  }
  // Invariant violation (corrupt row), not a domain error — creation always
  // writes exactly one of the two identities.
  throw new Error(
    "booking_request_sender_invariant: row has neither a performer owner pair nor anonymous contact fields",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create inputs
// ─────────────────────────────────────────────────────────────────────────────

/** Pitch fields shared by owned and anonymous creation. */
export interface CreateBookingRequestRecordBaseInput {
  placeId: string;
  /**
   * Calendar routing (venue-hierarchy FR-008). Required app-side for
   * TO_VENUE creation — the use case resolves it (defaulting to the place's
   * single/default calendar) BEFORE the repo call; optional here only so
   * pre-hierarchy callers keep compiling until Step 4 wires the resolution.
   */
  calendarId?: string | null;
  message: string;
  preferredDates: string[];
  expectedDraw?: number | null;
  genre?: string | null;
  // ── Expanded pitch fields (2026-07-11) ────────────────────────────────────
  actName?: string | null;
  lineupSize?: number | null;
  setLengthMinutes?: number | null;
  contactPhone?: string | null;
  techNeeds?: string | null;
  feeType?: BookingFeeType | null;
  /** Integer cents, interpreted in `feeCurrency`. */
  feeAmountCents?: number | null;
  /** ISO 4217 currency for `feeAmountCents`. */
  feeCurrency?: string | null;
  linkMusic?: string | null;
  linkVideo?: string | null;
  linkSocial?: string | null;
  linkEpk?: string | null;
  /**
   * Triage labels (venue-hierarchy FR-008). SANITIZED + capped by the use
   * case before the repo call (trimmed, empties dropped, bounded count and
   * per-tag length) — the adapter writes them verbatim. Omitted = the
   * column's `@default([])` applies.
   */
  tags?: string[];
  // ── Intent + the room + the window (venue-confirmation spec) ──────────────
  /**
   * Defaults to PERFORM. RENT/USE REQUIRE the window — `requestedStartsAt` +
   * `requestedEndsAt` — by DB CHECK. The room is NOT required for any intent
   * (ruling 2026-09-22).
   */
  intent?: BookingIntent;
  /** Optional for every intent. Same-place membership is the use case's obligation (no FK guard). */
  spaceId?: string | null;
  requestedStartsAt?: Date | null;
  requestedEndsAt?: Date | null;
  /** Sanitized by the use case; ≤200 chars (column bound). */
  purpose?: string | null;
  expectedAttendance?: number | null;
  /** Event-first origin; must be an event the sender owns (use-case-verified). */
  originEventId?: string | null;
  /**
   * TRUE when this create records a bill (lineup v3 L12) — the signed-in
   * PERFORM create and the embed inquiry. Omitted = false (the column
   * default): event-first, RENT/USE.
   */
  billRecorded?: boolean;
  expiresAt: Date;
}

/** Signed-in, performer-owned creation (the existing PLATFORM path). */
export interface CreateBookingRequestRecordInput
  extends CreateBookingRequestRecordBaseInput {
  performerOwnerType: PerformerOwnerType;
  performerOwnerId: string;
  /** Server-built verified-stats snapshot (FR-009); null when not shared. */
  verifiedStatsSnapshot?: VerifiedStatsSnapshot | null;
  /** Defaults to "PLATFORM". Signed-in embed submissions (FR-010) pass "EMBED". */
  source?: BookingRequestSource;
  embedId?: string | null;
}

/**
 * Anonymous embed-inquiry creation (booking-request-embed-button FR-005).
 * No performer owner pair; the contact fields identify the sender.
 */
export interface CreateAnonymousBookingRequestRecordInput
  extends CreateBookingRequestRecordBaseInput {
  contactName: string;
  /**
   * MUST be lowercased by the caller before it reaches the repo — the
   * anonymous dedupe index matches on `lower(email)` and the column is
   * lowercased at rest by convention.
   */
  contactEmail: string;
  /** Anonymous rows only come from the embed widget. */
  source: "EMBED";
  embedId?: string | null;
}

/**
 * Organizer → act creation (organizer-booking-requests FR-003). Deliberately
 * a SEPARATE repo method (`createToPerformer`) from the TO_VENUE `create`
 * union, so the sender-identity narrowing there
 * ({@link isAnonymousBookingRequestCreateInput}) never has to reason about a
 * third shape. The adapter stamps `direction: "TO_PERFORMER"`,
 * `source: "PLATFORM"` and null venue/claim columns.
 */
export interface CreateOrganizerBookingRequestRecordInput {
  organizerOrgId: string;
  performerOwnerType: PerformerOwnerType;
  performerOwnerId: string;
  message: string;
  /** ISO `YYYY-MM-DD` date strings (1–3, schema-enforced upstream). */
  preferredDates: string[];
  setLengthMinutes?: number | null;
  feeType?: BookingFeeType | null;
  /** Integer cents, interpreted in `feeCurrency`. */
  feeAmountCents?: number | null;
  /** ISO 4217 currency for `feeAmountCents`. */
  feeCurrency?: string | null;
  /** Must be an event the sender org owns (use-case-verified). */
  attachedEventId?: string | null;
  expiresAt: Date;
}

/**
 * Narrow the repo `create` union to the anonymous variant.
 *
 * Validates the exactly-one-identity invariant instead of trusting property
 * presence: TS union excess-property rules allow an owned input value that
 * also carries `contactEmail` (or vice versa), and mis-narrowing such an
 * input would write a row with a null owner AND null contactName — poisoning
 * {@link getBookingRequestSender}. Throws on both-identities or
 * neither-identity inputs. NOTE: `source: "EMBED"` is NOT usable as the
 * discriminant — signed-in embed submissions (FR-010) are owned + EMBED.
 */
export function isAnonymousBookingRequestCreateInput(
  input:
    | CreateBookingRequestRecordInput
    | CreateAnonymousBookingRequestRecordInput,
): input is CreateAnonymousBookingRequestRecordInput {
  const hasOwner =
    "performerOwnerId" in input && input.performerOwnerId != null;
  const hasContact = "contactEmail" in input && input.contactEmail != null;
  if (hasOwner === hasContact) {
    throw new Error(
      "booking_request_create_input_invariant: exactly one sender identity required",
    );
  }
  return !hasOwner;
}

/**
 * Write/rotate the single active claim token on an ACCEPTED anonymous request
 * (booking-request-embed-button FR-007, NFR-003 single-active-token). Applied
 * as a guarded compare-and-swap: the row must still be in `expectedFrom` AND
 * still anonymous-unclaimed (`performerOwnerId IS NULL AND claimedAt IS
 * NULL`) at write time, so a concurrent claim can never have its token
 * resurrected by a racing resend. Rotation simply overwrites the previous
 * hash — the old link dies.
 */
export interface SetBookingRequestClaimTokenInput {
  id: string;
  /** sha256 hex of the raw token — the raw token NEVER reaches the repo. */
  claimTokenHash: string;
  claimTokenExpiresAt: Date;
  /** Status CAS guard, same semantics as {@link UpdateBookingRequestStatusInput.expectedFrom}. */
  expectedFrom: readonly BookingRequestStatus[];
}

/**
 * Redeem a claim token: backfill the performer owner pair onto an anonymous
 * ACCEPTED request, stamp `claimedAt`, and NULL the token columns (single
 * use). Guarded compare-and-swap on `claimTokenHash` still matching
 * `expectedClaimTokenHash` (plus `claimedAt IS NULL` and status ACCEPTED), so
 * two concurrent redeems produce exactly one winner; the loser's write
 * matches zero rows and the adapter throws
 * `{ code: "conflict", message: "booking_request_already_claimed" }`.
 */
export interface ClaimBookingRequestRecordInput {
  id: string;
  /** The sha256 hex hash the caller looked the row up by. */
  expectedClaimTokenHash: string;
  performerOwnerType: PerformerOwnerType;
  performerOwnerId: string;
  claimedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Venue → inquirer outreach (booking-inquirer-outreach, 2026-09-05)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach a SHADOW performer owner pair to an unclaimed anonymous inquiry so a
 * venue reply has a reachable identity to address (see
 * `BookingRequestsRepo.attachInquirerOwner`).
 */
export interface AttachInquirerOwnerInput {
  id: string;
  performerOwnerType: PerformerOwnerType;
  /** The shadow Human minted from `contactEmail` (`humans.ensureGuestHuman`). */
  performerOwnerId: string;
}

/** Record the FIRST outbound thread email's Message-ID (see the repo doc). */
export interface SetInquirerEmailMessageIdInput {
  id: string;
  /** Bare RFC 5322 msg-id WITHOUT the angle brackets. */
  messageId: string;
}

/** Bounce/complaint fan-in from the provider webhook (see the repo doc). */
export interface MarkInquirerEmailUndeliverableInput {
  /** MUST be lowercased by the caller — `contactEmail` is lowercased at rest. */
  contactEmail: string;
  status: BookingInquirerEmailFailure;
  /** Provider-reported occurrence time; the stamp never moves backwards. */
  at: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachments (venue-hierarchy FR-008)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * File attached to a booking request (rider, stage plot, tech spec).
 * References the stored object by `storageKey` — there is no stored-object
 * row table; object bytes are GC'd via the PendingObjectDeletion outbox when
 * rows are soft-deleted (mirrors PlaceVerificationDocument).
 */
export interface BookingRequestAttachmentRecord {
  id: string;
  bookingRequestId: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /**
   * Which thread side uploaded the file. The DB column reuses the 3-value
   * `BookingMessageAuthorSide` enum, but SYSTEM never uploads — the write path
   * only ever stamps VENUE | PERFORMER (app-level guarantee; the adapter maps
   * an out-of-contract SYSTEM value to `null` rather than leaking it). Null on
   * rows created before the uploader columns existed (migration
   * booking_request_attachment_uploader) — the delete posture treats those as
   * venue-managed (only the venue may delete them).
   */
  uploadedBySide: BookingThreadSide | null;
  /**
   * The human who uploaded the file, when known. Plain id, no FK (mirrors
   * `BookingRequestMessage.authorHumanId`). Null on legacy rows.
   */
  uploadedByHumanId: string | null;
  // ── P3b (asks) ──
  /**
   * The ask this file was uploaded to answer (venue-booking-standards v1.1
   * FR-009a), or null for a loose "Attach a file" upload.
   */
  askId: string | null;
  /** Soft-delete stamp — see `BookingRequestsRepo.softDeleteAttachment`. */
  deletedAt: Date | null;
  createdAt: Date;
}

export interface AddBookingRequestAttachmentInput {
  bookingRequestId: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** See {@link BookingRequestAttachmentRecord.uploadedBySide} — never SYSTEM. */
  uploadedBySide: BookingThreadSide;
  uploadedByHumanId?: string | null;
  // ── P3b (asks) ── the ask the file answers (FR-009a); omit/null = none.
  askId?: string | null;
}

/**
 * Soft-delete an attachment. `bookingRequestId` is REQUIRED and goes in the
 * adapter's WHERE clause (not just an assert) — the row is only touched when
 * it belongs to that request, so a forged/leaked attachment id from another
 * request matches zero rows (IDOR backstop, same WHERE-scoping discipline as
 * the CAS-guarded methods above).
 */
export interface SoftDeleteBookingRequestAttachmentInput {
  id: string;
  bookingRequestId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The bill (lineup-booking-requests v2, FR-001, docs/specs/2026-09-25)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where an act on the bill came from. SELF = the sender's own act (the
 * request's owner pair, human OR org); TAGGED = a platform act the sender
 * tagged — a human, or since v3 (L17) a group (org) — notified, joins or
 * passes; EXTERNAL = free text.
 */
export type BookingRequestActSource = "SELF" | "TAGGED" | "EXTERNAL";

/**
 * Consent state of an act. SELF / EXTERNAL rows are CONFIRMED at insert
 * (SQL CHECK "BookingRequestAct_pending_only_tagged_check"); only TAGGED rows
 * sit PENDING. DECLINED is terminal on that request.
 */
export type BookingRequestActConfirmation = "PENDING" | "CONFIRMED" | "DECLINED";

/** EventHuman's role vocabulary, reused for acts on a bill. */
export type BookingRequestActRole = EventHumanRole;

/**
 * One act on a request's bill. Shape by `source` is DB-enforced
 * ("BookingRequestAct_source_shape_check"): SELF/TAGGED carry the owner pair
 * ("human" | "organization" — a TAGGED group since v3 L17) and no
 * `externalName`; EXTERNAL carries `externalName` and a null owner pair. Kept
 * flat (not a union) to mirror the row; readers switch on `source`.
 */
export interface BookingRequestActRecord {
  id: string;
  bookingRequestId: string;
  source: BookingRequestActSource;
  /** Plain id pair, no FK (mirrors `BookingRequestMessage.authorHumanId`). */
  actOwnerType: PerformerOwnerType | null;
  actOwnerId: string | null;
  externalName: string | null;
  externalUrl: string | null;
  role: BookingRequestActRole;
  /**
   * Free-text label when `role` is OTHER; null otherwise (SQL CHECK
   * "BookingRequestAct_custom_role_label_check"). v3 L13.
   */
  customRoleLabel: string | null;
  /** 0 = headliner. */
  sortOrder: number;
  confirmation: BookingRequestActConfirmation;
  invitedAt: Date | null;
  respondedAt: Date | null;
  declineReason: string | null;
  /**
   * Soft remove by the sender (v3 FR-001). Bill reads return only rows with
   * `removedAt === null` unless the caller passes `includeRemoved`.
   */
  removedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CreateBookingRequestActBase {
  /** Defaults to PERFORMER. */
  role?: BookingRequestActRole;
  /**
   * Label for role OTHER (≤ 60, already sanitized). Core passes null for any
   * other role — the SQL CHECK refuses a label beside a non-OTHER role.
   */
  customRoleLabel?: string | null;
  /**
   * 0 = headliner. Core MUST assign DISTINCT values per request: the adapter's
   * ordering beyond `sortOrder` (createdAt, then id) is deterministic but not
   * the caller's insert order.
   */
  sortOrder: number;
}

/**
 * One act to insert with `BookingRequestsRepo.addActs`, discriminated by
 * source. The confirmation state is NOT caller-chosen: SELF/EXTERNAL insert
 * CONFIRMED, TAGGED inserts PENDING (the adapter stamps it).
 */
export type CreateBookingRequestActInput =
  | (CreateBookingRequestActBase & {
      /**
       * The sender's own act. Carries NO owner fields on purpose: the adapter
       * copies the request row's own `performerOwnerType/Id` (read on the same
       * client), so a SELF row can never name anyone but the sender.
       */
      source: "SELF";
    })
  | (CreateBookingRequestActBase & {
      /**
       * A tagged platform act — a human, or (v3 L17) a group. Core rejects
       * tagging the SENDER (the sender goes on the bill as SELF, never as a
       * TAGGED invite to themselves) and non-taggable acts
       * (ACT_NOT_TAGGABLE) before this.
       */
      source: "TAGGED";
      actOwnerType: PerformerOwnerType;
      actOwnerId: string;
      /** When the tag notification is (about to be) sent. */
      invitedAt?: Date | null;
    })
  | (CreateBookingRequestActBase & {
      source: "EXTERNAL";
      /** Already sanitized + ≤ 120 chars (core's plainTextRequired). */
      externalName: string;
      /** Already validated http(s) (core's optionalHttpUrl). */
      externalUrl?: string | null;
    });

/**
 * The platform-act unique key (bookingRequestId, actOwnerType, actOwnerId).
 * Reads and writes of a single act go through it — never a bare act id — so
 * an act is only ever reachable by naming its OWNER (IDOR backstop).
 */
export interface BookingRequestActOwnerKey {
  bookingRequestId: string;
  actOwnerType: PerformerOwnerType;
  actOwnerId: string;
}

/**
 * Tagged human answers their spot (FR-003). The row is addressed by its
 * owner key — the caller passes the ACTING human as `actOwnerId`, so another
 * human's id matches zero rows. Compare-and-swap on `confirmation =
 * expectedFrom` in the same WHERE: a concurrent answer (or a wrong owner, or a
 * missing row) makes the write a no-op and the adapter throws
 * `{ code: "conflict", message: "booking_request_act_state_changed" }`.
 *
 * Transitions core drives through it: PENDING → CONFIRMED | DECLINED (the
 * answer), and CONFIRMED → DECLINED (consent withdrawn before any event was
 * minted from the request — `declineBookingRequestAct`). Which transitions
 * are LEGAL is core's rule; the adapter only enforces the CAS.
 */
export interface SetBookingRequestActConfirmationInput {
  bookingRequestId: string;
  /**
   * The TAGGED row's owner type. `"organization"` since v3 L17 — core then
   * passes the GROUP's id below after checking the acting human holds an org
   * edit role on it; the adapter only matches the key.
   */
  actOwnerType: PerformerOwnerType;
  /** The tagged act: the acting human, or the group they answer for. */
  actOwnerId: string;
  expectedFrom: "PENDING" | "CONFIRMED";
  to: "CONFIRMED" | "DECLINED";
  respondedAt: Date;
  /** DECLINED only; ≤ 240 chars, already sanitized. Ignored for CONFIRMED. */
  declineReason?: string | null;
}

/**
 * An anonymous inquiry was claimed (booking-request-embed-button FR-007) and
 * the request now HAS a sender pair: the inquiry's own act — the EXTERNAL row
 * the inquiry form wrote from its `actName` — becomes the claimant's SELF row
 * (lineup v2). `actId` names the row core chose; the adapter scopes the write
 * by `bookingRequestId` and `source = EXTERNAL` as well, and copies the owner
 * pair off the REQUEST ROW (never the caller), exactly like a SELF insert.
 */
export interface PromoteBookingRequestActToSelfInput {
  bookingRequestId: string;
  actId: string;
}

/**
 * Read options for the bill readers (`listActsForRequests`,
 * `getActForOwner`). Default: live rows only (`removedAt IS NULL`, v3
 * FR-001). `includeRemoved: true` adds the sender-removed rows — for the few
 * callers that must see them: the bill edit's "is this identity already on
 * the request?" dedupe (a removed row still holds the unique key) and the
 * ledger naming what was removed.
 */
export interface ListBookingRequestActsOptions {
  includeRemoved?: boolean;
}

// ── Bill editing (lineup v3 FR-009) ──────────────────────────────────────────
// Sender-side writes address an act by its ID, scoped by `bookingRequestId`
// in the WHERE (a foreign or unknown id matches zero rows). Authority (the
// sender pair) and the "no event yet" lock are core's; the adapter enforces
// only the scope and the row state. Call on the tx client after
// `lockBill`, like every other bill write.

/**
 * Take one LIVE act off the bill: stamps `removedAt = at`. Any source (SELF
 * can be removed, FR-009). The row keeps its unique key and its
 * confirmation. Zero matched rows (unknown id, another request's act, already
 * removed) → `{ code: "conflict", message: "booking_request_act_state_changed" }`.
 */
export interface SoftRemoveBookingRequestActInput {
  bookingRequestId: string;
  actId: string;
  at: Date;
}

/**
 * Put a removed act back (FR-009 "SELF can be removed and re-added"; also a
 * re-tag of an act the sender removed while it was invited or joined). A
 * re-add cannot INSERT: the removed row still holds the (request, ownerType,
 * ownerId) key. The adapter clears `removedAt`, sets `sortOrder`, and
 * stamps consent exactly as an insert would — SELF / EXTERNAL stay
 * CONFIRMED; TAGGED goes back to PENDING with `respondedAt` and
 * `declineReason` cleared and `invitedAt` set (consent is asked again: the
 * bill they agreed to is not the bill they are re-added to).
 *
 * A DECLINED row is never restorable (a pass is final, L14) — it matches
 * zero rows. Zero matched rows (unknown id, another request's, not removed,
 * DECLINED) → `{ code: "conflict", message: "booking_request_act_state_changed" }`.
 */
export interface RestoreBookingRequestActInput {
  bookingRequestId: string;
  actId: string;
  sortOrder: number;
  /** TAGGED only: when the fresh invite is (about to be) sent. */
  invitedAt?: Date | null;
}

/**
 * Rewrite the order of the LIVE bill: `orderedActIds[i]` gets `sortOrder = i`
 * (0 = headliner). Must name every live act on the request exactly once —
 * anything else (a missing, extra, duplicated, removed or foreign id) means
 * the caller planned against a stale bill and throws
 * `{ code: "conflict", message: "booking_request_bill_changed" }` before any
 * write. Removed rows keep their old sortOrder (nobody reads it).
 */
export interface SetBookingRequestActSortOrdersInput {
  bookingRequestId: string;
  orderedActIds: readonly string[];
}

/**
 * Change a LIVE act's role (L13). `customRoleLabel` must be null unless
 * `role` is OTHER (SQL CHECK; core nulls it). Zero matched rows →
 * `{ code: "conflict", message: "booking_request_act_state_changed" }`.
 */
export interface SetBookingRequestActRoleInput {
  bookingRequestId: string;
  actId: string;
  role: BookingRequestActRole;
  customRoleLabel: string | null;
}

/**
 * Rewrite a request's display `actName` (lineup v3 FR-009 / NFR-002). `null`
 * = no pitch name: readers name the sender. Already sanitized and bounded by
 * core (the column's 120).
 */
export interface SetBookingRequestActNameInput {
  id: string;
  actName: string | null;
}

/** Result of `BookingRequestsRepo.softDeleteAttachment` — see the port doc. */
export interface SoftDeleteBookingRequestAttachmentResult {
  record: BookingRequestAttachmentRecord;
  /**
   * true iff THIS call stamped `deletedAt` (the scoped updateMany matched a
   * live row). false = the row was already soft-deleted (idempotent repeat).
   * Callers enqueue `record.storageKey` on the PendingObjectDeletion outbox
   * ONLY when this is true — otherwise a repeat call double-enqueues the GC.
   */
  didStamp: boolean;
}

/**
 * Set or clear the venue-internal assignee (booking-holds FR-015). Not
 * status-guarded — assignment is a workflow field that may change on a
 * request in any state; edit-role membership of the assignee is validated in
 * core (`assign-booking-request`), never here.
 */
export interface SetBookingRequestAssigneeInput {
  id: string;
  assigneeHumanId: string | null;
}

export interface UpdateBookingRequestStatusInput {
  id: string;
  status: BookingRequestStatus;
  /**
   * Compare-and-swap guard: the transition is only applied when the row's
   * current status is one of these. A concurrent transition that already
   * moved the row elsewhere makes the write a no-op and the adapter throws
   * `{ code: "conflict", message: "booking_request_status_changed" }`.
   */
  expectedFrom: readonly BookingRequestStatus[];
  respondedAt?: Date | null;
  declineReason?: string | null;
  agreementId?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── P3b (asks) ── venue-booking-standards v1.1, V9–V11, FR-009b
// ─────────────────────────────────────────────────────────────────────────────

/** What an ask asks for — and so which answer column it takes. */
export type BookingRequestAskKind =
  | "IMAGE"
  | "FILE"
  | "LINK"
  | "TEXT"
  | "SET_LENGTH";

export const BOOKING_REQUEST_ASK_KINDS = [
  "IMAGE",
  "FILE",
  "LINK",
  "TEXT",
  "SET_LENGTH",
] as const satisfies readonly BookingRequestAskKind[];

/** OPEN until answered; ANSWERED may be answered again; WITHDRAWN is final. */
export type BookingRequestAskStatus = "OPEN" | "ANSWERED" | "WITHDRAWN";

/**
 * A venue's ask on a booking thread with the sender's saved answer. Exactly
 * one answer column is meaningful per kind (DB CHECK
 * "BookingRequestAsk_answer_shape_check"): IMAGE / FILE →
 * `answerAttachmentId`, LINK → `answerUrl`, TEXT → `answerText`,
 * SET_LENGTH → `answerMinutes`.
 */
export interface BookingRequestAskRecord {
  id: string;
  bookingRequestId: string;
  kind: BookingRequestAskKind;
  /** The venue's wording, plain text, ≤ 80. */
  label: string;
  /** Optional venue note, plain text, ≤ 240. */
  note: string | null;
  /** The standard the ask came from ("Ask for…" suggestions), if any. */
  standardField: BookingStandardField | null;
  /** IMAGE only: copy the answer into the event as its hero (V10). */
  useAsEventImage: boolean;
  status: BookingRequestAskStatus;
  askedByHumanId: string;
  askedAt: Date;
  answerAttachmentId: string | null;
  answerUrl: string | null;
  answerText: string | null;
  answerMinutes: number | null;
  answeredByHumanId: string | null;
  answeredAt: Date | null;
  /** Optimistic version of the answer; bumped by every answer. */
  answerRevision: number;
  withdrawnByHumanId: string | null;
  withdrawnAt: Date | null;
  /** The event the IMAGE answer was copied into (V10), and its Image row. */
  eventImageEventId: string | null;
  eventImageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBookingRequestAskInput {
  bookingRequestId: string;
  kind: BookingRequestAskKind;
  label: string;
  note: string | null;
  standardField: BookingStandardField | null;
  useAsEventImage: boolean;
  askedByHumanId: string;
  askedAt: Date;
}

/**
 * Save (or replace) an ask's answer. CAS: the row matches only while
 * `(id, bookingRequestId)` hold, status is OPEN or ANSWERED and
 * `answerRevision === expectedRevision`. Every answer column not named by
 * `answer` is cleared. Zero rows → `null` (the caller re-reads to say why).
 */
export interface AnswerBookingRequestAskInput {
  id: string;
  bookingRequestId: string;
  expectedRevision: number;
  answer:
    | { kind: "attachment"; attachmentId: string }
    | { kind: "url"; url: string }
    | { kind: "text"; text: string }
    | { kind: "minutes"; minutes: number };
  answeredByHumanId: string;
  answeredAt: Date;
}

/** OPEN → WITHDRAWN. CAS on status OPEN; zero rows → `null`. */
export interface WithdrawBookingRequestAskInput {
  id: string;
  bookingRequestId: string;
  withdrawnByHumanId: string;
  withdrawnAt: Date;
}

/**
 * Record the V10 image mapping. CAS: matches only while the ask is ANSWERED
 * with `answerAttachmentId === attachmentId` AND `eventImageEventId` is not
 * already `eventId` (one copy per (ask, event)). Returns whether THIS call
 * stamped it.
 */
export interface StampBookingRequestAskEventImageInput {
  id: string;
  /** In the WHERE too (IDOR backstop, like every ask CAS). */
  bookingRequestId: string;
  attachmentId: string;
  eventId: string;
  imageId: string;
}
