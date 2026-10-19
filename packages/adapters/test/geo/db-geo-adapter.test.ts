import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const EARTH_RADIUS_METERS = 6_371_000;
const toRadians = (value: number): number => (value * Math.PI) / 180;

const { encodeGeohashMock, geohashNeighborsMock } = vi.hoisted(() => ({
  encodeGeohashMock: vi.fn(
    (lat: number, lng: number, precision: number) =>
      `hash-${precision}-${lat.toFixed(2)}-${lng.toFixed(2)}`,
  ),
  geohashNeighborsMock: vi.fn((hash: string) =>
    Array.from({ length: 8 }, (_, index) => `${hash}-n${index}`),
  ),
}));

vi.mock("@th/core/lib/geo", () => ({
  bboxForRadius: (lat: number, lng: number, radiusKm: number) => {
    const radiusMeters = radiusKm * 1_000;
    const deltaLat = (radiusMeters / EARTH_RADIUS_METERS) * (180 / Math.PI);
    const cosLat = Math.cos(toRadians(lat));
    const deltaLng =
      cosLat === 0
        ? 180
        : ((radiusMeters / EARTH_RADIUS_METERS) * (180 / Math.PI)) /
          Math.max(cosLat, 1e-6);

    return {
      minLat: lat - deltaLat,
      maxLat: lat + deltaLat,
      minLng: lng - deltaLng,
      maxLng: lng + deltaLng,
    };
  },
  haversineDistance: (
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ) => {
    const phi1 = toRadians(lat1);
    const phi2 = toRadians(lat2);
    const deltaPhi = toRadians(lat2 - lat1);
    const deltaLambda = toRadians(lng2 - lng1);

    const sinDeltaPhi = Math.sin(deltaPhi / 2);
    const sinDeltaLambda = Math.sin(deltaLambda / 2);

    const a =
      sinDeltaPhi * sinDeltaPhi +
      Math.cos(phi1) * Math.cos(phi2) * sinDeltaLambda * sinDeltaLambda;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return EARTH_RADIUS_METERS * c;
  },
  encodeGeohash: encodeGeohashMock,
  geohashNeighbors: geohashNeighborsMock,
}));

// DbGeoAdapter imports these modules directly, so we mock them too.
vi.mock("@th/core/lib/geo/geohash", () => ({
  bboxForRadius: (lat: number, lng: number, radiusKm: number) => {
    const radiusMeters = radiusKm * 1_000;
    const deltaLat = (radiusMeters / EARTH_RADIUS_METERS) * (180 / Math.PI);
    const cosLat = Math.cos(toRadians(lat));
    const deltaLng =
      cosLat === 0
        ? 180
        : ((radiusMeters / EARTH_RADIUS_METERS) * (180 / Math.PI)) /
          Math.max(cosLat, 1e-6);

    return {
      minLat: lat - deltaLat,
      maxLat: lat + deltaLat,
      minLng: lng - deltaLng,
      maxLng: lng + deltaLng,
    };
  },
  encodeGeohash: encodeGeohashMock,
  geohashNeighbors: geohashNeighborsMock,
}));

vi.mock("@th/core/lib/geo/haversine", () => ({
  haversineDistance: (
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ) => {
    const phi1 = toRadians(lat1);
    const phi2 = toRadians(lat2);
    const deltaPhi = toRadians(lat2 - lat1);
    const deltaLambda = toRadians(lng2 - lng1);

    const sinDeltaPhi = Math.sin(deltaPhi / 2);
    const sinDeltaLambda = Math.sin(deltaLambda / 2);

    const a =
      sinDeltaPhi * sinDeltaPhi +
      Math.cos(phi1) * Math.cos(phi2) * sinDeltaLambda * sinDeltaLambda;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return EARTH_RADIUS_METERS * c;
  },
}));

import { publicEventCoordinate } from "@th/core/lib/location/public-coordinate";
import { redactPlaceLocation } from "@th/core/lib/location/redact-place-location";
import { haversineDistance } from "@th/core/lib/geo/haversine";

import { DbGeoAdapter } from "../../src/geo/db-geo-adapter";

/**
 * The event-ROW branch of an event candidate query — events with no venue or
 * a venue that publishes its address. (The other branch fetches events at a
 * withheld venue by the VENUE's point.)
 */
const eventRowClauses = (where: unknown): Array<Record<string, unknown>> => {
  const top = ((where as { AND?: unknown[] })?.AND ?? []) as Array<{
    OR?: Array<Record<string, unknown>>;
  }>;
  const split = top.find(
    (clause) =>
      Array.isArray(clause.OR) &&
      clause.OR.some((branch) => Array.isArray(branch.AND)),
  );
  const rowBranch = split?.OR?.find((branch) => Array.isArray(branch.AND));
  return (rowBranch?.AND ?? []) as Array<Record<string, unknown>>;
};

const createPrismaMock = (overrides?: {
  places?: Array<
    Partial<{
      id: string;
      name: string;
      address: string | null;
      lat: number;
      lng: number;
    }>
  >;
  events?: Array<
    Partial<{
      id: string;
      title: string;
      addressText: string | null;
      lat: number;
      lng: number;
      /** string (not just the enum) so tests can exercise unknown-mode fail-closed. */
      locationMode: string;
      locationRadiusMeters: number | null;
      locality: string | null;
      region: string | null;
    }>
  >;
  queryError?: Error;
}) => {
  const placeRows = overrides?.places ?? [];
  // The real Prisma row always carries these columns; tests that don't care
  // about location privacy default to EXACT so behaviour is unchanged.
  const eventRows = (overrides?.events ?? []).map((e) => ({
    addressText: null,
    slug: null,
    heroImage: null,
    // Selected on every row (N5: the projector fails a missing gate closed).
    gateType: "NONE",
    locationMode: "EXACT" as const,
    locationRadiusMeters: 500,
    locality: null,
    region: null,
    ...e,
  }));

  const placeFindMany = vi.fn().mockImplementation(async () => placeRows);
  const eventFindMany = vi.fn().mockImplementation(async () => eventRows);
  const queryRaw = overrides?.queryError
    ? vi.fn().mockRejectedValue(overrides.queryError)
    : vi.fn().mockResolvedValue([{ ok: 1 }]);

  const client = {
    place: { findMany: placeFindMany },
    event: { findMany: eventFindMany },
    $queryRaw: queryRaw,
  } as unknown as PrismaClient;

  return { client, spies: { placeFindMany, eventFindMany, queryRaw } };
};

describe("DbGeoAdapter", () => {
  beforeEach(() => {
    encodeGeohashMock.mockClear();
    geohashNeighborsMock.mockClear();
  });

  it("returns nearby places ordered by distance and respects pagination", async () => {
    const { client } = createPrismaMock({
      places: [
        { id: "2", name: "Second", address: "B", lat: 37.7751, lng: -122.418 },
        { id: "1", name: "First", address: "A", lat: 37.7749, lng: -122.4194 },
        { id: "3", name: "Far", address: "C", lat: 37.779, lng: -122.415 },
      ],
    });

    const adapter = new DbGeoAdapter(client);

    const result = await adapter.nearbyPlaces({
      lat: 37.7749,
      lng: -122.4194,
      radiusM: 400,
      limit: 1,
      offset: 0,
    });
    expect(result.items).toHaveLength(1);
    const [first] = result.items;
    expect(first).toBeDefined();
    if (!first) {
      throw new Error("Expected at least one nearby place");
    }
    expect(first.id).toBe("1");
    expect(first.distanceMeters).toBeGreaterThanOrEqual(0);
    expect(first.distanceMeters).toBeLessThan(10);
  });

  it("orders box search results deterministically by the EMITTED coordinate and paginates in JS", async () => {
    const { client, spies } = createPrismaMock({
      events: [
        { id: "b", title: "B", lat: 34.0524, lng: -118.244 },
        { id: "a", title: "A", lat: 34.0522, lng: -118.2437 },
        { id: "c", title: "C", lat: 34.06, lng: -118.25 },
      ],
    });

    const adapter = new DbGeoAdapter(client);

    const result = await adapter.boxSearch({
      entity: "event",
      sw: { lat: 34.0, lng: -118.3 },
      ne: { lat: 34.2, lng: -118.1 },
      limit: 2,
      offset: 0,
    });
    // Ordered by emitted lat/lng (EXACT rows: emitted == true), sliced to 2.
    expect(result.map((row) => row.id)).toEqual(["a", "b"]);

    // Ordering/pagination must NOT run in SQL against the true coordinates —
    // a true-coord ORDER BY leaks an obscured row's position between its
    // exact-mode neighbours, and SQL skip/take would page on that ordering.
    const callArgs = spies.eventFindMany.mock.calls[0]?.[0];
    expect(callArgs?.orderBy).toBeUndefined();
    expect(callArgs?.skip).toBeUndefined();
    expect(callArgs?.take).toBeUndefined();
  });

  it("computes haversine distance between coordinates", async () => {
    const { client } = createPrismaMock();
    const adapter = new DbGeoAdapter(client);

    const distance = await adapter.distance({
      a: { lat: 37.7749, lng: -122.4194 },
      b: { lat: 34.0522, lng: -118.2437 },
    });

    expect(distance).toBeGreaterThan(500_000);
    expect(distance).toBeLessThan(650_000);
  });

  it("reports unhealthy status when the health probe fails", async () => {
    const probeError = new Error("connection refused");
    const { client } = createPrismaMock({ queryError: probeError });

    const adapter = new DbGeoAdapter(client);
    const health = await adapter.health();

    expect(health.ok).toBe(false);
    expect(health.backend).toBe("db");
    expect(health.reason).toBe(probeError.message);
  });

  it("applies geohash prefix filtering for event radius queries", async () => {
    const { client, spies } = createPrismaMock({
      events: [{ id: "g", title: "Geo", lat: 0, lng: 0 }],
    });

    const adapter = new DbGeoAdapter(client);

    await adapter.nearbyEvents({ lat: 10.01, lng: 20.02, radiusM: 1_000 });

    const callArgs = spies.eventFindMany.mock.calls[0]?.[0];
    expect(eventRowClauses(callArgs?.where)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ geohash6: { not: null } }),
        // The geohash prefix filter is scoped to the EXACT candidate branch;
        // non-EXACT rows use a bbox widened by the max obfuscation radius
        // (their geohash is derived from the TRUE coordinate, so a tight
        // prefix filter would leak/miss based on the true pin).
        expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              locationMode: "EXACT",
              OR: expect.arrayContaining([
                expect.objectContaining({
                  geohash6: { startsWith: expect.stringContaining("hash-") },
                }),
              ]),
            }),
            expect.objectContaining({
              locationMode: { not: "EXACT" },
            }),
          ]),
        }),
      ]),
    );

    expect(encodeGeohashMock).toHaveBeenCalledWith(
      10.01,
      20.02,
      expect.any(Number),
    );
    expect(geohashNeighborsMock).toHaveBeenCalledWith(
      expect.stringContaining("hash-"),
    );
  });

  // ── FR-013: non-EXACT events never emit their precise pin or street address ──

  it("nearbyEvents coarsens OBSCURED coords + drops the street address, and drops fully-hidden events", async () => {
    const TRUE_LAT = 37.7749;
    const TRUE_LNG = -122.4194;
    const { client } = createPrismaMock({
      events: [
        {
          id: "exact",
          title: "Exact",
          addressText: "100 Real St, San Francisco, CA",
          lat: TRUE_LAT,
          lng: TRUE_LNG,
          locationMode: "EXACT",
          locality: "San Francisco",
          region: "CA",
        },
        {
          id: "obscured",
          title: "Obscured",
          addressText: "200 Secret Ave, San Francisco, CA",
          lat: TRUE_LAT,
          lng: TRUE_LNG,
          locationMode: "OBSCURED",
          locationRadiusMeters: 500,
          locality: "San Francisco",
          region: "CA",
        },
        {
          id: "fully-hidden",
          title: "Fully Hidden",
          addressText: "300 Private Rd, San Francisco, CA",
          lat: TRUE_LAT,
          lng: TRUE_LNG,
          locationMode: "OBSCURED",
          locationRadiusMeters: null,
          locality: "San Francisco",
          region: "CA",
        },
      ],
    });

    const adapter = new DbGeoAdapter(client);
    const result = await adapter.nearbyEvents({
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      radiusM: 5_000,
    });

    const byId = new Map(result.items.map((e) => [e.id, e]));

    const exact = byId.get("exact");
    expect(exact).toBeDefined();
    expect(exact?.lat).toBe(TRUE_LAT);
    expect(exact?.lng).toBe(TRUE_LNG);
    expect(exact?.addressText).toBe("100 Real St, San Francisco, CA");

    const obscured = byId.get("obscured");
    expect(obscured).toBeDefined();
    // Coordinate is obscured (not the true pin) — and is the deterministic
    // public point.
    expect(obscured?.lat).not.toBe(TRUE_LAT);
    expect(obscured?.lng).not.toBe(TRUE_LNG);
    const emitted = publicEventCoordinate({
      eventId: "obscured",
      locationMode: "OBSCURED",
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      locationRadiusMeters: 500,
    });
    expect(obscured?.lat).toBe(emitted?.lat);
    expect(obscured?.lng).toBe(emitted?.lng);
    // Map-UI discriminant is present; EXACT rows never carry it.
    expect(obscured?.obscured).toBe(true);
    expect(obscured?.radiusMeters).toBe(500);
    expect(exact?.obscured).toBeUndefined();
    // Street address is never emitted — only a coarse area label.
    expect(obscured?.addressText).toBe("San Francisco, CA");
    // Distance is measured from the obscured point, not the true point.
    expect(obscured?.distanceMeters).toBeGreaterThan(0);

    // FULLY HIDDEN (null radius): no marker at all — the row is dropped.
    expect(byId.has("fully-hidden")).toBe(false);
    // Totals/counts exclude hidden rows too (no count side-channel): even
    // when a hidden row slips past the SQL filter (belt-and-braces), the
    // reported total reflects only publicly-visible events.
    expect(result.pageInfo.total).toBe(2);
    expect(result.pageInfo.count).toBe(2);
  });

  it("excludes fully-hidden events in the query itself (totals + full pages)", async () => {
    const { client, spies } = createPrismaMock();
    const adapter = new DbGeoAdapter(client);
    const hiddenExclusion = {
      NOT: { locationMode: "OBSCURED", locationRadiusMeters: null },
    };

    // nearbyEvents: hidden rows must never be fetched — totals and pagination
    // are computed from rows the DB returns.
    await adapter.nearbyEvents({ lat: 10, lng: 20, radiusM: 1_000 });
    expect(eventRowClauses(spies.eventFindMany.mock.calls[0]?.[0]?.where)).toEqual(
      expect.arrayContaining([hiddenExclusion]),
    );

    // boxSearch: skip/take run in SQL, so the exclusion must too — otherwise
    // post-filtering hidden rows would return short pages.
    await adapter.boxSearch({
      entity: "event",
      sw: { lat: 0, lng: 0 },
      ne: { lat: 1, lng: 1 },
    });
    expect(eventRowClauses(spies.eventFindMany.mock.calls[1]?.[0]?.where)).toEqual(
      expect.arrayContaining([hiddenExclusion]),
    );
  });

  it("M5: event geo reads are PUBLISHED + PUBLIC + UNGATED only — no private or gated event on the public map", async () => {
    const { client, spies } = createPrismaMock();
    const adapter = new DbGeoAdapter(client);
    await adapter.nearbyEvents({ lat: 10, lng: 20, radiusM: 1_000 });
    await adapter.boxSearch({
      entity: "event",
      sw: { lat: 0, lng: 0 },
      ne: { lat: 1, lng: 1 },
    });
    expect(spies.eventFindMany).toHaveBeenCalledTimes(2);
    for (const call of spies.eventFindMany.mock.calls) {
      expect(call[0]?.where?.AND).toEqual(
        expect.arrayContaining([
          { status: "PUBLISHED", visibility: "PUBLIC", gateType: "NONE" },
        ]),
      );
    }
  });

  it("boxSearch coarsens non-EXACT event coords + address", async () => {
    const TRUE_LAT = 34.0522;
    const TRUE_LNG = -118.2437;
    const { client } = createPrismaMock({
      events: [
        {
          id: "obscured",
          title: "Obscured",
          addressText: "400 Hidden Blvd, Los Angeles, CA",
          lat: TRUE_LAT,
          lng: TRUE_LNG,
          locationMode: "OBSCURED",
          locationRadiusMeters: 500,
          locality: "Los Angeles",
          region: "CA",
        },
        {
          id: "fully-hidden",
          title: "Fully Hidden",
          addressText: "500 Invisible Ct, Los Angeles, CA",
          lat: TRUE_LAT,
          lng: TRUE_LNG,
          locationMode: "OBSCURED",
          locationRadiusMeters: null,
          locality: "Los Angeles",
          region: "CA",
        },
      ],
    });

    const adapter = new DbGeoAdapter(client);
    const rows = await adapter.boxSearch({
      entity: "event",
      sw: { lat: 33.0, lng: -119.0 },
      ne: { lat: 35.0, lng: -117.0 },
    });

    const row = rows.find((r) => r.id === "obscured");
    expect(row).toBeDefined();
    expect(row?.lat).not.toBe(TRUE_LAT);
    expect(row?.lng).not.toBe(TRUE_LNG);
    expect((row as { addressText?: string | null }).addressText).toBe(
      "Los Angeles, CA",
    );

    // FULLY HIDDEN (null radius): dropped from box results entirely.
    expect(rows.find((r) => r.id === "fully-hidden")).toBeUndefined();
  });

  it("fails closed on unknown location modes (treated as obscured)", async () => {
    const TRUE_LAT = 37.7749;
    const TRUE_LNG = -122.4194;
    const { client } = createPrismaMock({
      events: [
        {
          id: "weird",
          title: "Weird Mode",
          addressText: "700 Mystery Ln, San Francisco, CA",
          lat: TRUE_LAT,
          lng: TRUE_LNG,
          locationMode: "SOMETHING_NEW",
          locationRadiusMeters: 500,
          locality: "San Francisco",
          region: "CA",
        },
      ],
    });

    const adapter = new DbGeoAdapter(client);
    const result = await adapter.nearbyEvents({
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      radiusM: 5_000,
    });

    const row = result.items.find((e) => e.id === "weird");
    expect(row).toBeDefined();
    expect(row?.lat).not.toBe(TRUE_LAT);
    expect(row?.lng).not.toBe(TRUE_LNG);
    expect(row?.addressText).toBe("San Francisco, CA");
    expect(row?.obscured).toBe(true);
  });

  // ── Presence-oracle regression (FR-013/NFR-001) ────────────────────────────
  // Inclusion, totals, and page composition must be functions of the EMITTED
  // (obfuscated) coordinate only. If the true pin decided inclusion, a tiny
  // probe radius on a grid would recover an obscured event's address.

  const ORACLE_TRUE_LAT = 37.7749;
  const ORACLE_TRUE_LNG = -122.4194;
  const ORACLE_EMITTED = publicEventCoordinate({
    eventId: "obscured",
    locationMode: "OBSCURED",
    lat: ORACLE_TRUE_LAT,
    lng: ORACLE_TRUE_LNG,
    locationRadiusMeters: 500,
  })!;
  const oracleEvent = {
    id: "obscured",
    title: "Obscured",
    lat: ORACLE_TRUE_LAT,
    lng: ORACLE_TRUE_LNG,
    locationMode: "OBSCURED",
    locationRadiusMeters: 500,
  };

  it("nearbyEvents does NOT include an OBSCURED event when the probe hits the TRUE pin but misses the emitted point", async () => {
    // Sanity: the emitted point really is farther than the tiny probe radius.
    expect(
      haversineDistance(
        ORACLE_TRUE_LAT,
        ORACLE_TRUE_LNG,
        ORACLE_EMITTED.lat,
        ORACLE_EMITTED.lng,
      ),
    ).toBeGreaterThan(25);

    // Probe centred exactly on the TRUE pin — the candidate fetch (mocked)
    // returns the row, so only the emitted-point post-filter protects it.
    const { client } = createPrismaMock({ events: [oracleEvent] });
    const adapter = new DbGeoAdapter(client);
    const result = await adapter.nearbyEvents({
      lat: ORACLE_TRUE_LAT,
      lng: ORACLE_TRUE_LNG,
      radiusM: 25,
    });

    expect(result.items).toHaveLength(0);
    // Totals are emitted-coordinate functions too — no count side-channel.
    expect(result.pageInfo.total).toBe(0);
  });

  it("nearbyEvents DOES include an OBSCURED event when the probe hits the emitted point even though the TRUE pin is outside", async () => {
    // The true pin is > 50 m from the probe (which sits on the emitted point).
    expect(
      haversineDistance(
        ORACLE_EMITTED.lat,
        ORACLE_EMITTED.lng,
        ORACLE_TRUE_LAT,
        ORACLE_TRUE_LNG,
      ),
    ).toBeGreaterThan(50);

    const { client } = createPrismaMock({ events: [oracleEvent] });
    const adapter = new DbGeoAdapter(client);
    const result = await adapter.nearbyEvents({
      lat: ORACLE_EMITTED.lat,
      lng: ORACLE_EMITTED.lng,
      radiusM: 50,
    });

    expect(result.items.map((e) => e.id)).toEqual(["obscured"]);
    expect(result.pageInfo.total).toBe(1);
    expect(result.items[0]?.distanceMeters).toBeLessThanOrEqual(50);
  });

  it("boxSearch includes/excludes OBSCURED events by their EMITTED point", async () => {
    const { client } = createPrismaMock({ events: [oracleEvent] });
    const adapter = new DbGeoAdapter(client);

    // Tiny box (~±30 m) around the TRUE pin: emitted point is outside → drop.
    const aroundTrue = await adapter.boxSearch({
      entity: "event",
      sw: { lat: ORACLE_TRUE_LAT - 0.0003, lng: ORACLE_TRUE_LNG - 0.0003 },
      ne: { lat: ORACLE_TRUE_LAT + 0.0003, lng: ORACLE_TRUE_LNG + 0.0003 },
    });
    expect(aroundTrue).toHaveLength(0);

    // Tiny box around the EMITTED point: included, at the emitted coordinate.
    const aroundEmitted = await adapter.boxSearch({
      entity: "event",
      sw: { lat: ORACLE_EMITTED.lat - 0.0003, lng: ORACLE_EMITTED.lng - 0.0003 },
      ne: { lat: ORACLE_EMITTED.lat + 0.0003, lng: ORACLE_EMITTED.lng + 0.0003 },
    });
    expect(aroundEmitted.map((e) => e.id)).toEqual(["obscured"]);
    expect(aroundEmitted[0]?.lat).toBe(ORACLE_EMITTED.lat);
    expect(aroundEmitted[0]?.lng).toBe(ORACLE_EMITTED.lng);
  });

  it("widens the non-EXACT candidate bbox for nearbyEvents and boxSearch", async () => {
    const { client, spies } = createPrismaMock();
    const adapter = new DbGeoAdapter(client);

    await adapter.nearbyEvents({ lat: 10, lng: 20, radiusM: 1_000 });
    const nearbyOr = (
      eventRowClauses(spies.eventFindMany.mock.calls[0]?.[0]?.where) as Array<{
        OR?: Array<Record<string, unknown>>;
      }>
    )?.find(
      (clause) =>
        Array.isArray(clause.OR) &&
        clause.OR.some((branch) => "locationMode" in branch),
    )?.OR;
    const nearbyExact = nearbyOr?.find(
      (branch) => branch.locationMode === "EXACT",
    ) as { lat: { gte: number; lte: number } };
    const nearbyObscured = nearbyOr?.find(
      (branch) => typeof branch.locationMode === "object",
    ) as { lat: { gte: number; lte: number } };
    expect(nearbyExact).toBeDefined();
    expect(nearbyObscured).toBeDefined();
    // The obscured branch spans a strictly wider latitude window (widened by
    // the max obfuscation radius) than the exact branch.
    expect(nearbyObscured.lat.gte).toBeLessThan(nearbyExact.lat.gte);
    expect(nearbyObscured.lat.lte).toBeGreaterThan(nearbyExact.lat.lte);

    await adapter.boxSearch({
      entity: "event",
      sw: { lat: 0, lng: 0 },
      ne: { lat: 1, lng: 1 },
    });
    const boxOr = (
      eventRowClauses(spies.eventFindMany.mock.calls[1]?.[0]?.where) as Array<{
        OR?: Array<Record<string, unknown>>;
      }>
    )?.find(
      (clause) =>
        Array.isArray(clause.OR) &&
        clause.OR.some((branch) => "locationMode" in branch),
    )?.OR;
    const boxObscured = boxOr?.find(
      (branch) => typeof branch.locationMode === "object",
    ) as { lat: { gte: number; lte: number } };
    expect(boxObscured).toBeDefined();
    expect(boxObscured.lat.gte).toBeLessThan(0);
    expect(boxObscured.lat.lte).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2 — the VENUE floor on the map (DB backend). An event at a venue that
// withholds its address emits the VENUE's keyed circle centre, whatever the
// event row holds, and is a candidate by the venue's point.
// ─────────────────────────────────────────────────────────────────────────────

describe("DbGeoAdapter — events at a withheld venue", () => {
  const HOUSE_ID = "00000000-0000-4000-8000-0000000000a1";
  const TRUE_LAT = 36.1775;
  const TRUE_LNG = -86.7412;
  const house = (overrides: Record<string, unknown> = {}) => ({
    id: HOUSE_ID,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East side",
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    city: "Nashville",
    region: "TN",
    country: "US",
    ...overrides,
  });
  const staleEvent = (placeOverrides: Record<string, unknown> = {}) => ({
    id: "stale-at-house",
    title: "Basement Show",
    addressText: "1417 Shelby Ave, Nashville, TN 37206",
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    // Stored EXACT, before the venue was withheld.
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locality: "Nashville",
    region: "TN",
    placeId: HOUSE_ID,
    place: house(placeOverrides),
  });
  const VENUE_CIRCLE = redactPlaceLocation(house() as never);

  it("emits the VENUE's circle centre + coarse label, never the stale row", async () => {
    const { client } = createPrismaMock({ events: [staleEvent() as never] });
    const result = await new DbGeoAdapter(client).nearbyEvents({
      lat: VENUE_CIRCLE.lat!,
      lng: VENUE_CIRCLE.lng!,
      radiusM: 1_000,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      lat: VENUE_CIRCLE.lat,
      lng: VENUE_CIRCLE.lng,
      addressText: "Nashville, TN",
      obscured: true,
      // The venue's stored 800 m is drawn at the next rung up.
      radiusMeters: 1000,
    });
    expect(JSON.stringify(result)).not.toContain("Shelby");
  });

  it("a tiny probe on the house's TRUE point does not find it (no oracle via the venue)", async () => {
    const { client } = createPrismaMock({ events: [staleEvent() as never] });
    const trueToEmitted = haversineDistance(
      TRUE_LAT,
      TRUE_LNG,
      VENUE_CIRCLE.lat!,
      VENUE_CIRCLE.lng!,
    );
    expect(trueToEmitted).toBeGreaterThan(25);
    const result = await new DbGeoAdapter(client).nearbyEvents({
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      radiusM: 25,
    });
    expect(result.items).toHaveLength(0);
    expect(result.pageInfo.total).toBe(0);
  });

  it("drops an event whose venue is fully hidden", async () => {
    const { client } = createPrismaMock({
      events: [staleEvent({ locationRadiusMeters: null }) as never],
    });
    const rows = await new DbGeoAdapter(client).boxSearch({
      entity: "event",
      sw: { lat: 35, lng: -88 },
      ne: { lat: 37, lng: -85 },
    });
    expect(rows).toHaveLength(0);
  });

  it("fetches withheld-venue events by the VENUE's point, and places by EXACT only", async () => {
    const { client, spies } = createPrismaMock();
    const adapter = new DbGeoAdapter(client);
    await adapter.nearbyEvents({ lat: 10, lng: 20, radiusM: 1_000 });
    const top = spies.eventFindMany.mock.calls[0]?.[0]?.where?.AND as Array<{
      OR?: Array<Record<string, unknown>>;
    }>;
    const venueBranch = top
      .find((clause) => Array.isArray(clause.OR))
      ?.OR?.find((branch) => "place" in branch) as {
      place: { is: Record<string, unknown> };
    };
    expect(venueBranch.place.is).toMatchObject({
      locationMode: { not: "EXACT" },
      locationRadiusMeters: { not: null },
    });

    await adapter.nearbyPlaces({ lat: 10, lng: 20, radiusM: 1_000 });
    await adapter.boxSearch({
      entity: "place",
      sw: { lat: 0, lng: 0 },
      ne: { lat: 1, lng: 1 },
    });
    for (const call of spies.placeFindMany.mock.calls) {
      expect(call[0]?.where?.AND).toEqual(
        expect.arrayContaining([{ locationMode: "EXACT" }]),
      );
    }
  });
});
