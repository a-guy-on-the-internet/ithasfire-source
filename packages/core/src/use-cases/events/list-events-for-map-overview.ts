import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  GEO_MAX_LIMIT,
  type EventDTO,
  type GeoPort,
  eventDtoSchema,
} from "@th/ports/geo";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import {
  gateHeroUrl,
  resolveVisibleHeroKeys,
} from "../moderation/gate-image-visibility";

/**
 * Continental US bounding box — generous enough to capture events in all 48
 * contiguous states plus some buffer into southern Canada / northern Mexico.
 */
const US_BOUNDING_BOX = {
  sw: { lat: 24.0, lng: -125.0 }, // south-west (below Key West)
  ne: { lat: 50.0, lng: -66.0 }, // north-east (above Maine)
};

export const listEventsForMapOverviewInputSchema = z
  .object({
    limit: z.number().int().min(1).max(GEO_MAX_LIMIT).default(100),
    /** Only include events that start at or after this instant. */
    startsAfter: z.coerce.date().optional(),
    /** Only include events that start before this instant. */
    startsBefore: z.coerce.date().optional(),
  })
  .strict();

export const listEventsForMapOverviewOutputSchema = z
  .object({
    events: z.array(eventDtoSchema),
  })
  .strict();

export type ListEventsForMapOverviewInput = z.infer<
  typeof listEventsForMapOverviewInputSchema
>;
export type ListEventsForMapOverviewOutput = z.infer<
  typeof listEventsForMapOverviewOutputSchema
>;

export type ListEventsForMapOverviewDeps = {
  geo: Pick<GeoPort, "boxSearch">;
  repos: Pick<Repos, "imageModerationRecords">;
  logger?: LoggerPort;
};

/**
 * Lightweight overview query for the hero map — returns all geocoded events
 * within the continental US bounding box so the homepage always shows pins
 * even when the visitor has not shared their location.
 */
export async function listEventsForMapOverview(
  deps: ListEventsForMapOverviewDeps,
  rawInput: unknown,
): Promise<ListEventsForMapOverviewOutput> {
  const input = parseInput(listEventsForMapOverviewInputSchema, rawInput);

  const results = await callOrDependencyFailed(
    () =>
      deps.geo.boxSearch({
        sw: US_BOUNDING_BOX.sw,
        ne: US_BOUNDING_BOX.ne,
        entity: "event",
        limit: input.limit,
        startsAfter: input.startsAfter,
        startsBefore: input.startsBefore,
      }),
    deps.logger,
    {
      action: "geo.box_search_events_overview",
      limit: input.limit,
    },
  );

  // boxSearch returns Array<PlaceDTO | EventDTO> — filter to events only
  const events = results.filter((r): r is EventDTO => "title" in r);

  deps.logger?.info("events.list_for_map_overview", {
    limit: input.limit,
    resultCount: events.length,
  });

  // Gate the hero (FR-005) BEFORE eventDtoSchema.parse — which strips the raw
  // `heroImageKey`. Absent record = legacy = visible. One batched lookup.
  const visibleHeroKeys = await resolveVisibleHeroKeys(deps.repos, events);
  const sanitized = events.map((e) =>
    eventDtoSchema.parse({
      ...e,
      heroImageUrl: gateHeroUrl(e, visibleHeroKeys),
    }),
  );
  return listEventsForMapOverviewOutputSchema.parse({ events: sanitized });
}
