import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { STAFF_TECH } from "@th/types";

import { parseInput } from "../../../lib/io";
import { requirePlatformStaff } from "../../../lib/rbac";
import { volunteerPackWithRolesSchema } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const getVolunteerPackAdminInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    packId: z.string().uuid(),
  })
  .strict();

export const getVolunteerPackAdminOutputSchema = z
  .object({ pack: volunteerPackWithRolesSchema })
  .strict();

export type GetVolunteerPackAdminInput = z.infer<
  typeof getVolunteerPackAdminInputSchema
>;
export type GetVolunteerPackAdminOutput = z.infer<
  typeof getVolunteerPackAdminOutputSchema
>;

export type GetVolunteerPackAdminDeps = {
  repos: Pick<Repos, "volunteering">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Staff preview + editor read (FR-016): one pack with its catalogue roles and
 * their shift presets, EXACTLY as an organizer would see it — including while
 * the pack is DRAFT.
 *
 * Authorization is STAFF_TECH and NOTHING ELSE. Pack status is deliberately
 * not part of the gate: previewing an unpublished pack before shipping it to
 * every organizer is the whole point of the DRAFT state.
 *
 * This exists because the organizer-facing reads are status-filtered by
 * construction and must stay that way: `listVolunteerPacks` is LIVE-only in
 * the repo, and `getRoleTemplateWithShifts` returns `null` for a platform row
 * (it has no orgId to authorize a read against). Neither is widened to serve
 * staff — the staff path gets its own status-blind read instead, so a future
 * change here cannot loosen the organizer path.
 */
export async function getVolunteerPackAdmin(
  deps: GetVolunteerPackAdminDeps,
  rawInput: unknown,
): Promise<GetVolunteerPackAdminOutput> {
  const input = parseInput(getVolunteerPackAdminInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: STAFF_TECH,
  });

  const pack = await deps.repos.volunteering.getPackWithRoles(input.packId);
  if (!pack) {
    throw fail("VOLUNTEER_PACK_NOT_FOUND");
  }

  return getVolunteerPackAdminOutputSchema.parse({ pack });
}
