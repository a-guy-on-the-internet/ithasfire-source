import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { STAFF_TECH } from "@th/types";

import { parseInput } from "../../../lib/io";
import { requirePlatformStaff } from "../../../lib/rbac";
import { ticketPackStatusSchema, ticketPackWithCountsSchema } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const listTicketPacksAdminInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    /** Omitted = every pack, DRAFT included. This is the staff read. */
    status: ticketPackStatusSchema.optional(),
  })
  .strict();

export const listTicketPacksAdminOutputSchema = z
  .object({ packs: z.array(ticketPackWithCountsSchema) })
  .strict();

export type ListTicketPacksAdminInput = z.infer<
  typeof listTicketPacksAdminInputSchema
>;
export type ListTicketPacksAdminOutput = z.infer<
  typeof listTicketPacksAdminOutputSchema
>;

export type ListTicketPacksAdminDeps = {
  repos: Pick<Repos, "ticketTypeTemplates">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Staff catalogue list (spec FR-012): every pack with status, its catalogue
 * template + entry counts, and the number of owned forks descended from it.
 *
 * Gated on STAFF_TECH (ADMIN + DEVELOPER), matching /platform/volunteer-packs
 * — pack content is published platform-wide and shipping a typo to every
 * organizer is an engineering-owned action.
 */
export async function listTicketPacksAdmin(
  deps: ListTicketPacksAdminDeps,
  rawInput: unknown,
): Promise<ListTicketPacksAdminOutput> {
  const input = parseInput(listTicketPacksAdminInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: STAFF_TECH,
  });

  const packs = await deps.repos.ticketTypeTemplates.listPacks(
    input.status ? { status: input.status } : undefined,
  );

  return listTicketPacksAdminOutputSchema.parse({ packs });
}
