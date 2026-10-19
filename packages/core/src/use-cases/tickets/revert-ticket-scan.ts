import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_SCAN_ROLES, requireOrgMembership } from "../../lib/rbac";
import { fail } from "@th/errors";

/** Operators can revert a scan within this window after it was recorded. */
const UNDO_WINDOW_MS = 60_000;

export const revertTicketScanInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ticketId: z.uuid(),
  })
  .strict();

export type RevertTicketScanInput = z.infer<typeof revertTicketScanInputSchema>;

export type RevertTicketScanOutput = {
  ticketId: string;
  reverted: true;
};

export type RevertTicketScanDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function revertTicketScan(
  deps: RevertTicketScanDeps,
  rawInput: unknown,
): Promise<RevertTicketScanOutput> {
  const input = parseInput(revertTicketScanInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ticket = await tx.tickets.getById(input.ticketId);
    if (!ticket) {
      throw fail("TICKET_NOT_FOUND");
    }

    const event = await tx.events.getById(ticket.eventId);
    if (!event || !event.orgId) {
      throw fail("EVENT_NOT_FOUND");
    }

    await requireOrgMembership({
      repos: tx,
      orgId: event.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_SCAN_ROLES,
    });

    if (ticket.status !== "SCANNED" || !ticket.scannedAt) {
      throw fail("TICKET_NOT_SCANNED");
    }

    const now = deps.clock.now();
    const elapsed = now.getTime() - ticket.scannedAt.getTime();
    if (elapsed > UNDO_WINDOW_MS) {
      throw fail("UNDO_WINDOW_EXPIRED");
    }

    // From SCANNED only, the status read above. A refund that landed since
    // the read made the ticket terminal; reverting it to VALID would retake
    // its capacity place without the lock (refunds-restock spec 2026-10-09).
    const reverted = await tx.tickets.setStatus(input.ticketId, "VALID", {
      scannedAt: null,
      expectedStatus: "SCANNED",
    });
    if (!reverted) {
      throw fail("TICKET_NOT_SCANNED");
    }

    deps.logger?.info("tickets.revert_scan", {
      ticketId: input.ticketId,
      actorHumanId: input.actorHumanId,
      elapsedMs: elapsed,
    });

    return { ticketId: input.ticketId, reverted: true as const };
  });
}
