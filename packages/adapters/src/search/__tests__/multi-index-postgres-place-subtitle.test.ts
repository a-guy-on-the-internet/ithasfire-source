import { describe, expect, it } from "vitest";

import { MultiIndexPostgresAdapter } from "../multi-index-postgres-adapter";

// W5 — a withheld venue's street never becomes its search subtitle (Postgres
// backend; the Meilisearch twin is pinned in its own adapter test).
describe("MultiIndexPostgresAdapter — place subtitle never falls back to a withheld street", () => {
  const adapter = new MultiIndexPostgresAdapter({ prisma: {} as never });
  const toRecord = Reflect.get(adapter, "toRecord") as (
    doc: unknown,
  ) => Record<string, unknown>;
  const doc = (overrides: Record<string, unknown>) => ({
    type: "place" as const,
    id: "place_plc-9",
    placeId: "plc-9",
    name: "The Shelby House",
    pageSlug: null,
    formattedAddress: "1417 Shelby Ave",
    city: "Nashville",
    region: "TN",
    countryCode: "US",
    lat: null,
    lng: null,
    geohash6: null,
    locationHidden: true,
    locationRadiusMeters: null,
    capacity: null,
    eventCount: 0,
    bio: null,
    status: "ACTIVE" as const,
    verificationStatus: "VERIFIED" as const,
    listedInDirectory: true,
    areaLabel: "East Nashville",
    ...overrides,
  });

  it("withheld venue → the area label, never the street", () => {
    expect(toRecord.call(adapter, doc({ locationIsExact: false })).subtitle).toBe(
      "East Nashville",
    );
  });

  it("EXACT venue → falls back to its address, as before", () => {
    expect(toRecord.call(adapter, doc({ locationIsExact: true })).subtitle).toBe(
      "1417 Shelby Ave",
    );
  });
});
