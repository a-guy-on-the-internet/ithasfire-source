import type { EventStatus } from "@th/types/repos/events";

export type PostEventPromptAudience = "PERFORMER" | "ATTENDEE";
export type PostEventPromptStatus = "PENDING" | "SENT" | "FAILED";

export interface PostEventPromptRecord {
  id: string;
  eventId: string;
  humanId: string;
  /** Denormalized review-target place (the gig's venue) for PERFORMER rows. */
  placeId: string | null;
  audience: PostEventPromptAudience;
  status: PostEventPromptStatus;
  attempts: number;
  sentAt: Date | null;
  createdAt: Date;
}

export interface EnqueuePostEventPromptInput {
  eventId: string;
  humanId: string;
  placeId?: string | null;
  audience: PostEventPromptAudience;
}

/**
 * A completed platform gig eligible for PERFORMER prompts: an ACCEPTED
 * BookingRequest whose Agreement's event has ended (weave FR-009). The
 * adapter query already excludes CANCELLED/DRAFT/ARCHIVED events (status IN
 * PUBLISHED|COMPLETED); `eventStatus` is still surfaced so the use case can
 * belt-and-braces re-check.
 */
export interface PerformerGigCandidate {
  bookingRequestId: string;
  eventId: string;
  eventStatus: EventStatus;
  eventEndsAt: Date;
  /** The venue the request was pitched to — the review target. */
  placeId: string | null;
  /** Polymorphic sender pair ("human" | "organization"); null for anonymous. */
  performerOwnerType: string | null;
  performerOwnerId: string | null;
  /**
   * Registered lineup humans on the linked event (EventHuman rows with
   * role=PERFORMER and a non-null humanId). For org/band senders this is the
   * only reliable per-human performer identity we have.
   */
  lineupHumanIds: string[];
}

/** An ended event with at least one SCANNED ticket (attendee FR-006). */
export interface AttendeeEventCandidate {
  eventId: string;
  eventStatus: EventStatus;
  placeId: string | null;
}

/**
 * The SHARED post-event prompt outbox (booking-review-data-weave WS3 +
 * attendee-reviews FR-006). Daily sweeps enqueue PENDING rows per audience;
 * a dispatch job drains them through the notify pipeline. The
 * (eventId, humanId, audience) unique index is the idempotency anchor —
 * enqueue inserts with skip-duplicates, so re-running a sweep is a no-op.
 *
 * The candidate queries live HERE (not on the tickets / booking-requests
 * repos) deliberately: they are prompt-specific joins with zero other
 * consumers, and keeping them local avoids widening long-standing repo
 * interfaces (and their many test fakes) for one feature.
 */
export interface PostEventPromptsRepo {
  /**
   * Bulk-insert prompts, silently skipping rows that collide with the
   * (eventId, humanId, audience) unique index. Returns the number of rows
   * actually created.
   */
  createManySkipExisting(
    inputs: EnqueuePostEventPromptInput[],
  ): Promise<number>;

  /**
   * PENDING prompts for the given audiences, oldest first, capped at
   * `limit`. Filtering by audience happens IN THE QUERY so dispatch-gated
   * audiences (ATTENDEE until its review form ships) can never starve the
   * batch. `FOR UPDATE SKIP LOCKED` claim in the adapter, mirroring the
   * rsvp-notices repo, so overlapping drain runs never double-process.
   */
  listPending(input: {
    limit: number;
    audiences: PostEventPromptAudience[];
  }): Promise<PostEventPromptRecord[]>;

  /** Flip prompts to SENT at `at`. No-op on an empty array. */
  markSent(ids: string[], at: Date): Promise<void>;

  /**
   * Dead-letter prompts (send exhausted its attempts, or the event/place
   * vanished before dispatch). No-op on an empty array.
   */
  markFailed(ids: string[]): Promise<void>;

  /** Bump `attempts` on the given prompts. No-op on an empty array. */
  incrementAttempts(ids: string[]): Promise<void>;

  /**
   * ACCEPTED booking requests whose agreement's event ended inside
   * (endedAfter, endedBefore], event status PUBLISHED | COMPLETED (weave
   * FR-009; CANCELLED excluded per the spec's cancelled-gig risk).
   */
  listPerformerGigCandidates(input: {
    endedAfter: Date;
    endedBefore: Date;
  }): Promise<PerformerGigCandidate[]>;

  /**
   * Events that ended inside (endedAfter, endedBefore], status PUBLISHED |
   * COMPLETED, with at least one SCANNED ticket (attendee FR-006).
   */
  listAttendeeEventCandidates(input: {
    endedAfter: Date;
    endedBefore: Date;
  }): Promise<AttendeeEventCandidate[]>;

  /** Distinct owner humanIds of SCANNED tickets for an event. */
  scannedTicketHolderHumanIds(eventId: string): Promise<string[]>;

  /**
   * HumanIds that already hold a prompt (any status) for the event in the
   * given audience. Used by the attendee sweep to enforce audience
   * precedence: a human with a PERFORMER prompt never also gets an ATTENDEE
   * one (attendee-reviews prompt-fatigue mitigation).
   */
  humanIdsWithPrompt(input: {
    eventId: string;
    audience: PostEventPromptAudience;
  }): Promise<string[]>;

  /**
   * Whether a prompt (any status) already exists for the exact
   * (eventId, humanId, audience) triple. The dispatch drain uses it to
   * re-check attendee/performer precedence AT SEND TIME: a human who also
   * holds a PERFORMER prompt for the event must never receive the ATTENDEE
   * one, even when late lineup edits create both rows across separate enqueue
   * runs (the enqueue-time check only covers a single run's ordering).
   */
  existsForAudience(input: {
    eventId: string;
    humanId: string;
    audience: PostEventPromptAudience;
  }): Promise<boolean>;
}
