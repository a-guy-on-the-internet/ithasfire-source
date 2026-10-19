import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { saveEventInputSchema, saveEventOutputSchema } from "./schemas";
import { getSaveableEventOrThrow } from "./shared";

export type SaveEventInput = z.infer<typeof saveEventInputSchema>;
export type SaveEventOutput = z.infer<typeof saveEventOutputSchema>;

export type SaveEventDeps = {
  repos: Pick<Repos, "tx" | "eventSaves" | "events">;
  logger?: LoggerPort;
};

/**
 * Idempotent keep-for-later bookmark (FR-001). The actor must be able to see
 * the event (PUBLISHED — same gate as the detail page); saving carries no
 * side effects beyond the save row itself (FR-002).
 */
export async function saveEvent(
  deps: SaveEventDeps,
  rawInput: unknown,
): Promise<SaveEventOutput> {
  const logger = deps.logger?.child({ useCase: "saveEvent" });

  const execute = async () => {
    const input = parseInput(saveEventInputSchema, rawInput);
    await getSaveableEventOrThrow(deps.repos, input.eventId);

    const save = await deps.repos.tx(async (tx) => {
      const result = await tx.eventSaves.upsert({
        eventId: input.eventId,
        humanId: input.actorHumanId,
      });

      if (result.created) {
        await tx.audit.log({
          entity: "event_save",
          entityId: result.save.id,
          action: "event_save.created",
          data: {
            actorHumanId: input.actorHumanId,
            eventId: input.eventId,
          },
        });
      }

      return {
        saveId: result.save.id,
        alreadySaved: !result.created,
      } as const;
    });

    return saveEventOutputSchema.parse(save);
  };

  if (logger) {
    return logger.withTime("saveEvent", execute);
  }

  return execute();
}
