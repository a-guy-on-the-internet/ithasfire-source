import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import { applicationThreadPartySchema, resolveThreadParty } from "./_shared/application-thread";

export const markApplicationMessagesReadInputSchema = z
  .object({
    party: applicationThreadPartySchema,
    /** Only messages with createdAt <= upToCreatedAt are stamped. */
    upToCreatedAt: z.coerce.date(),
  })
  .strict();

export const markApplicationMessagesReadOutputSchema = z
  .object({
    /** Rows newly stamped read (0 on a repeat). */
    updated: z.number().int().nonnegative(),
  })
  .strict();

export type MarkApplicationMessagesReadInput = z.input<
  typeof markApplicationMessagesReadInputSchema
>;
export type MarkApplicationMessagesReadOutput = z.infer<
  typeof markApplicationMessagesReadOutputSchema
>;

export type MarkApplicationMessagesReadDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * The reading side stamps `readAt` on the OTHER side's messages up to a
 * timestamp (FR-015; mirrors markBookingRequestMessagesRead). Only
 * counterparty rows that are still unread are touched, so the marker is
 * monotonic (never re-stamped, never cleared) and a repeat is a no-op. One
 * `readAt` per message, per side: any organizer member reading clears the
 * organizer side's badge.
 *
 * Works on a read-only (WITHDRAWN) thread: reading history still clears
 * the badge. Audit: none (benign, self-only, high-frequency; the booking
 * mark-read precedent).
 */
export async function markApplicationMessagesRead(
  deps: MarkApplicationMessagesReadDeps,
  rawInput: unknown,
): Promise<MarkApplicationMessagesReadOutput> {
  const input = parseInput(markApplicationMessagesReadInputSchema, rawInput);
  const now = deps.clock.now();

  const { updated, submissionId, side } = await deps.repos.tx(async (tx) => {
    const party = await resolveThreadParty(tx, input.party, now);
    const count = await tx.eventApplications.markApplicationMessagesRead({
      submissionId: party.submission.id,
      readerSide: party.side,
      upToCreatedAt: input.upToCreatedAt,
      readAt: now,
    });
    return { updated: count, submissionId: party.submission.id, side: party.side };
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    action: "messages_marked_read",
    submissionId,
    side,
    updated,
  });

  return markApplicationMessagesReadOutputSchema.parse({ updated });
}
