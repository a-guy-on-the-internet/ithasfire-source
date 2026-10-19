import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import type { ThemePreset, ThemePresetsConfig } from "@th/types/theme-preset";

import { parseInput } from "../../../lib/io";
import { BUILT_IN_PRESETS } from "./built-in-presets";
import { fail } from "@th/errors";
import { plainTextRequired } from "../../../lib/sanitize-plain-text";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const saveThemePresetInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    preset: z.object({
      slug: z
        .string()
        .min(1)
        .max(80)
        .regex(
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          "slug must be lowercase kebab-case",
        ),
      name: plainTextRequired(120),
      tokens: z.record(z.string(), z.string()),
    }),
  })
  .strict();

export const saveThemePresetOutputSchema = z.object({
  preset: z.object({
    slug: z.string(),
    name: z.string(),
    tokens: z.record(z.string(), z.string()),
    builtIn: z.boolean().optional(),
  }),
});

export type SaveThemePresetInput = z.infer<typeof saveThemePresetInputSchema>;
export type SaveThemePresetOutput = z.infer<typeof saveThemePresetOutputSchema>;

export type SaveThemePresetDeps = {
  repos: Pick<Repos, "platformSettings">;
  authz: AuthZPort;
  logger?: LoggerPort;
};

const PLATFORM_STAFF_ROLES = ["ADMIN", "DEVELOPER"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function saveThemePreset(
  deps: SaveThemePresetDeps,
  rawInput: unknown,
): Promise<SaveThemePresetOutput> {
  const logger = deps.logger?.child({ useCase: "saveThemePreset" });

  const execute = async () => {
    const input = parseInput(saveThemePresetInputSchema, rawInput);

    // Auth: require ADMIN or DEVELOPER
    const check = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...PLATFORM_STAFF_ROLES],
    });
    if (!check.allowed) {
      throw fail("STAFF_ONLY");
    }

    // Prevent overwriting built-in presets
    const isBuiltIn = BUILT_IN_PRESETS.some(
      (p) => p.slug === input.preset.slug,
    );
    if (isBuiltIn) {
      throw fail("CANNOT_OVERWRITE_BUILTIN_PRESET");
    }

    // Read current custom presets
    const presetsRecord = await deps.repos.platformSettings.get("themePresets");
    let existingPresets: ThemePreset[] = [];
    if (presetsRecord) {
      try {
        const parsed: ThemePresetsConfig = JSON.parse(presetsRecord.value);
        existingPresets = parsed.presets ?? [];
      } catch {
        // Corrupted — reset
        existingPresets = [];
      }
    }

    // Upsert by slug
    const idx = existingPresets.findIndex((p) => p.slug === input.preset.slug);
    const preset: ThemePreset = {
      slug: input.preset.slug,
      name: input.preset.name,
      tokens: input.preset.tokens,
    };

    if (idx >= 0) {
      existingPresets[idx] = preset;
    } else {
      existingPresets.push(preset);
    }

    // Persist
    const config: ThemePresetsConfig = { presets: existingPresets };
    await deps.repos.platformSettings.upsert(
      "themePresets",
      JSON.stringify(config),
    );

    return { preset };
  };

  if (logger) {
    return logger.withTime("saveThemePreset", execute);
  }
  return execute();
}
