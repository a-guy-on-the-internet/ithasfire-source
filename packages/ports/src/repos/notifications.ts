import type {
  CreateNotificationInput,
  CreateNotificationResult,
  FindNotifiedHumanIdsForEventInput,
  ListNotificationsInput,
  ListNotificationsResult,
  MarkReadResult,
  NotificationAction,
  NotificationKind,
  NotificationRecord,
} from "@th/types/repos/notifications";

export interface NotificationsRepo {
  create(input: CreateNotificationInput): Promise<CreateNotificationResult>;
  getById(id: string): Promise<NotificationRecord | null>;
  listByHuman(input: ListNotificationsInput): Promise<ListNotificationsResult>;
  countUnread(humanId: string): Promise<number>;
  markRead(ids: string[], humanId: string): Promise<MarkReadResult>;
  markAllRead(humanId: string): Promise<MarkReadResult>;
  /**
   * Returns the subset of `humanIds` that already have a persisted in-app
   * notification for (`variant`, `eventId`) — the durable per-recipient
   * ledger used by fan-out dispatchers to subtract already-notified
   * recipients on overlapping ticks / explicit re-drives.
   */
  findNotifiedHumanIdsForEvent(
    input: FindNotifiedHumanIdsForEventInput,
  ): Promise<string[]>;
}

export type {
  CreateNotificationInput,
  CreateNotificationResult,
  FindNotifiedHumanIdsForEventInput,
  ListNotificationsInput,
  ListNotificationsResult,
  MarkReadResult,
  NotificationAction,
  NotificationKind,
  NotificationRecord,
} from "@th/types/repos/notifications";
