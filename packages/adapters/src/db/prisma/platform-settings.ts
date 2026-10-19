import type { PlatformSettingsRepo } from "@th/ports/repos/platform-settings";
import type {
  PlatformSettingRecord,
  PlatformSettingKey,
} from "@th/types/repos/platform-settings";
import type { PrismaClientOrTx } from "./types";

export function makePlatformSettingsRepo(
  p: PrismaClientOrTx,
): PlatformSettingsRepo {
  return {
    async get(key: PlatformSettingKey): Promise<PlatformSettingRecord | null> {
      const row = await (p as any).platformSetting.findUnique({
        where: { key },
      });
      return row ?? null;
    },

    async getAll(): Promise<PlatformSettingRecord[]> {
      return (p as any).platformSetting.findMany({ orderBy: { key: "asc" } });
    },

    async upsert(
      key: PlatformSettingKey,
      value: string,
    ): Promise<PlatformSettingRecord> {
      return (p as any).platformSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    },
  };
}
