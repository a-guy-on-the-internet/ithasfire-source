import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import type {
  ThemePreset,
  ThemePresetsConfig,
  ActiveThemePresetConfig,
} from "@th/types/theme-preset";

import { parseInput } from "../../../lib/io";
import { BUILT_IN_PRESETS } from "./built-in-presets";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const deleteThemePresetInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    slug: z.string().min(1),
  })
  .strict();

export const deleteThemePresetOutputSchema = z.object({
  deleted: z.boolean(),
});

export type DeleteThemePresetInput = z.infer<
  typeof deleteThemePresetInputSchema
>;
export type DeleteThemePresetOutput = z.infer<
  typeof deleteThemePresetOutputSchema
>;

export type DeleteThemePresetDeps = {
  repos: Pick<Repos, "platformSettings">;
  authz: AuthZPort;
  logger?: LoggerPort;
};

const PLATFORM_STAFF_ROLES = ["ADMIN", "DEVELOPER"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteThemePreset(
  deps: DeleteThemePresetDeps,
  rawInput: unknown,
): Promise<DeleteThemePresetOutput> {
  const logger = deps.logger?.child({ useCase: "deleteThemePreset" });

  const execute = async () => {
    const input = parseInput(deleteThemePresetInputSchema, rawInput);

    // Auth: require ADMIN or DEVELOPER
    const check = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...PLATFORM_STAFF_ROLES],
    });
    if (!check.allowed) {
      throw fail("STAFF_ONLY");
    }

    // Cannot delete built-in presets
    if (BUILT_IN_PRESETS.some((p) => p.slug === input.slug)) {
      throw fail("CANNOT_DELETE_BUILTIN_PRESET");
    }

    // Read current custom presets
    const presetsRecord = await deps.repos.platformSettings.get("themePresets");
    let existingPresets: ThemePreset[] = [];
    if (presetsRecord) {
      try {
        const parsed: ThemePresetsConfig = JSON.parse(presetsRecord.value);
        existingPresets = parsed.presets ?? [];
      } catch {
        existingPresets = [];
      }
    }

    const before = existingPresets.length;
    existingPresets = existingPresets.filter((p) => p.slug !== input.slug);
    const deleted = existingPresets.length < before;

    // Persist updated list
    const config: ThemePresetsConfig = { presets: existingPresets };
    await deps.repos.platformSettings.upsert(
      "themePresets",
      JSON.stringify(config),
    );

    // If the deleted preset was active, deactivate
    if (deleted) {
      const activeRecord =
        await deps.repos.platformSettings.get("activeThemePreset");
      if (activeRecord) {
        try {
          const active: ActiveThemePresetConfig = JSON.parse(
            activeRecord.value,
          );
          if (active.slug === input.slug) {
            await deps.repos.platformSettings.upsert(
              "activeThemePreset",
              JSON.stringify({ slug: null }),
            );
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    return { deleted };
  };

  if (logger) {
    return logger.withTime("deleteThemePreset", execute);
  }
  return execute();
}
