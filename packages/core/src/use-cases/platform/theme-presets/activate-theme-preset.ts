import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import type {
  ActiveThemePresetConfig,
  ThemePresetsConfig,
} from "@th/types/theme-preset";

import { parseInput } from "../../../lib/io";
import { BUILT_IN_PRESETS } from "./built-in-presets";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const activateThemePresetInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    /** Slug of the preset to activate, or null/undefined to revert to default. */
    slug: z.string().nullable(),
  })
  .strict();

export const activateThemePresetOutputSchema = z.object({
  activeSlug: z.string().nullable(),
});

export type ActivateThemePresetInput = z.infer<
  typeof activateThemePresetInputSchema
>;
export type ActivateThemePresetOutput = z.infer<
  typeof activateThemePresetOutputSchema
>;

export type ActivateThemePresetDeps = {
  repos: Pick<Repos, "platformSettings">;
  authz: AuthZPort;
  logger?: LoggerPort;
};

const PLATFORM_STAFF_ROLES = ["ADMIN", "DEVELOPER"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function activateThemePreset(
  deps: ActivateThemePresetDeps,
  rawInput: unknown,
): Promise<ActivateThemePresetOutput> {
  const logger = deps.logger?.child({ useCase: "activateThemePreset" });

  const execute = async () => {
    const input = parseInput(activateThemePresetInputSchema, rawInput);

    // Auth: require ADMIN or DEVELOPER
    const check = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...PLATFORM_STAFF_ROLES],
    });
    if (!check.allowed) {
      throw fail("STAFF_ONLY");
    }

    // Null or "default" slug → deactivate
    const slug = input.slug === "default" ? null : input.slug;

    // If activating a non-null slug, validate it exists
    if (slug) {
      const isBuiltIn = BUILT_IN_PRESETS.some((p) => p.slug === slug);
      if (!isBuiltIn) {
        // Check custom presets
        const presetsRecord =
          await deps.repos.platformSettings.get("themePresets");
        let found = false;
        if (presetsRecord) {
          try {
            const parsed: ThemePresetsConfig = JSON.parse(presetsRecord.value);
            found = (parsed.presets ?? []).some((p) => p.slug === slug);
          } catch {
            // ignore parse errors
          }
        }
        if (!found) {
          throw fail("PRESET_NOT_FOUND");
        }
      }
    }

    // Persist
    const config: ActiveThemePresetConfig = { slug };
    await deps.repos.platformSettings.upsert(
      "activeThemePreset",
      JSON.stringify(config),
    );

    return { activeSlug: slug };
  };

  if (logger) {
    return logger.withTime("activateThemePreset", execute);
  }
  return execute();
}
