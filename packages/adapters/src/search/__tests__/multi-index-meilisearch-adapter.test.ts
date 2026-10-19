import { describe, expect, it, vi } from "vitest";

import {
  MultiIndexMeilisearchAdapter,
  buildMeiliSort,
  meiliQuote,
} from "../multi-index-meilisearch-adapter";

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_HUMAN_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Injects a fake Meilisearch index so `autocomplete()` runs without a live
 * server. Captures the `searchParams` passed to `index.search` (so we can
 * assert the `attributesToRetrieve` allowlist) and returns `hits` verbatim.
 */
function withFakeIndex(
  adapter: MultiIndexMeilisearchAdapter,
  hits: Array<Record<string, unknown>>,
) {
  const search = vi.fn(async (_query: string, _params: unknown) => ({
    hits,
    estimatedTotalHits: hits.length,
  }));
  // `getIndex()` returns the cached private `index` field when set.
  (adapter as unknown as { index: unknown }).index = { search };
  return { search };
}

describe("MultiIndexMeilisearchAdapter", () => {
  it("scopes org and owner filters to events so non-event docs stay eligible", () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    const buildSearchParams = Reflect.get(adapter, "buildSearchParams") as (
      filters: {
        orgId?: string;
        ownerHumanId?: string;
      },
      base: { limit: number },
    ) => { filter?: string };

    const params = buildSearchParams.call(
      adapter,
      {
        orgId: ORG_ID,
        ownerHumanId: OWNER_HUMAN_ID,
      },
      { limit: 10 },
    );

    expect(params.filter).toBe(
      [
        // Event visibility gate is applied because includeNonPublicEvents was
        // not set (fail-closed), even though an owner scope is present.
        '(type != "event" OR isPublic = true)',
        '(type != "human" OR isPublic = true)',
        '(type != "place" OR placeStatus = "ACTIVE")',
        `(type != "event" OR orgId = "${ORG_ID}")`,
        `(type != "event" OR ownerHumanId = "${OWNER_HUMAN_ID}")`,
      ].join(" AND "),
    );
  });

  it("applies the event visibility gate by default (public path, no bypass)", () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    const buildSearchParams = Reflect.get(adapter, "buildSearchParams") as (
      filters: Record<string, unknown>,
      base: { limit: number },
    ) => { filter?: string };

    const params = buildSearchParams.call(
      adapter,
      { types: ["event"] },
      { limit: 10 },
    );

    expect(params.filter).toContain('(type != "event" OR isPublic = true)');
  });

  it("relaxes the event visibility gate ONLY with bypass + owner scope", () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    const buildSearchParams = Reflect.get(adapter, "buildSearchParams") as (
      filters: Record<string, unknown>,
      base: { limit: number },
    ) => { filter?: string };

    // Bypass + org scope → gate is dropped; owner-scope clause constrains rows.
    const scoped = buildSearchParams.call(
      adapter,
      { types: ["event"], includeNonPublicEvents: true, orgId: ORG_ID },
      { limit: 10 },
    );
    expect(scoped.filter).not.toContain('(type != "event" OR isPublic = true)');
    expect(scoped.filter).toContain(`(type != "event" OR orgId = "${ORG_ID}")`);
  });

  it("IGNORES the bypass flag when no owner scope is present (fail-closed)", () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    const buildSearchParams = Reflect.get(adapter, "buildSearchParams") as (
      filters: Record<string, unknown>,
      base: { limit: number },
    ) => { filter?: string };

    // Bypass flag but NO orgId/ownerHumanId — defense in depth: the adapter
    // itself keeps the visibility gate applied, so a direct adapter call can't
    // leak PRIVATE events by flipping the flag alone.
    const params = buildSearchParams.call(
      adapter,
      { types: ["event"], includeNonPublicEvents: true },
      { limit: 10 },
    );

    expect(params.filter).toContain('(type != "event" OR isPublic = true)');
  });

  it("scopes the placeIds filter to event documents", () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    const buildSearchParams = Reflect.get(adapter, "buildSearchParams") as (
      filters: Record<string, unknown>,
      base: { limit: number },
    ) => { filter?: string };

    const params = buildSearchParams.call(
      adapter,
      { placeIds: ["plc-1", "plc-2"] },
      { limit: 10 },
    );

    expect(params.filter).toContain(
      '(type != "event" OR (placeId = "plc-1" OR placeId = "plc-2"))',
    );
  });

  it("applies listedInDirectory filter only to place documents", () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    const buildSearchParams = Reflect.get(adapter, "buildSearchParams") as (
      filters: { listedInDirectoryOnly?: boolean },
      base: { limit: number },
    ) => { filter?: string };

    const params = buildSearchParams.call(
      adapter,
      { listedInDirectoryOnly: true },
      { limit: 20 },
    );

    expect(params.filter).toContain(
      '(type != "place" OR listedInDirectory = true)',
    );
    // Ensure the directory filter doesn't suppress non-place results
    expect(params.filter).not.toContain("listedInDirectory = false");
  });

  it("does not apply listedInDirectory filter when listedInDirectoryOnly is false/absent", () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    const buildSearchParams = Reflect.get(adapter, "buildSearchParams") as (
      filters: { listedInDirectoryOnly?: boolean },
      base: { limit: number },
    ) => { filter?: string };

    const params = buildSearchParams.call(adapter, {}, { limit: 20 });

    expect(params.filter).not.toContain("listedInDirectory");
  });

  it("requests _geo in attributesToRetrieve and round-trips coords for a geocoded event", async () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    const { search } = withFakeIndex(adapter, [
      {
        id: "evt-doc-1",
        type: "event",
        eventId: "evt-1",
        title: "Show at the Basement",
        subtitle: "The Basement",
        helper: "Jul 18",
        slug: "show-at-the-basement",
        startsAtIso: "2026-07-18T00:00:00.000Z",
        // Meilisearch stores the geo point under the reserved `_geo` key
        // (matches the indexing path in the adapter).
        _geo: { lat: 36.1447, lng: -86.7681 },
        imageUrl: null,
        lowestPriceCents: 1500,
        lowestBuyerTotalCents: 1800,
        currency: "usd",
        paidTierCount: 1,
        hasFreeTier: false,
      },
    ]);

    const result = await adapter.autocomplete({ query: "basement", limit: 10 });

    expect(result.ok).toBe(true);
    // Guards the actual bug: `_geo` must be in the retrieval allowlist, or
    // Meilisearch omits it from hits and every event returns null coords.
    const firstCall = search.mock.calls[0];
    expect(firstCall).toBeDefined();
    const params = firstCall![1] as { attributesToRetrieve: string[] };
    expect(params.attributesToRetrieve).toContain("_geo");

    if (!result.ok) throw new Error("expected ok result");
    expect(result.value.suggestions[0]).toMatchObject({
      type: "event",
      eventId: "evt-1",
      lat: 36.1447,
      lng: -86.7681,
    });
  });

  it("maps a hit without _geo to null lat/lng", async () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    withFakeIndex(adapter, [
      {
        id: "evt-doc-2",
        type: "event",
        eventId: "evt-2",
        title: "TBA venue show",
        subtitle: null,
        helper: null,
        slug: null,
        startsAtIso: null,
        _geo: null,
        imageUrl: null,
        lowestPriceCents: null,
        lowestBuyerTotalCents: null,
        currency: null,
        paidTierCount: 0,
        hasFreeTier: false,
      },
    ]);

    const result = await adapter.autocomplete({ query: "tba", limit: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.value.suggestions[0]).toMatchObject({
      type: "event",
      eventId: "evt-2",
      lat: null,
      lng: null,
    });
  });

  it("maps hasPayWhatYouWantTier from the hit, defaulting a pre-reindex hit to false", async () => {
    const hitBase = {
      type: "event",
      subtitle: null,
      helper: null,
      slug: null,
      startsAtIso: null,
      _geo: null,
      imageUrl: null,
      lowestPriceCents: 0,
      lowestBuyerTotalCents: null,
      currency: "usd",
      paidTierCount: 0,
      hasFreeTier: false,
    };
    const run = async (extra: Record<string, unknown>) => {
      const adapter = new MultiIndexMeilisearchAdapter({
        host: "http://localhost:7700",
        apiKey: "test-key",
      });
      withFakeIndex(adapter, [
        { ...hitBase, id: "d", eventId: "evt-pw", title: "PWYW show", ...extra },
      ]);
      const result = await adapter.autocomplete({ query: "pwyw", limit: 10 });
      if (!result.ok) throw new Error("expected ok result");
      return result.value.suggestions[0];
    };

    expect(await run({ hasPayWhatYouWantTier: true })).toMatchObject({
      hasPayWhatYouWantTier: true,
    });
    // A document indexed before the field existed has no such key.
    expect(await run({})).toMatchObject({ hasPayWhatYouWantTier: false });
  });

  it("carries endsAt, addressText, and isPublic onto the Meili event document", () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    const toMeiliDocument = Reflect.get(adapter, "toMeiliDocument") as (
      doc: unknown,
    ) => Record<string, unknown>;

    const startsAt = new Date("2026-06-12T03:00:00.000Z");
    const endsAt = new Date("2026-06-12T05:30:00.000Z");
    const doc = {
      type: "event",
      id: "event-carry-fields",
      eventId: "evt-carry-fields",
      slug: "carry-fields",
      orgId: null,
      ownerType: "HUMAN",
      ownerHumanId: null,
      title: "Carry Fields",
      artists: [],
      tags: ["music"],
      venueId: null,
      venueName: "River Hall",
      addressText: "123 Main St, Brooklyn, NY",
      city: "Brooklyn",
      regionCode: "NY",
      countryCode: "US",
      lat: 40.6,
      lng: -73.9,
      startsAt,
      endsAt,
      status: "PUBLISHED",
      isPublic: false,
      popularityScore: 10,
      recencyScore: 0,
      summary: null,
      imageUrl: null,
      lowestPriceCents: 1000,
      lowestBuyerTotalCents: 1200,
      currency: "usd",
      paidTierCount: 1,
      hasFreeTier: false,
    };

    const meili = toMeiliDocument.call(adapter, doc);

    expect(meili.addressText).toBe("123 Main St, Brooklyn, NY");
    expect(meili.endsAtIso).toBe(endsAt.toISOString());
    expect(meili.endsAt).toBe(Math.floor(endsAt.getTime() / 1000));
    // A PRIVATE event is still mapped (present in the index) but flagged.
    expect(meili.isPublic).toBe(false);
  });

  it("carries the event's venueId into placeId so events are place-filterable", () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    const toMeiliDocument = Reflect.get(adapter, "toMeiliDocument") as (
      doc: unknown,
    ) => Record<string, unknown>;

    const doc = {
      type: "event",
      id: "event-with-venue",
      eventId: "evt-with-venue",
      slug: "with-venue",
      orgId: null,
      ownerType: "HUMAN",
      ownerHumanId: null,
      title: "Show With Venue",
      artists: [],
      tags: [],
      venueId: "plc-venue-42",
      venueName: "The Venue",
      addressText: null,
      city: null,
      regionCode: null,
      countryCode: "US",
      lat: null,
      lng: null,
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
    };

    const meili = toMeiliDocument.call(adapter, doc);
    expect(meili.placeId).toBe("plc-venue-42");
  });

  it("retrieves and maps endsAt, city, region, location, imageUrl onto the event suggestion", async () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    const { search } = withFakeIndex(adapter, [
      {
        id: "evt-doc-payload",
        type: "event",
        eventId: "evt-payload",
        title: "Payload Show",
        subtitle: "The Basement",
        helper: "Jul 18",
        slug: "payload-show",
        startsAtIso: "2026-07-18T00:00:00.000Z",
        endsAtIso: "2026-07-18T03:00:00.000Z",
        timezone: "America/Chicago",
        city: "Nashville",
        regionCode: "TN",
        addressText: "123 Main St, Nashville, TN",
        imageUrl: "https://cdn.example.com/hero.jpg",
        _geo: null,
        lowestPriceCents: 1500,
        lowestBuyerTotalCents: 1800,
        currency: "usd",
        paidTierCount: 1,
        hasFreeTier: false,
      },
    ]);

    const result = await adapter.autocomplete({ query: "payload", limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    // The render payload fields must be in the retrieval allowlist, or Meili
    // omits them from hits and the embed renders nulls.
    const params = search.mock.calls[0]![1] as {
      attributesToRetrieve: string[];
    };
    expect(params.attributesToRetrieve).toEqual(
      expect.arrayContaining([
        "endsAtIso",
        "addressText",
        "regionCode",
        "city",
        // Without it every search-backed card stamps in the fallback zone.
        "timezone",
      ]),
    );

    const suggestion = result.value.suggestions[0];
    expect(suggestion).toMatchObject({
      type: "event",
      eventId: "evt-payload",
      endsAt: new Date("2026-07-18T03:00:00.000Z"),
      timezone: "America/Chicago",
      city: "Nashville",
      region: "TN",
      location: "123 Main St, Nashville, TN",
      imageUrl: "https://cdn.example.com/hero.jpg",
    });
  });

  it("routes interpolated filter literals through meiliQuote (injection-safe by construction)", () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

    const buildSearchParams = Reflect.get(adapter, "buildSearchParams") as (
      filters: Record<string, unknown>,
      base: { limit: number },
    ) => { filter?: string };

    // A placeId carrying a double-quote must be escaped so it can't break out
    // of the string literal and inject filter syntax.
    const params = buildSearchParams.call(
      adapter,
      { placeIds: ['plc" OR type = "event'] },
      { limit: 10 },
    );

    expect(params.filter).toContain(
      '(type != "event" OR (placeId = "plc\\" OR type = \\"event"))',
    );
  });
});

describe("buildMeiliSort (event ordering)", () => {
  const geo = { lat: 36.1447, lng: -86.7681, radiusKm: 50 };
  const geoAsc = "_geoPoint(36.1447, -86.7681):asc";

  it("relevance WITHOUT geo → no sort spec (pure ranking rules — today's behavior)", () => {
    expect(buildMeiliSort("relevance", undefined)).toBeUndefined();
  });

  it("relevance WITH geo → distance sort only (byte-identical to today)", () => {
    expect(buildMeiliSort("relevance", geo)).toEqual([geoAsc]);
  });

  it("date WITHOUT geo → soonest-first only", () => {
    expect(buildMeiliSort("date", undefined)).toEqual(["startsAt:asc"]);
  });

  it("date WITH geo → soonest-first, distance breaks ties", () => {
    expect(buildMeiliSort("date", geo)).toEqual(["startsAt:asc", geoAsc]);
  });

  it("distance WITH geo → nearest-first, soonest breaks ties", () => {
    expect(buildMeiliSort("distance", geo)).toEqual([geoAsc, "startsAt:asc"]);
  });

  it("distance WITHOUT geo → gracefully falls back to date order", () => {
    expect(buildMeiliSort("distance", undefined)).toEqual(["startsAt:asc"]);
  });

  it("date_desc → latest-first", () => {
    expect(buildMeiliSort("date_desc", undefined)).toEqual(["startsAt:desc"]);
  });

  it("price_asc / price_desc order on the BUYER TOTAL, not face price", () => {
    expect(buildMeiliSort("price_asc", undefined)).toEqual([
      "lowestBuyerTotalCents:asc",
    ]);
    expect(buildMeiliSort("price_desc", undefined)).toEqual([
      "lowestBuyerTotalCents:desc",
    ]);
  });

  it("popularity → popularityScore descending", () => {
    expect(buildMeiliSort("popularity", undefined)).toEqual([
      "popularityScore:desc",
    ]);
  });

  // Geo is a TIEBREAK for date, but price/popularity/date_desc are absolute
  // orderings — appending a distance key would silently reorder equal-priced
  // events by proximity, which is not what "cheapest first" means.
  it.each(["date_desc", "price_asc", "price_desc", "popularity"] as const)(
    "%s ignores geo (it is not a distance tiebreak)",
    (sort) => {
      expect(buildMeiliSort(sort, geo)).toEqual(
        buildMeiliSort(sort, undefined),
      );
    },
  );

  // Meili REJECTS a search whose sort names an attribute missing from
  // `updateSortableAttributes`, so a new mode must never reference one that is
  // not declared in `ensureIndexes`.
  it("every mode sorts only on declared sortable attributes", () => {
    const SORTABLE = [
      "startsAt",
      "popularityScore",
      "eventsHostedCount",
      "eventCount",
      "lowestBuyerTotalCents",
      "_geo",
    ];
    const modes = [
      "relevance",
      "date",
      "date_desc",
      "distance",
      "price_asc",
      "price_desc",
      "popularity",
    ] as const;

    for (const mode of modes) {
      for (const key of buildMeiliSort(mode, geo) ?? []) {
        const attr = key.startsWith("_geoPoint(")
          ? "_geo"
          : key.split(":")[0];
        expect(SORTABLE).toContain(attr);
      }
    }
  });
});

describe("buildSearchParams — sort threading", () => {
  const geo = { lat: 36.1447, lng: -86.7681, radiusKm: 50 };
  const geoAsc = "_geoPoint(36.1447, -86.7681):asc";

  function build(
    filters: Record<string, unknown>,
    sort?: "relevance" | "date" | "distance",
  ): { sort?: string[] } {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });
    const buildSearchParams = Reflect.get(adapter, "buildSearchParams") as (
      f: Record<string, unknown>,
      base: { limit: number },
      s?: string,
    ) => { sort?: string[] };
    return buildSearchParams.call(adapter, filters, { limit: 10 }, sort);
  }

  it("relevance (default) + geo keeps today's distance sort (regression guard)", () => {
    // No explicit sort → relevance. With geo, base.sort must be distance-only,
    // exactly as before this change.
    expect(build({ types: ["event"], geo }).sort).toEqual([geoAsc]);
  });

  it("relevance (default) + no geo emits no sort", () => {
    expect(build({ types: ["event"] }).sort).toBeUndefined();
  });

  it("date + geo threads soonest-first then distance", () => {
    expect(build({ types: ["event"], geo }, "date").sort).toEqual([
      "startsAt:asc",
      geoAsc,
    ]);
  });

  it("distance + geo threads nearest-first then soonest", () => {
    expect(build({ types: ["event"], geo }, "distance").sort).toEqual([
      geoAsc,
      "startsAt:asc",
    ]);
  });

  it("distance + no geo falls back to date order", () => {
    expect(build({ types: ["event"] }, "distance").sort).toEqual([
      "startsAt:asc",
    ]);
  });
});

describe("meiliQuote", () => {
  it("wraps a plain value in double quotes", () => {
    expect(meiliQuote("nashville")).toBe('"nashville"');
  });

  it("escapes embedded double quotes", () => {
    expect(meiliQuote('a"b')).toBe('"a\\"b"');
  });

  it("escapes backslashes (before quotes, so escaping is unambiguous)", () => {
    expect(meiliQuote("a\\b")).toBe('"a\\\\b"');
    expect(meiliQuote('a\\"b')).toBe('"a\\\\\\"b"');
  });
});

// ── Place documents: the routable slug, and only that ──────────────────────
//
// A place used to have TWO slugs. `Place.slug` was a multi-segment DIRECTORY
// key (`us/tn/x--a1b2c3d4e5`) that no route resolves, and it rode the shared
// `slug` attribute — so anything that reached for the obvious field got a dead
// link. It is deprecated; a place's ONE slug is its `EntityPage.slug`, the flat
// value `/places/[slug]` resolves on, carried as `pageSlug`.
//
// `pageSlug` rides the SHARED entity-page-slug field `profileSlug` (a human's
// page slug lives there too) so it needs no new `attributesToRetrieve` entry.
// The shared `slug` attribute stays NULL for a place. These pin both
// directions.
describe("MultiIndexMeilisearchAdapter — place page slug", () => {
  const buildAdapter = () =>
    new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });

  const placeDoc = (pageSlug: string | null) => ({
    type: "place" as const,
    id: "place_plc-1",
    placeId: "plc-1",
    name: "The Basement East",
    pageSlug,
    formattedAddress: "917 Woodland St",
    city: "Nashville",
    region: "TN",
    countryCode: "US",
    lat: 36.176,
    lng: -86.751,
    capacity: 400,
    eventCount: 0,
    bio: null,
    status: "ACTIVE" as const,
    verificationStatus: "VERIFIED" as const,
    listedInDirectory: true,
  });

  it("indexes pageSlug onto the shared entity-page-slug field, leaving `slug` null", () => {
    const adapter = buildAdapter();
    const toMeiliDocument = Reflect.get(adapter, "toMeiliDocument") as (
      doc: unknown,
    ) => Record<string, unknown>;

    const meili = toMeiliDocument.call(
      adapter,
      placeDoc("the-basement-east-a1b2c3d4"),
    );

    expect(meili.profileSlug).toBe("the-basement-east-a1b2c3d4");
    // The old directory key lived here. A place writes nothing to it now.
    expect(meili.slug).toBeNull();
  });

  it("indexes a null pageSlug as null — never falling back to another field", () => {
    const adapter = buildAdapter();
    const toMeiliDocument = Reflect.get(adapter, "toMeiliDocument") as (
      doc: unknown,
    ) => Record<string, unknown>;

    const meili = toMeiliDocument.call(adapter, placeDoc(null));

    expect(meili.profileSlug).toBeNull();
    expect(meili.slug).toBeNull();
  });

  it("reads the page slug back onto the place suggestion as pageSlug", async () => {
    const adapter = buildAdapter();
    withFakeIndex(adapter, [
      {
        id: "place_plc-1",
        type: "place",
        placeId: "plc-1",
        title: "The Basement East",
        subtitle: "917 Woodland St",
        helper: null,
        // A STALE index row still carrying the old directory key.
        slug: "us/tn/the-basement-east--a1b2c3d4e5",
        profileSlug: "the-basement-east-a1b2c3d4",
        city: "Nashville",
        capacity: 400,
      },
    ]);

    const result = await adapter.autocomplete({ query: "basement", limit: 5 });
    expect(result.ok).toBe(true);
    const suggestion = (
      result as { value: { suggestions: Array<Record<string, unknown>> } }
    ).value.suggestions[0]!;
    expect(suggestion.type).toBe("place");
    expect(suggestion.pageSlug).toBe("the-basement-east-a1b2c3d4");
    // A stale row's directory key must not ride out to the client — that is
    // exactly how the dead venue link came back last time.
    expect(suggestion).not.toHaveProperty("slug");
  });

  it("surfaces a null pageSlug when the hit carries no entity-page slug", async () => {
    const adapter = buildAdapter();
    withFakeIndex(adapter, [
      {
        id: "place_plc-2",
        type: "place",
        placeId: "plc-2",
        title: "Imported Venue",
        subtitle: null,
        helper: null,
        slug: "us/tn/imported-venue--0f1e2d3c4b",
        profileSlug: null,
        city: "Nashville",
        capacity: null,
      },
    ]);

    const result = await adapter.autocomplete({ query: "imported", limit: 5 });
    const suggestion = (
      result as { value: { suggestions: Array<Record<string, unknown>> } }
    ).value.suggestions[0]!;
    expect(suggestion.pageSlug).toBeNull();
  });
});

// W5 — a withheld venue's street never becomes its search subtitle. The
// document is redacted at index time (`formattedAddress` null), but the
// fallback must not depend on that alone.
describe("MultiIndexMeilisearchAdapter — place subtitle never falls back to a withheld street", () => {
  const adapter = new MultiIndexMeilisearchAdapter({
    host: "http://localhost:7700",
    apiKey: "test-key",
  });
  const toMeiliDocument = Reflect.get(adapter, "toMeiliDocument") as (
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
    const meili = toMeiliDocument.call(adapter, doc({ locationIsExact: false }));
    expect(meili.subtitle).toBe("East Nashville");
  });

  it("an unknown exactness fails closed to the area label", () => {
    const meili = toMeiliDocument.call(adapter, doc({}));
    expect(meili.subtitle).toBe("East Nashville");
  });

  it("EXACT venue → falls back to its address, as before", () => {
    const meili = toMeiliDocument.call(adapter, doc({ locationIsExact: true }));
    expect(meili.subtitle).toBe("1417 Shelby Ave");
  });

  it("a bio still wins", () => {
    const meili = toMeiliDocument.call(
      adapter,
      doc({ locationIsExact: false, bio: "DIY space" }),
    );
    expect(meili.subtitle).toBe("DIY space");
  });
});

// ── Map precision: venues + events on the /search map ─────────────────────
// A venue suggestion now carries map coordinates. They come ONLY from the
// indexed (already redacted) document, and they fail closed: no radius and
// not exact ⇒ no coordinates.
describe("MultiIndexMeilisearchAdapter — map precision", () => {
  const buildAdapter = () =>
    new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "test-key",
    });
  // The shape `placeToDocument` emits AFTER `redactPlaceLocation`.
  const redactedPlaceDoc = (overrides: Record<string, unknown>) => ({
    type: "place" as const,
    id: "place_plc-m",
    placeId: "plc-m",
    name: "Fishbowl House",
    pageSlug: "fishbowl-house-plcm",
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

  /** Index a document, then read it back through autocomplete. */
  const roundTrip = async (doc: Record<string, unknown>) => {
    const adapter = buildAdapter();
    const toMeiliDocument = Reflect.get(adapter, "toMeiliDocument") as (
      d: unknown,
    ) => Record<string, unknown>;
    const stored = toMeiliDocument.call(adapter, doc);
    const { search } = withFakeIndex(adapter, [stored]);
    const result = await adapter.autocomplete({ query: "fishbowl", limit: 5 });
    if (!result.ok) throw new Error("expected ok");
    return {
      stored,
      search,
      suggestion: result.value.suggestions[0] as unknown as Record<string, unknown>,
    };
  };

  it("retrieves the precision attributes (Meili omits anything not listed — the `_geo` bug again)", async () => {
    const { search } = await roundTrip(redactedPlaceDoc({}));
    const params = search.mock.calls[0]![1] as { attributesToRetrieve: string[] };
    expect(params.attributesToRetrieve).toEqual(
      expect.arrayContaining(["_geo", "locationIsExact", "locationRadiusMeters"]),
    );
  });

  it("an EXACT venue round-trips as a pin", async () => {
    const { suggestion } = await roundTrip(
      redactedPlaceDoc({
        formattedAddress: "917 Woodland St",
        lat: 36.176,
        lng: -86.751,
        locationIsExact: true,
        locationHidden: false,
      }),
    );
    expect(suggestion).toMatchObject({
      lat: 36.176,
      lng: -86.751,
      locationIsExact: true,
      locationRadiusMeters: null,
    });
  });

  it("an OBSCURED venue round-trips as its circle, and carries nothing the redacted doc did not", async () => {
    const doc = redactedPlaceDoc({
      lat: 36.181,
      lng: -86.742,
      locationHidden: false,
      locationRadiusMeters: 1000,
    });
    const { suggestion } = await roundTrip(doc);
    expect(suggestion).toMatchObject({
      lat: 36.181,
      lng: -86.742,
      locationIsExact: false,
      locationRadiusMeters: 1000,
    });
    // Every coordinate on the suggestion is the redacted doc's own centre.
    const numbers = JSON.stringify(suggestion).match(/-?\d+\.\d+/g) ?? [];
    for (const n of numbers) {
      if (Number(n) === suggestion.confidence) continue;
      expect([doc.lat, doc.lng]).toContain(Number(n));
    }
    expect(JSON.stringify(suggestion)).not.toMatch(/Woodland|formattedAddress/);
  });

  it("a HIDDEN venue carries no coordinates and is flagged hidden", async () => {
    const { suggestion } = await roundTrip(redactedPlaceDoc({}));
    expect(suggestion).toMatchObject({
      lat: null,
      lng: null,
      locationIsExact: false,
      locationRadiusMeters: null,
      locationHidden: true,
    });
  });

  it("an un-geocoded EXACT venue is off the map but NOT hidden", async () => {
    const { suggestion } = await roundTrip(
      redactedPlaceDoc({ formattedAddress: "1 Somewhere St", locationIsExact: true, locationHidden: false }),
    );
    expect(suggestion).toMatchObject({ lat: null, lng: null, locationHidden: false });
  });

  it("a STALE hit (indexed before the precision attributes) is not plotted, even with a _geo", async () => {
    const adapter = buildAdapter();
    withFakeIndex(adapter, [
      {
        id: "place_plc-s",
        type: "place",
        placeId: "plc-s",
        title: "Old Row",
        subtitle: null,
        helper: null,
        profileSlug: null,
        city: "Nashville",
        capacity: null,
        _geo: { lat: 36.1, lng: -86.7 },
      },
    ]);
    const result = await adapter.autocomplete({ query: "old", limit: 5 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.suggestions[0]).toMatchObject({
      lat: null,
      lng: null,
      locationIsExact: false,
      locationRadiusMeters: null,
      // It had a point: not claimed private.
      locationHidden: false,
    });
  });

  it("an event carries its precision through index and back", async () => {
    const adapter = buildAdapter();
    const toMeiliDocument = Reflect.get(adapter, "toMeiliDocument") as (
      d: unknown,
    ) => Record<string, unknown>;
    const stored = toMeiliDocument.call(adapter, {
      type: "event",
      id: "event_evt-m",
      eventId: "evt-m",
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
    expect(stored).toMatchObject({ locationIsExact: false, locationRadiusMeters: 500 });
    withFakeIndex(adapter, [stored]);
    const result = await adapter.autocomplete({ query: "show", limit: 5 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.suggestions[0]).toMatchObject({
      lat: 36.15,
      lng: -86.77,
      locationIsExact: false,
      locationRadiusMeters: 500,
    });
  });
});

describe("MultiIndexMeilisearchAdapter — non-destructive rebuild sweep", () => {
  function withWritableIndex(adapter: MultiIndexMeilisearchAdapter) {
    const task = { waitTask: vi.fn(async () => ({})) };
    const addDocuments = vi.fn((_docs: unknown[], _opts: unknown) => task);
    const deleteDocuments = vi.fn((_input: unknown) => task);
    (adapter as unknown as { index: unknown }).index = {
      addDocuments,
      deleteDocuments,
    };
    return { addDocuments, deleteDocuments };
  }

  it("stamps every written document with a write marker", async () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "k",
    });
    const idx = withWritableIndex(adapter);
    const before = Date.now();
    await adapter.upsertDocuments({
      documents: [
        {
          type: "organization",
          id: `organization_${ORG_ID}`,
          orgId: ORG_ID,
          name: "Org",
          slug: "org",
          status: "ACTIVE",
          eventCount: 0,
          memberCount: 0,
          bio: null,
        },
      ],
    });
    const [docs] = idx.addDocuments.mock.calls[0]!;
    const marker = (docs as Array<{ indexedMarker: number }>)[0]!.indexedMarker;
    expect(marker).toBeGreaterThanOrEqual(before);
  });

  it("deletes only the type's documents written before the marker, except keepIds", async () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "k",
    });
    const idx = withWritableIndex(adapter);
    const token = await adapter.beginSweep();
    if (!token.ok) throw token.error;
    // The marker leans a minute early: skewed writers are kept, never swept.
    expect(Number(token.value.marker)).toBeLessThan(Date.now() - 50_000);

    await adapter.deleteUnswept({
      type: "place",
      token: token.value,
      keepIds: ["place_a"],
    });

    expect(idx.deleteDocuments).toHaveBeenCalledWith({
      filter:
        `type = "place" AND (indexedMarker < ${token.value.marker} OR indexedMarker NOT EXISTS)` +
        ` AND id NOT IN ["place_a"]`,
    });
  });
});

describe("MultiIndexMeilisearchAdapter — category names", () => {
  it("ensureIndexes makes categoryNames searchable at the LOWEST rank", async () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "k",
    });
    const noop = vi.fn(async () => ({}));
    const updateSearchableAttributes = vi.fn(async (_attrs: string[]) => ({}));
    (adapter as unknown as { client: unknown }).client = {
      createIndex: noop,
    };
    (adapter as unknown as { index: unknown }).index = {
      updateSearchableAttributes,
      updateFilterableAttributes: noop,
      updateSortableAttributes: noop,
      updateTypoTolerance: noop,
      updateRankingRules: noop,
    };

    const result = await adapter.ensureIndexes();
    expect(result.ok).toBe(true);
    const attrs = updateSearchableAttributes.mock.calls[0]![0];
    expect(attrs[attrs.length - 1]).toBe("categoryNames");
    expect(attrs.indexOf("categoryNames")).toBeGreaterThan(
      attrs.indexOf("summary"),
    );
  });

  it("writes an event's categoryNames and an empty list for other types", async () => {
    const adapter = new MultiIndexMeilisearchAdapter({
      host: "http://localhost:7700",
      apiKey: "k",
    });
    const task = { waitTask: vi.fn(async () => ({})) };
    const addDocuments = vi.fn((_docs: unknown[], _opts: unknown) => task);
    (adapter as unknown as { index: unknown }).index = { addDocuments };

    await adapter.upsertDocuments({
      documents: [
        {
          type: "event",
          id: "event_1",
          eventId: "1",
          slug: null,
          orgId: null,
          ownerType: "HUMAN",
          ownerHumanId: null,
          title: "Quiet Set",
          artists: [],
          tags: ["music"],
          categoryNames: ["Music", "Música"],
          venueId: null,
          venueName: null,
          addressText: null,
          city: null,
          regionCode: null,
          countryCode: null,
          lat: null,
          lng: null,
          locationIsExact: false,
          locationRadiusMeters: null,
          startsAt: null,
          endsAt: null,
          timezone: "America/Chicago",
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
        },
        {
          type: "organization",
          id: "organization_o",
          orgId: ORG_ID,
          name: "Org",
          slug: "org",
          status: "ACTIVE",
          eventCount: 0,
          memberCount: 0,
          bio: null,
        },
      ],
    });
    const docs = addDocuments.mock.calls[0]![0] as Array<{
      id: string;
      categoryNames: string[];
    }>;
    expect(docs.find((d) => d.id === "event_1")!.categoryNames).toEqual([
      "Music",
      "Música",
    ]);
    expect(docs.find((d) => d.id === "organization_o")!.categoryNames).toEqual(
      [],
    );
  });
});
