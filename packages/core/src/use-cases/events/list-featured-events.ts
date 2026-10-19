import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { EventRecord, EventStatus, Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  cardVenueName,
  resolveVenueConfirmationByEvent,
} from "../../lib/venue-confirmation";
import { projectPublicEventLocation } from "../../lib/location/project-public-event-location";
import type { PlaceLocationSource } from "../../lib/location/redact-place-location";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 48;

const featuredEventSchema = z
  .object({
    eventId: z.string().uuid(),
    title: z.string(),
    status: z.custom<EventStatus>(),
    slug: z.string().nullable(),
    startsAt: z.date(),
    addressText: z.string().nullable(),
    /** Venue name — only when the venue confirmed the event. */
    placeName: z.string().nullable(),
    regionCode: z.string().nullable(),
  })
  .strict();

export const listFeaturedEventsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    categorySlug: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const listFeaturedEventsOutputSchema = z
  .object({
    events: z.array(featuredEventSchema),
  })
  .strict();

export type ListFeaturedEventsInput = z.infer<
  typeof listFeaturedEventsInputSchema
>;
export type ListFeaturedEventsOutput = z.infer<
  typeof listFeaturedEventsOutputSchema
>;

export type ListFeaturedEventsDeps = {
  repos: Pick<Repos, "events" | "places">;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Deliberate-swallow reporter (ReporterPort convention). Handed to
   * `resolveVenueConfirmationByEvent`, which degrades a venue whose row
   * cannot be read (not confirmed, fully hidden) instead of failing the
   * page — that degradation must reach Sentry, not only the log.
   */
  reportError?: ReporterPort;
};

const toFeaturedEvent = (
  record: EventRecord,
  /**
   * The venue's name for the card label: the confirmed venue's name, or an
   * unconfirmed COMMUNITY listing's name-only display per
   * `mayNameUnconfirmedVenue` (owner ruling 2026-10-07) — both read from
   * `VenueConfirmationResolution.displayPlaceName`, the same value the search
   * indexer uses. A plain-text label ONLY: never a link, venue id, or
   * confirmed mark.
   */
  displayPlaceName: string | null,
  /** `VenueConfirmationResolution.confirmed` — gates the unconfirmed name on an EXACT public location. */
  venueConfirmed: boolean,
  /**
   * The venue's privacy row from the same batched place read
   * (`VenueConfirmationResolution.placeLocation`); null for no place. The
   * card label goes through the public projection — an OBSCURED event (or
   * one at a withheld venue) prints "locality, region", never its street.
   */
  placeLocation: PlaceLocationSource | null,
) => {
  const location = projectPublicEventLocation(record, { place: placeLocation });
  return featuredEventSchema.parse({
    eventId: record.id,
    title: record.title,
    status: record.status,
    slug: record.slug ?? null,
    startsAt: record.startsAt,
    addressText: location.label,
    placeName: cardVenueName(displayPlaceName, venueConfirmed, location),
    regionCode: record.regionCode ?? null,
  });
};

export async function listFeaturedEvents(
  deps: ListFeaturedEventsDeps,
  rawInput: unknown,
): Promise<ListFeaturedEventsOutput> {
  const input = parseInput(listFeaturedEventsInputSchema, rawInput);

  const paginated = await deps.repos.events.filterByCategory({
    categorySlug: input.categorySlug ?? null,
    limit: input.limit,
    offset: 0,
    startsAfter: new Date(),
  });

  const events = paginated.items;

  deps.logger?.info("events.list_featured", {
    limit: input.limit,
    categorySlug: input.categorySlug ?? null,
    resultCount: events.length,
    total: paginated.pageInfo.total,
  });

  const venueConfirmation = await resolveVenueConfirmationByEvent(
    deps,
    events,
    { useCase: "listFeaturedEvents" },
  );
  const mapped = events.map((record) =>
    toFeaturedEvent(
      record,
      venueConfirmation.get(record.id)?.displayPlaceName ?? null,
      venueConfirmation.get(record.id)?.confirmed ?? false,
      venueConfirmation.get(record.id)?.placeLocation ?? null,
    ),
  );
  return listFeaturedEventsOutputSchema.parse({ events: mapped });
}
