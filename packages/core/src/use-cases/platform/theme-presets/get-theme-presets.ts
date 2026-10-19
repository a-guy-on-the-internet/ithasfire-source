import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ThemePreset, ThemePresetsConfig } from "@th/types/theme-preset";

import { BUILT_IN_PRESETS } from "./built-in-presets";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const getThemePresetsInputSchema = z.object({}).strict().optional();

const presetItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  tokens: z.record(z.string(), z.string()),
  builtIn: z.boolean().optional(),
});

export const getThemePresetsOutputSchema = z.object({
  presets: z.array(presetItemSchema),
  activeSlug: z.string().nullable(),
});

export type GetThemePresetsInput = z.infer<typeof getThemePresetsInputSchema>;
export type GetThemePresetsOutput = z.infer<typeof getThemePresetsOutputSchema>;

export type GetThemePresetsDeps = {
  repos: Pick<Repos, "platformSettings">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function getThemePresets(
  deps: GetThemePresetsDeps,
  _rawInput?: unknown,
): Promise<GetThemePresetsOutput> {
  const logger = deps.logger?.child({ useCase: "getThemePresets" });

  const execute = async () => {
    // 1. Fetch any custom presets saved in platform settings
    const presetsRecord = await deps.repos.platformSettings.get("themePresets");
    let customPresets: ThemePreset[] = [];
    if (presetsRecord) {
      try {
        const parsed: ThemePresetsConfig = JSON.parse(presetsRecord.value);
        customPresets = parsed.presets ?? [];
      } catch {
        // Corrupted data — log and ignore
        logger?.warn("Failed to parse themePresets setting");
      }
    }

    // 2. Fetch active theme slug
    const activeRecord =
      await deps.repos.platformSettings.get("activeThemePreset");
    let activeSlug: string | null = null;
    if (activeRecord) {
      try {
        const parsed = JSON.parse(activeRecord.value);
        activeSlug = parsed.slug ?? null;
      } catch {
        logger?.warn("Failed to parse activeThemePreset setting");
      }
    }

    // 3. Merge: built-ins first, then custom
    // Custom presets can shadow built-ins by slug
    const builtInSlugs = new Set(BUILT_IN_PRESETS.map((p) => p.slug));
    const nonShadowed = customPresets.filter((p) => !builtInSlugs.has(p.slug));
    const presets: ThemePreset[] = [...BUILT_IN_PRESETS, ...nonShadowed];

    return { presets, activeSlug };
  };

  if (logger) {
    return logger.withTime("getThemePresets", execute);
  }
  return execute();
}
