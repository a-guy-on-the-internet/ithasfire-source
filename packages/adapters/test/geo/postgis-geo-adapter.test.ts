import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { haversineDistance } from "@th/core/lib/geo/haversine";
import { publicEventCoordinate } from "@th/core/lib/location/public-coordinate";
import { redactPlaceLocation } from "@th/core/lib/location/redact-place-location";

import { PostGISGeoAdapter } from "../../src/geo/postgis-geo-adapter";

const TRUE_LAT = 40.6892;
const TRUE_LNG = -74.0445;

/**
 * The public point emitted for the OBSCURED test row `id: "obscured"` — a
 * keyed circle centre, so it is specific to that event id.
 */
const EMITTED = publicEventCoordinate({
  eventId: "obscured",
  locationMode: "OBSCURED",
  lat: TRUE_LAT,
  lng: TRUE_LNG,
  locationRadiusMeters: 500,
})!;

type EventRowOverrides = {
  id?: string;
  title?: string;
  addressText?: string | null;
  /** string (not just the enum) so tests can exercise unknown-mode fail-closed. */
  locationMode?: string;
  locationRadiusMeters?: number | null;
  locality?: string | null;
  region?: string | null;
  distance?: number;
};

/**
 * Mock a `pg` Pool whose `query()` returns a fixed event row set. The PostGIS
 * adapter routes through `pool.query(sql.text, sql.values)` and reads
 * `result.rows`, so we can exercise `mapEventRow` without a live PostGIS DB.
 * Issued query text/values are captured in `queries` so tests can assert on
 * the generated SQL.
 */
const createPoolMock = (rows: EventRowOverrides[]) => {
  const eventRows = rows.map((r) => ({
    id: r.id ?? "evt",
    title: r.title ?? "Event",
    addressText: r.addressText ?? null,
    slug: null,
    heroImageUrl: null,
    // The SQL admits ungated rows only, and the row carries the column (N5:
    // the projector fails a missing gate closed).
    gateType: "NONE",
    locationMode: r.locationMode ?? "EXACT",
    // Preserve an explicit null (fully hidden) — `??` would coerce it to 500.
    locationRadiusMeters:
      r.locationRadiusMeters === undefined ? 500 : r.locationRadiusMeters,
    locality: r.locality ?? null,
    region: r.region ?? null,
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    distance: r.distance ?? 0,
    total: rows.length,
  }));

  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: async (text: string, values: unknown[]) => {
      queries.push({ text, values });
      return { rows: eventRows };
    },
  } as unknown as Pool;

  return { client, queries };
};

describe("PostGISGeoAdapter FR-013 location redaction", () => {
  it("nearbyEvents coarsens non-EXACT coords + drops the street address, keeps EXACT intact", async () => {
    const { client } = createPoolMock([
      {
        id: "exact",
        title: "Exact",
        addressText: "100 Real St, NY",
        locationMode: "EXACT",
        locality: "Brooklyn",
        region: "NY",
        distance: 10,
      },
      {
        id: "obscured",
        title: "Obscured",
        addressText: "200 Secret Ave, NY",
        locationMode: "OBSCURED",
        locationRadiusMeters: 500,
        locality: "Brooklyn",
        region: "NY",
        distance: 10,
      },
      {
        id: "fully-hidden",
        title: "Fully Hidden",
        addressText: "300 Private Rd, NY",
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
        locality: "Brooklyn",
        region: "NY",
        distance: 10,
      },
    ]);

    const adapter = new PostGISGeoAdapter(client);
    const result = await adapter.nearbyEvents({
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      radiusM: 5_000,
    });

    const byId = new Map(result.items.map((e) => [e.id, e]));

    const exact = byId.get("exact");
    expect(exact?.lat).toBe(TRUE_LAT);
    expect(exact?.lng).toBe(TRUE_LNG);
    expect(exact?.addressText).toBe("100 Real St, NY");
    // EXACT keeps the SQL-computed true distance.
    expect(exact?.distanceMeters).toBe(10);

    const obscured = byId.get("obscured");
    expect(obscured).toBeDefined();
    expect(obscured?.lat).not.toBe(TRUE_LAT);
    expect(obscured?.lng).not.toBe(TRUE_LNG);
    // The emitted point is the deterministic public coordinate.
    expect(obscured?.lat).toBe(EMITTED.lat);
    expect(obscured?.lng).toBe(EMITTED.lng);
    expect(obscured?.addressText).toBe("Brooklyn, NY");
    // Map-UI discriminant is present.
    expect(obscured?.obscured).toBe(true);
    expect(obscured?.radiusMeters).toBe(500);
    // Distance was re-measured from the obscured point (no longer the
    // SQL true-distance of 10), so it reflects the offset.
    expect(obscured?.distanceMeters).toBeGreaterThan(0);
    expect(obscured?.distanceMeters).not.toBe(10);
    expect(obscured?.distanceMeters).toBeCloseTo(
      haversineDistance(TRUE_LAT, TRUE_LNG, EMITTED.lat, EMITTED.lng),
      0,
    );

    // FULLY HIDDEN (null radius): no marker at all — the row is dropped.
    expect(byId.has("fully-hidden")).toBe(false);
    // EXACT rows never carry the obscured discriminant.
    expect(exact?.obscured).toBeUndefined();
  });

  it("fails closed on unknown location modes (treated as obscured)", async () => {
    const { client } = createPoolMock([
      {
        id: "weird",
        title: "Weird Mode",
        addressText: "700 Mystery Ln, NY",
        locationMode: "SOMETHING_NEW",
        locationRadiusMeters: 500,
        locality: "Brooklyn",
        region: "NY",
        distance: 10,
      },
    ]);

    const adapter = new PostGISGeoAdapter(client);
    const result = await adapter.nearbyEvents({
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      radiusM: 5_000,
    });

    const row = result.items.find((e) => e.id === "weird");
    expect(row).toBeDefined();
    expect(row?.lat).not.toBe(TRUE_LAT);
    expect(row?.lng).not.toBe(TRUE_LNG);
    expect(row?.addressText).toBe("Brooklyn, NY");
    expect(row?.obscured).toBe(true);
  });

  it("boxSearch coarsens non-EXACT event coords + address, drops fully-hidden rows", async () => {
    const { client } = createPoolMock([
      {
        id: "obscured",
        title: "Obscured",
        addressText: "400 Hidden Blvd, NY",
        locationMode: "OBSCURED",
        locationRadiusMeters: 500,
        locality: "Brooklyn",
        region: "NY",
      },
      {
        id: "fully-hidden",
        title: "Fully Hidden",
        addressText: "500 Invisible Ct, NY",
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
        locality: "Brooklyn",
        region: "NY",
      },
    ]);

    const adapter = new PostGISGeoAdapter(client);
    const rows = await adapter.boxSearch({
      entity: "event",
      sw: { lat: 39.0, lng: -75.0 },
      ne: { lat: 41.0, lng: -73.0 },
    });

    const row = rows.find((r) => r.id === "obscured");
    expect(row).toBeDefined();
    expect(row?.lat).not.toBe(TRUE_LAT);
    expect(row?.lng).not.toBe(TRUE_LNG);
    expect((row as { addressText?: string | null }).addressText).toBe(
      "Brooklyn, NY",
    );

    // FULLY HIDDEN (null radius): dropped from box results entirely.
    expect(rows.find((r) => r.id === "fully-hidden")).toBeUndefined();
  });

  // Fully-hidden events must be excluded IN SQL, not post-filtered, so the
  // candidate set (and everything derived from it) never reflects them —
  // counting hidden rows would open a count side-channel that could
  // triangulate a hidden event.
  const HIDDEN_EXCLUSION_SQL = `AND NOT (e."locationMode" = 'OBSCURED' AND e."locationRadiusMeters" IS NULL)`;

  it("excludes fully-hidden events in the SQL itself for nearbyEvents and boxSearch", async () => {
    const { client, queries } = createPoolMock([]);
    const adapter = new PostGISGeoAdapter(client);

    await adapter.nearbyEvents({
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      radiusM: 5_000,
    });
    expect(queries[0]?.text).toContain(HIDDEN_EXCLUSION_SQL);

    await adapter.boxSearch({
      entity: "event",
      sw: { lat: 39.0, lng: -75.0 },
      ne: { lat: 41.0, lng: -73.0 },
    });
    expect(queries[1]?.text).toContain(HIDDEN_EXCLUSION_SQL);
  });

  it("widens the SQL candidate fetch by the per-row obfuscation radius", async () => {
    const { client, queries } = createPoolMock([]);
    const adapter = new PostGISGeoAdapter(client);

    // nearbyEvents: per-row widened ST_DWithin so every event whose EMITTED
    // point could be within radiusM is a candidate.
    await adapter.nearbyEvents({
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      radiusM: 5_000,
    });
    // …by the DRAWN radius: the stored one snapped UP to the ladder (a
    // legacy 120 m row is drawn at 150 m and can sit up to 148.5 m away).
    expect(queries[0]?.text).toMatch(
      /CASE WHEN e\."locationMode" = 'EXACT' THEN 0 ELSE COALESCE\(\(SELECT min\(rung\) FROM unnest\(\$\d+::int\[\]\) AS rung WHERE rung >= e\."locationRadiusMeters"\), 0\) END/,
    );

    // boxSearch: non-EXACT rows are matched against an expanded envelope.
    await adapter.boxSearch({
      entity: "event",
      sw: { lat: 39.0, lng: -75.0 },
      ne: { lat: 41.0, lng: -73.0 },
    });
    expect(queries[1]?.text).toContain("ST_Expand(");
    expect(queries[1]?.text).toContain(`e."locationMode" <> 'EXACT'`);
  });

  it("reports full-length pages and totals excluding hidden rows", async () => {
    const { client } = createPoolMock([
      { id: "e1", locationMode: "EXACT", distance: 5 },
      {
        id: "e2",
        locationMode: "OBSCURED",
        locationRadiusMeters: 500,
        distance: 6,
      },
    ]);
    const adapter = new PostGISGeoAdapter(client);

    const result = await adapter.nearbyEvents({
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      radiusM: 5_000,
      limit: 2,
    });

    expect(result.items).toHaveLength(2);
    expect(result.pageInfo.total).toBe(2);
    expect(result.pageInfo.count).toBe(2);
  });

  // ── Presence-oracle regression (FR-013/NFR-001) ────────────────────────────
  // Inclusion, totals, and page composition must be functions of the EMITTED
  // (obfuscated) coordinate only. If the true pin decided inclusion, a tiny
  // probe radius on a grid would recover an obscured event's address.

  it("nearbyEvents does NOT include an OBSCURED event when the probe hits the TRUE pin but misses the emitted point", async () => {
    // Sanity: the emitted point really is farther than the tiny probe radius.
    const offsetMeters = haversineDistance(
      TRUE_LAT,
      TRUE_LNG,
      EMITTED.lat,
      EMITTED.lng,
    );
    expect(offsetMeters).toBeGreaterThan(25);

    // Probe centred exactly on the TRUE pin — the SQL candidate fetch (mocked)
    // returns the row, so only the emitted-point post-filter protects it.
    const { client } = createPoolMock([
      { id: "obscured", locationMode: "OBSCURED", locationRadiusMeters: 500 },
    ]);
    const adapter = new PostGISGeoAdapter(client);
    const result = await adapter.nearbyEvents({
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      radiusM: 25,
    });

    expect(result.items).toHaveLength(0);
    // Totals are emitted-coordinate functions too — no count side-channel.
    expect(result.pageInfo.total).toBe(0);
  });

  it("nearbyEvents DOES include an OBSCURED event when the probe hits the emitted point even though the TRUE pin is outside", async () => {
    // The true pin is > 50 m from the probe (which sits on the emitted point).
    expect(
      haversineDistance(EMITTED.lat, EMITTED.lng, TRUE_LAT, TRUE_LNG),
    ).toBeGreaterThan(50);

    const { client } = createPoolMock([
      { id: "obscured", locationMode: "OBSCURED", locationRadiusMeters: 500 },
    ]);
    const adapter = new PostGISGeoAdapter(client);
    const result = await adapter.nearbyEvents({
      lat: EMITTED.lat,
      lng: EMITTED.lng,
      radiusM: 50,
    });

    expect(result.items.map((e) => e.id)).toEqual(["obscured"]);
    expect(result.pageInfo.total).toBe(1);
    expect(result.items[0]?.distanceMeters).toBeLessThanOrEqual(50);
  });

  it("computes totals and page slices AFTER the emitted-point filter", async () => {
    // Probe at the true pin, just short of the OBSCURED row's emitted point:
    // both EXACT rows (5 m, 6 m) are inside, the OBSCURED row's emitted
    // point is not — it must not occupy a page slot or count toward the
    // total. (A nested circle's centre can sit close to the pin, so the probe
    // is sized from the actual emitted distance rather than assumed.)
    const emittedDistance = haversineDistance(
      TRUE_LAT,
      TRUE_LNG,
      EMITTED.lat,
      EMITTED.lng,
    );
    expect(emittedDistance).toBeGreaterThan(10);
    const { client } = createPoolMock([
      { id: "exact-a", locationMode: "EXACT", distance: 5 },
      { id: "exact-b", locationMode: "EXACT", distance: 6 },
      { id: "obscured", locationMode: "OBSCURED", locationRadiusMeters: 500 },
    ]);
    const adapter = new PostGISGeoAdapter(client);

    const page = await adapter.nearbyEvents({
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      radiusM: Math.min(100, emittedDistance * 0.9),
      limit: 1,
      offset: 1,
    });

    expect(page.items.map((e) => e.id)).toEqual(["exact-b"]);
    expect(page.pageInfo.total).toBe(2);
  });

  it("boxSearch includes/excludes OBSCURED events by their EMITTED point, and orders by it", async () => {
    const { client } = createPoolMock([
      { id: "obscured", locationMode: "OBSCURED", locationRadiusMeters: 500 },
    ]);
    const adapter = new PostGISGeoAdapter(client);

    // Tiny box (~±30 m) around the TRUE pin: emitted point is outside → drop.
    const aroundTrue = await adapter.boxSearch({
      entity: "event",
      sw: { lat: TRUE_LAT - 0.0003, lng: TRUE_LNG - 0.0003 },
      ne: { lat: TRUE_LAT + 0.0003, lng: TRUE_LNG + 0.0003 },
    });
    expect(aroundTrue).toHaveLength(0);

    // Tiny box around the EMITTED point: included, at the emitted coordinate.
    const aroundEmitted = await adapter.boxSearch({
      entity: "event",
      sw: { lat: EMITTED.lat - 0.0003, lng: EMITTED.lng - 0.0003 },
      ne: { lat: EMITTED.lat + 0.0003, lng: EMITTED.lng + 0.0003 },
    });
    expect(aroundEmitted.map((e) => e.id)).toEqual(["obscured"]);
    expect(aroundEmitted[0]?.lat).toBe(EMITTED.lat);
    expect(aroundEmitted[0]?.lng).toBe(EMITTED.lng);
  });

  it("boxSearch does not order events by the true coordinate in SQL", async () => {
    // True-coordinate ORDER BY would bound an obscured row's true position
    // between its exact-mode neighbours; ordering happens in JS on the
    // emitted coordinate instead.
    const { client, queries } = createPoolMock([]);
    const adapter = new PostGISGeoAdapter(client);

    await adapter.boxSearch({
      entity: "event",
      sw: { lat: 39.0, lng: -75.0 },
      ne: { lat: 41.0, lng: -73.0 },
    });
    expect(queries[0]?.text).not.toContain("ORDER BY lat");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2 — the VENUE floor on the map. An event at a venue that withholds its
// address emits the VENUE's keyed circle centre, whatever the event row holds
// (a stale true copy included), and is a candidate by the venue's point.
// ─────────────────────────────────────────────────────────────────────────────

describe("PostGISGeoAdapter — events at a withheld venue", () => {
  const HOUSE_ID = "00000000-0000-4000-8000-0000000000a1";
  const venueRow = (overrides: Record<string, unknown> = {}) => ({
    id: "stale-at-house",
    title: "Basement Show",
    addressText: "1417 Shelby Ave, Nashville, TN 37206",
    slug: null,
    heroImageUrl: null,
    heroImageKey: null,
    // Selected with every row (N5: a missing gate projects as gated).
    gateType: "NONE",
    // Stored EXACT, true point — before the venue was withheld.
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locality: "Nashville",
    region: "TN",
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    distance: 10,
    placeId: HOUSE_ID,
    placeRowId: HOUSE_ID,
    placeLocationMode: "OBSCURED",
    placeLocationRadiusMeters: 800,
    placeLocationLabel: "East side",
    placeLat: TRUE_LAT,
    placeLng: TRUE_LNG,
    placeCity: "Nashville",
    placeRegion: "TN",
    placeCountry: "US",
    ...overrides,
  });
  const clientFor = (rows: unknown[]) => {
    const queries: Array<{ text: string }> = [];
    const client = {
      query: async (text: string) => {
        queries.push({ text });
        return { rows };
      },
    } as unknown as Pool;
    return { client, queries };
  };
  const VENUE_CIRCLE = redactPlaceLocation({
    id: HOUSE_ID,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    lat: TRUE_LAT,
    lng: TRUE_LNG,
  });

  it("emits the VENUE's circle centre + coarse label, never the stale row", async () => {
    const { client } = clientFor([venueRow()]);
    const result = await new PostGISGeoAdapter(client).nearbyEvents({
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

  it("drops an event whose venue is fully hidden", async () => {
    const { client } = clientFor([venueRow({ placeLocationRadiusMeters: null })]);
    const result = await new PostGISGeoAdapter(client).nearbyEvents({
      lat: TRUE_LAT,
      lng: TRUE_LNG,
      radiusM: 1_000,
    });
    expect(result.items).toHaveLength(0);
    expect(result.pageInfo.total).toBe(0);
  });

  it("joins the venue and makes withheld-venue events candidates by the VENUE's point", async () => {
    const { client, queries } = clientFor([]);
    const adapter = new PostGISGeoAdapter(client);
    await adapter.nearbyEvents({ lat: TRUE_LAT, lng: TRUE_LNG, radiusM: 1_000 });
    await adapter.boxSearch({
      entity: "event",
      sw: { lat: 36, lng: -87 },
      ne: { lat: 37, lng: -86 },
    });
    for (const { text } of queries) {
      expect(text).toContain(`LEFT JOIN "Place" AS pl ON pl.id = e."placeId"`);
      expect(text).toContain(`pl.location_mode <> 'EXACT'`);
      expect(text).toContain(`ST_MakePoint(pl.lng, pl.lat)`);
    }
    expect(queries[0]?.text).toMatch(
      /\+ \(SELECT min\(rung\) FROM unnest\(\$\d+::int\[\]\) AS rung WHERE rung >= pl\.location_radius_meters\)/,
    );
  });

  it("M5: event geo reads are PUBLISHED + PUBLIC + UNGATED only — no private or gated event on the public map", async () => {
    const { client, queries } = clientFor([]);
    const adapter = new PostGISGeoAdapter(client);
    await adapter.nearbyEvents({ lat: TRUE_LAT, lng: TRUE_LNG, radiusM: 1_000 });
    await adapter.boxSearch({
      entity: "event",
      sw: { lat: 36, lng: -87 },
      ne: { lat: 37, lng: -86 },
    });
    expect(queries).toHaveLength(2);
    for (const { text } of queries) {
      const flat = text.replace(/\s+/g, " ");
      expect(flat).toContain(
        `e.status = 'PUBLISHED' AND e.visibility = 'PUBLIC' AND e."gateType" = 'NONE'`,
      );
    }
  });

  it("place pin queries return EXACT venues only", async () => {
    const { client, queries } = clientFor([]);
    const adapter = new PostGISGeoAdapter(client);
    await adapter.nearbyPlaces({ lat: TRUE_LAT, lng: TRUE_LNG, radiusM: 1_000 });
    await adapter.boxSearch({
      entity: "place",
      sw: { lat: 36, lng: -87 },
      ne: { lat: 37, lng: -86 },
    });
    for (const { text } of queries) {
      expect(text).toContain(`p.location_mode = 'EXACT'`);
    }
  });
});
