import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import { fail } from "@th/errors";

import { generateVenueCalendarFeed, type ICalEvent } from "../../lib/ical";
import { parseInput } from "../../lib/io";
import { CALENDAR_FEED_COPY } from "../comms/copy/calendar-feeds";
import {
  resolveNotificationLocale,
  type NotificationLocale,
} from "../comms/locale";
import { publicIcalLocation } from "../../lib/location/public-ical-location";
import {
  expandFeedOccurrences,
  type FeedOccurrence,
} from "./expand-feed-occurrences";
import {
  publicPlaceEventFilters,
  resolvePublicPlace,
} from "./get-venue-calendar";

// ─────────────────────────────────────────────────────────────────────────────
// Public iCalendar feeds: place, organisation and host (webcal://).
//
// ANONYMOUS and cached for an hour, then copied into other people's calendar
// apps. Each feed lists only what a stranger may see on the public web:
// PUBLIC, plus PUBLISHED for live shows. A show that was called off stays in
// the feed as `STATUS:CANCELLED` (same UID, higher SEQUENCE) until it has
// passed, so a subscriber's calendar marks the night instead of silently
// losing it (owner ruling 2026-10-16). A cancelled event appears only if it
// was PUBLISHED at the moment it was cancelled (`cancelledFromStatus`, owner
// ruling 2026-10-17): a draft cancelled before anyone could see it, or a show
// unpublished, edited (new title, exact address) and then cancelled, never
// surfaces. `publishedAt` alone cannot say this: unpublish keeps it. A row
// cancelled before that column existed (NULL) is excluded too: its status at
// cancel is unknown, and no subscriber holds an entry for it (this read
// shipped with the column). A called-off night of a still-PUBLISHED listing
// is public and always listed.
//
// UIDs: a single-date event is `<eventId>@ithasfire.com`; one night of a
// multi-date listing is `<eventId>-<eventDateId>@ithasfire.com`, so N nights
// are N distinct VEVENTs a client keeps apart. The per-night UID replaced a
// shared `<eventId>@` UID on purpose (2026-10-17): N VEVENTs under one UID
// made clients keep one night. Subscribed calendars replace a feed's contents
// on each refresh, so the switch is a one-time change for subscribers; do not
// "restore" the shared UID.
//
// SEQUENCE must never decrease (RFC 5545 §3.8.7.4), and a night is NOT
// terminal: `restoreEventDate` flips CANCELLED back to SCHEDULED. So SEQUENCE
// is derived from LAST-MODIFIED (the later of the event's and the night's
// `updatedAt`, which only move forward): seconds since 2020-01-01, which
// stays inside the RFC's signed 32-bit INTEGER range until 2088.
//
// LOCATION: every LOCATION/GEO goes through `publicIcalLocation` (gated →
// none; non-EXACT → coarse label, no GEO). No ticket-holder reveal here.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Place feed: same look-ahead and live page size as the place page. */
const PLACE_WINDOW_MS = 90 * DAY_MS;
const PLACE_LIVE_LIMIT = 20;
/** Owner feeds keep the last 30 days so a just-passed show does not vanish. */
const OWNER_LOOKBACK_MS = 30 * DAY_MS;
const OWNER_LIVE_LIMIT = 200;
/** Cancelled shows are read separately and never crowd the live limit. */
const CANCELLED_LIMIT = 50;

/** SEQUENCE epoch: 2020-01-01T00:00:00Z (see the header). */
const SEQUENCE_EPOCH_MS = Date.UTC(2020, 0, 1);
const INT32_MAX = 2_147_483_647;

/** Monotonic SEQUENCE from the row's last write; 0 when unknown. */
export function feedSequence(lastModified: Date | null): number {
  if (!lastModified) return 0;
  const seconds = Math.floor(
    (lastModified.getTime() - SEQUENCE_EPOCH_MS) / 1000,
  );
  return Math.min(Math.max(seconds, 0), INT32_MAX);
}

const UID_DOMAIN = "ithasfire.com";

export type PublicCalendarFeedDeps = {
  repos: Pick<
    Repos,
    "events" | "eventDates" | "places" | "organizations" | "humans" | "bans"
  >;
  clock: ClockPort;
  /** Public web origin for event links (env.PUBLIC_WEB_URL). */
  appBaseUrl: string;
  logger?: LoggerPort;
};

export type PublicCalendarFeedOutput = {
  icsBody: string;
};

export const placeCalendarFeedInputSchema = z
  .object({ placeId: z.string().uuid(), lang: z.string().max(35).optional() })
  .strict();

export const ownerCalendarFeedInputSchema = z
  .object({
    ownerType: z.enum(["ORGANIZATION", "HUMAN"]),
    ownerId: z.string().uuid(),
    lang: z.string().max(35).optional(),
  })
  .strict();

/** Every error a feed throws for "there is no such public feed". */
export const PUBLIC_CALENDAR_FEED_NOT_FOUND_CODES: ReadonlySet<string> =
  new Set([
    "invalid_input",
    "PLACE_NOT_FOUND",
    "PLACE_NOT_VERIFIED",
    "PLACE_NOT_ACTIVE",
    "ORG_NOT_FOUND",
    "HUMAN_NOT_FOUND",
  ]);

// ─────────────────────────────────────────────────────────────────────────────
// Shared projection
// ─────────────────────────────────────────────────────────────────────────────

export function feedOccurrenceUid(
  eventId: string,
  eventDateId: string | null,
): string {
  return eventDateId
    ? `${eventId}-${eventDateId}@${UID_DOMAIN}`
    : `${eventId}@${UID_DOMAIN}`;
}

function eventUrl(appBaseUrl: string, slug: string | null): string | null {
  return slug ? `${appBaseUrl.replace(/\/+$/, "")}/events/${slug}` : null;
}

async function toICalEvents(
  occurrences: readonly FeedOccurrence<EventRecord>[],
  loadPlace: (placeId: string) => Promise<PlaceRecord | null>,
  opts: { appBaseUrl: string; hostName?: string | null },
): Promise<ICalEvent[]> {
  const seen = new Set<string>();
  const out: ICalEvent[] = [];
  for (const o of occurrences) {
    const uid = feedOccurrenceUid(o.event.id, o.eventDateId);
    // Defensive: one VEVENT per UID, whatever the reads returned.
    if (seen.has(uid)) continue;
    seen.add(uid);
    const { location, geo } = publicIcalLocation(
      o.event,
      o.event.placeId ? await loadPlace(o.event.placeId) : null,
    );
    const url = eventUrl(opts.appBaseUrl, o.event.slug);
    out.push({
      uid,
      title: o.event.title,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      location,
      geo,
      url,
      organizerName: opts.hostName ?? null,
      description: url,
      status: o.cancelled ? "CANCELLED" : "CONFIRMED",
      sequence: feedSequence(o.lastModified),
      lastModified: o.lastModified,
    });
  }
  return out;
}

function feedLabels(locale: NotificationLocale) {
  const copy = CALENDAR_FEED_COPY[locale];
  return { cancelled: copy.cancelled, hostedBy: copy.hostedBy };
}

/** One `places.getById` per distinct place per request. */
function memoizePlaceReads(
  repos: Pick<Repos, "places">,
): (placeId: string) => Promise<PlaceRecord | null> {
  const reads = new Map<string, Promise<PlaceRecord | null>>();
  return (placeId) => {
    let read = reads.get(placeId);
    if (!read) {
      read = repos.places.getById(placeId);
      reads.set(placeId, read);
    }
    return read;
  };
}

/** One row per event across the feed's reads (a listing can match several). */
function uniqueEvents(...pages: ReadonlyArray<readonly EventRecord[]>) {
  const byId = new Map<string, EventRecord>();
  for (const page of pages) {
    for (const event of page) if (!byId.has(event.id)) byId.set(event.id, event);
  }
  return [...byId.values()];
}

async function readFeedDates(
  repos: Pick<Repos, "eventDates">,
  events: readonly EventRecord[],
) {
  return events.length > 0
    ? repos.eventDates.listByEventIds({
        eventIds: events.map((e) => e.id),
        statuses: ["SCHEDULED", "CANCELLED"],
      })
    : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Place feed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The place feed (`/api/venues/:placeId/calendar.ics`). Same place gate and
 * event predicates as the public place calendar (`resolvePublicPlace`,
 * `publicPlaceEventFilters`); the place PAGE still hides cancelled shows, the
 * feed marks them.
 */
export async function buildPlaceCalendarFeed(
  deps: PublicCalendarFeedDeps,
  rawInput: unknown,
): Promise<PublicCalendarFeedOutput> {
  const input = parseInput(placeCalendarFeedInputSchema, rawInput);
  const locale = resolveNotificationLocale(input.lang);
  const place = await resolvePublicPlace(deps.repos, input.placeId);

  const now = deps.clock.now();
  const to = new Date(now.getTime() + PLACE_WINDOW_MS);
  const shared = {
    placeId: place.id,
    from: now,
    to,
    status: "upcoming" as const,
    offset: 0,
    includeDateOccurrences: true,
    ...publicPlaceEventFilters(place),
    // `publicPlaceEventFilters` sets `excludeBannedOwners`: resolve the
    // withheld set once for the three reads, not once per read.
    withheldOwners: await deps.repos.bans.listWithheldOwners(),
  };

  const [live, cancelled, calledOffNights] = await Promise.all([
    deps.repos.events.listPublishedByPlace({
      ...shared,
      limit: PLACE_LIVE_LIMIT,
    }),
    // Taken-down / cancelled events (their remaining nights are CANCELLED).
    deps.repos.events.listPublishedByPlace({
      ...shared,
      limit: CANCELLED_LIMIT,
      statuses: ["CANCELLED"],
      cancelledWhilePublished: true,
      dateOccurrenceStatuses: ["SCHEDULED", "CANCELLED"],
    }),
    // Live listings with a called-off night in the window. Calling off the
    // last upcoming night re-pins `startsAt` to the past, so neither read
    // above would see the listing at all.
    deps.repos.events.listPublishedByPlace({
      ...shared,
      limit: CANCELLED_LIMIT,
      matchDateOccurrencesOnly: true,
      dateOccurrenceStatuses: ["CANCELLED"],
    }),
  ]);

  const events = uniqueEvents(
    live.items,
    cancelled.items,
    calledOffNights.items,
  );
  const dates = await readFeedDates(deps.repos, events);
  const occurrences = expandFeedOccurrences(events, dates, {
    window: { from: now, to },
    cancelledFrom: now,
  });

  const icalEvents = await toICalEvents(
    occurrences,
    async (placeId) => (placeId === place.id ? place : null),
    { appBaseUrl: deps.appBaseUrl },
  );

  deps.logger?.info("events.place_calendar_feed", {
    placeId: place.id,
    liveEventCount: live.items.length,
    cancelledEventCount: cancelled.items.length,
    calledOffNightEventCount: calledOffNights.items.length,
    entryCount: icalEvents.length,
  });

  return {
    icsBody: generateVenueCalendarFeed(icalEvents, {
      calendarName: `${place.name} — Ithas Fire`,
      labels: feedLabels(locale),
      refreshInterval: "PT1H",
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Organisation / host feeds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The org feed (`/api/orgs/:orgId/calendar.ics`) and host feed
 * (`/api/humans/:humanId/calendar.ics`). Live shows from 30 days ago onward,
 * nearest first, so an owner with more than the page limit loses its
 * FURTHEST shows, not its next ones; plus upcoming cancelled ones.
 */
export async function buildOwnerCalendarFeed(
  deps: PublicCalendarFeedDeps,
  rawInput: unknown,
): Promise<PublicCalendarFeedOutput> {
  const input = parseInput(ownerCalendarFeedInputSchema, rawInput);
  const locale = resolveNotificationLocale(input.lang);

  let ownerName: string | null;
  if (input.ownerType === "ORGANIZATION") {
    const org = await deps.repos.organizations.getById(input.ownerId);
    if (!org || org.status !== "ACTIVE") {
      throw fail("ORG_NOT_FOUND", { category: "NOT_FOUND" });
    }
    ownerName = org.name;
  } else {
    const human = await deps.repos.humans.getById(input.ownerId);
    if (!human || human.status !== "ACTIVE") {
      throw fail("HUMAN_NOT_FOUND", { category: "NOT_FOUND" });
    }
    ownerName = human.name ?? null;
  }

  const now = deps.clock.now();
  const liveFrom = new Date(now.getTime() - OWNER_LOOKBACK_MS);
  const shared = {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    // Filtered in the query, so private rows never crowd the page limit.
    visibility: ["PUBLIC" as const],
    includeDateOccurrences: true,
    startsAtOrder: "asc" as const,
    // Ban-that-sticks: the event pages of a withheld owner are not public
    // (`ownerBanned`), so the feed lists none of them either. The withheld
    // set is resolved once for the three reads, not once per read.
    excludeBannedOwners: true,
    withheldOwners: await deps.repos.bans.listWithheldOwners(),
    offset: 0,
  };

  const [live, cancelled, calledOffNights] = await Promise.all([
    deps.repos.events.listByOwner({
      ...shared,
      status: ["PUBLISHED"],
      dateRange: { from: liveFrom },
      // A show still running (e.g. a months-long exhibition) stays listed.
      includeRunning: true,
      limit: OWNER_LIVE_LIMIT,
    }),
    deps.repos.events.listByOwner({
      ...shared,
      status: ["CANCELLED"],
      cancelledWhilePublished: true,
      dateOccurrenceStatuses: ["SCHEDULED", "CANCELLED"],
      dateRange: { from: now },
      limit: CANCELLED_LIMIT,
    }),
    // Live listings with a called-off night ahead (see the place feed).
    deps.repos.events.listByOwner({
      ...shared,
      status: ["PUBLISHED"],
      matchDateOccurrencesOnly: true,
      dateOccurrenceStatuses: ["CANCELLED"],
      dateRange: { from: now },
      limit: CANCELLED_LIMIT,
    }),
  ]);

  const events = uniqueEvents(
    live.items,
    cancelled.items,
    calledOffNights.items,
  );
  const dates = await readFeedDates(deps.repos, events);
  const occurrences = expandFeedOccurrences(events, dates, {
    window: { from: liveFrom },
    cancelledFrom: now,
  });

  const icalEvents = await toICalEvents(
    occurrences,
    memoizePlaceReads(deps.repos),
    { appBaseUrl: deps.appBaseUrl, hostName: ownerName },
  );

  deps.logger?.info("events.owner_calendar_feed", {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    liveEventCount: live.items.length,
    cancelledEventCount: cancelled.items.length,
    calledOffNightEventCount: calledOffNights.items.length,
    entryCount: icalEvents.length,
  });

  const calendarName = ownerName
    ? `${ownerName} — Ithas Fire`
    : `${CALENDAR_FEED_COPY[locale].hostCalendar} — Ithas Fire`;
  return {
    icsBody: generateVenueCalendarFeed(icalEvents, {
      calendarName,
      labels: feedLabels(locale),
      prodId:
        input.ownerType === "ORGANIZATION"
          ? "-//Ithas Fire//OrgCalendar//EN"
          : "-//Ithas Fire//HostCalendar//EN",
      refreshInterval: "PT1H",
    }),
  };
}
