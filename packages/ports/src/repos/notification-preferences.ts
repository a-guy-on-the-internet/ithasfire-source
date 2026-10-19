import type {
  NotificationPreferenceChannel,
  NotificationPreferenceCategory,
  NotificationPreferenceDelta,
  NotificationPreferenceSnapshot,
  NotificationPreferenceScope,
  NotificationPreferenceScopeKind,
  NotificationEmailFrequency,
  NotificationPreferenceCategoryDelta,
  NotificationPreferenceChannelsDelta,
  NotificationPreferenceChannelSnapshot,
  NotificationPreferenceEmailChannelDelta,
  NotificationPreferenceEmailChannelSnapshot,
  ReadEffectiveNotificationPreferencesInput,
  UpsertNotificationPreferencesInput,
  BatchReadAnnouncementEmailEnabledInput,
} from "@th/types/repos/notification-preferences";

export interface NotificationPreferencesRepo {
  upsert(input: UpsertNotificationPreferencesInput): Promise<void>;
  readEffective(
    input: ReadEffectiveNotificationPreferencesInput,
  ): Promise<NotificationPreferenceSnapshot>;

  /**
   * Batch-resolve whether each human still has announcement emails enabled for
   * a given org. A human is enabled unless EITHER their GLOBAL pref OR their
   * ORG(orgId) pref sets `email.announcements = false`. Humans with no rows
   * default to enabled.
   *
   * Returns a Map keyed by humanId → enabled. Humans not present in the map
   * (e.g. with no overriding rows) should be treated as enabled by callers.
   */
  batchReadAnnouncementEmailEnabled(
    input: BatchReadAnnouncementEmailEnabledInput,
  ): Promise<Map<string, boolean>>;
}

export type {
  NotificationPreferenceChannel,
  NotificationPreferenceCategory,
  NotificationPreferenceDelta,
  NotificationPreferenceSnapshot,
  NotificationPreferenceScope,
  NotificationPreferenceScopeKind,
  NotificationEmailFrequency,
  NotificationPreferenceCategoryDelta,
  NotificationPreferenceChannelsDelta,
  NotificationPreferenceChannelSnapshot,
  NotificationPreferenceEmailChannelDelta,
  NotificationPreferenceEmailChannelSnapshot,
  ReadEffectiveNotificationPreferencesInput,
  UpsertNotificationPreferencesInput,
  BatchReadAnnouncementEmailEnabledInput,
} from "@th/types/repos/notification-preferences";
