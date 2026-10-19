import type {
  PlatformSettingRecord,
  PlatformSettingKey,
} from "@th/types/repos/platform-settings";

export interface PlatformSettingsRepo {
  /** Get a single setting by key. Returns null if not set. */
  get(key: PlatformSettingKey): Promise<PlatformSettingRecord | null>;

  /** Get all platform settings. */
  getAll(): Promise<PlatformSettingRecord[]>;

  /** Create or update a setting. */
  upsert(
    key: PlatformSettingKey,
    value: string,
  ): Promise<PlatformSettingRecord>;
}

export type { PlatformSettingRecord, PlatformSettingKey };
