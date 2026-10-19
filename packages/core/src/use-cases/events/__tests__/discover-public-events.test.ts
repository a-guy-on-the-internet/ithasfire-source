import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { buildOffsetPaginatedResult } from "@th/ports";
import type {
  EventGateType,
  EventRecord,
  EventVisibility,
  Repos,
  WaitlistStatus,
} from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import type { ImageModerationStatus } from "@th/types/repos/image-moderation-records";

import { haversineDistance } from "../../../lib/geo/haversine";
import { projectPublicEventLocation } from "../../../lib/location/project-public-event-location";
import { redactPlaceLocation } from "../../../lib/location/redact-place-location";
import {
  discoverPublicEvents,
  type DiscoverPublicEventsDeps,
} from "../discover-public-events";
import { describeCardVenueName } from "./_card-venue-name-cases";

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

const eventFactory = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  id: overrides.id ?? randomUUID(),
  orgId: overrides.orgId ?? randomUUID(),
  humanId: overrides.humanId ?? null,
  title: overrides.title ?? "Open Mic Night",
  status: overrides.status ?? "PUBLISHED",
  visibility: overrides.visibility ?? ("PUBLIC" as EventVisibility),
  gateType: overrides.gateType ?? ("NONE" as EventGateType),
  locationMode: overrides.locationMode ?? "EXACT",
  locationRadiusMeters: overrides.locationRadiusMeters ?? null,
  locationLabel: overrides.locationLabel ?? null,
  startsAt: overrides.startsAt ?? new Date("2025-07-01T18:00:00.000Z"),
  endsAt: overrides.endsAt ?? null,
  placeId: overrides.placeId ?? null,
  savedLocationId: overrides.savedLocationId ?? null,
  categoryId: overrides.categoryId ?? null,

  addressText: overrides.addressText ?? "The Blue Note — Columbia, MO",
  lat: overrides.lat ?? 38.9517,
  lng: overrides.lng ?? -92.3341,
  slug: overrides.slug ?? "open-mic-night",
  shortId: overrides.shortId ?? "omc001",
  regionCode: overrides.regionCode ?? "mo",
  publishedAt: overrides.publishedAt ?? new Date("2025-05-01T12:00:00.000Z"),
  agreementPrimaryId: overrides.agreementPrimaryId ?? randomUUID(),
  agreementResaleId: overrides.agreementResaleId ?? null,
  defaultLocale: overrides.defaultLocale ?? "en-US",
  listingPriority: overrides.listingPriority ?? null,
  passwordHash: overrides.passwordHash ?? null,
  passwordUpdatedAt: overrides.passwordUpdatedAt ?? null,
  waitlistStatus: overrides.waitlistStatus ?? ("CLOSED" as WaitlistStatus),
  waitlistPublishAt: overrides.waitlistPublishAt ?? null,
  waitlistDescription: overrides.waitlistDescription ?? null,
  waitlistCap: overrides.waitlistCap ?? null,
  payoutTermsId: overrides.payoutTermsId ?? null,
  resalePayoutTermsId: overrides.resalePayoutTermsId ?? null,
  placeLayoutId: overrides.placeLayoutId ?? null,
  currency: null,
  recurrenceSchedule: overrides.recurrenceSchedule ?? null,
  heroImageUrl: overrides.heroImageUrl ?? null,
  heroImageKey: overrides.heroImageKey ?? null,
});

const makePaginatedResult = (events: EventRecord[]) =>
  buildOffsetPaginatedResult({
    items: events,
    total: events.length,
    limit: Math.max(events.length, 1),
    offset: 0,
  });

const makeDeps = (
  events: EventRecord[] = [eventFactory()],
  overrides: Partial<DiscoverPublicEventsDeps> = {},
  statusByKey: Record<string, ImageModerationStatus> = {},
): DiscoverPublicEventsDeps & {
  resolveByKeys: ReturnType<typeof vi.fn>;
} => {
  const gate = makeImageModerationGateFake(statusByKey);
  const repos = {
    events: {
      listPublished: vi.fn(async () => makePaginatedResult(events)),
      listPublishedByRegion: vi.fn(async () => makePaginatedResult(events)),
      listPublishedByCountry: vi.fn(async () => makePaginatedResult(events)),
      filterByCategory: vi.fn(async () => makePaginatedResult(events)),
    },
    imageModerationRecords: gate.imageModerationRecords,
  } as unknown as Repos;

  return {
    repos,
    logger: overrides.logger ?? createTestLogger(),
    resolveByKeys: gate.imageModerationRecords.resolveByKeys,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("discoverPublicEvents", () => {
  it("returns published events with basic fields", async () => {
    const deps = makeDeps();

    const result = await discoverPublicEvents(deps, { limit: 20 });

    expect(result.events).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.events[0]).toMatchObject({
      title: "Open Mic Night",
      status: "PUBLISHED",
      slug: "open-mic-night",
    });
  });

  it("uses listPublished when no region or country is specified — PUBLIC only (a PRIVATE event is link-only)", async () => {
    const deps = makeDeps();
    await discoverPublicEvents(deps, { limit: 10 });

    expect(deps.repos.events.listPublished).toHaveBeenCalledWith({
      limit: 10,
      offset: 0,
      startsAfter: expect.any(Date),
      visibility: ["PUBLIC"],
      // Ban that sticks: a banned owner's events never reach the feed.
      excludeBannedOwners: true,
    });
  });

  it("uses listPublishedByRegion when regionCode is provided", async () => {
    const deps = makeDeps();
    await discoverPublicEvents(deps, { regionCode: "co", limit: 10 });

    expect(deps.repos.events.listPublishedByRegion).toHaveBeenCalledWith({
      regionCode: "co",
      limit: 10,
      offset: 0,
      startsAfter: expect.any(Date),
    });
  });

  it("uses listPublishedByCountry when countryCode is provided", async () => {
    const deps = makeDeps();
    await discoverPublicEvents(deps, { countryCode: "us", limit: 10 });

    expect(deps.repos.events.listPublishedByCountry).toHaveBeenCalledWith({
      countryCode: "us",
      limit: 10,
      offset: 0,
      startsAfter: expect.any(Date),
    });
  });

  it("uses filterByCategory when categorySlug is provided", async () => {
    const deps = makeDeps();
    await discoverPublicEvents(deps, { categorySlug: "open-mics", limit: 10 });

    expect(deps.repos.events.filterByCategory).toHaveBeenCalledWith({
      categorySlug: "open-mics",
      limit: 10,
      offset: 0,
      startsAfter: expect.any(Date),
    });
    // Should NOT call listPublished
    expect(deps.repos.events.listPublished).not.toHaveBeenCalled();
  });

  it("categorySlug takes priority over regionCode", async () => {
    const deps = makeDeps();
    await discoverPublicEvents(deps, {
      categorySlug: "support-recovery",
      regionCode: "co",
      limit: 10,
    });

    expect(deps.repos.events.filterByCategory).toHaveBeenCalledWith({
      categorySlug: "support-recovery",
      limit: 10,
      offset: 0,
      startsAfter: expect.any(Date),
    });
    expect(deps.repos.events.listPublishedByRegion).not.toHaveBeenCalled();
  });

  it("computes distanceKm when user location is provided", async () => {
    const event = eventFactory({
      lat: 38.9517,
      lng: -92.3341,
    });
    const deps = makeDeps([event]);

    // User at roughly Kansas City (~200 km from Columbia, MO)
    const result = await discoverPublicEvents(deps, {
      userLat: 39.0997,
      userLng: -94.5786,
      limit: 20,
    });

    expect(result.events[0]!.distanceKm).toBeGreaterThan(100);
    expect(result.events[0]!.distanceKm).toBeLessThan(300);
  });

  it("returns null distanceKm when user location is not provided", async () => {
    const deps = makeDeps();
    const result = await discoverPublicEvents(deps, { limit: 20 });

    expect(result.events[0]!.distanceKm).toBeNull();
  });

  it("returns null distanceKm when event has no coordinates", async () => {
    const event = eventFactory({});
    // Force null coordinates (the ?? in the factory falls through, so assign directly)
    (event as any).lat = null;
    (event as any).lng = null;
    const deps = makeDeps([event]);

    const result = await discoverPublicEvents(deps, {
      userLat: 39.0997,
      userLng: -94.5786,
      limit: 20,
    });

    expect(result.events[0]!.distanceKm).toBeNull();
  });

  it("sorts by distance when user location is provided", async () => {
    const close = eventFactory({
      title: "Close Event",
      lat: 39.0997,
      lng: -94.5786,
    });
    const far = eventFactory({
      title: "Far Event",
      lat: 34.0522,
      lng: -118.2437,
    });
    const deps = makeDeps([far, close]);

    const result = await discoverPublicEvents(deps, {
      userLat: 39.0997,
      userLng: -94.5786,
      limit: 20,
    });

    expect(result.events[0]!.title).toBe("Close Event");
    expect(result.events[1]!.title).toBe("Far Event");
  });

  it("rejects invalid input", async () => {
    const deps = makeDeps();

    await expect(discoverPublicEvents(deps, { limit: -1 })).rejects.toThrow();
  });

  it("filters by dateRange=today", async () => {
    const today = new Date();
    today.setHours(14, 0, 0, 0);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 3);

    const todayEvent = eventFactory({
      title: "Today Event",
      startsAt: today,
    });
    const futureEvent = eventFactory({
      title: "Future Event",
      startsAt: tomorrow,
    });
    const deps = makeDeps([todayEvent, futureEvent]);

    const result = await discoverPublicEvents(deps, {
      dateRange: "today",
      limit: 20,
    });

    expect(result.events.map((e) => e.title)).toContain("Today Event");
    expect(result.events.map((e) => e.title)).not.toContain("Future Event");
  });

  it("includes tags array (empty in phase 1)", async () => {
    const deps = makeDeps();
    const result = await discoverPublicEvents(deps, { limit: 20 });

    expect(result.events[0]!.tags).toEqual([]);
  });

  it("excludes gateType when NONE", async () => {
    const event = eventFactory({ gateType: "NONE" as EventGateType });
    const deps = makeDeps([event]);

    const result = await discoverPublicEvents(deps, { limit: 20 });

    expect(result.events[0]!.gateType).toBeUndefined();
  });

  it("includes gateType when PASSWORD", async () => {
    const event = eventFactory({ gateType: "PASSWORD" as EventGateType });
    const deps = makeDeps([event]);

    const result = await discoverPublicEvents(deps, { limit: 20 });

    expect(result.events[0]!.gateType).toBe("PASSWORD");
  });

  it("a GATED EXACT event keeps its badge but shows only the coarse label — no street, no distance", async () => {
    // The factory lists its fields explicitly; the coarse fields ride on top.
    const event = {
      ...eventFactory({
        gateType: "PASSWORD" as EventGateType,
        locationMode: "EXACT",
        addressText: "1417 Shelby Ave, Nashville, TN",
      }),
      locality: "Nashville",
      region: "TN",
    } as EventRecord;
    const deps = makeDeps([event]);

    const result = await discoverPublicEvents(deps, {
      limit: 20,
      userLat: 38.95,
      userLng: -92.33,
    });

    expect(result.events[0]!.gateType).toBe("PASSWORD");
    expect(result.events[0]!.addressText).toBe("Nashville, TN");
    expect(result.events[0]!.distanceKm).toBeNull();
    expect(JSON.stringify(result)).not.toContain("Shelby");
  });

  it("marks isRecurring false for a single-date listing", async () => {
    const deps = makeDeps();

    const result = await discoverPublicEvents(deps, { limit: 20 });

    expect(result.events[0]!.isRecurring).toBe(false);
  });

  it("marks isRecurring true when the event carries a recurrence schedule", async () => {
    const event = eventFactory({
      title: "Weekly Open Mic",
      recurrenceSchedule: { kind: "RRULE", rrule: "FREQ=WEEKLY" },
    });
    const deps = makeDeps([event]);

    const result = await discoverPublicEvents(deps, { limit: 20 });

    expect(result.events[0]!.isRecurring).toBe(true);
  });

  // ── Hero moderation gate (FR-005) ──────────────────────────────────────
  const HERO_KEY = "events/e/images/hero.png";
  const HERO_URL = "https://cdn.example/events/e/images/hero.png";
  const heroEvent = () =>
    eventFactory({ heroImageUrl: HERO_URL, heroImageKey: HERO_KEY });

  it("shows the hero when its moderation record is APPROVED", async () => {
    const deps = makeDeps([heroEvent()], {}, { [HERO_KEY]: "APPROVED" });
    const result = await discoverPublicEvents(deps, { limit: 20 });
    expect(result.events[0]!.heroImageUrl).toBe(HERO_URL);
    expect(deps.resolveByKeys).toHaveBeenCalledTimes(1);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits the hero when its moderation record is %s",
    async (status) => {
      const deps = makeDeps([heroEvent()], {}, { [HERO_KEY]: status });
      const result = await discoverPublicEvents(deps, { limit: 20 });
      expect(result.events[0]!.heroImageUrl).toBeNull();
    },
  );

  it("shows a legacy hero with NO moderation record (fail-open)", async () => {
    const deps = makeDeps([heroEvent()], {}, {});
    const result = await discoverPublicEvents(deps, { limit: 20 });
    expect(result.events[0]!.heroImageUrl).toBe(HERO_URL);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Location privacy (D2): discovery is anonymous. The card label never carries
// an OBSCURED event's street, and `distanceKm` is measured to the point the
// viewer is SHOWN — a true distance read from a few viewer positions
// trilaterates the house.
// ─────────────────────────────────────────────────────────────────────────────

describe("discoverPublicEvents — public location projection", () => {
  const TRUE = { lat: 36.1775, lng: -86.7412 };
  const VIEWER = { userLat: 36.16, userLng: -86.78 };
  const STREET = "1417 Shelby Ave, Nashville, TN 37206";
  const trueKm =
    haversineDistance(VIEWER.userLat, VIEWER.userLng, TRUE.lat, TRUE.lng) / 1000;

  const obscured = (overrides: Partial<EventRecord> = {}) =>
    Object.assign(
      eventFactory({
        locationMode: "OBSCURED",
        locationRadiusMeters: 500,
        addressText: STREET,
        ...TRUE,
        ...overrides,
      }),
      { locality: "Nashville", region: "TN" },
    );

  it("OBSCURED: coarse label, distance from the emitted point (not the true one)", async () => {
    const event = obscured();
    const result = await discoverPublicEvents(makeDeps([event]), {
      limit: 20,
      ...VIEWER,
    });

    const shown = projectPublicEventLocation(event);
    const summary = result.events[0]!;
    expect(summary.addressText).toBe("Nashville, TN");
    expect(JSON.stringify(summary)).not.toContain("Shelby");
    expect(summary.distanceKm).toBeCloseTo(
      haversineDistance(VIEWER.userLat, VIEWER.userLng, shown.lat!, shown.lng!) /
        1000,
      9,
    );
    expect(summary.distanceKm).not.toBeCloseTo(trueKm, 6);
  });

  it("two events by one organizer at one address → the SAME emitted point (no averaging across events)", async () => {
    const orgId = randomUUID();
    const a = obscured({ id: randomUUID(), orgId });
    const b = obscured({ id: randomUUID(), orgId });
    const result = await discoverPublicEvents(makeDeps([a, b]), {
      limit: 20,
      ...VIEWER,
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.distanceKm).toBe(result.events[1]!.distanceKm);
    expect(result.events[0]!.distanceKm).not.toBeCloseTo(trueKm, 6);
  });

  it("fully hidden: no distance at all (sorts last), label only", async () => {
    const result = await discoverPublicEvents(
      makeDeps([obscured({ locationRadiusMeters: null })]),
      { limit: 20, ...VIEWER },
    );
    expect(result.events[0]!.distanceKm).toBeNull();
    expect(result.events[0]!.addressText).toBe("Nashville, TN");
  });

  it("a stale EXACT row at a WITHHELD venue: venue floor applies — no street, venue-circle distance", async () => {
    const placeId = randomUUID();
    const event = Object.assign(
      eventFactory({ placeId, locationMode: "EXACT", addressText: STREET, ...TRUE }),
      { locality: "Nashville", region: "TN" },
    );
    const venue = {
      id: placeId,
      name: "The Shelby House",
      locationMode: "OBSCURED",
      locationRadiusMeters: 800,
      formattedAddress: STREET,
      city: "Nashville",
      region: "TN",
      orgIdsWithAccess: [],
      humanIdsWithAccess: [],
      acceptsCommunityListings: false,
      ...TRUE,
    };
    const deps = makeDeps([event]);
    (deps.repos as unknown as { places: unknown }).places = {
      getById: vi.fn(async () => venue),
    };

    const result = await discoverPublicEvents(deps, { limit: 20, ...VIEWER });

    const venueCircle = redactPlaceLocation(venue);
    const summary = result.events[0]!;
    expect(summary.addressText).toBe("Nashville, TN");
    expect(summary.distanceKm).toBeCloseTo(
      haversineDistance(
        VIEWER.userLat,
        VIEWER.userLng,
        venueCircle.lat!,
        venueCircle.lng!,
      ) / 1000,
      9,
    );
  });

  it("EXACT: byte-identical label and true distance", async () => {
    const event = eventFactory({ locationMode: "EXACT", addressText: STREET, ...TRUE });
    const result = await discoverPublicEvents(makeDeps([event]), {
      limit: 20,
      ...VIEWER,
    });
    expect(result.events[0]!.addressText).toBe(STREET);
    expect(result.events[0]!.distanceKm).toBe(trueKm);
  });
});

describeCardVenueName({
  makeEvent: () => eventFactory(),
  cardPlaceName: async (event, place) => {
    const deps = makeDeps([event]);
    (deps.repos as unknown as { places: unknown }).places = {
      getById: vi.fn(async () => place),
    };
    const result = await discoverPublicEvents(deps, { limit: 20 });
    return result.events[0]!.placeName;
  },
});

// The transport mapper formats the card date in this zone; without it a UTC
// server printed a 7pm Chicago show as the next day (prod, 2026-10-13).
describe("discoverPublicEvents carries the event's timezone", () => {
  it("returns Event.timezone, and the platform default for an unknown or absent zone", async () => {
    const deps = makeDeps([
      { ...eventFactory(), timezone: "America/Los_Angeles" },
      { ...eventFactory(), timezone: "Mars/Olympus_Mons" },
      eventFactory(),
    ]);

    const result = await discoverPublicEvents(deps, { limit: 20 });

    expect(result.events.map((e) => e.timezone)).toEqual([
      "America/Los_Angeles",
      "America/Chicago",
      "America/Chicago",
    ]);
  });
});
