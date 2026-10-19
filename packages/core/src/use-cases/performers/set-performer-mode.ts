import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { PerformerOwnerType } from "@th/ports/repos/performer-profiles";

import { parseInput } from "../../lib/io";
import { isPerformerEnabled } from "../../lib/performer-mode";
import { ORG_ADMIN_ROLES, requireOwnerAccess } from "../../lib/rbac";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const setPerformerModeInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ownerType: z.enum(["human", "org"]),
    ownerId: z.uuid(),
    enabled: z.boolean(),
  })
  .strict();

export const setPerformerModeOutputSchema = z
  .object({
    performerProfileId: z.uuid(),
    enabled: z.boolean(),
  })
  .strict();

export type SetPerformerModeInput = z.infer<typeof setPerformerModeInputSchema>;
export type SetPerformerModeOutput = z.infer<
  typeof setPerformerModeOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type SetPerformerModeDeps = {
  repos: Pick<Repos, "tx" | "performerProfiles" | "authz" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/** Map the wire owner type to the stored party convention. */
export function toPerformerOwnerType(
  ownerType: "human" | "org",
): PerformerOwnerType {
  return ownerType === "human" ? "human" : "organization";
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Explicit performer-mode opt-in / opt-out (performer-mode.spec.yaml FR-001 /
 * FR-004). A Human may only toggle their own mode; an Org's mode requires an
 * org admin role. Idempotent: enabling an already-enabled profile is a no-op
 * returning the same profile. Disabling retains the row + data.
 */
export async function setPerformerMode(
  deps: SetPerformerModeDeps,
  rawInput: unknown,
): Promise<SetPerformerModeOutput> {
  const input = parseInput(setPerformerModeInputSchema, rawInput);

  const ownerType = toPerformerOwnerType(input.ownerType);

  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.ownerType === "human" ? "HUMAN" : "ORGANIZATION",
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ADMIN_ROLES,
  });

  const now = deps.clock.now();

  // One tx per mutation: the read (for transition detection), the upsert and
  // the audit entry commit or roll back together.
  const profile = await deps.repos.tx(async (tx) => {
    const previous = await tx.performerProfiles.getByOwner({
      ownerType,
      ownerId: input.ownerId,
    });
    const wasEnabled = isPerformerEnabled(previous);

    const updated = await tx.performerProfiles.upsertEnabled({
      ownerType,
      ownerId: input.ownerId,
      enabled: input.enabled,
      now,
    });

    // Audit only actual transitions — idempotent re-enables are no-ops.
    if (wasEnabled !== input.enabled) {
      await tx.audit.log({
        entity: "performer_profile",
        entityId: updated.id,
        action: input.enabled
          ? "performer_mode_enabled"
          : "performer_mode_disabled",
        data: {
          ownerType,
          ownerId: input.ownerId,
          actorHumanId: input.actorHumanId,
        },
        at: now,
      });
    }

    return updated;
  });

  deps.logger?.info("performers.set_mode", {
    performerProfileId: profile.id,
    ownerType,
    ownerId: input.ownerId,
    enabled: input.enabled,
    actorHumanId: input.actorHumanId,
  });

  return setPerformerModeOutputSchema.parse({
    performerProfileId: profile.id,
    enabled: isPerformerEnabled(profile),
  });
}
