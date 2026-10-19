import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type {
  EventRecord,
  Repos,
  TxRepos,
  SaveEventInput,
} from "@th/ports/repos";
import type { TemplateDefaults } from "./schemas";
import {
  applyTemplateToEventDraftInputSchema,
  applyTemplateToEventDraftResultSchema,
  type ApplyTemplateToEventDraftInput,
  type ApplyTemplateToEventDraftResult,
  type TemplateOverrides,
} from "./schemas";
import type { TemplateOwnerContext } from "./permissions";
import { ensureTemplateOwnerAccess } from "./permissions";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { onEventLocationChanged } from "../arrival-areas/on-event-location-changed";
import { fail } from "@th/errors";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type ApplyTemplateToEventDraftDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

interface StoredApplyTemplateResult {
  payloadHash: string;
  response: ApplyTemplateToEventDraftResult;
}

export async function applyTemplateToEventDraft(
  deps: ApplyTemplateToEventDraftDeps,
  rawInput: unknown,
): Promise<ApplyTemplateToEventDraftResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "applyTemplateToEventDraft",
  });

  const execute = async () => {
    const input = parseInput(applyTemplateToEventDraftInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `event-template:apply:${input.templateId}:${input.eventId}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredApplyTemplateResult>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredApplyTemplateResult>(idempotencyKey);
      if (afterWait) {
        if (afterWait.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return afterWait.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      const result = await deps.repos.tx(async (tx) => {
        const template = await tx.eventTemplates.getById(input.templateId);
        if (!template) {
          throw fail("TEMPLATE_NOT_FOUND");
        }

        if (!template.active) {
          throw fail("TEMPLATE_INACTIVE");
        }

        if (template.archivedAt) {
          throw fail("TEMPLATE_ARCHIVED");
        }

        const owner = await ensureTemplateOwnerAccess(
          tx,
          template.ownerScope,
          template.ownerId,
          input.actorHumanId,
          { purpose: "edit" },
          scopedLogger,
        );

        const event = await tx.events.getById(input.eventId);
        if (!event) {
          throw fail("EVENT_NOT_FOUND");
        }

        ensureEventMatchesOwner(event, owner);

        if (event.status !== "DRAFT") {
          throw fail("EVENT_NOT_DRAFT");
        }

        const defaults = template.defaults ?? ({} as TemplateDefaults);
        const overrides = input.overrides ?? ({} as TemplateOverrides);

        const appliedFields: string[] = [];
        let pendingEvent = event;
        let nextLocation = getEventLocation(event);
        let nextTitle = event.title;

        const resolvedTitle = overrides.title ?? defaults.title;
        if (resolvedTitle !== undefined && resolvedTitle !== event.title) {
          nextTitle = resolvedTitle;
          appliedFields.push("title");
        }

        const resolvedLocation = overrides.location ?? defaults.location;
        if (resolvedLocation !== undefined) {
          const normalizedLocation =
            normalizeTemplateLocation(resolvedLocation);
          if (!areLocationsEqual(normalizedLocation, nextLocation)) {
            await ensureLocationAccessible(tx, owner, normalizedLocation);
            nextLocation = normalizedLocation;
            appliedFields.push("location");
          }
        }

        if (appliedFields.length > 0) {
          pendingEvent = await tx.events.upsertDraft({
            eventId: event.id,
            orgId: event.orgId,
            humanId: event.humanId,
            title: nextTitle,
            startsAt: event.startsAt,
            endsAt: event.endsAt ?? event.startsAt,
            status: "DRAFT",
            location: nextLocation,
          });

          if (
            appliedFields.includes("location") &&
            nextLocation.kind === "saved-location" &&
            event.savedLocationId !== nextLocation.savedLocationId
          ) {
            await tx.savedLocations.incrementUsage(
              nextLocation.savedLocationId,
            );
          }

          // arrival-areas FR-014: a template that moves the draft to another
          // place or address switches its own areas off and drops stale
          // hides, in this transaction, audited.
          if (appliedFields.includes("location")) {
            await onEventLocationChanged(tx, {
              before: event,
              after: pendingEvent,
              actorHumanId: input.actorHumanId,
              now: deps.clock.now(),
            });
          }

          const now = deps.clock.now();
          await tx.audit.log({
            entity: "event_template",
            entityId: template.id,
            action: "applied",
            data: { eventId: event.id, appliedFields },
            at: now,
          });
        }

        return applyTemplateToEventDraftResultSchema.parse({
          eventId: pendingEvent.id,
          appliedFields,
        });
      });

      await deps.idempotency.commit<StoredApplyTemplateResult>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("apply_template_to_event_draft", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("applyTemplateToEventDraft", execute);
  }

  return execute();
}

function buildPayloadHash(input: ApplyTemplateToEventDraftInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function ensureEventMatchesOwner(
  event: EventRecord,
  owner: TemplateOwnerContext,
): void {
  if (owner.kind === "org") {
    if (!event.orgId || event.orgId !== owner.orgId) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "template" } });
    }
  } else if (!event.humanId || event.humanId !== owner.humanId) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "template" } });
  }
}

function getEventLocation(event: EventRecord): SaveEventInput["location"] {
  if (event.placeId) {
    return { kind: "place", placeId: event.placeId };
  }
  if (event.savedLocationId) {
    return { kind: "saved-location", savedLocationId: event.savedLocationId };
  }
  if (event.addressText && event.lat !== null && event.lng !== null) {
    return {
      kind: "freeform",
      addressText: event.addressText,
      lat: event.lat,
      lng: event.lng,
    };
  }
  return { kind: "none" };
}

function normalizeTemplateLocation(
  location: NonNullable<TemplateDefaults["location"]>,
): SaveEventInput["location"] {
  switch (location.kind) {
    case "place":
      return { kind: "place", placeId: location.placeId };
    case "saved-location":
      return {
        kind: "saved-location",
        savedLocationId: location.savedLocationId,
      };
    case "freeform":
      return {
        kind: "freeform",
        addressText: location.addressText,
        lat: location.lat,
        lng: location.lng,
      };
    case "none":
    default:
      return { kind: "none" };
  }
}

function areLocationsEqual(
  a: SaveEventInput["location"],
  b: SaveEventInput["location"],
): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "place":
      return b.kind === "place" && a.placeId === b.placeId;
    case "saved-location":
      return (
        b.kind === "saved-location" && a.savedLocationId === b.savedLocationId
      );
    case "freeform":
      return (
        b.kind === "freeform" &&
        a.addressText === b.addressText &&
        a.lat === b.lat &&
        a.lng === b.lng
      );
    case "none":
      return true;
  }
}

async function ensureLocationAccessible(
  tx: TxRepos,
  owner: TemplateOwnerContext,
  location: SaveEventInput["location"],
): Promise<void> {
  if (location.kind === "place") {
    if (owner.kind === "org") {
      const place = await tx.places.getById(location.placeId);
      if (!place || !place.orgIdsWithAccess.includes(owner.orgId)) {
        throw fail("PLACE_NOT_FOUND");
      }
      if (place.status !== "ACTIVE") {
        throw fail("PLACE_NOT_ACTIVE");
      }
    } else {
      const place = await tx.places.getById(location.placeId);
      if (!place || !place.humanIdsWithAccess.includes(owner.humanId)) {
        throw fail("PLACE_NOT_FOUND");
      }
      if (place.status !== "ACTIVE") {
        throw fail("PLACE_NOT_ACTIVE");
      }
    }
    return;
  }

  if (location.kind === "saved-location") {
    if (owner.kind === "org") {
      const saved = await tx.savedLocations.getAccessibleByOrg({
        id: location.savedLocationId,
        orgId: owner.orgId,
      });
      if (!saved) {
        throw fail("SAVED_LOCATION_NOT_FOUND");
      }
    } else {
      const saved = await tx.savedLocations.getAccessibleByHuman({
        id: location.savedLocationId,
        humanId: owner.humanId,
      });
      if (!saved) {
        throw fail("SAVED_LOCATION_NOT_FOUND");
      }
    }
    return;
  }

  if (location.kind === "freeform") {
    // no additional access validation required for freeform
    return;
  }

  if (location.kind === "none") {
    return;
  }
}
