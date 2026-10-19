import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/io", () => {
  return {
    parseInput: <T>(_schema: unknown, rawInput: T) => rawInput,
    callOrDependencyFailed: async <T>(fn: () => Promise<T>) => fn(),
    describeError: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  } as const;
});
import type { Mock } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { MetricsPort } from "@th/ports/metric";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  EventRecord,
  PickRandomEventInput,
} from "@th/ports/repos/events";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import type { PlaceRecord } from "@th/ports/repos/places";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { haversineDistance } from "../../../lib/geo/haversine";
import { projectPublicEventLocation } from "../../../lib/location/project-public-event-location";
import { redactPlaceLocation } from "../../../lib/location/redact-place-location";
import {
  getRandomEvent,
  getRandomEventInput,
  type GetRandomEventDeps,
} from "../get-random-event";

const NOW = new Date("2025-01-01T00:00:00.000Z");

function makeUuid(index: number): string {
  const suffix = index.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${suffix}`;
}

interface MetricsMock extends MetricsPort {
  increment: Mock;
  record: Mock;
}

type TestContext = {
  deps: GetRandomEventDeps;
  organizations: Map<string, OrganizationRecord>;
  places: Map<string, PlaceRecord>;
  pickRandomEvent: Mock;
  metrics: MetricsMock;
  idempotency: ReturnType<typeof createFakeIdempotencyPort>;
};

describe("getRandomEvent", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("returns a random event (with slug) from the repo", async () => {
    const orgId = makeUuid(100);
    const event = makeEventRecord({
      id: makeUuid(1),
      orgId,
      slug: "lucky-night",
      lat: 37.7749,
      lng: -122.4194,
      addressText: "SF",
      title: "Geo Show",
    });
    ctx.organizations.set(orgId, makeOrgRecord({ id: orgId, name: "Org" }));
    ctx.pickRandomEvent.mockResolvedValue(event);

    const output = await getRandomEvent(ctx.deps, {
      near: { lat: 37.7749, lng: -122.4194, radiusKm: 10 },
      window: {
        from: new Date("2025-01-01T00:00:00.000Z"),
        to: new Date("2025-02-01T00:00:00.000Z"),
      },
    });

    expect(output.id).toBe(event.id);
    expect(output.slug).toBe("lucky-night");
    expect(output.source).toBe("geo");
    expect(output.org).toEqual({ id: orgId, name: "Org" });
    expect(output.location.distanceKm).not.toBeNull();
    expect(ctx.metrics.increment).toHaveBeenCalledWith("search.lucky.found", {
      source: "geo",
    });
  });

  it("derives source=text when a query but no geo is provided", async () => {
    const event = makeEventRecord({ id: makeUuid(2), title: "Text Event" });
    ctx.pickRandomEvent.mockResolvedValue(event);

    const output = await getRandomEvent(ctx.deps, {
      q: "music",
      window: {
        from: new Date("2025-01-01T00:00:00.000Z"),
        to: new Date("2025-03-01T00:00:00.000Z"),
      },
    });

    expect(output.source).toBe("text");
    // No geo param => distance can't be computed.
    expect(output.location.distanceKm).toBeNull();
    expect(ctx.metrics.increment).toHaveBeenCalledWith("search.lucky.found", {
      source: "text",
    });
  });

  it("derives source=fallback when neither geo nor query is provided", async () => {
    const event = makeEventRecord({ id: makeUuid(3), title: "Fallback Fest" });
    ctx.pickRandomEvent.mockResolvedValue(event);

    const output = await getRandomEvent(ctx.deps, {
      window: {
        from: new Date("2025-01-01T00:00:00.000Z"),
        to: new Date("2025-02-01T00:00:00.000Z"),
      },
    });

    expect(output.source).toBe("fallback");
    expect(output.id).toBe(event.id);
  });

  it("throws NO_RANDOM_EVENT_AVAILABLE when the repo returns null", async () => {
    ctx.pickRandomEvent.mockResolvedValue(null);

    await expect(
      getRandomEvent(ctx.deps, {
        window: {
          from: new Date("2025-01-01T00:00:00.000Z"),
          to: new Date("2025-02-01T00:00:00.000Z"),
        },
      }),
    ).rejects.toMatchObject({ code: "NO_RANDOM_EVENT_AVAILABLE" });
  });

  it("degrades to NO_RANDOM_EVENT_AVAILABLE (not a 500) when the repo throws", async () => {
    ctx.pickRandomEvent.mockRejectedValue(new Error("db connection reset"));

    await expect(
      getRandomEvent(ctx.deps, {
        window: {
          from: new Date("2025-01-01T00:00:00.000Z"),
          to: new Date("2025-02-01T00:00:00.000Z"),
        },
      }),
    ).rejects.toMatchObject({ code: "NO_RANDOM_EVENT_AVAILABLE" });
  });

  it("passes normalized filters through to the repo", async () => {
    const excluded = makeUuid(8);
    const event = makeEventRecord({ id: makeUuid(7) });
    ctx.pickRandomEvent.mockResolvedValue(event);
    // H2: a placeId filter loads the place for its owner ids.
    ctx.places.set(makeUuid(300), {
      id: makeUuid(300),
      name: "Filtered Venue",
      orgIdsWithAccess: [makeUuid(200)],
      humanIdsWithAccess: [],
    } as unknown as PlaceRecord);

    await getRandomEvent(ctx.deps, {
      near: { lat: 40, lng: -74, radiusKm: 25 },
      q: "  jazz  ",
      window: {
        from: new Date("2025-01-01T00:00:00.000Z"),
        to: new Date("2025-02-01T00:00:00.000Z"),
      },
      orgId: makeUuid(200),
      placeId: makeUuid(300),
      excludeEventIds: [excluded, excluded],
      publishedOnly: true,
    });

    expect(ctx.pickRandomEvent).toHaveBeenCalledTimes(1);
    const arg = ctx.pickRandomEvent.mock.calls[0]![0] as PickRandomEventInput;
    // H3: there is NO caller-controlled scope on the repo call — the repo
    // always picks published + PUBLIC + ungated.
    expect(arg).not.toHaveProperty("publishedOnly");
    expect(arg.window).toEqual({
      from: new Date("2025-01-01T00:00:00.000Z"),
      to: new Date("2025-02-01T00:00:00.000Z"),
    });
    expect(arg.near).toEqual({ lat: 40, lng: -74, radiusKm: 25 });
    expect(arg.q).toBe("jazz");
    expect(arg.orgId).toBe(makeUuid(200));
    expect(arg.placeId).toBe(makeUuid(300));
    expect(arg.venueConfirmedFor).toEqual({
      orgIds: [makeUuid(200)],
      humanIds: [],
      acceptsCommunityListings: false,
    });
    // Duplicates are deduped by normalization.
    expect(arg.excludeEventIds).toEqual([excluded]);
  });

  it("sends no scope flag and applies a 30-day window", async () => {
    const event = makeEventRecord({ id: makeUuid(9) });
    ctx.pickRandomEvent.mockResolvedValue(event);

    await getRandomEvent(ctx.deps, {});

    const arg = ctx.pickRandomEvent.mock.calls[0]![0] as PickRandomEventInput;
    expect(arg).not.toHaveProperty("publishedOnly");
    expect(arg.window.from).toEqual(NOW);
    expect(arg.window.to).toEqual(
      new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
    );
    expect(arg.near).toBeNull();
    expect(arg.q).toBeNull();
    expect(arg.excludeEventIds).toEqual([]);
  });

  it("accepts the max radius (500) and passes it through to the repo", async () => {
    const event = makeEventRecord({ id: makeUuid(10) });
    ctx.pickRandomEvent.mockResolvedValue(event);

    await getRandomEvent(ctx.deps, {
      near: { lat: 10, lng: 10, radiusKm: 500 },
    });

    const arg = ctx.pickRandomEvent.mock.calls[0]![0] as PickRandomEventInput;
    expect(arg.near?.radiusKm).toBe(500);
  });

  it("rejects a radius above the 500km cap", async () => {
    // The input schema enforces the cap (max 500, inclusive), so anything
    // larger is rejected at validation rather than silently clamped.
    await expect(
      getRandomEvent(ctx.deps, {
        near: { lat: 10, lng: 10, radiusKm: 501 },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("validates time window", async () => {
    await expect(
      getRandomEvent(ctx.deps, {
        window: {
          from: new Date("2025-02-01T00:00:00.000Z"),
          to: new Date("2025-01-01T00:00:00.000Z"),
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_TIME_WINDOW" });
  });

  it("replays cached response when idempotency key reused with different seed", async () => {
    const event = makeEventRecord({ id: makeUuid(4) });
    ctx.pickRandomEvent.mockResolvedValue(event);

    const input = {
      window: {
        from: new Date("2025-01-01T00:00:00.000Z"),
        to: new Date("2025-02-01T00:00:00.000Z"),
      },
      idempotencyKey: "client-key-123",
      seed: "seed-1",
    } as const;

    const first = await getRandomEvent(ctx.deps, input);
    ctx.pickRandomEvent.mockClear();

    const second = await getRandomEvent(ctx.deps, { ...input, seed: "seed-2" });

    expect(second).toEqual(first);
    expect(ctx.pickRandomEvent).not.toHaveBeenCalled();
  });
});

function createTestContext(): TestContext {
  const organizations = new Map<string, OrganizationRecord>();
  const places = new Map<string, PlaceRecord>();
  const pickRandomEvent = vi.fn(async () => null as EventRecord | null);

  const metrics = createMetricsMock();
  const idempotency = createFakeIdempotencyPort();
  const logger = createTestLogger();
  const clock: ClockPort = {
    now: () => new Date(NOW.getTime()),
  };

  const repos = createReposStub({ organizations, places, pickRandomEvent });

  const deps: GetRandomEventDeps = {
    repos,
    idempotency,
    clock,
    logger,
    metrics,
  };

  return { deps, organizations, places, pickRandomEvent, metrics, idempotency };
}

function createMetricsMock(): MetricsMock {
  return {
    increment: vi.fn(),
    record: vi.fn(),
  };
}

function createReposStub({
  organizations,
  places,
  pickRandomEvent,
}: {
  organizations: Map<string, OrganizationRecord>;
  places: Map<string, PlaceRecord>;
  pickRandomEvent: Mock;
}): Repos {
  const eventsRepo = {
    getById: vi.fn(async () => null),
    findManyByIds: vi.fn(async () => []),
    pickRandomEvent,
    getContent: vi.fn(async () => null),
    updateContent: vi.fn(),
    listPublishedByCountry: vi.fn(),
    listTicketTypes: vi.fn(),
    listPublishedForSitemap: vi.fn(async () => []),
    ensureHostPermission: vi.fn(),
    upsertDraft: vi.fn(),
    publish: vi.fn(),
    setCategory: vi.fn(),
    setListingPriority: vi.fn(),
    listPublishedByRegion: vi.fn(),
    filterByCategory: vi.fn(),
    searchPublished: vi.fn(),
    updateVisibility: vi.fn(),
    updateGateType: vi.fn(),
    updatePassword: vi.fn(),
    updateWaitlistSettings: vi.fn(),
    getGateSettings: vi.fn(),
    assignSlug: vi.fn(),
    updateSlug: vi.fn(),
    recordSlugHistory: vi.fn(async () => undefined),
    resolveBySlug: vi.fn(async () => null),
    getSlugContext: vi.fn(async () => null),
  } as unknown as Repos["events"];

  const organizationsRepo = {
    getById: vi.fn(async (id: string) => organizations.get(id) ?? null),
    create: vi.fn(),
    addMember: vi.fn(),
    countMembersByRole: vi.fn(),
    listActive: vi.fn(async () => ({ items: [], total: 0 })),
  } as unknown as Repos["organizations"];

  const placesRepo = {
    getById: vi.fn(async (id: string) => places.get(id) ?? null),
    upsert: vi.fn(),
    listAccessibleByHuman: vi.fn(async () => ({
      items: [],
      pageInfo: {
        total: 0,
        count: 0,
        limit: 20,
        offset: 0,
        hasNextPage: false,
        nextOffset: null,
      },
    })),
  } as unknown as Repos["places"];

  const txRepos = {
    events: eventsRepo,
    organizations: organizationsRepo,
    places: placesRepo,
  } as unknown as TxRepos;

  return {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
    events: eventsRepo,
    organizations: organizationsRepo,
    places: placesRepo,
  } as unknown as Repos;
}

function makeEventRecord(
  overrides: Partial<EventRecord> & { id: string },
): EventRecord {
  return {
    id: overrides.id,
    orgId: overrides.orgId ?? null,
    humanId: overrides.humanId ?? null,
    title: overrides.title ?? "Sample Event",
    status: overrides.status ?? "PUBLISHED",
    visibility: overrides.visibility ?? "PUBLIC",
    gateType: overrides.gateType ?? "NONE",
    locationMode: overrides.locationMode ?? "EXACT",
    locationRadiusMeters: overrides.locationRadiusMeters ?? null,
    locationLabel: overrides.locationLabel ?? null,
    startsAt: overrides.startsAt ?? new Date("2025-01-10T00:00:00.000Z"),
    endsAt: overrides.endsAt ?? null,
    placeId: overrides.placeId ?? null,
    savedLocationId: overrides.savedLocationId ?? null,
    addressText: overrides.addressText ?? "123 Main St",
    lat: overrides.lat ?? 40.7128,
    lng: overrides.lng ?? -74.006,
    slug: overrides.slug ?? null,
    shortId: overrides.shortId ?? null,
    regionCode: overrides.regionCode ?? null,
    publishedAt: overrides.publishedAt ?? new Date("2024-12-01T00:00:00.000Z"),
    categoryId: overrides.categoryId ?? "category-rock",
    agreementPrimaryId: overrides.agreementPrimaryId ?? "agreement-primary",
    agreementResaleId: overrides.agreementResaleId ?? null,
    defaultLocale: overrides.defaultLocale ?? null,
    listingPriority: overrides.listingPriority ?? null,
    passwordHash: overrides.passwordHash ?? null,
    passwordUpdatedAt: overrides.passwordUpdatedAt ?? null,
    waitlistStatus: overrides.waitlistStatus ?? "DISABLED",
    waitlistPublishAt: overrides.waitlistPublishAt ?? null,
    waitlistDescription: overrides.waitlistDescription ?? null,
    waitlistCap: overrides.waitlistCap ?? null,
    payoutTermsId: overrides.payoutTermsId ?? null,
    resalePayoutTermsId: overrides.resalePayoutTermsId ?? null,
    placeLayoutId: overrides.placeLayoutId ?? null,
    currency: null,
  } as EventRecord;
}

function makeOrgRecord(
  overrides: Partial<OrganizationRecord> & { id: string },
): OrganizationRecord {
  return {
    id: overrides.id,
    name: overrides.name ?? "Org Name",
    slug: overrides.slug ?? "org-name",
    status: overrides.status ?? "ACTIVE",
    defaultLocale: overrides.defaultLocale ?? null,
  } as OrganizationRecord;
}

// ─────────────────────────────────────────────────────────────────────────────
// Venue confirmation (docs/specs/2026-08-27): the public random read names
// the venue ONLY when it vouches for the event; otherwise `place` is null and
// `placeId` never leaves the server.
// ─────────────────────────────────────────────────────────────────────────────

describe("getRandomEvent — venue confirmation", () => {
  const PLACE_ID = makeUuid(500);
  const VENUE_ORG_ID = makeUuid(501);
  const VENUE_HUMAN_ID = makeUuid(502);
  const THIRD_PARTY_ORG_ID = makeUuid(503);
  const WINDOW = {
    from: new Date("2025-01-01T00:00:00.000Z"),
    to: new Date("2025-02-01T00:00:00.000Z"),
  };

  function seed(overrides: Partial<EventRecord>) {
    const ctx = createTestContext();
    ctx.places.set(PLACE_ID, {
      id: PLACE_ID,
      name: "The Corner Stage",
      orgIdsWithAccess: [VENUE_ORG_ID],
      humanIdsWithAccess: [VENUE_HUMAN_ID],
    } as unknown as PlaceRecord);
    // `makeEventRecord` copies known fields only; spread the overrides on top
    // so the venue-confirmation columns land.
    ctx.pickRandomEvent.mockResolvedValue({
      ...makeEventRecord({ id: makeUuid(510), placeId: PLACE_ID }),
      ...overrides,
    });
    return ctx;
  }

  it("UNCONFIRMED third-party event: place is null and the placeId is not on the wire", async () => {
    const ctx = seed({ orgId: THIRD_PARTY_ORG_ID });
    const out = await getRandomEvent(ctx.deps, { window: WINDOW });
    expect(out.place).toBeNull();
    expect(JSON.stringify(out)).not.toContain(PLACE_ID);
  });

  it("VENUE-OWNED (org or direct human owner): place is present without a stamp", async () => {
    const byOrg = await getRandomEvent(seed({ orgId: VENUE_ORG_ID }).deps, { window: WINDOW });
    expect(byOrg.place).toEqual({ id: PLACE_ID, name: "The Corner Stage" });
    const byHuman = await getRandomEvent(seed({ humanId: VENUE_HUMAN_ID }).deps, { window: WINDOW });
    expect(byHuman.place).toEqual({ id: PLACE_ID, name: "The Corner Stage" });
  });

  it("STAMPED third-party event: place is present", async () => {
    const ctx = seed({
      orgId: THIRD_PARTY_ORG_ID,
      venueConfirmedPlaceId: PLACE_ID, venueConfirmedAt: new Date("2024-12-20T00:00:00.000Z"),
      venueConfirmationWithdrawnAt: null,
    });
    const out = await getRandomEvent(ctx.deps, { window: WINDOW });
    expect(out.place).toEqual({ id: PLACE_ID, name: "The Corner Stage" });
  });

  it("WITHDRAWN stamp: place is null, exactly like never-confirmed", async () => {
    const ctx = seed({
      orgId: THIRD_PARTY_ORG_ID,
      venueConfirmedPlaceId: PLACE_ID, venueConfirmedAt: new Date("2024-12-20T00:00:00.000Z"),
      venueConfirmationWithdrawnAt: new Date("2024-12-21T00:00:00.000Z"),
      venueConfirmationWithdrawnReason: "not ours",
    });
    const out = await getRandomEvent(ctx.deps, { window: WINDOW });
    expect(out.place).toBeNull();
  });

  it("a vanished place row cannot vouch: place is null even for a stamped event", async () => {
    const ctx = seed({ orgId: THIRD_PARTY_ORG_ID, venueConfirmedPlaceId: PLACE_ID, venueConfirmedAt: new Date("2024-12-20T00:00:00.000Z") });
    ctx.places.delete(PLACE_ID);
    const out = await getRandomEvent(ctx.deps, { window: WINDOW });
    expect(out.place).toBeNull();
  });

  it("H2: a placeId FILTER reads confirmed-only — venueConfirmedFor (the place's owner ids) reaches pickRandomEvent", async () => {
    const ctx = seed({ orgId: VENUE_ORG_ID });
    await getRandomEvent(ctx.deps, { window: WINDOW, placeId: PLACE_ID });
    expect(ctx.pickRandomEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        venueConfirmedFor: {
          orgIds: [VENUE_ORG_ID],
          humanIds: [VENUE_HUMAN_ID],
          acceptsCommunityListings: false,
        },
      }),
    );
  });

  it("H2: no placeId filter → no venueConfirmedFor on the pick", async () => {
    const ctx = seed({ orgId: VENUE_ORG_ID });
    await getRandomEvent(ctx.deps, { window: WINDOW });
    const arg = ctx.pickRandomEvent.mock.calls[0]![0] as Record<string, unknown>;
    expect("venueConfirmedFor" in arg).toBe(false);
  });

  it("H2: an unknown placeId filter is 'nothing to pick' — the repo is never asked", async () => {
    const ctx = seed({ orgId: VENUE_ORG_ID });
    ctx.places.delete(PLACE_ID);
    await expect(getRandomEvent(ctx.deps, { window: WINDOW, placeId: PLACE_ID })).rejects.toMatchObject({
      code: "NO_RANDOM_EVENT_AVAILABLE",
    });
    expect(ctx.pickRandomEvent).not.toHaveBeenCalled();
  });

  it("a REJECTING place read reports once (guarded) and still returns place: null", async () => {
    const ctx = seed({ orgId: VENUE_ORG_ID });
    const err = new Error("db down");
    (ctx.deps.repos.places.getById as Mock).mockRejectedValueOnce(err);
    const reportError = vi.fn();
    const out = await getRandomEvent({ ...ctx.deps, reportError }, { window: WINDOW });
    expect(out.place).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(err, {
      tags: { useCase: "getRandomEvent", step: "placeRead" },
      extra: { eventId: makeUuid(510), placeId: PLACE_ID },
    });

    // A throwing reporter changes nothing.
    const again = seed({ orgId: VENUE_ORG_ID });
    (again.deps.repos.places.getById as Mock).mockRejectedValueOnce(err);
    const throwing = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(getRandomEvent({ ...again.deps, reportError: throwing }, { window: WINDOW })).resolves.toMatchObject({
      place: null,
    });
  });

  it("a REJECTING org read reports once (guarded) and still returns the event, org unnamed", async () => {
    const ctx = seed({ orgId: VENUE_ORG_ID });
    const err = new Error("org read down");
    (ctx.deps.repos.organizations.getById as Mock).mockRejectedValueOnce(err);
    const reportError = vi.fn();
    const out = await getRandomEvent({ ...ctx.deps, reportError }, { window: WINDOW });
    expect(out.org).toMatchObject({ id: VENUE_ORG_ID });
    expect(out.org?.name).toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(err, {
      tags: { useCase: "getRandomEvent", step: "orgRead" },
      extra: { eventId: makeUuid(510), orgId: VENUE_ORG_ID },
    });

    // A throwing reporter changes nothing.
    const again = seed({ orgId: VENUE_ORG_ID });
    (again.deps.repos.organizations.getById as Mock).mockRejectedValueOnce(err);
    const throwing = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(
      getRandomEvent({ ...again.deps, reportError: throwing }, { window: WINDOW }),
    ).resolves.toMatchObject({ org: { id: VENUE_ORG_ID } });
  });

  it("a REJECTING pick reports once and degrades to NO_RANDOM_EVENT_AVAILABLE", async () => {
    const ctx = createTestContext();
    const err = new Error("db down");
    ctx.pickRandomEvent.mockRejectedValue(err);
    const reportError = vi.fn();
    await expect(getRandomEvent({ ...ctx.deps, reportError }, { window: WINDOW })).rejects.toMatchObject({
      code: "NO_RANDOM_EVENT_AVAILABLE",
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({ tags: { useCase: "getRandomEvent", step: "pickRandomEvent" } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Location privacy (D2): the random pick is a PUBLIC read. An OBSCURED event —
// or any event at a venue that withholds its address — emits its keyed circle
// centre and a coarse label, and the `near` distance is measured to THAT point.
// ─────────────────────────────────────────────────────────────────────────────

describe("getRandomEvent — public location projection", () => {
  const TRUE = { lat: 36.1775, lng: -86.7412 };
  const VIEWER = { lat: 36.16, lng: -86.78 };
  const WINDOW = {
    from: new Date("2025-01-01T00:00:00.000Z"),
    to: new Date("2025-02-01T00:00:00.000Z"),
  };
  const kmFrom = (to: { lat: number; lng: number }) =>
    haversineDistance(VIEWER.lat, VIEWER.lng, to.lat, to.lng) / 1000;

  it("OBSCURED event → circle centre + coarse label; distance from the EMITTED point", async () => {
    const ctx = createTestContext();
    const event = makeEventRecord({
      id: makeUuid(700),
      locationMode: "OBSCURED",
      locationRadiusMeters: 500,
      addressText: "1417 Shelby Ave, Nashville, TN 37206",
      ...TRUE,
    });
    Object.assign(event, { locality: "Nashville", region: "TN" });
    ctx.pickRandomEvent.mockResolvedValue(event);

    const output = await getRandomEvent(ctx.deps, {
      near: { ...VIEWER, radiusKm: 10 },
      window: WINDOW,
    });

    const expected = projectPublicEventLocation(event);
    expect(output.location.lat).toBe(expected.lat);
    expect(output.location.lng).toBe(expected.lng);
    expect(output.location.lat).not.toBe(TRUE.lat);
    expect(output.location.addressText).toBe("Nashville, TN");
    expect(JSON.stringify(output)).not.toContain("Shelby");
    expect(output.location.distanceKm).toBeCloseTo(
      kmFrom({ lat: expected.lat!, lng: expected.lng! }),
      9,
    );
    expect(output.location.distanceKm).not.toBeCloseTo(kmFrom(TRUE), 6);
  });

  it("a stale EXACT row at a WITHHELD venue → the venue's circle, no street", async () => {
    const ctx = createTestContext();
    const placeId = makeUuid(701);
    const venue = {
      id: placeId,
      name: "The Shelby House",
      locationMode: "OBSCURED",
      locationRadiusMeters: 800,
      formattedAddress: "1417 Shelby Ave, Nashville, TN 37206",
      city: "Nashville",
      region: "TN",
      orgIdsWithAccess: [],
      humanIdsWithAccess: [],
      ...TRUE,
    } as unknown as PlaceRecord;
    ctx.places.set(placeId, venue);
    ctx.pickRandomEvent.mockResolvedValue(
      makeEventRecord({
        id: makeUuid(702),
        placeId,
        locationMode: "EXACT",
        addressText: "1417 Shelby Ave, Nashville, TN 37206",
        ...TRUE,
      }),
    );

    const output = await getRandomEvent(ctx.deps, {
      near: { ...VIEWER, radiusKm: 10 },
      window: WINDOW,
    });

    const venueCircle = redactPlaceLocation(venue);
    expect(output.location.lat).toBe(venueCircle.lat);
    expect(output.location.lng).toBe(venueCircle.lng);
    expect(output.location.addressText).toBe("Nashville, TN");
    expect(output.location.distanceKm).not.toBeCloseTo(kmFrom(TRUE), 6);
    expect(JSON.stringify(output)).not.toContain("Shelby Ave");
  });

  it("a fully hidden event → no coordinates and NO distance", async () => {
    const ctx = createTestContext();
    ctx.pickRandomEvent.mockResolvedValue(
      makeEventRecord({
        id: makeUuid(703),
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
        ...TRUE,
      }),
    );

    const output = await getRandomEvent(ctx.deps, {
      near: { ...VIEWER, radiusKm: 10 },
      window: WINDOW,
    });

    expect(output.location).toMatchObject({ lat: null, lng: null, distanceKm: null });
    expect(output.location.addressText).not.toBe("123 Main St");
  });

  it("EXACT event → unchanged: true pin, street, true distance", async () => {
    const ctx = createTestContext();
    ctx.pickRandomEvent.mockResolvedValue(
      makeEventRecord({
        id: makeUuid(704),
        locationMode: "EXACT",
        addressText: "1 Broadway",
        ...TRUE,
      }),
    );

    const output = await getRandomEvent(ctx.deps, {
      near: { ...VIEWER, radiusKm: 10 },
      window: WINDOW,
    });

    expect(output.location).toEqual({
      lat: TRUE.lat,
      lng: TRUE.lng,
      addressText: "1 Broadway",
      distanceKm: kmFrom(TRUE),
    });
  });
});

describe("getRandomEventInput — H3: the client cannot widen the pick", () => {
  it("REJECTS publishedOnly: false (the drafts/private-events door)", () => {
    const parsed = getRandomEventInput.safeParse({ publishedOnly: false });
    expect(parsed.success).toBe(false);
  });

  it("accepts publishedOnly: true (deployed clients still send it) and omission", () => {
    expect(getRandomEventInput.safeParse({ publishedOnly: true }).success).toBe(
      true,
    );
    expect(getRandomEventInput.safeParse({}).success).toBe(true);
  });

  it("rejects any other value for it", () => {
    for (const value of ["false", 0, null, "true"]) {
      expect(
        getRandomEventInput.safeParse({ publishedOnly: value }).success,
      ).toBe(false);
    }
  });
});
