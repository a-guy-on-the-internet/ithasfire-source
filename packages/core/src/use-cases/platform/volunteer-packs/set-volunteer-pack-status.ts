import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { STAFF_TECH } from "@th/types";

import { parseInput } from "../../../lib/io";
import { requirePlatformStaff } from "../../../lib/rbac";
import { volunteerPackRecordSchema, volunteerPackStatusSchema } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const setVolunteerPackStatusInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    packId: z.string().uuid(),
    status: volunteerPackStatusSchema,
  })
  .strict();

export const setVolunteerPackStatusOutputSchema = z
  .object({ pack: volunteerPackRecordSchema })
  .strict();

export type SetVolunteerPackStatusInput = z.infer<
  typeof setVolunteerPackStatusInputSchema
>;
export type SetVolunteerPackStatusOutput = z.infer<
  typeof setVolunteerPackStatusOutputSchema
>;

export type SetVolunteerPackStatusDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Publish (LIVE) or unpublish (DRAFT) a pack — the one action that changes
 * what every organizer on the platform can see, which is why it is separate
 * from `upsertVolunteerPack` and separately audited (FR-015).
 *
 * Unpublishing is non-destructive: the pack's catalogue roles stay, they just
 * stop appearing in organizer reads (every organizer-facing query requires a
 * LIVE pack). Org-owned FORKS are unaffected — they are org rows, and an org
 * that already customised a role keeps it.
 *
 * A no-op transition still writes an audit row on purpose: "who tried to
 * publish this and when" is exactly the trail FR-015 exists for, and
 * suppressing it would hide a repeated failed publish.
 *
 * Auth: STAFF_TECH (ADMIN + DEVELOPER).
 */
export async function setVolunteerPackStatus(
  deps: SetVolunteerPackStatusDeps,
  rawInput: unknown,
): Promise<SetVolunteerPackStatusOutput> {
  const input = parseInput(setVolunteerPackStatusInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: STAFF_TECH,
  });

  const pack = await deps.repos.tx(async (tx) => {
    const prior = await tx.volunteering.getPack(input.packId);
    if (!prior) {
      throw fail("VOLUNTEER_PACK_NOT_FOUND");
    }

    const updated = await tx.volunteering.updatePack(input.packId, {
      status: input.status,
      curatedByHumanId: input.actorHumanId,
    });

    await tx.audit.log({
      entity: "volunteer_pack",
      entityId: updated.id,
      action:
        input.status === "LIVE"
          ? "volunteer_pack.published"
          : "volunteer_pack.unpublished",
      data: {
        actorHumanId: input.actorHumanId,
        key: updated.key,
        from: prior.status,
        to: updated.status,
      },
      at: deps.clock.now(),
    });

    return updated;
  });

  deps.logger?.info("setVolunteerPackStatus.completed", {
    packId: pack.id,
    status: pack.status,
  });

  return setVolunteerPackStatusOutputSchema.parse({ pack });
}
