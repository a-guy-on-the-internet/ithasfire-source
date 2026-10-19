import { describe, expect, it, vi } from "vitest";

import { buildOffsetPaginatedResult } from "@th/ports/pagination";
import type { EventRecord } from "@th/ports/repos/events";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";

import { listEventsByCategory } from "../../categories/list-events-by-category";
import { listSavedEvents } from "../../event-saves/list-saved-events";
import { listEventsByCategoryAndCity } from "../list-events-by-category-and-city";
import { listEventsByCountry } from "../list-events-by-country";
import { listEventsByLocation } from "../list-events-by-location";
import { listFeaturedEvents } from "../list-featured-events";
import { searchPublishedEvents } from "../search-published-events";

/**
 * D2 — card labels. Every public list prints ONE location line per event,
 * and for anything not EXACT (the event's own mode, floored by its venue's
 * CURRENT privacy) that line is "locality, region" — never the street. EXACT
 * events print exactly what they always printed.
 */

const STREET = "1417 Shelby Ave, Nashville, TN 37206";
const CLUB_STREET = "1 Broadway, Nashville, TN 37203";
const HOUSE_ID = "00000000-0000-4000-8000-0000000000a1";

const base = (id: string, overrides: Partial<EventRecord>): EventRecord =>
  ({
    id,
    orgId: "00000000-0000-4000-8000-0000000000f1",
    humanId: null,
    title: `Event ${id.slice(-2)}`,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    stewardship: "OWNED",
    attendanceMode: "TICKETED",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    startsAt: new Date("2099-06-01T20:00:00.000Z"),
    endsAt: null,
    placeId: null,
    addressText: CLUB_STREET,
    locality: "Nashville",
    region: "TN",
    lat: 36.16,
    lng: -86.77,
    slug: `event-${id.slice(-2)}`,
    regionCode: "tn",
    recurrenceSchedule: null,
    heroImageUrl: null,
    heroImageKey: null,
    ...overrides,
  }) as EventRecord;

/** EXACT, no venue: prints its street, unchanged. */
const EXACT = base("00000000-0000-4000-8000-000000000001", {});
/** Organizer-obscured (a shipped feature): must never print its street. */
const OBSCURED = base("00000000-0000-4000-8000-000000000002", {
  locationMode: "OBSCURED",
  locationRadiusMeters: 500,
  addressText: STREET,
  locationLabel: "East side",
  lat: 36.1775,
  lng: -86.7412,
});
/** Stored EXACT before its venue was withheld: the venue floor must win. */
const STALE_AT_HOUSE = base("00000000-0000-4000-8000-000000000003", {
  placeId: HOUSE_ID,
  addressText: STREET,
  lat: 36.1775,
  lng: -86.7412,
});

const HOUSE = {
  id: HOUSE_ID,
  name: "The Shelby House",
  locationMode: "OBSCURED",
  locationRadiusMeters: null,
  formattedAddress: STREET,
  city: "Nashville",
  region: "TN",
  lat: 36.1775,
  lng: -86.7412,
  orgIdsWithAccess: [],
  humanIdsWithAccess: [],
  acceptsCommunityListings: false,
};

const EVENTS = [EXACT, OBSCURED, STALE_AT_HOUSE];

function repos() {
  const page = () =>
    buildOffsetPaginatedResult({
      items: EVENTS,
      total: EVENTS.length,
      limit: 50,
      offset: 0,
    });
  return {
    events: {
      listPublishedByRegion: vi.fn(async () => page()),
      listPublishedByCountry: vi.fn(async () => page()),
      listPublishedByCategoryAndCity: vi.fn(async () => ({
        ...page(),
        indexableTotal: EVENTS.length,
      })),
      filterByCategory: vi.fn(async () => page()),
      countIndexableByCategory: vi.fn(async () => 1),
      listTicketTypesForEventIds: vi.fn(async () => []),
      searchPublished: vi.fn(async () => EVENTS),
    },
    places: {
      getById: vi.fn(async (id: string) => (id === HOUSE_ID ? HOUSE : null)),
    },
    categories: {
      getBySlug: vi.fn(async () => ({
        id: "cat-1",
        slug: "music",
        name: "Music",
        active: true,
      })),
    },
    eventSaves: {
      listForHuman: vi.fn(async () => ({
        items: EVENTS.map((event, i) => ({
          id: `save-${i}`,
          eventId: event.id,
          humanId: "human-1",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          event: {
            id: event.id,
            slug: event.slug,
            title: event.title,
            startsAt: event.startsAt,
            endsAt: null,
            timezone: "America/Chicago",
            status: event.status,
            visibility: event.visibility,
            heroImageId: null,
            heroImageUrl: null,
            heroImageKey: null,
            addressText: event.addressText,
            locationLabel: event.locationLabel,
            placeId: event.placeId,
            locationMode: event.locationMode,
            locationRadiusMeters: event.locationRadiusMeters,
            locality: event.locality,
            region: event.region,
            gateType: event.gateType,
          },
        })),
        nextCursor: null,
      })),
    },
    ...makeImageModerationGateFake(),
  };
}

const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };

/** The label each surface printed for [EXACT, OBSCURED, STALE_AT_HOUSE]. */
function expectLabels(labels: Array<string | null | undefined>) {
  expect(labels).toEqual([CLUB_STREET, "Nashville, TN", "Nashville, TN"]);
  expect(JSON.stringify(labels)).not.toContain("Shelby");
}

describe("public card location labels", () => {
  it("listEventsByLocation", async () => {
    const out = await listEventsByLocation(
      { repos: repos() as never, clock },
      { regionCode: "tn" },
    );
    expectLabels(out.events.map((e) => e.addressText));
  });

  it("listEventsByCountry", async () => {
    const out = await listEventsByCountry(
      { repos: repos() as never, clock },
      { countryCode: "US" },
    );
    expectLabels(out.events.map((e) => e.addressText));
  });

  it("listFeaturedEvents", async () => {
    const out = await listFeaturedEvents(
      { repos: repos() as never, clock },
      { categorySlug: "music" },
    );
    expectLabels(out.events.map((e) => e.addressText));
  });

  it("listEventsByCategoryAndCity", async () => {
    const out = await listEventsByCategoryAndCity(
      { repos: repos() as never, clock },
      { categorySlug: "music", citySegment: "nashville-tn" },
    );
    expectLabels(out.events.map((e) => e.addressText));
  });

  it("listEventsByCategory (categories)", async () => {
    const out = await listEventsByCategory(
      { repos: repos() as never },
      { categorySlug: "music" },
    );
    expectLabels(out.events.map((e) => e.addressText));
  });

  it("listSavedEvents", async () => {
    const out = await listSavedEvents(
      { repos: repos() as never, clock },
      { actorHumanId: "human-1", scope: "upcoming" },
    );
    expectLabels(out.items.map((item) => item.event.addressText));
  });

  it("searchPublishedEvents (Postgres fallback)", async () => {
    const out = await searchPublishedEvents(
      { repos: repos() as never },
      { query: "event" },
    );
    expectLabels(out.suggestions.map((s) => s.subtitle));
  });
});
