import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { EventRecord, Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { resolveTimeZone } from "../../lib/venue-local-time";
import {
  projectPublicEventLocation,
  publicDistanceMeters,
} from "../../lib/location/project-public-event-location";
import type { PlaceLocationSource } from "../../lib/location/redact-place-location";
import {
  cardVenueName,
  resolveVenueConfirmationByEvent,
} from "../../lib/venue-confirmation";
import {
  gateHeroUrl,
  resolveVisibleHeroKeys,
} from "../moderation/gate-image-visibility";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 48;
const MAX_OFFSET = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const discoverPublicEventsInputSchema = z
  .object({
    /** Viewer latitude — when provided, events are enriched with distance. */
    userLat: z.number().min(-90).max(90).optional(),
    /** Viewer longitude — when provided, events are enriched with distance. */
    userLng: z.number().min(-180).max(180).optional(),
    /** Filter to events within this region code. */
    regionCode: z.string().trim().min(2).max(64).optional(),
    /** Filter to events within this country code. */
    countryCode: z.string().trim().min(2).max(8).optional(),
    /** Filter to events in this category (by slug). */
    categorySlug: z.string().trim().min(1).max(64).optional(),
    /** Tag-based filter — events must match at least one tag. */
    tags: z.array(z.string().trim().min(1)).optional(),
    /** Date range preset filter. */
    dateRange: z.enum(["today", "this_week", "this_weekend"]).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.number().int().min(0).max(MAX_OFFSET).default(0),
  })
  .strict();

const discoverEventSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: z.string(),
  slug: z.string().nullable(),
  startsAt: z.date().or(z.string()),
  /** `Event.timezone`, resolved: the card's date renders in it, not UTC. */
  timezone: z.string(),
  addressText: z.string().nullable(),
  /** Venue name when the event is at a linked Place; null for freeform. */
  placeName: z.string().nullable(),
  regionCode: z.string().nullable(),
  heroImageUrl: z.string().nullable(),
  gateType: z.enum(["NONE", "PASSWORD", "APPLICATION"]).optional(),
  // True when the event carries a recurrence schedule (a single Event that
  // repeats, e.g. a weekly open mic). Surfaces a "Recurring" card affordance.
  isRecurring: z.boolean(),
  distanceKm: z.number().nonnegative().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

export const discoverPublicEventsOutputSchema = z
  .object({
    events: z.array(discoverEventSummarySchema),
    total: z.number().int().nonnegative(),
  })
  .strict();

export type DiscoverPublicEventsInput = z.infer<
  typeof discoverPublicEventsInputSchema
>;
export type DiscoverPublicEventsOutput = z.infer<
  typeof discoverPublicEventsOutputSchema
>;

export type DiscoverPublicEventsDeps = {
  repos: Pick<Repos, "events" | "imageModerationRecords" | "places">;
  logger?: LoggerPort;
  /**
   * Deliberate-swallow reporter (ReporterPort convention). Handed to
   * `resolveVenueConfirmationByEvent`, which degrades a venue whose row
   * cannot be read (not confirmed, fully hidden) instead of failing the
   * page — that degradation must reach Sentry, not only the log.
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type DiscoverEventSummary = z.infer<typeof discoverEventSummarySchema>;

const toSummary = (
  record: EventRecord,
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
   * The event's venue privacy row from the same batched place read
   * (`VenueConfirmationResolution.placeLocation`); null for no place.
   */
  placeLocation: PlaceLocationSource | null,
  userLat?: number,
  userLng?: number,
): DiscoverEventSummary => {
  // THE public projection: the label never carries an OBSCURED event's
  // street, and the distance is measured to the EMITTED point (the keyed
  // circle centre), never the stored one — a true distance from a few viewer
  // positions trilaterates the house. Hidden → no distance at all.
  const location = projectPublicEventLocation(record, {
    place: placeLocation,
  });
  let distanceKm: number | null = null;
  if (userLat != null && userLng != null) {
    const distanceMeters = publicDistanceMeters(
      { lat: userLat, lng: userLng },
      location,
    );
    distanceKm = distanceMeters === null ? null : distanceMeters / 1000;
  }

  return {
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
    distanceKm,
    tags: [], // Phase 1: tags are empty; will be populated when tag model exists
  };
};

const getDateRangeBounds = (
  preset: "today" | "this_week" | "this_weekend",
): { start: Date; end: Date } => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (preset) {
    case "today": {
      const todayEnd = new Date(todayStart);
      todayEnd.setDate(todayEnd.getDate() + 1);
      return { start: todayStart, end: todayEnd };
    }
    case "this_week": {
      const weekEnd = new Date(todayStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      return { start: todayStart, end: weekEnd };
    }
    case "this_weekend": {
      const dayOfWeek = todayStart.getDay(); // 0=Sun, 6=Sat
      const daysToFriday = dayOfWeek <= 5 ? 5 - dayOfWeek : 6; // next Friday
      const friday = new Date(todayStart);
      friday.setDate(friday.getDate() + daysToFriday);
      const monday = new Date(friday);
      monday.setDate(monday.getDate() + 3); // Monday after
      return { start: friday, end: monday };
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function discoverPublicEvents(
  deps: DiscoverPublicEventsDeps,
  rawInput: unknown,
): Promise<DiscoverPublicEventsOutput> {
  const input = parseInput(discoverPublicEventsInputSchema, rawInput);

  // Fetch published events. Filter by category, region, country, or global.
  // All public discovery excludes past events — `startsAfter: now` is the floor.
  const startsAfter = new Date();
  let paginated;
  if (input.categorySlug) {
    paginated = await deps.repos.events.filterByCategory({
      categorySlug: input.categorySlug,
      limit: input.limit,
      offset: input.offset,
      startsAfter,
    });
  } else if (input.regionCode) {
    paginated = await deps.repos.events.listPublishedByRegion({
      regionCode: input.regionCode,
      limit: input.limit,
      offset: input.offset,
      startsAfter,
    });
  } else if (input.countryCode) {
    paginated = await deps.repos.events.listPublishedByCountry({
      countryCode: input.countryCode,
      limit: input.limit,
      offset: input.offset,
      startsAfter,
    });
  } else {
    paginated = await deps.repos.events.listPublished({
      limit: input.limit,
      offset: input.offset,
      startsAfter,
      // A PRIVATE event is link-only: `listPublished` returns every
      // visibility by default (the search indexer needs them), so the public
      // feed must ask for PUBLIC explicitly.
      visibility: ["PUBLIC"],
      // A banned owner's events are withheld (ban-that-sticks).
      excludeBannedOwners: true,
    });
  }

  let events = paginated.items;

  // ── Date range filter (client-side for now) ─────────────────────────────
  if (input.dateRange) {
    const { start, end } = getDateRangeBounds(input.dateRange);
    events = events.filter((e) => {
      const eventStart = e.startsAt;
      return eventStart >= start && eventStart < end;
    });
  }

  // ── Moderation visibility gate (FR-005): drop pending/flagged heroes ────
  // (absent record = legacy = visible). One batched resolveByKeys for the page.
  const visibleHeroKeys = await resolveVisibleHeroKeys(deps.repos, events);

  // ── Map to summaries with distance ─────────────────────────────────────
  const venueConfirmation = await resolveVenueConfirmationByEvent(
    deps,
    events,
    { useCase: "discoverPublicEvents" },
  );
  let summaries = events.map((e) =>
    toSummary(
      e,
      visibleHeroKeys,
      venueConfirmation.get(e.id)?.displayPlaceName ?? null,
      venueConfirmation.get(e.id)?.confirmed ?? false,
      venueConfirmation.get(e.id)?.placeLocation ?? null,
      input.userLat,
      input.userLng,
    ),
  );

  // ── Sort by distance when user location is available ────────────────────
  if (input.userLat != null && input.userLng != null) {
    summaries = summaries.sort((a, b) => {
      const da = a.distanceKm ?? Infinity;
      const db = b.distanceKm ?? Infinity;
      return da - db;
    });
  }

  deps.logger?.info("events.discover_public", {
    categorySlug: input.categorySlug,
    regionCode: input.regionCode,
    countryCode: input.countryCode,
    dateRange: input.dateRange,
    userHasLocation: input.userLat != null,
    limit: input.limit,
    offset: input.offset,
    resultCount: summaries.length,
    total: paginated.pageInfo.total,
  });

  return discoverPublicEventsOutputSchema.parse({
    events: summaries,
    total: paginated.pageInfo.total,
  });
}
