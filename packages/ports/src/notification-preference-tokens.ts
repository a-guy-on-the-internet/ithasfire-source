import type {
  NotificationPreferenceTokenPayload,
  NotificationPreferenceTokenScope,
} from "@th/types/repos/notification-preferences";

export interface NotificationPreferenceTokensPort {
  validateUnsubscribeToken(
    token: string,
  ): Promise<NotificationPreferenceTokenPayload | null>;
}

export type {
  NotificationPreferenceTokenPayload,
  NotificationPreferenceTokenScope,
} from "@th/types/repos/notification-preferences";
