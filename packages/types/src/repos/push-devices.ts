export type PushProvider = "expo" | "fcm" | "apns" | "web";
export type PushPlatform = "ios" | "android" | "web" | "unknown";

export interface PushDeviceRecord {
  id: string;
  humanId: string;
  provider: PushProvider;
  token: string;
  platform: PushPlatform;
  appId: string | null;
  enabled: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertPushDeviceInput {
  humanId: string;
  provider: PushProvider;
  token: string;
  platform?: PushPlatform | null;
  appId?: string | null;
}

export interface MarkPushDeviceSeenInput {
  id: string;
  seenAt?: Date;
}

export interface DisablePushDeviceInput {
  id: string;
}

export interface DisablePushDevicesByTokenInput {
  provider: PushProvider;
  token: string;
}

export interface DisablePushDevicesByHumanInput {
  humanId: string;
  token: string;
}

export interface FindActiveDevicesByHumanInput {
  humanId: string;
}

export interface EnforceActiveDeviceCapInput {
  humanId: string;
  /** Max ACTIVE (enabled) devices the human may keep; must be >= 1. */
  maxActive: number;
}

export interface FindDevicesByIdsInput {
  ids: string[];
}
