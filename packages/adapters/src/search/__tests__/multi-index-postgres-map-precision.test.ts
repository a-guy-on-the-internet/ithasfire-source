import { describe, expect, it } from "vitest";

import { MultiIndexPostgresAdapter } from "../multi-index-postgres-adapter";

// Pure mapping (no database): what the Postgres adapter WRITES for a
// document's map precision, and what it READS back onto a suggestion. The
// real-SQL round trip is pinned in multi-index-postgres-adapter.test.ts.
describe("MultiIndexPostgresAdapter — map precision mapping", () => {
  const adapter = new MultiIndexPostgresAdapter({ prisma: {} as never });
  const toRecord = Reflect.get(adapter, "toRecord") as (
    doc: unknown,
  ) => Record<string, unknown>;
  const rowToSuggestion = Reflect.get(adapter, "rowToSuggestion") as (
    row: unknown,
    rows: unknown[],
  ) => Record<string, unknown>;

  const placeDoc = (overrides: Record<string, unknown>) => ({
    type: "place" as const,
    id: "place_plc-9",
    placeId: "plc-9",
    name: "Fishbowl House",
    pageSlug: null,
    formattedAddress: null,
    city: "Nashville",
    region: "TN",
    countryCode: "US",
    lat: null,
    lng: null,
    geohash6: null,
    locationIsExact: false,
    locationHidden: true,
    locationRadiusMeters: null,
    areaLabel: "East Nashville",
    capacity: null,
    eventCount: 0,
    bio: null,
    status: "ACTIVE" as const,
    verificationStatus: "VERIFIED" as const,
    listedInDirectory: true,
    ...overrides,
  });
  const readBack = (record: Record<string, unknown>) => {
    const row = { ...record, score: 1, totalCount: 1 };
    return rowToSuggestion.call(adapter, row, [row]);
  };

  it("writes the redacted document's precision verbatim", () => {
    const record = toRecord.call(
      adapter,
      placeDoc({ lat: 36.18, lng: -86.74, locationHidden: false, locationRadiusMeters: 1000 }),
    );
    expect(record).toMatchObject({
      lat: 36.18,
      lng: -86.74,
      locationIsExact: false,
      locationRadiusMeters: 1000,
    });
  });

  it("an OBSCURED venue reads back as its circle — the redacted centre, nothing more", () => {
    const suggestion = readBack(
      toRecord.call(
        adapter,
        placeDoc({ lat: 36.18, lng: -86.74, locationHidden: false, locationRadiusMeters: 1000 }),
      ),
    );
    expect(suggestion).toMatchObject({
      type: "place",
      lat: 36.18,
      lng: -86.74,
      locationIsExact: false,
      locationRadiusMeters: 1000,
    });
    expect(JSON.stringify(suggestion)).not.toMatch(/formattedAddress|geohash/);
  });

  it("a HIDDEN venue reads back with no coordinates, flagged hidden", () => {
    expect(readBack(toRecord.call(adapter, placeDoc({})))).toMatchObject({
      lat: null,
      lng: null,
      locationIsExact: false,
      locationRadiusMeters: null,
      locationHidden: true,
    });
  });

  it("an un-geocoded EXACT venue is off the map but NOT hidden", () => {
    expect(
      readBack(toRecord.call(adapter, placeDoc({ locationIsExact: true, locationHidden: false }))),
    ).toMatchObject({ lat: null, lng: null, locationHidden: false });
  });

  it("a row written before the columns existed (defaults false / null) is not plotted", () => {
    const stale = toRecord.call(adapter, placeDoc({ lat: 36.1, lng: -86.7, locationHidden: false }));
    stale.locationIsExact = false; // the migration's column default
    stale.locationRadiusMeters = null;
    // Off the map, and — since it still had a point — NOT claimed private.
    expect(readBack(stale)).toMatchObject({ lat: null, lng: null, locationHidden: false });
  });

  it("an EXACT venue reads back as a pin", () => {
    expect(
      readBack(
        toRecord.call(
          adapter,
          placeDoc({ lat: 36.16, lng: -86.78, locationIsExact: true, locationHidden: false }),
        ),
      ),
    ).toMatchObject({ lat: 36.16, lng: -86.78, locationIsExact: true, locationRadiusMeters: null });
  });

  it("an event carries its precision onto the record and back", () => {
    const record = toRecord.call(adapter, {
      type: "event",
      id: "event_e1",
      eventId: "e1",
      slug: "show",
      orgId: null,
      ownerType: "HUMAN",
      ownerHumanId: null,
      title: "Show",
      artists: [],
      tags: [],
      venueId: null,
      venueName: null,
      addressText: "Nashville, TN",
      city: "Nashville",
      regionCode: "TN",
      countryCode: "US",
      lat: 36.15,
      lng: -86.77,
      locationIsExact: false,
      locationRadiusMeters: 500,
      startsAt: null,
      endsAt: null,
      status: "PUBLISHED",
      isPublic: true,
      popularityScore: 0,
      recencyScore: 0,
      summary: null,
      imageUrl: null,
      lowestPriceCents: null,
      lowestBuyerTotalCents: null,
      currency: null,
      paidTierCount: 0,
      hasFreeTier: false,
    });
    expect(record).toMatchObject({ locationIsExact: false, locationRadiusMeters: 500 });
    expect(readBack(record)).toMatchObject({
      lat: 36.15,
      lng: -86.77,
      locationIsExact: false,
      locationRadiusMeters: 500,
    });
  });
});
