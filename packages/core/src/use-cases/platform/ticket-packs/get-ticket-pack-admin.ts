import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { STAFF_TECH } from "@th/types";

import { parseInput } from "../../../lib/io";
import { requirePlatformStaff } from "../../../lib/rbac";
import { ticketPackWithTemplatesSchema } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const getTicketPackAdminInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    packId: z.string().uuid(),
  })
  .strict();

export const getTicketPackAdminOutputSchema = z
  .object({ pack: ticketPackWithTemplatesSchema })
  .strict();

export type GetTicketPackAdminInput = z.infer<
  typeof getTicketPackAdminInputSchema
>;
export type GetTicketPackAdminOutput = z.infer<
  typeof getTicketPackAdminOutputSchema
>;

export type GetTicketPackAdminDeps = {
  repos: Pick<Repos, "ticketTypeTemplates">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Staff preview + editor read (spec FR-012): one pack with its catalogue
 * templates, EXACTLY as an organizer would see it — including while DRAFT.
 *
 * Authorization is STAFF_TECH and NOTHING ELSE. Pack status is deliberately
 * not part of the gate: previewing an unpublished pack before shipping it to
 * every organizer is the whole point of the DRAFT state. The organizer-facing
 * reads stay LIVE-only by construction and are never widened to serve staff.
 */
export async function getTicketPackAdmin(
  deps: GetTicketPackAdminDeps,
  rawInput: unknown,
): Promise<GetTicketPackAdminOutput> {
  const input = parseInput(getTicketPackAdminInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: STAFF_TECH,
  });

  const pack = await deps.repos.ticketTypeTemplates.getPackWithTemplates(
    input.packId,
  );
  if (!pack) {
    throw fail("TICKET_PACK_NOT_FOUND");
  }

  return getTicketPackAdminOutputSchema.parse({ pack });
}
