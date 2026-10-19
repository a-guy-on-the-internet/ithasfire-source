import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

/**
 * Per-date un-RSVP for a recurring community listing (recurring-dates spec,
 * slice 2). Reversible: an idempotent delete of the (eventDateId, humanId)
 * row. Mirrors {@link cancelRsvp} — deliberately NO event/date-state gating: a
 * user must always be able to withdraw their "I'm going" marker, even if the
 * date has since been cancelled or already passed (deleting a non-existent
 * RSVP is a no-op by the repo contract).
 */

export const cancelEventDateRsvpInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventDateId: z.uuid(),
  })
  .strict();

export const cancelEventDateRsvpOutputSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export type CancelEventDateRsvpInput = z.infer<
  typeof cancelEventDateRsvpInputSchema
>;
export type CancelEventDateRsvpOutput = z.infer<
  typeof cancelEventDateRsvpOutputSchema
>;

export type CancelEventDateRsvpDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function cancelEventDateRsvp(
  deps: CancelEventDateRsvpDeps,
  rawInput: unknown,
): Promise<CancelEventDateRsvpOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "cancelEventDateRsvp" });

  const execute = async (): Promise<CancelEventDateRsvpOutput> => {
    const input = parseInput(cancelEventDateRsvpInputSchema, rawInput);

    await deps.repos.eventDateRsvps.delete({
      eventDateId: input.eventDateId,
      humanId: input.actorHumanId,
    });

    return cancelEventDateRsvpOutputSchema.parse({ ok: true });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("cancelEventDateRsvp", execute);
  }

  return execute();
}
