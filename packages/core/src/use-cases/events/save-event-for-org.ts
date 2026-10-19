import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";

import {
  baseSaveEventInputSchema,
  ensureEndsAfterStarts,
  ensurePlaceAccessibleForOrg,
  ensureSavedLocationAccessibleForOrg,
  finalizeSaveEvent,
  fetchAndValidateExistingEvent,
  normalizeLocation,
  OwnerContext,
  parseInput,
  type SaveEventDeps,
  type SaveEventOutput,
  venuePlacementInputShape,
} from "./_shared/save-event-shared";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";

export const saveEventForOrgInputSchema = baseSaveEventInputSchema.extend({
  orgId: z.uuid(),
  // Venue-hierarchy placement (FR-005/FR-011) — optional, validated against
  // the resolved Place inside the save transaction.
  ...venuePlacementInputShape,
});

export type SaveEventForOrgInput = z.infer<typeof saveEventForOrgInputSchema>;

export async function saveEventForOrg(
  deps: SaveEventDeps,
  rawInput: unknown,
): Promise<SaveEventOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "saveEventForOrg" });

  const execute = async () => {
    const input = parseInput(saveEventForOrgInputSchema, rawInput);
    return executeSaveEventForOrg(deps, scopedLogger, input);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("saveEventForOrg", execute);
  }

  return execute();
}

async function executeSaveEventForOrg(
  deps: SaveEventDeps,
  logger: LoggerPort | undefined,
  input: SaveEventForOrgInput,
): Promise<SaveEventOutput> {
  ensureEndsAfterStarts(input.startsAt, input.endsAt ?? null);

  const location = normalizeLocation(input.location);
  const owner: OwnerContext = { kind: "org", orgId: input.orgId };
  const { repos } = deps;

  const org = await repos.organizations.getById(owner.orgId);
  if (!org) {
    throw fail("ORGANIZATION_NOT_FOUND");
  }

  const membership = await requireOrgMembership({
    repos,
    orgId: owner.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

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
      await ensurePlaceAccessibleForOrg(
        repos.places,
        owner.orgId,
        location.placeId,
        logger,
      );
    }
  } else if (location.kind === "saved-location") {
    await ensureSavedLocationAccessibleForOrg(
      repos,
      owner.orgId,
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
