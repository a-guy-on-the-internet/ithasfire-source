import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { actorHoldsEventEditRole } from "../../lib/event-edit-rights";

import {
  baseSaveEventInputSchema,
  ensureEndsAfterStarts,
  ensurePlaceAccessibleForHuman,
  ensureSavedLocationAccessibleForHuman,
  finalizeSaveEvent,
  fetchAndValidateExistingEvent,
  normalizeLocation,
  OwnerContext,
  parseInput,
  type SaveEventDeps,
  type SaveEventOutput,
  venuePlacementInputShape,
} from "./_shared/save-event-shared";

export const saveEventForHumanInputSchema = baseSaveEventInputSchema.extend(
  // Venue-hierarchy placement (FR-005/FR-011) — optional, validated against
  // the resolved Place inside the save transaction.
  venuePlacementInputShape,
);

export type SaveEventForHumanInput = z.infer<
  typeof saveEventForHumanInputSchema
>;

export async function saveEventForHuman(
  deps: SaveEventDeps,
  rawInput: unknown,
): Promise<SaveEventOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "saveEventForHuman" });

  const execute = async () => {
    const input = parseInput(saveEventForHumanInputSchema, rawInput);
    return executeSaveEventForHuman(deps, scopedLogger, input);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("saveEventForHuman", execute);
  }

  return execute();
}

async function executeSaveEventForHuman(
  deps: SaveEventDeps,
  logger: LoggerPort | undefined,
  input: SaveEventForHumanInput,
): Promise<SaveEventOutput> {
  ensureEndsAfterStarts(input.startsAt, input.endsAt ?? null);

  const location = normalizeLocation(input.location);
  const { repos } = deps;
  const owner: OwnerContext = {
    kind: "human",
    humanId: await resolveSaveOwnerHumanId(
      repos,
      input.eventId ?? null,
      input.actorHumanId,
    ),
  };

  const human = await repos.humans.getById(owner.humanId);
  if (!human) {
    throw fail("HUMAN_NOT_FOUND");
  }

  // Validate event ownership BEFORE location access so a scope mismatch
  // surfaces as the truthful NOT_RESOURCE_OWNER error instead of being masked
  // by a PLACE_NOT_FOUND from checking the place against the acting scope.
  const eventId = input.eventId ?? null;
  const existingEvent = eventId
    ? await fetchAndValidateExistingEvent(repos, owner, eventId, logger)
    : null;

  if (location.kind === "place") {
    // Skip re-validation when the place is unchanged on an existing event:
    // it is already attached, and re-checking it against the acting scope
    // would break legitimate edits (and block edits if the place later went
    // inactive). Newly-set or changed placeIds keep full validation — that is
    // the security boundary against attaching an inaccessible place.
    // Deliberate trade-off: a place's later SUSPENSION or access revocation is
    // NOT an edit-block for an already-attached place — enforcing venue-side
    // revocation would be a dedicated detach/moderation flow, not this check.
    const placeUnchanged =
      existingEvent !== null && existingEvent.placeId === location.placeId;
    if (!placeUnchanged) {
      await ensurePlaceAccessibleForHuman(
        repos.places,
        owner.humanId,
        location.placeId,
        logger,
      );
    }
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
    eventId,
    existingEvent,
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
    calendarId: input.calendarId,
    spaceId: input.spaceId,
    bookingIntent: input.bookingIntent,
    clientKey: input.clientKey,
  });
}

/**
 * WHOSE event this save writes. The OWNER, never the actor, whenever they
 * differ: a delegate saving the principal's personal event (owner ruling
 * 2026-09-28) must leave `humanId = principal`. Resolving the owner to the
 * actor here would, on the create path, mint the event under the delegate —
 * and on the edit path, fail the ownership check below or (worse, if that
 * check ever loosened) re-home the principal's event onto the delegate.
 *
 *  - New event (no `eventId`)   → the actor. This input carries no
 *    principal to create FOR, so a brand-new blank event is the actor's.
 *  - Existing human-owned event whose owner the actor holds an edit role for
 *    (the owner, or an OWNER/ADMIN/EDITOR delegate — `actorHoldsEventEditRole`)
 *    → the event's owner.
 *  - Anything else → the actor, so `fetchAndValidateExistingEvent` refuses
 *    with the same `NOT_RESOURCE_OWNER` (or `EVENT_NOT_FOUND`) as before.
 *
 * Place / saved-location access is then checked against the OWNER's scope —
 * the delegate is acting for the principal, as an org EDITOR acts for the org.
 */
async function resolveSaveOwnerHumanId(
  repos: Repos,
  eventId: string | null,
  actorHumanId: string,
): Promise<string> {
  if (!eventId) return actorHumanId;
  const event = await repos.events.getById(eventId);
  if (!event || event.orgId || !event.humanId) return actorHumanId;
  if (event.humanId === actorHumanId) return actorHumanId;
  const canEdit = await actorHoldsEventEditRole(
    repos.authz,
    { orgId: null, humanId: event.humanId },
    actorHumanId,
  );
  return canEdit ? event.humanId : actorHumanId;
}
