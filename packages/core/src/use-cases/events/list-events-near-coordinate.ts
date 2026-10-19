import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  GEO_DEFAULT_LIMIT,
  GEO_MAX_LIMIT,
  type EventDTO,
  type GeoPort,
  eventDtoSchema,
  latitudeSchema,
  longitudeSchema,
} from "@th/ports/geo";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import {
  gateHeroUrl,
  resolveVisibleHeroKeys,
} from "../moderation/gate-image-visibility";

const MAX_RADIUS_METERS = 200_000;

export const listEventsNearCoordinateInputSchema = z
  .object({
    lat: latitudeSchema,
    lng: longitudeSchema,
    radiusM: z.number().positive().max(MAX_RADIUS_METERS),
    limit: z
      .number()
      .int()
      .min(1)
      .max(GEO_MAX_LIMIT)
      .default(GEO_DEFAULT_LIMIT),
    offset: z.number().int().min(0).default(0),
    /** Only include events that start at or after this instant. */
    startsAfter: z.coerce.date().optional(),
    /** Only include events that start before this instant. */
    startsBefore: z.coerce.date().optional(),
  })
  .strict();

export const listEventsNearCoordinateOutputSchema = z
  .object({
    events: z.array(eventDtoSchema),
  })
  .strict();

export type ListEventsNearCoordinateInput = z.infer<
  typeof listEventsNearCoordinateInputSchema
>;
export type ListEventsNearCoordinateOutput = z.infer<
  typeof listEventsNearCoordinateOutputSchema
>;

export type ListEventsNearCoordinateDeps = {
  geo: Pick<GeoPort, "nearbyEvents">;
  repos: Pick<Repos, "imageModerationRecords">;
  logger?: LoggerPort;
};

// Gate the hero (FR-005) BEFORE eventDtoSchema.parse — which strips the raw
// `heroImageKey` from the public output. Absent record = legacy = visible.
const sanitizeEvent = (event: EventDTO, visibleHeroKeys: ReadonlySet<string>) =>
  eventDtoSchema.parse({
    ...event,
    heroImageUrl: gateHeroUrl(event, visibleHeroKeys),
  });

export async function listEventsNearCoordinate(
  deps: ListEventsNearCoordinateDeps,
  rawInput: unknown,
): Promise<ListEventsNearCoordinateOutput> {
  const input = parseInput(listEventsNearCoordinateInputSchema, rawInput);

  const paginated = await callOrDependencyFailed(
    () =>
      deps.geo.nearbyEvents({
        lat: input.lat,
        lng: input.lng,
        radiusM: input.radiusM,
        limit: input.limit,
        offset: input.offset,
        startsAfter: input.startsAfter,
        startsBefore: input.startsBefore,
      }),
    deps.logger,
    {
      action: "geo.nearby_events",
      lat: input.lat,
      lng: input.lng,
      radiusM: input.radiusM,
      limit: input.limit,
      offset: input.offset,
    },
  );

  const events = paginated.items;

  deps.logger?.info("events.list_near_coordinate", {
    lat: input.lat,
    lng: input.lng,
    radiusM: input.radiusM,
    limit: input.limit,
    offset: input.offset,
    resultCount: events.length,
    total: paginated.pageInfo.total,
  });

  const visibleHeroKeys = await resolveVisibleHeroKeys(deps.repos, events);
  const sanitized = events.map((e) => sanitizeEvent(e, visibleHeroKeys));
  return listEventsNearCoordinateOutputSchema.parse({ events: sanitized });
}
