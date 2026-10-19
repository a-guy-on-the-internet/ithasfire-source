/**
 * Invite complaint auto-pause (W4, owner ruling 2026-10-06): spam complaints
 * on personal invite emails, and the per-organiser pause they can trip.
 *
 * The organiser is the event OWNER: an org, or the human who owns
 * person-owned events (same shape as the invite opt-out owner).
 *
 * The address is never stored or passed here: core hands over
 * `hashInviteOptOutEmail(canonical address)`, the same keyed hash the
 * opt-out list uses.
 *
 * The trip rule lives in core. This repo only gives it the pieces, and core
 * runs them in ONE `repos.tx` after {@link EventInvitePausesRepo.lockOwner}.
 */
import type { EventInviteOptOutOwner } from "./event-invite-opt-outs";

export type EventInvitePauseOwner = EventInviteOptOutOwner;

export type EventInvitePauseReason = "COMPLAINT_COUNT" | "COMPLAINT_RATE";
export type EventInvitePauseDecision = "LIFTED" | "KEPT";

export type EventInvitePauseRecord = {
  id: string;
  owner: EventInvitePauseOwner;
  reason: EventInvitePauseReason;
  complaintCount: number;
  recipientCount: number;
  pausedAt: Date;
  reviewRequestedAt: Date | null;
  reviewRequestNote: string | null;
  decision: EventInvitePauseDecision | null;
  decidedAt: Date | null;
  decidedByHumanId: string | null;
  decisionNote: string | null;
  liftedAt: Date | null;
};

/** A pause row for the staff queue, with the organiser's display name. */
export type EventInvitePauseListItem = EventInvitePauseRecord & {
  ownerName: string | null;
};

/**
 * Staff queue filters:
 *  - AWAITING_REVIEW: open, with a review request (oldest request first);
 *  - OPEN: every open pause (oldest first, so a page cut drops the newest);
 *  - LIFTED: closed history (newest lift first).
 */
export type EventInvitePauseListStatus = "AWAITING_REVIEW" | "OPEN" | "LIFTED";

export interface EventInvitePausesRepo {
  /**
   * Transaction-scoped advisory lock on one owner (`pg_advisory_xact_lock`).
   * Serialises complaint recording + trip evaluation per owner. Only
   * meaningful inside `repos.tx`; released at commit/rollback.
   */
  lockOwner(owner: EventInvitePauseOwner): Promise<void>;

  /**
   * Insert one complaint. Idempotent on `providerEventId` (INSERT … ON
   * CONFLICT DO NOTHING): `created` is false for a replay.
   */
  recordComplaint(input: {
    providerEventId: string;
    owner: EventInvitePauseOwner;
    eventId: string | null;
    emailHash: string;
    /** When the complained-about mail was sent (its tag); null if untagged. */
    sentAt: Date | null;
    occurredAt: Date;
  }): Promise<{ created: boolean }>;

  /**
   * Distinct complaining addresses (emailHash) about mail SENT at or after
   * `since`: `sentAt`, or `occurredAt` for a complaint without a send time.
   */
  countDistinctComplainants(input: {
    owner: EventInvitePauseOwner;
    since: Date;
  }): Promise<number>;

  /**
   * DISTINCT recipients (lowercased invitee email) of the owner's PERSONAL
   * invites whose (last) send is at or after `since`. One guest invited to
   * three events counts once. Revoked invites count: their email went out.
   */
  countInviteRecipients(input: {
    owner: EventInvitePauseOwner;
    since: Date;
  }): Promise<number>;

  /** The owner's open pause (liftedAt IS NULL), or null. */
  getOpenPause(owner: EventInvitePauseOwner): Promise<EventInvitePauseRecord | null>;

  /** The owner's most recent pause, open or lifted, or null. */
  getLatestPause(owner: EventInvitePauseOwner): Promise<EventInvitePauseRecord | null>;

  /** When the owner's last pause was lifted, or null. */
  getLastLiftedAt(owner: EventInvitePauseOwner): Promise<Date | null>;

  /**
   * The event of the owner's most recent complaint (by `occurredAt`) that
   * names one, or null. A complaint's `eventId` is nulled when its event is
   * deleted, so a non-null id names an event that still exists; callers
   * still check it belongs to the owner. Used to deep-link the pause notices.
   */
  getLatestComplaintEventId(owner: EventInvitePauseOwner): Promise<string | null>;

  /**
   * Open a pause. Throws `{ code: "invite_pause_already_open" }` when the
   * owner already has one (partial unique); callers hold the owner lock and
   * check first, so that is a bug, not a race.
   */
  openPause(input: {
    owner: EventInvitePauseOwner;
    reason: EventInvitePauseReason;
    complaintCount: number;
    recipientCount: number;
    pausedAt: Date;
  }): Promise<EventInvitePauseRecord>;

  getById(id: string): Promise<EventInvitePauseRecord | null>;

  /**
   * Record the organiser's review request, only while the pause is open and
   * no request is waiting (a conditional update). Null when it was not
   * (closed, or already requested).
   */
  requestReview(input: {
    id: string;
    note: string | null;
    at: Date;
  }): Promise<EventInvitePauseRecord | null>;

  /**
   * Staff decision on an OPEN pause (a conditional update; null when the
   * pause is gone or already lifted).
   *  - LIFTED: sets liftedAt; the review request stays as history.
   *  - KEPT: clears the review request and its note, so the organiser can
   *    ask again.
   */
  decide(input: {
    id: string;
    decision: EventInvitePauseDecision;
    note: string | null;
    decidedByHumanId: string;
    at: Date;
  }): Promise<EventInvitePauseRecord | null>;

  list(input: {
    status: EventInvitePauseListStatus;
    limit: number;
    offset: number;
  }): Promise<EventInvitePauseListItem[]>;
}
