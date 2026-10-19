export type NotificationDigestType = "ORGANIZER_WEEKLY" | "ATTENDEE_FEEDBACK";

export type NotificationDigestChannel = "EMAIL" | "IN_APP";

export type FeedbackRequestStatus =
  | "PENDING"
  | "SCHEDULED"
  | "SENT"
  | "COMPLETED"
  | "SKIPPED";

export interface OrganizerDigestRecipient {
  humanId: string;
  email: string | null;
  name: string | null;
}

export interface OrganizerEventMetric {
  eventId: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  ticketsSold: number;
  grossRevenueCents: number;
}

export interface OrganizerUpcomingEvent {
  orgId: string;
  eventId: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  ticketsOnSale: number;
}

export interface OrganizerDigestMetrics {
  orgId: string;
  orgName: string;
  recipients: OrganizerDigestRecipient[];
  windowStart: Date;
  windowEnd: Date;
  totals: {
    ticketsSold: number;
    grossRevenueCents: number;
    platformFeesCents: number;
  };
  recentEvents: OrganizerEventMetric[];
  upcomingEvents: OrganizerUpcomingEvent[];
}

export interface FeedbackRequestRecord {
  id: string;
  eventId: string;
  orderId: string;
  humanId: string;
  status: FeedbackRequestStatus;
  channel: NotificationDigestChannel;
  sendAfter: Date;
  sentAt?: Date | null;
  respondedAt?: Date | null;
  payloadHash?: string | null;
}

export interface AttendeeFeedbackCandidate {
  requestId: string;
  humanId: string;
  humanEmail: string | null;
  humanName: string | null;
  eventId: string;
  eventTitle: string;
  eventEndsAt: Date | null;
  organizerName: string | null;
  orderId: string;
  channel: NotificationDigestChannel;
  sendAfter: Date;
}

export interface CompletedEventOrders {
  eventId: string;
  orgId: string | null;
  eventTitle: string;
  eventEndsAt: Date | null;
  organizerName: string | null;
  attendees: Array<{
    orderId: string;
    humanId: string;
    humanEmail: string | null;
    humanName: string | null;
    sendAfter: Date;
  }>;
}

export interface NotificationDigestLogRecord {
  id: string;
  humanId: string;
  orgId: string | null;
  eventId: string | null;
  digestType: NotificationDigestType;
  channel: NotificationDigestChannel;
  payloadHash: string;
  templateKey: string;
  metadata: Record<string, unknown> | null;
  sentAt: Date;
}

export interface NotificationDigestSubscriptionRecord {
  humanId: string;
  digestType: NotificationDigestType;
  subscribed: boolean;
  unsubscribedAt?: Date | null;
  reason?: string | null;
  /**
   * Soft auto-suppression counter (attendee-prompt-delivery-hygiene FR-003/004):
   * consecutive weekly digests sent with no review since. Absent row = 0.
   */
  consecutiveIgnored: number;
  /** When the most recent digest of this type was emailed to this human. */
  lastDigestSentAt?: Date | null;
}

/**
 * One un-reviewed, still-in-window attended show for a human's weekly review
 * digest (attendee-prompt-delivery-hygiene FR-002). Carries only the copy the
 * digest needs — no other-attendee identity.
 */
export interface AttendeeReviewDigestShow {
  eventId: string;
  eventTitle: string;
  /** The gig's venue name, when the event has a resolvable place. */
  placeName: string | null;
  /** Event end (endsAt ?? startsAt), used for ordering + copy. */
  eventEndsAt: Date;
}

/**
 * A human owed a weekly review digest: at least one un-reviewed, in-window
 * attended (scanned-ticket) show. Grouped per human so the sender emits ONE
 * email (attendee-prompt-delivery-hygiene FR-002).
 */
export interface AttendeeReviewDigestCandidate {
  humanId: string;
  humanEmail: string | null;
  humanName: string | null;
  shows: AttendeeReviewDigestShow[];
}

export interface RecordDigestLogInput {
  humanId: string;
  orgId?: string | null;
  eventId?: string | null;
  digestType: NotificationDigestType;
  channel: NotificationDigestChannel;
  payloadHash: string;
  templateKey: string;
  metadata?: Record<string, unknown> | null;
  sentAt: Date;
}

export interface UpsertDigestSubscriptionInput {
  humanId: string;
  digestType: NotificationDigestType;
  subscribed: boolean;
  reason?: string | null;
  unsubscribedAt?: Date | null;
}
