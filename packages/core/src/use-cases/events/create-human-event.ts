import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import { fail } from "@th/errors";

import {
  baseSaveEventInputSchema,
  ensureEndsAfterStarts,
  ensurePlaceAccessibleForHuman,
  ensureSavedLocationAccessibleForHuman,
  finalizeSaveEvent,
  normalizeLocation,
  type OwnerContext,
  parseInput,
  type SaveEventDeps,
  type SaveEventOutput,
} from "./_shared/save-event-shared";

export const createHumanEventInputSchema = baseSaveEventInputSchema.omit({
  eventId: true,
});

export type CreateHumanEventInput = z.infer<typeof createHumanEventInputSchema>;

export async function createHumanEvent(
  deps: SaveEventDeps,
  rawInput: unknown,
): Promise<SaveEventOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "createHumanEvent" });

  const execute = async () => {
    const input = parseInput(createHumanEventInputSchema, rawInput);
    return executeCreateHumanEvent(deps, scopedLogger, input);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("createHumanEvent", execute);
  }

  return execute();
}

async function executeCreateHumanEvent(
  deps: SaveEventDeps,
  logger: LoggerPort | undefined,
  input: CreateHumanEventInput,
): Promise<SaveEventOutput> {
  ensureEndsAfterStarts(input.startsAt, input.endsAt ?? null);

  const location = normalizeLocation(input.location);
  const owner: OwnerContext = { kind: "human", humanId: input.actorHumanId };
  const { repos } = deps;

  const human = await repos.humans.getById(owner.humanId);
  if (!human) {
    throw fail("HUMAN_NOT_FOUND");
  }

  if (location.kind === "place") {
    await ensurePlaceAccessibleForHuman(
      repos.places,
      owner.humanId,
      location.placeId,
      logger,
    );
  } else if (location.kind === "saved-location") {
    await ensureSavedLocationAccessibleForHuman(
      repos,
      owner.humanId,
      location.savedLocationId,
      logger,
    );
  }

  return finalizeSaveEvent(deps, logger, {
    owner,
    actorHumanId: input.actorHumanId,
    eventId: null,
    existingEvent: null,
    title: input.title,
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? null,
    location,
    locationMode: input.locationMode,
    locationRadiusMeters: input.locationRadiusMeters,
    locationLabel: input.locationLabel,
    timezone: input.timezone,
    addressRevealPreset: input.addressRevealPreset,
    addressRevealAt: input.addressRevealAt,
    content: input.content,
    heroImageId: input.heroImageId,
    ageLimit: input.ageLimit,
    instructionalAdmission: input.instructionalAdmission,
    clientKey: input.clientKey,
  });
}
