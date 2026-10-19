import type { ReviewAggregateSubjectType } from "./review-aggregates";

/**
 * Provenance of an attendee review (venue-rating-block-and-owner-optin FR-009).
 * VERIFIED_TICKET = scanned-ticket-only verified path; COMMUNITY = unverified,
 * venue-direct cold-start path (no event, name/unverified email).
 */
export type AttendeeReviewSource = "VERIFIED_TICKET" | "COMMUNITY";

export interface AttendeeReviewRecord {
  id: string;
  /** Null for COMMUNITY (venue-direct) reviews — they anchor to placeId only. */
  eventId: string | null;
  /** Null for not-signed-in COMMUNITY guests (see anonymousName/anonymousEmail). */
  humanId: string | null;
  /** COMMUNITY guest name (mirrors PlaceReview seed pattern). */
  anonymousName: string | null;
  /** COMMUNITY guest email — REQUIRED-but-unverified, PII (SAR/deletion covered). */
  anonymousEmail: string | null;
  /** VERIFIED_TICKET | COMMUNITY (FR-009). */
  source: AttendeeReviewSource;
  overallRating: number;
  soundQuality: number | null;
  venueComfort: number | null;
  organization: number | null;
  valueForMoney: number | null;
  /** PRIVATE organizer-facing comment — never on any public surface. */
  text: string | null;
  // Denormalized aggregation targets, stamped from the event at submit time.
  placeId: string | null;
  ownerType: string | null;
  ownerId: string | null;
  seriesId: string | null;
  // Moderation.
  hidden: boolean;
  flagged: boolean;
  flagReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAttendeeReviewInput {
  eventId: string;
  humanId: string;
  overallRating: number;
  soundQuality?: number | null;
  venueComfort?: number | null;
  organization?: number | null;
  valueForMoney?: number | null;
  text?: string | null;
  placeId?: string | null;
  ownerType?: string | null;
  ownerId?: string | null;
  seriesId?: string | null;
}

/**
 * UNVERIFIED, venue-direct COMMUNITY review (FR-009). Anchors to placeId only:
 * no eventId, no owner/series rollup. `humanId` for a signed-in submitter, else
 * anonymousName/anonymousEmail for a guest. Always persisted with
 * `source = COMMUNITY`.
 */
export interface CreateCommunityAttendeeReviewInput {
  placeId: string;
  humanId?: string | null;
  anonymousName?: string | null;
  anonymousEmail?: string | null;
  overallRating: number;
  soundQuality?: number | null;
  venueComfort?: number | null;
  organization?: number | null;
  valueForMoney?: number | null;
  text?: string | null;
}

/** An event at a place the viewer is a candidate to leave a VERIFIED review for. */
export interface PlaceReviewableEventCandidate {
  eventId: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  status: string;
}

/**
 * The minimal per-review shape the aggregation pipeline consumes (a subset of
 * AttendeeReviewRecord). `reviewerKey` is the DISTINCT-reviewer gating key — the
 * humanId for a signed-in reviewer, or the row id for an anonymous COMMUNITY
 * guest (so each guest counts once). `source` drives the FR-010 verified vs
 * community split — the two buckets are aggregated + suppressed SEPARATELY.
 */
export interface AttendeeReviewAggRow {
  reviewerKey: string;
  source: AttendeeReviewSource;
  overallRating: number;
  soundQuality: number | null;
  venueComfort: number | null;
  organization: number | null;
  valueForMoney: number | null;
}

export interface ListAttendeeReviewSubjectIdsInput {
  subjectType: ReviewAggregateSubjectType;
  limit: number;
  /** Cursor: return subjectIds strictly greater than this (ascending order). */
  afterSubjectId?: string;
}

/**
 * Verified attendee reviews (attendee-reviews FR-001/FR-002). Submit + the
 * aggregation/feedback/moderation surfaces (FR-004/FR-007/FR-009).
 */
export interface AttendeeReviewsRepo {
  /**
   * Insert one review. A P2002 on the (eventId, humanId) unique index maps
   * to AppError ATTENDEE_REVIEW_ALREADY_SUBMITTED in the adapter — the race
   * backstop behind the use case's pre-check.
   */
  create(input: CreateAttendeeReviewInput): Promise<AttendeeReviewRecord>;

  /**
   * Insert an UNVERIFIED, venue-direct COMMUNITY review (FR-009). Fully open —
   * no unique-index race to map (community rows carry a null eventId, so the
   * (eventId, humanId) index never binds them).
   */
  createCommunityReview(
    input: CreateCommunityAttendeeReviewInput,
  ): Promise<AttendeeReviewRecord>;

  getById(id: string): Promise<AttendeeReviewRecord | null>;

  findByEventAndHuman(input: {
    eventId: string;
    humanId: string;
  }): Promise<AttendeeReviewRecord | null>;

  /**
   * Whether the human owns at least one SCANNED ticket for the event — the
   * verified-attendance eligibility gate (FR-001, NFR-002). Lives here (not
   * on TicketsRepo) to keep this feature's blast radius local; fold into
   * TicketsRepo if a second consumer appears.
   */
  hasScannedTicket(input: {
    eventId: string;
    humanId: string;
  }): Promise<boolean>;

  // ── Aggregation (FR-004) ─────────────────────────────────────────────────

  /**
   * Distinct subjectIds of the given type that have at least one NON-HIDDEN
   * review, ascending, cursor-paginated via `afterSubjectId`. Drives the full
   * recompute sweep. EVENT → eventId; PLACE → non-null placeId; OWNER →
   * non-null ownerId; SERIES → non-null seriesId.
   */
  listSubjectIdsWithReviews(
    input: ListAttendeeReviewSubjectIdsInput,
  ): Promise<string[]>;

  /**
   * The minimal aggregation rows for one subject — every NON-HIDDEN review
   * whose denormalized target matches (subjectType, subjectId). Feeds the
   * anonymization policy; carries no text or identity beyond humanId.
   */
  listAggRowsForSubject(input: {
    subjectType: ReviewAggregateSubjectType;
    subjectId: string;
  }): Promise<AttendeeReviewAggRow[]>;

  // ── Organizer feedback + moderation (FR-007 / FR-009) ────────────────────

  /**
   * All NON-HIDDEN reviews for one event, newest first. Powers the OWNER-scoped
   * feedback read (exact aggregate + unattributed text list) — the use case
   * strips identity/timestamps before returning anything.
   */
  listForEventFeedback(eventId: string): Promise<AttendeeReviewRecord[]>;

  /**
   * All NON-HIDDEN reviews for one PLACE (verified + community), newest first.
   * Powers the venue-owner private feedback read (FR-006): the use case splits
   * by source, computes the per-source exact aggregates, and returns
   * unattributed text entries.
   */
  listForPlaceFeedback(placeId: string): Promise<AttendeeReviewRecord[]>;

  /**
   * Events AT a place the given human is a candidate to leave a VERIFIED review
   * for (FR-003 upsell): non-cancelled events where the human owns a SCANNED
   * ticket and has NOT already reviewed. Window/ended checks are applied by the
   * use case (mirrors get-attendee-review-eligibility).
   */
  listReviewableEventCandidatesForPlace(input: {
    placeId: string;
    humanId: string;
  }): Promise<PlaceReviewableEventCandidate[]>;

  /** Sets the moderation `flagged`/`flagReason` fields (owner report action). */
  setFlagged(input: {
    reviewId: string;
    flagged: boolean;
    flagReason: string | null;
  }): Promise<AttendeeReviewRecord>;

  /** Sets the moderation `hidden` field (staff hide action). */
  setHidden(input: {
    reviewId: string;
    hidden: boolean;
  }): Promise<AttendeeReviewRecord>;
}
