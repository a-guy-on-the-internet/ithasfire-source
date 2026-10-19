import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import {
  FEATURE_GATE_SETTING_KEYS,
  type PlatformSettingKey,
} from "@th/types/repos/platform-settings";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

// Keys an authenticated platform admin may toggle through this endpoint.
// Anything outside this set has its own dedicated use case (theme presets,
// POS terminal, etc.) or isn't user-toggleable.
const UPDATABLE_PLATFORM_SETTING_KEYS = [
  "supportEmail",
  "platformName",
  "email:physicalAddress",
  ...FEATURE_GATE_SETTING_KEYS,
  "homepage:heroStyle",
] as const;

export const updatePlatformSettingInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    key: z.enum(UPDATABLE_PLATFORM_SETTING_KEYS),
    value: z.string().min(1).max(500),
  })
  .strict();

const settingItemSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export const updatePlatformSettingOutputSchema = z
  .object({
    setting: settingItemSchema,
  })
  .strict();

export type UpdatePlatformSettingInput = z.infer<
  typeof updatePlatformSettingInputSchema
>;
export type UpdatePlatformSettingOutput = z.infer<
  typeof updatePlatformSettingOutputSchema
>;

export type UpdatePlatformSettingDeps = {
  repos: Pick<Repos, "platformSettings" | "audit" | "tx">;
  authz: AuthZPort;
  logger?: LoggerPort;
};

const PLATFORM_STAFF_ROLES = ["ADMIN", "DEVELOPER"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function updatePlatformSetting(
  deps: UpdatePlatformSettingDeps,
  rawInput: unknown,
): Promise<UpdatePlatformSettingOutput> {
  const logger = deps.logger?.child({ useCase: "updatePlatformSetting" });

  const execute = async () => {
    const input = parseInput(updatePlatformSettingInputSchema, rawInput);

    // Only ADMIN and DEVELOPER staff can change platform settings
    const check = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...PLATFORM_STAFF_ROLES],
    });
    if (!check.allowed) {
      throw fail("STAFF_ONLY");
    }

    // Per-key value validation (after auth so unprivileged callers can't probe valid enum values)
    if (input.key === "homepage:heroStyle") {
      if (!["map", "carousel", "both"].includes(input.value)) {
        throw {
          code: "invalid_input",
          message: "homepage:heroStyle must be one of: map, carousel, both",
        } as const;
      }
    }

    const record = await deps.repos.tx(async (tx) => {
      const r = await tx.platformSettings.upsert(
        input.key as PlatformSettingKey,
        input.value,
      );
      await tx.audit.log({
        entity: "PlatformSetting",
        entityId: input.key,
        action: "platform_setting.update",
        data: {
          key: input.key,
          value: input.value,
          actorHumanId: input.actorHumanId,
        },
        at: new Date(),
      });
      return r;
    });

    return {
      setting: { key: record.key, value: record.value },
    };
  };

  if (logger) {
    return logger.withTime("updatePlatformSetting", execute);
  }
  return execute();
}
