import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { STAFF_TECH } from "@th/types";

import { parseInput } from "../../../lib/io";
import { requirePlatformStaff } from "../../../lib/rbac";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const removeVolunteerPackInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    packId: z.string().uuid(),
  })
  .strict();

export const removeVolunteerPackOutputSchema = z
  .object({
    removed: z.boolean(),
    /** Catalogue rows deleted alongside the pack. */
    deletedRoleCount: z.number().int().min(0),
  })
  .strict();

export type RemoveVolunteerPackInput = z.infer<
  typeof removeVolunteerPackInputSchema
>;
export type RemoveVolunteerPackOutput = z.infer<
  typeof removeVolunteerPackOutputSchema
>;

export type RemoveVolunteerPackDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * The CHECK constraint that turns a mis-ordered delete into a loud failure
 * instead of an orphaned catalogue row. Postgres reports CHECK violations
 * with no distinguishing error code — Prisma maps them to no `P` code at all
 * — so the constraint NAME in the message is the only reliable signal, and
 * matching on it beats letting the raw string surface as an opaque 500.
 */
const PLATFORM_PACK_CHECK = "VolunteerRoleTemplate_platform_pack_check";

function isPlatformPackCheckViolation(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.includes(PLATFORM_PACK_CHECK);
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete a pack and its catalogue roles, leaving every org-owned fork intact.
 *
 * ORDERING IS MANDATORY, and it is DB-enforced rather than documented-and-
 * hoped. The `packId` FK is `ON DELETE SET NULL`, which is the fork-safe half
 * of the rule: an org's customised copy keeps its provenance and outlives the
 * catalogue. Postgres allows exactly one referential action per FK, so the
 * other half — "a pack's PLATFORM rows die with it" — has to happen here. And
 * `VolunteerRoleTemplate_platform_pack_check` (`isPlatform = false OR packId
 * IS NOT NULL`) makes forgetting it fail: SET NULL on a surviving platform row
 * violates the CHECK, so the DELETE raises instead of quietly leaving rows
 * that no organizer read can reach and no job can collect.
 *
 * So, in ONE transaction:
 *   1. `deletePlatformRoleTemplatesByPack` — `packId` AND `isPlatform`, so
 *      org forks (`isPlatform` false) are not matched.
 *   2. Re-count. Anything left means a concurrent insert landed between the
 *      two statements; surface the typed `VOLUNTEER_PACK_HAS_PLATFORM_ROLES`
 *      rather than letting step 3 raise a raw constraint string.
 *   3. `deletePack`.
 *
 * Step 2 narrows the window but cannot close it (a row committed after the
 * count still breaks step 3), so step 3 is also wrapped: a CHECK violation is
 * translated to the same typed error instead of an opaque 500.
 *
 * Auth: STAFF_TECH (ADMIN + DEVELOPER). Writes an AuditLog row (FR-015).
 */
export async function removeVolunteerPack(
  deps: RemoveVolunteerPackDeps,
  rawInput: unknown,
): Promise<RemoveVolunteerPackOutput> {
  const input = parseInput(removeVolunteerPackInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: STAFF_TECH,
  });

  const result = await deps.repos.tx(async (tx) => {
    const pack = await tx.volunteering.getPack(input.packId);
    if (!pack) {
      throw fail("VOLUNTEER_PACK_NOT_FOUND");
    }

    // 1 — catalogue rows first. Org forks are excluded by `isPlatform`.
    const deletedRoleCount =
      await tx.volunteering.deletePlatformRoleTemplatesByPack(input.packId);

    // 2 — typed pre-check, not a raw CHECK violation.
    const remaining = await tx.volunteering.countPlatformRoleTemplatesByPack(
      input.packId,
    );
    if (remaining > 0) {
      throw fail("VOLUNTEER_PACK_HAS_PLATFORM_ROLES", {
        meta: { packId: input.packId, remaining },
      });
    }

    // 3 — the pack itself. Org forks SET NULL here and survive.
    try {
      await tx.volunteering.deletePack(input.packId);
    } catch (error) {
      if (isPlatformPackCheckViolation(error)) {
        throw fail("VOLUNTEER_PACK_HAS_PLATFORM_ROLES", {
          meta: { packId: input.packId },
        });
      }
      throw error;
    }

    await tx.audit.log({
      entity: "volunteer_pack",
      entityId: input.packId,
      action: "volunteer_pack.deleted",
      data: {
        actorHumanId: input.actorHumanId,
        key: pack.key,
        name: pack.name,
        status: pack.status,
        deletedRoleCount,
      },
      at: deps.clock.now(),
    });

    return { removed: true, deletedRoleCount };
  });

  deps.logger?.info("removeVolunteerPack.completed", {
    packId: input.packId,
    deletedRoleCount: result.deletedRoleCount,
  });

  return removeVolunteerPackOutputSchema.parse(result);
}
