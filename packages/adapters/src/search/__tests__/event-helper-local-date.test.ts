import { describe, expect, it } from "vitest";

import type { EventSearchDocument } from "@th/ports/search/multi-index.types";

import { MultiIndexMeilisearchAdapter } from "../multi-index-meilisearch-adapter";
import { MultiIndexPostgresAdapter } from "../multi-index-postgres-adapter";

// Pure mapping (no database, no Meilisearch): the `helper` date both search
// adapters WRITE for an event document. Regression (prod, 2026-10-13): the
// formatter had no `timeZone`, so on a UTC server a 7pm Chicago show was
// indexed as the next day ("Oct 20" for a Mon 19 Oct show). Each case pins
// its zone, so the result is the same under TZ=UTC and TZ=America/Chicago.

const eventDoc = (
  startsAt: Date | null,
  timezone: string,
): EventSearchDocument => ({
  type: "event",
  id: "event_e1",
  eventId: "e1",
  slug: "show",
  orgId: null,
  ownerType: "HUMAN",
  ownerHumanId: null,
  title: "Open Mic",
  artists: [],
  tags: [],
  venueId: null,
  venueName: null,
  addressText: "Nashville, TN",
  city: "Nashville",
  regionCode: "TN",
  countryCode: "US",
  lat: null,
  lng: null,
  locationIsExact: false,
  locationRadiusMeters: null,
  startsAt,
  endsAt: null,
  timezone,
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
  hasPayWhatYouWantTier: false,
});

const CASES = [
  {
    name: "7pm CDT Monday, 00:00Z the next day",
    at: "2026-10-13T00:00:00.000Z",
    zone: "America/Chicago",
    helper: "Oct 12",
  },
  {
    name: "10pm CDT Tuesday",
    at: "2026-10-14T03:00:00.000Z",
    zone: "America/Chicago",
    helper: "Oct 13",
  },
  {
    name: "2pm CDT",
    at: "2026-10-13T19:00:00.000Z",
    zone: "America/Chicago",
    helper: "Oct 13",
  },
  {
    name: "7pm CST in winter",
    at: "2026-12-08T01:00:00.000Z",
    zone: "America/Chicago",
    helper: "Dec 7",
  },
  {
    name: "9pm PDT in Los Angeles",
    at: "2026-10-13T04:00:00.000Z",
    zone: "America/Los_Angeles",
    helper: "Oct 12",
  },
];

describe("MultiIndexPostgresAdapter: event helper date", () => {
  const adapter = new MultiIndexPostgresAdapter({ prisma: {} as never });
  const toRecord = Reflect.get(adapter, "toRecord") as (
    doc: unknown,
  ) => Record<string, unknown>;

  it.each(CASES)("writes the local date: $name", ({ at, zone, helper }) => {
    const record = toRecord.call(adapter, eventDoc(new Date(at), zone));
    expect(record.helper).toBe(helper);
  });

  it("writes no helper for an event with no start", () => {
    const record = toRecord.call(adapter, eventDoc(null, "America/Chicago"));
    expect(record.helper).toBeNull();
  });
});

describe("MultiIndexMeilisearchAdapter: event helper date", () => {
  const adapter = new MultiIndexMeilisearchAdapter({
    host: "http://localhost:7700",
    apiKey: "test-key",
  });
  const toMeiliDocument = Reflect.get(adapter, "toMeiliDocument") as (
    doc: unknown,
  ) => Record<string, unknown>;

  it.each(CASES)("stores the local date: $name", ({ at, zone, helper }) => {
    const stored = toMeiliDocument.call(adapter, eventDoc(new Date(at), zone));
    expect(stored.helper).toBe(helper);
  });

  it("stores no helper for an event with no start", () => {
    const stored = toMeiliDocument.call(
      adapter,
      eventDoc(null, "America/Chicago"),
    );
    expect(stored.helper).toBeNull();
  });
});

// The zone `helper` was formatted in is stored beside it and read back on the
// hit, so the card can stamp the time in the event's zone too. A document
// indexed before the field existed reads null (the mapper falls back).
describe("search adapters: event timezone is stored and read back", () => {
  const LA_SHOW = new Date("2026-10-16T05:30:00.000Z"); // Thu 10:30 PM PDT

  it("Postgres: the record carries the zone, the row reads it back", () => {
    const adapter = new MultiIndexPostgresAdapter({ prisma: {} as never });
    const toRecord = Reflect.get(adapter, "toRecord") as (
      doc: unknown,
    ) => Record<string, unknown>;
    const record = toRecord.call(
      adapter,
      eventDoc(LA_SHOW, "America/Los_Angeles"),
    );
    expect(record.timezone).toBe("America/Los_Angeles");
    expect(record.helper).toBe("Oct 15");

    const rowToSuggestion = Reflect.get(adapter, "rowToSuggestion") as (
      row: unknown,
      rows: unknown[],
    ) => Record<string, unknown>;
    const row = { ...record, score: 1, totalCount: 1 };
    expect(rowToSuggestion.call(adapter, row, [row]).timezone).toBe(
      "America/Los_Angeles",
    );
  });

  it("Postgres: a non-event record stores no zone", () => {
    const adapter = new MultiIndexPostgresAdapter({ prisma: {} as never });
    const toRecord = Reflect.get(adapter, "toRecord") as (
      doc: unknown,
    ) => Record<string, unknown>;
    const record = toRecord.call(adapter, {
      type: "organization",
      id: "org_o1",
      orgId: "o1",
      name: "Org",
      slug: "o1",
      status: "ACTIVE",
      eventCount: 0,
      memberCount: 0,
      bio: null,
    });
    expect(record.timezone).toBeNull();
  });

  describe("Meilisearch", () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });
    const toMeiliDocument = Reflect.get(adapter, "toMeiliDocument") as (
      doc: unknown,
    ) => Record<string, unknown>;
    const hitToSuggestion = Reflect.get(adapter, "hitToSuggestion") as (
      hit: unknown,
      response: unknown,
    ) => Record<string, unknown>;
    const response = { hits: [], estimatedTotalHits: 1 };

    it("the stored document carries the zone, the hit reads it back", () => {
      const stored = toMeiliDocument.call(
        adapter,
        eventDoc(LA_SHOW, "America/Los_Angeles"),
      );
      expect(stored.timezone).toBe("America/Los_Angeles");
      expect(stored.helper).toBe("Oct 15");
      expect(hitToSuggestion.call(adapter, stored, response).timezone).toBe(
        "America/Los_Angeles",
      );
    });

    it("a document indexed before the attribute existed reads null", () => {
      const stored = toMeiliDocument.call(
        adapter,
        eventDoc(LA_SHOW, "America/Los_Angeles"),
      );
      delete stored.timezone;
      expect(
        hitToSuggestion.call(adapter, stored, response).timezone,
      ).toBeNull();
    });
  });
});
