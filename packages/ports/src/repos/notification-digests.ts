import type {
  AttendeeFeedbackCandidate,
  AttendeeReviewDigestCandidate,
  AttendeeReviewDigestShow,
  FeedbackRequestRecord,
  NotificationDigestChannel,
  NotificationDigestLogRecord,
  NotificationDigestSubscriptionRecord,
  NotificationDigestType,
  OrganizerDigestMetrics,
  RecordDigestLogInput,
  UpsertDigestSubscriptionInput,
  CompletedEventOrders,
  OrganizerUpcomingEvent,
} from "@th/types";

export interface NotificationDigestsRepo {
  listOrganizerMetrics(input: {
    windowStart: Date;
    windowEnd: Date;
    limit?: number;
  }): Promise<OrganizerDigestMetrics[]>;

  listUpcomingEvents(input: {
    orgIds: string[];
    referenceTime: Date;
    limitPerOrg?: number;
  }): Promise<OrganizerUpcomingEvent[]>;

  listCompletedEventOrders(input: {
    windowStart: Date;
    windowEnd: Date;
  }): Promise<CompletedEventOrders[]>;

  listAttendeeFeedbackDue(input: {
    now: Date;
    limit?: number;
  }): Promise<AttendeeFeedbackCandidate[]>;

  markFeedbackSent(input: {
    requestId: string;
    sentAt: Date;
    payloadHash: string;
  }): Promise<FeedbackRequestRecord>;

  ensureFeedbackRequest(input: {
    eventId: string;
    orderId: string;
    humanId: string;
    channel: NotificationDigestChannel;
    sendAfter: Date;
    metadata?: Record<string, unknown> | null;
  }): Promise<FeedbackRequestRecord>;

  recordDigestLog(
    input: RecordDigestLogInput,
  ): Promise<NotificationDigestLogRecord>;

  findDigestLogByHash(input: {
    digestType: NotificationDigestType;
    channel: NotificationDigestChannel;
    payloadHash: string;
  }): Promise<NotificationDigestLogRecord | null>;

  getSubscription(
    humanId: string,
    digestType: NotificationDigestType,
  ): Promise<NotificationDigestSubscriptionRecord | null>;

  upsertSubscription(
    input: UpsertDigestSubscriptionInput,
  ): Promise<NotificationDigestSubscriptionRecord>;

  // ── Attendee weekly review digest (attendee-prompt-delivery-hygiene) ──────

  /**
   * Humans owed a weekly review digest: each has >= 1 un-reviewed, in-window
   * attended (scanned-ticket) show. An event is in-window when its end
   * (endsAt ?? startsAt) is within (now - windowMs, now] and status is
   * PUBLISHED | COMPLETED; a show drops out once the human has an AttendeeReview
   * for it. Grouped per human so the sender emits ONE email (FR-002). The
   * digest lists only the human's OWN shows — no other-attendee identity.
   */
  listAttendeeReviewDigestCandidates(input: {
    now: Date;
    windowMs: number;
    limit?: number;
  }): Promise<AttendeeReviewDigestCandidate[]>;

  /**
   * Whether the human submitted ANY AttendeeReview strictly after `since` —
   * the re-engagement signal that resets the soft suppression counter
   * (FR-004a). Considers all reviews, not just in-window ones.
   */
  hasAttendeeReviewSince(input: {
    humanId: string;
    since: Date;
  }): Promise<boolean>;

  /**
   * Record that a digest of `digestType` was emailed to the human at `sentAt`:
   * bumps `consecutiveIgnored` by 1 and stamps `lastDigestSentAt`. Upserts the
   * subscription (creating it at consecutiveIgnored=1 when absent).
   */
  recordDigestSent(input: {
    humanId: string;
    digestType: NotificationDigestType;
    sentAt: Date;
  }): Promise<NotificationDigestSubscriptionRecord>;

  /**
   * Reset the soft suppression counter to 0 for a re-engaged human. No-op when
   * no subscription row exists (default counter is already 0).
   */
  resetConsecutiveIgnored(input: {
    humanId: string;
    digestType: NotificationDigestType;
  }): Promise<void>;
}

export type {
  AttendeeFeedbackCandidate,
  AttendeeReviewDigestCandidate,
  AttendeeReviewDigestShow,
  FeedbackRequestRecord,
  NotificationDigestChannel,
  NotificationDigestLogRecord,
  NotificationDigestSubscriptionRecord,
  NotificationDigestType,
  OrganizerDigestMetrics,
  OrganizerUpcomingEvent,
  RecordDigestLogInput,
  UpsertDigestSubscriptionInput,
  CompletedEventOrders,
} from "@th/types";
