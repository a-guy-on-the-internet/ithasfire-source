import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { STAFF_TECH } from "@th/types";

import { parseInput } from "../../../lib/io";
import { requirePlatformStaff } from "../../../lib/rbac";
import { ticketPackRecordSchema, ticketPackStatusSchema } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const setTicketPackStatusInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    packId: z.string().uuid(),
    status: ticketPackStatusSchema,
  })
  .strict();

export const setTicketPackStatusOutputSchema = z
  .object({ pack: ticketPackRecordSchema })
  .strict();

export type SetTicketPackStatusInput = z.infer<
  typeof setTicketPackStatusInputSchema
>;
export type SetTicketPackStatusOutput = z.infer<
  typeof setTicketPackStatusOutputSchema
>;

export type SetTicketPackStatusDeps = {
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
 * from `upsertTicketPack` and separately audited.
 *
 * Unpublishing is non-destructive: the pack's catalogue templates stay, they
 * just stop appearing in organizer reads. Owned FORKS are unaffected — and
 * events the templates were applied to are copies, untouched by definition
 * (spec FR-008).
 *
 * A no-op transition still writes an audit row on purpose: "who tried to
 * publish this and when" is exactly the trail the audit exists for.
 *
 * Auth: STAFF_TECH (ADMIN + DEVELOPER).
 */
export async function setTicketPackStatus(
  deps: SetTicketPackStatusDeps,
  rawInput: unknown,
): Promise<SetTicketPackStatusOutput> {
  const input = parseInput(setTicketPackStatusInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: STAFF_TECH,
  });

  const pack = await deps.repos.tx(async (tx) => {
    const prior = await tx.ticketTypeTemplates.getPack(input.packId);
    if (!prior) {
      throw fail("TICKET_PACK_NOT_FOUND");
    }

    const updated = await tx.ticketTypeTemplates.updatePack(input.packId, {
      status: input.status,
      curatedByHumanId: input.actorHumanId,
    });

    await tx.audit.log({
      entity: "ticket_pack",
      entityId: updated.id,
      action:
        input.status === "LIVE"
          ? "ticket_pack.published"
          : "ticket_pack.unpublished",
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

  deps.logger?.info("setTicketPackStatus.completed", {
    packId: pack.id,
    status: pack.status,
  });

  return setTicketPackStatusOutputSchema.parse({ pack });
}
