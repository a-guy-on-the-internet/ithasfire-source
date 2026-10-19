export type NotificationPreferenceCategory =
  | "transactional"
  | "announcements"
  /**
   * Ahead-of-time nudges about something the human already opted into — today
   * the 24h-before community RSVP reminder. Separate from `transactional` ON
   * PURPOSE: the whole point is that a reminder is independently switchable
   * without muting the confirmation/receipt class of message.
   */
  | "reminders"
  | "marketing"
  | "organizerMessages"
  /**
   * "Bills you're on" (lineup-booking-requests v3, L8 / FR-012): act-facing
   * notices AFTER the invite — removed from a bill, the request isn't going
   * ahead. Switchable per channel; the invite itself stays transactional
   * (it is the consent ask).
   */
  | "billsYoureOn";

export type NotificationPreferenceChannel = "email" | "sms" | "push" | "in_app";

export type NotificationPreferenceScopeKind = "GLOBAL" | "ORG" | "EVENT";

export type NotificationEmailFrequency =
  | "INSTANT"
  | "DAILY_DIGEST"
  | "WEEKLY_DIGEST";

export type NotificationPreferenceScope =
  | { kind: "GLOBAL" }
  | { kind: "ORG"; orgId: string }
  | { kind: "EVENT"; eventId: string };

export type NotificationPreferenceCategoryDelta = Partial<
  Record<NotificationPreferenceCategory, boolean>
>;

export interface NotificationPreferenceEmailChannelDelta extends NotificationPreferenceCategoryDelta {
  frequency?: NotificationEmailFrequency;
}

export interface NotificationPreferenceChannelsDelta {
  email?: NotificationPreferenceEmailChannelDelta;
  sms?: NotificationPreferenceCategoryDelta;
  push?: NotificationPreferenceCategoryDelta;
  in_app?: NotificationPreferenceCategoryDelta;
}

export interface NotificationPreferenceDelta {
  categories?: NotificationPreferenceCategoryDelta;
  channels?: NotificationPreferenceChannelsDelta;
}

export interface NotificationPreferenceChannelSnapshot {
  transactional: boolean;
  announcements: boolean;
  reminders: boolean;
  marketing: boolean;
  organizerMessages: boolean;
  billsYoureOn: boolean;
}

export interface NotificationPreferenceEmailChannelSnapshot extends NotificationPreferenceChannelSnapshot {
  frequency?: NotificationEmailFrequency | null;
}

export interface NotificationPreferenceSnapshot {
  email?: NotificationPreferenceEmailChannelSnapshot;
  sms?: NotificationPreferenceChannelSnapshot;
  push?: NotificationPreferenceChannelSnapshot;
  in_app?: NotificationPreferenceChannelSnapshot;
}

export interface UpsertNotificationPreferencesInput {
  humanId: string;
  scope: NotificationPreferenceScope;
  delta: NotificationPreferenceDelta;
}

export interface ReadEffectiveNotificationPreferencesInput {
  humanId: string;
  scope: NotificationPreferenceScope;
}

export interface BatchReadAnnouncementEmailEnabledInput {
  humanIds: string[];
  orgId: string;
}

export interface NotificationPreferenceTokenScope {
  kind: NotificationPreferenceScopeKind;
  orgId?: string;
  eventId?: string;
}

export interface NotificationPreferenceTokenPayload {
  tokenId: string;
  humanId: string;
  scope: NotificationPreferenceTokenScope;
  categories?: NotificationPreferenceCategoryDelta;
  channels?: NotificationPreferenceChannelsDelta;
  expiresAt: Date;
}
