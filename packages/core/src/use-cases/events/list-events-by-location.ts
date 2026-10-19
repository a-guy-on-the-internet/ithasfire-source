import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { EventRecord, EventStatus, Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { resolveTimeZone } from "../../lib/venue-local-time";
import {
  cardVenueName,
  resolveVenueConfirmationByEvent,
} from "../../lib/venue-confirmation";
import { projectPublicEventLocation } from "../../lib/location/project-public-event-location";
import type { PlaceLocationSource } from "../../lib/location/redact-place-location";
import {
  gateHeroUrl,
  resolveVisibleHeroKeys,
} from "../moderation/gate-image-visibility";
import {
  loadPricingByEventId,
  pricingSummarySchema,
  type PricingSummary,
} from "./_shared/event-pricing";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 48;
const MAX_OFFSET = 500;

/**
 * Summary shape for event location listings.
 * Uses `id` to match EventRecord from @th/types (not `eventId`).
 */
const eventLocationSummarySchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    status: z.custom<EventStatus>(),
    slug: z.string().nullable(),
    startsAt: z.date(),
    /** `Event.timezone`, resolved: the card's date renders in it, not UTC. */
    timezone: z.string(),
    addressText: z.string().nullable(),
    /** Venue name — only when the venue confirmed the event. */
    placeName: z.string().nullable(),
    regionCode: z.string().nullable(),
    heroImageUrl: z.string().nullable(),
    gateType: z.enum(["NONE", "PASSWORD", "APPLICATION"]).optional(),
    // True when the event carries a recurrence schedule (a single Event that
    // repeats, e.g. a weekly open mic). Surfaces a "Recurring" card affordance.
    isRecurring: z.boolean(),
    pricing: pricingSummarySchema.nullable(),
  })
  .strict();

export const listEventsByLocationInputSchema = z
  .object({
    regionCode: z.string().trim().min(2).max(64),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.number().int().min(0).max(MAX_OFFSET).default(0),
  })
  .strict();

export const listEventsByLocationOutputSchema = z
  .object({
    events: z.array(eventLocationSummarySchema),
  })
  .strict();

export type ListEventsByLocationInput = z.infer<
  typeof listEventsByLocationInputSchema
>;
export type ListEventsByLocationOutput = z.infer<
  typeof listEventsByLocationOutputSchema
>;

export type ListEventsByLocationDeps = {
  repos: Pick<
    Repos,
    | "events"
    | "imageModerationRecords"
    | "places"
    // The all-in card price (`loadPricingByEventId` → fee context + venue situs).
    | "payoutTerms"
    | "feePolicies"
    | "savedLocations"
  >;
  /** Required (FR-003) — `loadPricingByEventId` resolves each tier's price at `now`. */
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

const toLocationSummary = (
  record: EventRecord,
  pricing: PricingSummary | null,
  visibleHeroKeys: ReadonlySet<string>,
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
  return eventLocationSummarySchema.parse({
    id: record.id,
    title: record.title,
    status: record.status,
    slug: record.slug ?? null,
    startsAt: record.startsAt,
    timezone: resolveTimeZone(record.timezone),
    addressText: location.label,
    placeName: cardVenueName(displayPlaceName, venueConfirmed, location),
    regionCode: record.regionCode ?? null,
    heroImageUrl: gateHeroUrl(record, visibleHeroKeys),
    gateType: record.gateType !== "NONE" ? record.gateType : undefined,
    isRecurring: record.recurrenceSchedule != null,
    pricing,
  });
};

const normalizeRegionCode = (value: string): string =>
  value.trim().toLowerCase();

export async function listEventsByLocation(
  deps: ListEventsByLocationDeps,
  rawInput: unknown,
): Promise<ListEventsByLocationOutput> {
  const input = parseInput(listEventsByLocationInputSchema, rawInput);
  const normalizedRegionCode = normalizeRegionCode(input.regionCode);

  // ONE instant for the page query and its prices, from the injected clock
  // (as the country listing does): a card is never priced at a later moment
  // than the one that put it on the page.
  const now = deps.clock.now();
  const paginated = await deps.repos.events.listPublishedByRegion({
    regionCode: normalizedRegionCode,
    limit: input.limit,
    offset: input.offset,
    startsAfter: now,
  });

  const events = paginated.items;

  deps.logger?.info("events.list_by_location", {
    regionCode: normalizedRegionCode,
    limit: input.limit,
    offset: input.offset,
    resultCount: events.length,
    total: paginated.pageInfo.total,
  });

  const pricingByEventId = await loadPricingByEventId(
    deps,
    events,
    now,
    { useCase: "listEventsByLocation" },
  );
  const visibleHeroKeys = await resolveVisibleHeroKeys(deps.repos, events);
  const venueConfirmation = await resolveVenueConfirmationByEvent(
    deps,
    events,
    { useCase: "listEventsByLocation" },
  );
  const mapped = events.map((record) =>
    toLocationSummary(
      record,
      pricingByEventId.get(record.id) ?? null,
      visibleHeroKeys,
      venueConfirmation.get(record.id)?.displayPlaceName ?? null,
      venueConfirmation.get(record.id)?.confirmed ?? false,
      venueConfirmation.get(record.id)?.placeLocation ?? null,
    ),
  );
  return listEventsByLocationOutputSchema.parse({ events: mapped });
}
