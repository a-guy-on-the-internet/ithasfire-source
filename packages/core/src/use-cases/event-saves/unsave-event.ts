import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { unsaveEventInputSchema, unsaveEventOutputSchema } from "./schemas";

export type UnsaveEventInput = z.infer<typeof unsaveEventInputSchema>;
export type UnsaveEventOutput = z.infer<typeof unsaveEventOutputSchema>;

export type UnsaveEventDeps = {
  repos: Pick<Repos, "tx" | "eventSaves">;
  logger?: LoggerPort;
};

/**
 * Idempotent removal of the actor's own bookmark. Deliberately no visibility
 * check — you can always unsave, even events you can no longer see.
 */
export async function unsaveEvent(
  deps: UnsaveEventDeps,
  rawInput: unknown,
): Promise<UnsaveEventOutput> {
  const logger = deps.logger?.child({ useCase: "unsaveEvent" });

  const execute = async () => {
    const input = parseInput(unsaveEventInputSchema, rawInput);

    await deps.repos.tx(async (tx) => {
      const result = await tx.eventSaves.delete({
        eventId: input.eventId,
        humanId: input.actorHumanId,
      });
      if (!result.deleted || !result.saveId) {
        return;
      }

      await tx.audit.log({
        entity: "event_save",
        entityId: result.saveId,
        action: "event_save.deleted",
        data: {
          actorHumanId: input.actorHumanId,
          eventId: input.eventId,
        },
      });
    });

    return unsaveEventOutputSchema.parse({ success: true });
  };

  if (logger) {
    return logger.withTime("unsaveEvent", execute);
  }

  return execute();
}
