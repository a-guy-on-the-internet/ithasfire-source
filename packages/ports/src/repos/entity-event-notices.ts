export type FollowNoticeChannel = "in_app" | "email" | "push";

/** Why a delivery finished. Recorded on the row; never shown to users. */
export type FollowDeliveryFinishReason =
  | "DELIVERED"
  | "FOLLOW_GONE"
  | "MUTED"
  | "FOLLOWED_AFTER_NOTICE"
  | "EVENT_NOT_ANNOUNCEABLE"
  | "PAGE_NOT_ELIGIBLE"
  | "NEARBY_NO_PUBLIC_HOME"
  | "NEARBY_EVENT_NOT_PUBLIC"
  | "NEARBY_OUTSIDE_RADIUS"
  | "DEAD_LETTER";

/** Why a notice stopped expanding before reaching its whole audience. */
export type FollowNoticeClosedReason = "EVENT_STARTED" | "EVENT_GONE";

export interface EntityEventNotice {
  id: string; entityPageId: string; eventId: string; createdAt: Date;
}
export interface EntityEventDelivery extends EntityEventNotice {
  noticeId: string; humanId: string; followId: string; leaseToken: string;
  inAppDone: boolean; emailDone: boolean; pushDone: boolean; attempts: number;
}

/** One step of audience expansion: the notice touched, and what it produced. */
export interface ExpandAudienceStep {
  noticeId: string;
  /** Deliveries written (a follower already reached for this event is not). */
  inserted: number;
  /** Set when the notice was closed without (further) expansion. */
  closedReason: FollowNoticeClosedReason | null;
}

/**
 * The location fields of a follower's past event, for "near you" alerts —
 * exactly what core's PUBLIC location projection reads, and nothing else.
 * Raw coordinates here are only ever an INPUT to that projection.
 */
export interface FollowerHomeCandidate {
  event: {
    id: string; orgId: string | null; humanId: string | null; placeId: string | null;
    gateType: string | null; locationMode: string | null; locationRadiusMeters: number | null;
    locationLabel: string | null; addressText: string | null;
    lat: number | null; lng: number | null;
    locality: string | null; region: string | null; countryCode: string | null; postalCode: string | null;
  };
  /** The event's venue; null when the event has none or the row is gone. */
  place: {
    id: string; locationMode: string | null; locationRadiusMeters: number | null;
    locationLabel: string | null; formattedAddress: string | null;
    addressLine1: string | null; addressLine2: string | null;
    city: string | null; region: string | null; postalCode: string | null; countryCode: string | null;
    lat: number | null; lng: number | null;
  } | null;
}

/** Transactional publication outbox; fan-out and delivery are separately bounded. */
export interface EntityEventNoticesRepo {
  enqueue(input: {entityPageId: string; eventId: string; at: Date}): Promise<void>;
  /**
   * Atomically expand at most `limit` followers from ONE open notice,
   * preserving its cutoff. A notice whose event has started (or is gone) is
   * closed with a reason instead. Null when no open notice is left.
   */
  expandAudience(input: {limit: number; now: Date}): Promise<ExpandAudienceStep | null>;
  claim(input: {now: Date; leaseUntil: Date; token: string}): Promise<EntityEventDelivery | null>;
  /** CAS on the live lease: stale workers cannot settle another worker's delivery. */
  renew(id: string, token: string, now: Date, leaseUntil: Date): Promise<boolean>;
  settleChannel(id: string, token: string, channel: FollowNoticeChannel, now: Date): Promise<boolean>;
  finish(id: string, token: string, now: Date, reason: FollowDeliveryFinishReason): Promise<void>;
  retry(id: string, token: string, retryAt: Date, now: Date): Promise<void>;
  /**
   * The follower's most recent ticketed events (newest first, at most
   * `limit`), with only the fields the public projection needs.
   */
  followerHomeCandidates(humanId: string, limit: number): Promise<FollowerHomeCandidate[]>;
  /**
   * Retention: delete notices (and, by cascade, their deliveries) whose event
   * started before `cutoff` or no longer exists. Returns rows deleted.
   */
  purgeStartedBefore(cutoff: Date): Promise<{notices: number}>;
}
