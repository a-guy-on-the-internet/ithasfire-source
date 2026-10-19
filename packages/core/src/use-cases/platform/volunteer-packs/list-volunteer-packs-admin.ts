import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { STAFF_TECH } from "@th/types";

import { parseInput } from "../../../lib/io";
import { requirePlatformStaff } from "../../../lib/rbac";
import {
  volunteerPackStatusSchema,
  volunteerPackWithCountsSchema,
} from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const listVolunteerPacksAdminInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    /** Omitted = every pack, DRAFT included. This is the staff read. */
    status: volunteerPackStatusSchema.optional(),
  })
  .strict();

export const listVolunteerPacksAdminOutputSchema = z
  .object({ packs: z.array(volunteerPackWithCountsSchema) })
  .strict();

export type ListVolunteerPacksAdminInput = z.infer<
  typeof listVolunteerPacksAdminInputSchema
>;
export type ListVolunteerPacksAdminOutput = z.infer<
  typeof listVolunteerPacksAdminOutputSchema
>;

export type ListVolunteerPacksAdminDeps = {
  repos: Pick<Repos, "volunteering">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Staff catalogue list (FR-014): every pack with status, targeting, its
 * catalogue-role count and the number of org-owned forks descended from it.
 *
 * Gated on STAFF_TECH (ADMIN + DEVELOPER), matching the fees and jobs panels
 * — NOT the wider STAFF_ALL that `featured` uses. A REVIEWER or SUPPORT staff
 * member is refused: pack content is published platform-wide and shipping a
 * typo to every organizer is an engineering-owned action.
 */
export async function listVolunteerPacksAdmin(
  deps: ListVolunteerPacksAdminDeps,
  rawInput: unknown,
): Promise<ListVolunteerPacksAdminOutput> {
  const input = parseInput(listVolunteerPacksAdminInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: STAFF_TECH,
  });

  const packs = await deps.repos.volunteering.listPacks(
    input.status ? { status: input.status } : undefined,
  );

  return listVolunteerPacksAdminOutputSchema.parse({ packs });
}
