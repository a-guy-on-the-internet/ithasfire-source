import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import { makeTicketCapacityUsageFake } from "@th/test-utils/fakes/ticket-capacity";

import { redactPlaceLocation } from "../../../lib/location/redact-place-location";
import {
  getEmbedCalendarEvents,
  type GetEmbedCalendarEventsDeps,
} from "../get-embed-calendar-events";
import {
  getEmbedEventDetail,
  type GetEmbedEventDetailDeps,
} from "../get-embed-event-detail";
import {
  getEmbedForWidget,
  type GetEmbedForWidgetDeps,
} from "../get-embed-for-widget";

/**
 * D2 on the embed surfaces: a partner's page is as public as it gets. An
 * OBSCURED event, or any event at a venue that withholds its address, shows
 * "locality, region" — never the street — and the venue floor is read from
 * the venue's CURRENT row, not from what the event row says.
 */

const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const EMBED_ID = "00000000-0000-4000-8000-0000000000c0";
const EVENT_ID = "00000000-0000-4000-8000-0000000000c1";
const HOUSE_ID = "00000000-0000-4000-8000-0000000000c2";
const ORIGIN = "https://embedder.example.com";
const STREET = "1417 Shelby Ave, Nashville, TN 37206";

const HOUSE = {
  id: HOUSE_ID,
  name: "The Shelby House",
  locationMode: "OBSCURED",
  locationRadiusMeters: 800,
  formattedAddress: STREET,
  city: "Nashville",
  region: "TN",
  lat: 36.1775,
  lng: -86.7412,
};

const event = (overrides: Record<string, unknown>) => ({
  id: EVENT_ID,
  // Ungated (N5: a missing gate fails closed to label only).
  gateType: "NONE",
  title: "Basement Show",
  slug: "basement-show",
  status: "PUBLISHED",
  startsAt: new Date("2099-06-01T20:00:00.000Z"),
  endsAt: null,
  timezone: "America/Chicago",
  currency: "usd",
  heroImageUrl: null,
  heroImageKey: null,
  addressText: STREET,
  locality: "Nashville",
  region: "TN",
  locationLabel: null,
  lat: 36.1775,
  lng: -86.7412,
  locationMode: "EXACT",
  locationRadiusMeters: null,
  placeId: null,
  waitlistStatus: "DISABLED",
  waitlistDescription: null,
  ...overrides,
});

const OBSCURED = event({ locationMode: "OBSCURED", locationRadiusMeters: 500 });
const STALE_AT_HOUSE = event({ placeId: HOUSE_ID });

const embedRow = {
  id: EMBED_ID,
  domain: "embedder.example.com",
  subjectType: "event",
  subjectId: EVENT_ID,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
};

function repos(ev: Record<string, unknown>) {
  return {
    embeds: { getById: vi.fn(async () => embedRow) },
    events: {
      getById: vi.fn(async () => ev),
      listTicketTypes: vi.fn(async () => []),
      listTicketTypesForEventIds: vi.fn(async () => []),
      getContent: vi.fn(async () => null),
    },
    places: { getById: vi.fn(async (id: string) => (id === HOUSE_ID ? HOUSE : null)) },
    eventHumans: { listByEvent: vi.fn(async () => []) },
    tags: { getEventTags: vi.fn(async () => []) },
    images: { resolveByIds: vi.fn(async () => []) },
    seats: { listSectionsByEvent: vi.fn(async () => []) },
    seriesOccurrences: {
      findSeriesIdByEventId: vi.fn(async () => null),
      listPublishedDatesBySeriesId: vi.fn(async () => []),
    },
    eventDates: { listByEventIds: vi.fn(async () => []) },
    ...makeImageModerationGateFake(),
    ...makeTicketCapacityUsageFake(),
  };
}

const widget = (ev: Record<string, unknown>) =>
  getEmbedForWidget(
    {
      repos: repos(ev) as unknown as GetEmbedForWidgetDeps["repos"],
      search: { autocomplete: vi.fn() } as unknown as GetEmbedForWidgetDeps["search"],
      publicAppUrl: "http://localhost:3000",
      clock: { now: () => TEST_NOW },
      logger: createTestLogger(),
    },
    { embedId: EMBED_ID, hostOrigin: ORIGIN },
  );

const calendar = (ev: Record<string, unknown>) =>
  getEmbedCalendarEvents(
    {
      repos: repos(ev) as unknown as GetEmbedCalendarEventsDeps["repos"],
      search: { autocomplete: vi.fn() } as unknown as GetEmbedCalendarEventsDeps["search"],
      clock: { now: () => new Date() },
      publicAppUrl: "http://localhost:3000",
    },
    { embedId: EMBED_ID, hostOrigin: ORIGIN },
  );

const detail = (ev: Record<string, unknown>) =>
  getEmbedEventDetail(
    {
      repos: repos(ev) as unknown as GetEmbedEventDetailDeps["repos"],
      publicAppUrl: "http://localhost:3000",
      clock: { now: () => TEST_NOW },
      logger: createTestLogger(),
    },
    { embedId: EMBED_ID, eventId: EVENT_ID, hostOrigin: ORIGIN },
  );

describe("embed widget (single event)", () => {
  it("EXACT → the street, unchanged", async () => {
    expect((await widget(event({}))).event?.addressText).toBe(STREET);
  });
  it("OBSCURED → coarse label, no street", async () => {
    const out = await widget(OBSCURED);
    expect(out.event?.addressText).toBe("Nashville, TN");
    expect(JSON.stringify(out)).not.toContain("Shelby");
  });
  it("stale EXACT row at a withheld venue → coarse label, no street", async () => {
    const out = await widget(STALE_AT_HOUSE);
    expect(out.event?.addressText).toBe("Nashville, TN");
    expect(JSON.stringify(out)).not.toContain("Shelby");
  });
  it("never names the place: placeLabel is null at a linked place, withheld or not", async () => {
    // Naming a place on an event is the place-confirmation decision, which
    // this branch does not run, so it sends no name at all.
    expect((await widget(event({}))).event?.placeLabel).toBeNull();
    expect((await widget(STALE_AT_HOUSE)).event?.placeLabel).toBeNull();
    const atPublicPlace = await widget(
      event({ placeId: "00000000-0000-4000-8000-0000000000c3" }),
    );
    expect(atPublicPlace.event?.placeLabel).toBeNull();
  });
});

describe("embed calendar (single event)", () => {
  it("EXACT → the street, unchanged", async () => {
    expect((await calendar(event({}))).events[0]?.location).toBe(STREET);
  });
  it("OBSCURED → coarse label, no street", async () => {
    const out = await calendar(OBSCURED);
    expect(out.events[0]?.location).toBe("Nashville, TN");
    expect(JSON.stringify(out)).not.toContain("Shelby");
  });
  it("stale EXACT row at a withheld venue → coarse label, no street", async () => {
    const out = await calendar(STALE_AT_HOUSE);
    expect(out.events[0]?.location).toBe("Nashville, TN");
    expect(JSON.stringify(out)).not.toContain("Shelby");
  });

  it("never names the place: placeLabel is null at a linked place, withheld or not", async () => {
    // Same rule as the widget's single-event branch above.
    expect((await calendar(event({}))).events[0]?.placeLabel).toBeNull();
    expect((await calendar(STALE_AT_HOUSE)).events[0]?.placeLabel).toBeNull();
    const atPublicPlace = await calendar(
      event({ placeId: "00000000-0000-4000-8000-0000000000c3" }),
    );
    expect(atPublicPlace.events[0]?.placeLabel).toBeNull();
  });
});

describe("embed event detail", () => {
  it("stale EXACT row at a withheld venue → the VENUE's circle, no street", async () => {
    const out = await detail(STALE_AT_HOUSE);
    const venueCircle = redactPlaceLocation(HOUSE);
    expect(out.event.addressText).toBeNull();
    expect(out.event.locationCoords).toMatchObject({
      isExact: false,
      latitude: venueCircle.lat,
      longitude: venueCircle.lng,
      // The venue's stored 800 m is drawn at the next rung up.
      radiusMeters: 1000,
    });
    expect(JSON.stringify(out.event)).not.toContain("Shelby");
  });

  it("a venue read that THROWS fails closed (no coordinates) and is reported", async () => {
    const r = repos(STALE_AT_HOUSE);
    r.places.getById = vi.fn(async () => {
      throw new Error("db down");
    });
    const reportError = vi.fn();
    const out = await getEmbedEventDetail(
      {
        repos: r as unknown as GetEmbedEventDetailDeps["repos"],
        publicAppUrl: "http://localhost:3000",
        clock: { now: () => TEST_NOW },
        logger: createTestLogger(),
        reportError,
      },
      { embedId: EMBED_ID, eventId: EVENT_ID, hostOrigin: ORIGIN },
    );
    expect(out.event.locationCoords).toBeNull();
    expect(out.event.addressText).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "getEmbedEventDetail" }),
      }),
    );
  });
});
