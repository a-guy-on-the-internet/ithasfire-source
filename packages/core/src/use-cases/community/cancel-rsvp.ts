import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

/**
 * FR-004 (community-managed-event-listings spec): reversible RSVP — un-RSVP
 * is an idempotent delete of the (eventId, humanId) row. Deliberately no
 * event-state gating: a user must always be able to withdraw their "I'm
 * going" marker, even if the event has since been cancelled/unpublished
 * (deleting a non-existent RSVP is a no-op by the repo contract).
 */

export const cancelRsvpInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();

export const cancelRsvpOutputSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export type CancelRsvpInput = z.infer<typeof cancelRsvpInputSchema>;
export type CancelRsvpOutput = z.infer<typeof cancelRsvpOutputSchema>;

export type CancelRsvpDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function cancelRsvp(
  deps: CancelRsvpDeps,
  rawInput: unknown,
): Promise<CancelRsvpOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "cancelRsvp" });

  const execute = async (): Promise<CancelRsvpOutput> => {
    const input = parseInput(cancelRsvpInputSchema, rawInput);

    await deps.repos.eventRsvps.delete({
      eventId: input.eventId,
      humanId: input.actorHumanId,
    });

    return cancelRsvpOutputSchema.parse({ ok: true });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("cancelRsvp", execute);
  }

  return execute();
}
