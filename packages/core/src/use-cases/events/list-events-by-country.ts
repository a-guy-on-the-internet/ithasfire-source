import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { ReadThroughCachePort } from "@th/ports/read-through-cache";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import {
  loadPricingByEventId,
  pricingSummarySchema,
  type PricingSummary,
} from "./_shared/event-pricing";

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

const eventCountrySummarySchema = z
  .object({
    eventId: z.string(),
    title: z.string(),
    status: z.string(),
    slug: z.string().nullable(),
    startsAt: z.date(),
    /** `Event.timezone`, resolved: the card's date renders in it, not UTC. */
    timezone: z.string(),
    addressText: z.string().nullable(),
    /** Venue name — only when the venue confirmed the event. */
    placeName: z.string().nullable(),
    countryCode: z.string().nullable(),
    regionCode: z.string().nullable(),
    heroImageUrl: z.string().nullable(),
    gateType: z.enum(["NONE", "PASSWORD", "APPLICATION"]).optional(),
    /**
     * Same rollup `listEventsByLocation` returns, and for the same reason: the
     * transport mapper needs it to print a price.
     *
     * Without it this use case could only ever produce "See details", so the
     * home page quoted real prices when the reader had granted location (the
     * tiered SEARCH path, which carries pricing from the index) and quoted
     * none when they had not (this DB fallback). Same events, same grid, price
     * present or absent depending on a browser permission.
     */
    pricing: pricingSummarySchema.nullable(),
  })
  .strict();

export const listEventsByCountryInputSchema = z
  .object({
    countryCode: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const listEventsByCountryOutputSchema = z
  .object({
    events: z.array(eventCountrySummarySchema),
  })
  .strict();

export type ListEventsByCountryInput = z.infer<
  typeof listEventsByCountryInputSchema
>;
export type ListEventsByCountryOutput = z.infer<
  typeof listEventsByCountryOutputSchema
>;

export type ListEventsByCountryDeps = {
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
  /**
   * Optional whole-result cache. Hand one in ONLY for requests whose answer
   * cannot depend on the caller — the transport passes it for anonymous
   * requests only. Every input that changes the answer is in the key. Only
   * the first page of a two-letter country is cached.
   *
   * Writes through the API (publish, privacy changes, moderation, …) reach the
   * cache through its generation within seconds. What only the TTL bounds:
   * changes driven by the clock (an event that has started, a price tier that
   * flips at `clock.now()`) and by background jobs (a hero newly APPROVED).
   * A load that swallowed a failure (reported) is returned but never cached.
   */
  cache?: ReadThroughCachePort;
};

const normalizeCountryCode = (value: string): string =>
  value.trim().toUpperCase();

const toCountrySummary = (
  record: EventRecord,
  visibleHeroKeys: ReadonlySet<string>,
  pricing: PricingSummary | null,
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
  return eventCountrySummarySchema.parse({
    eventId: record.id,
    title: record.title,
    status: record.status,
    slug: record.slug ?? null,
    startsAt: record.startsAt,
    timezone: resolveTimeZone(record.timezone),
    addressText: location.label,
    placeName: cardVenueName(displayPlaceName, venueConfirmed, location),
    countryCode: record.countryCode ?? null,
    regionCode: record.regionCode ?? null,
    heroImageUrl: gateHeroUrl(record, visibleHeroKeys),
    gateType: record.gateType !== "NONE" ? record.gateType : undefined,
    pricing,
  });
};

export async function listEventsByCountry(
  deps: ListEventsByCountryDeps,
  rawInput: unknown,
): Promise<ListEventsByCountryOutput> {
  const input = parseInput(listEventsByCountryInputSchema, rawInput);
  const normalizedCountryCode = normalizeCountryCode(input.countryCode);

  const load = () =>
    loadEventsByCountry(deps, {
      countryCode: normalizedCountryCode,
      limit: input.limit,
      offset: input.offset,
    });

  // Only the home-page shape is cached: a real two-letter country and the
  // first page. Anything else (arbitrary strings, deep pages) would only fill
  // the cache with keys nobody asks for twice.
  const cacheable =
    deps.cache !== undefined &&
    COUNTRY_CODE.test(normalizedCountryCode) &&
    input.offset === 0;
  if (!cacheable || !deps.cache) return (await load()).output;

  try {
    return await deps.cache.getOrLoad(
      `events.listEventsByCountry:v2:${JSON.stringify([
        normalizedCountryCode,
        input.limit,
      ])}`,
      async () => {
        const result = await load();
        // A degraded answer (a swallowed venue-read failure) is correct for
        // THIS request but must not be served to everyone for a TTL.
        if (result.degraded) throw new DegradedCountryEvents(result.output);
        return result.output;
      },
    );
  } catch (err) {
    if (err instanceof DegradedCountryEvents) return err.output;
    throw err;
  }
}

const COUNTRY_CODE = /^[A-Z]{2}$/;

/**
 * Internal signal: the load succeeded but swallowed a failure on the way
 * (reported through `reportError`). Thrown inside the cache load so the cache
 * never stores it; every caller that shared the load gets the degraded answer.
 */
class DegradedCountryEvents extends Error {
  constructor(readonly output: ListEventsByCountryOutput) {
    super("degraded");
    this.name = "DegradedCountryEvents";
  }
}

async function loadEventsByCountry(
  deps: ListEventsByCountryDeps,
  input: { countryCode: string; limit: number; offset: number },
): Promise<{ output: ListEventsByCountryOutput; degraded: boolean }> {
  const normalizedCountryCode = input.countryCode;
  const now = deps.clock.now();
  // Every deliberate swallow below reports through `reportError` (CLAUDE.md
  // reporter rule), so a report during this load IS the "degraded" signal.
  let degraded = false;
  const reportError: ReporterPort = (err, context) => {
    degraded = true;
    deps.reportError?.(err, context);
  };

  const paginated = await deps.repos.events.listPublishedByCountry({
    countryCode: normalizedCountryCode,
    limit: input.limit,
    offset: input.offset,
    startsAfter: now,
    // This use case returns `{ events }` and nothing else — no caller can see
    // a total or a next-page cursor, so the COUNT(*) that produced them was
    // pure cost. Skipping it makes `pageInfo` a lower bound; nothing below
    // reads it.
    includeTotal: false,
  });

  const events = paginated.items;

  deps.logger?.info("events.list_by_country", {
    countryCode: normalizedCountryCode,
    limit: input.limit,
    offset: input.offset,
    resultCount: events.length,
  });

  const visibleHeroKeys = await resolveVisibleHeroKeys(deps.repos, events);
  // `now` comes from the injected clock, not `new Date()`: this rollup feeds
  // the price on every card this query produces, and a defaulted clock would
  // leave them quoting a pre-flip price indefinitely (FR-003).
  //
  // The all-in part degrades through `reportError` — the local wrapper, so a
  // page whose prices fell back to "See details" is never cached for a TTL.
  const pricingByEventId = await loadPricingByEventId(
    { repos: deps.repos, logger: deps.logger, reportError },
    events,
    now,
    { useCase: "listEventsByCountry" },
  );
  const venueConfirmation = await resolveVenueConfirmationByEvent(
    { ...deps, reportError },
    events,
    { useCase: "listEventsByCountry" },
  );
  const mapped = events.map((record) =>
    toCountrySummary(
      record,
      visibleHeroKeys,
      pricingByEventId.get(record.id) ?? null,
      venueConfirmation.get(record.id)?.displayPlaceName ?? null,
      venueConfirmation.get(record.id)?.confirmed ?? false,
      venueConfirmation.get(record.id)?.placeLocation ?? null,
    ),
  );
  return {
    output: listEventsByCountryOutputSchema.parse({ events: mapped }),
    degraded,
  };
}
