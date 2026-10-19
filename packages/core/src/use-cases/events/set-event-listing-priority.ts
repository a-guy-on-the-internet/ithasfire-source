import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { ensureActorCanEditEvent } from "./_shared/ensure-actor-can-edit-event";

import { parseInput } from "../../lib/io";

const prioritySchema = z.number().int().min(-1000).max(1000);

export const setEventListingPriorityInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    priority: prioritySchema.nullable(),
  })
  .strict();

export const setEventListingPriorityOutputSchema = z
  .object({
    eventId: z.uuid(),
    listingPriority: z.number().int().nullable(),
  })
  .strict();

export type SetEventListingPriorityInput = z.infer<
  typeof setEventListingPriorityInputSchema
>;
export type SetEventListingPriorityOutput = z.infer<
  typeof setEventListingPriorityOutputSchema
>;

export type SetEventListingPriorityDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function setEventListingPriority(
  deps: SetEventListingPriorityDeps,
  rawInput: unknown,
): Promise<SetEventListingPriorityOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "setEventListingPriority",
  });

  const execute = async () => {
    const input = parseInput(setEventListingPriorityInputSchema, rawInput);

    const updated = await deps.repos.tx(async (tx) => {
      const event = await ensureActorCanEditEvent(
        tx,
        input.eventId,
        input.actorHumanId,
      );

      const result = await tx.events.setListingPriority({
        eventId: event.id,
        priority: input.priority,
      });

      const now = deps.clock.now();
      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "event_listing_priority_set",
        data: {
          actorHumanId: input.actorHumanId,
          priority: input.priority,
        },
        at: now,
      });

      return result;
    });

    return setEventListingPriorityOutputSchema.parse({
      eventId: updated.id,
      listingPriority: updated.listingPriority ?? null,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("setEventListingPriority", execute);
  }

  return execute();
}
