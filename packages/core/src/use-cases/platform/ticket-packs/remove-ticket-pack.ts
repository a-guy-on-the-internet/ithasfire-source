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

export const removeTicketPackInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    packId: z.string().uuid(),
  })
  .strict();

export const removeTicketPackOutputSchema = z
  .object({
    removed: z.boolean(),
    /** Catalogue rows deleted alongside the pack. */
    deletedTemplateCount: z.number().int().min(0),
  })
  .strict();

export type RemoveTicketPackInput = z.infer<typeof removeTicketPackInputSchema>;
export type RemoveTicketPackOutput = z.infer<
  typeof removeTicketPackOutputSchema
>;

export type RemoveTicketPackDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * The CHECK constraint that turns a mis-ordered delete into a loud failure
 * instead of an orphaned catalogue row. Postgres reports CHECK violations
 * with no distinguishing Prisma `P` code, so the constraint NAME in the
 * message is the only reliable signal (same shape as
 * `removeVolunteerPack`'s handling).
 */
const PLATFORM_PACK_CHECK = "TicketTypeTemplate_platform_pack_check";

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
 * Delete a pack and its catalogue templates, leaving every owned fork
 * intact (spec FR-012: "Deleting a pack deletes its platform templates;
 * owned forks survive via SetNull packId").
 *
 * ORDERING IS MANDATORY, and DB-enforced: the `packId` FK is SET NULL (the
 * fork-safe half), and `TicketTypeTemplate_platform_pack_check` makes the
 * SET NULL of a surviving PLATFORM row raise, so, in ONE transaction:
 *
 *   1. `deletePlatformTemplatesByPack` — `packId` AND `isPlatform`, so
 *      owned forks (`isPlatform` false) are not matched.
 *   2. Re-count; anything left means a concurrent insert landed — surface
 *      the typed TICKET_PACK_HAS_PLATFORM_TEMPLATES.
 *   3. `deletePack` (wrapped: a CHECK violation from a row committed after
 *      the count is translated to the same typed error, not an opaque 500).
 *
 * Auth: STAFF_TECH (ADMIN + DEVELOPER). Writes an AuditLog row.
 */
export async function removeTicketPack(
  deps: RemoveTicketPackDeps,
  rawInput: unknown,
): Promise<RemoveTicketPackOutput> {
  const input = parseInput(removeTicketPackInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: STAFF_TECH,
  });

  const result = await deps.repos.tx(async (tx) => {
    const pack = await tx.ticketTypeTemplates.getPack(input.packId);
    if (!pack) {
      throw fail("TICKET_PACK_NOT_FOUND");
    }

    // 1 — catalogue rows first. Owned forks are excluded by `isPlatform`.
    const deletedTemplateCount =
      await tx.ticketTypeTemplates.deletePlatformTemplatesByPack(input.packId);

    // 2 — typed pre-check, not a raw CHECK violation.
    const remaining =
      await tx.ticketTypeTemplates.countPlatformTemplatesByPack(input.packId);
    if (remaining > 0) {
      throw fail("TICKET_PACK_HAS_PLATFORM_TEMPLATES", {
        meta: { packId: input.packId, remaining },
      });
    }

    // 3 — the pack itself. Owned forks SET NULL here and survive.
    try {
      await tx.ticketTypeTemplates.deletePack(input.packId);
    } catch (error) {
      if (isPlatformPackCheckViolation(error)) {
        throw fail("TICKET_PACK_HAS_PLATFORM_TEMPLATES", {
          meta: { packId: input.packId },
        });
      }
      throw error;
    }

    await tx.audit.log({
      entity: "ticket_pack",
      entityId: input.packId,
      action: "ticket_pack.deleted",
      data: {
        actorHumanId: input.actorHumanId,
        key: pack.key,
        name: pack.name,
        status: pack.status,
        deletedTemplateCount,
      },
      at: deps.clock.now(),
    });

    return { removed: true, deletedTemplateCount };
  });

  deps.logger?.info("removeTicketPack.completed", {
    packId: input.packId,
    deletedTemplateCount: result.deletedTemplateCount,
  });

  return removeTicketPackOutputSchema.parse(result);
}
