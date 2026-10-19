import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { FEATURE_GATE_SETTING_KEYS } from "@th/types/repos/platform-settings";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors UPDATABLE_PLATFORM_SETTING_KEYS in update-platform-setting.ts —
// the surface admins read through this endpoint matches what they can
// write. Keep both lists driven by FEATURE_GATE_SETTING_KEYS so feature
// gates can't drift out of sync again.
const READABLE_PLATFORM_SETTING_KEYS = [
  "supportEmail",
  "platformName",
  "email:physicalAddress",
  ...FEATURE_GATE_SETTING_KEYS,
  "homepage:heroStyle",
] as const;

export const getPlatformSettingsInputSchema = z
  .object({
    /** Optional list of keys to fetch. If omitted, returns all. */
    keys: z.array(z.enum(READABLE_PLATFORM_SETTING_KEYS)).optional(),
  })
  .strict();

const settingItemSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export const getPlatformSettingsOutputSchema = z
  .object({
    settings: z.array(settingItemSchema),
  })
  .strict();

export type GetPlatformSettingsInput = z.infer<
  typeof getPlatformSettingsInputSchema
>;
export type GetPlatformSettingsOutput = z.infer<
  typeof getPlatformSettingsOutputSchema
>;

export type GetPlatformSettingsDeps = {
  repos: Pick<Repos, "platformSettings">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function getPlatformSettings(
  deps: GetPlatformSettingsDeps,
  rawInput: unknown,
): Promise<GetPlatformSettingsOutput> {
  const logger = deps.logger?.child({ useCase: "getPlatformSettings" });

  const execute = async () => {
    const input = getPlatformSettingsInputSchema.parse(rawInput);

    if (input.keys && input.keys.length > 0) {
      const all = await deps.repos.platformSettings.getAll();
      const keySet = new Set<string>(input.keys);

      return {
        settings: all
          .filter((r) => keySet.has(r.key))
          .map((r) => ({ key: r.key, value: r.value })),
      };
    }

    const all = await deps.repos.platformSettings.getAll();
    return {
      settings: all.map((r) => ({ key: r.key, value: r.value })),
    };
  };

  if (logger) {
    return logger.withTime("getPlatformSettings", execute);
  }
  return execute();
}
