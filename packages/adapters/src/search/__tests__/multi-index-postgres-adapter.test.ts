import { readFile } from "node:fs/promises";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import type {
  EventSearchDocument,
  MultiSearchAutocompleteInput,
  MultiSearchDocument,
  MultiSearchSuggestion,
} from "@th/ports/search/multi-index.types";

import { MultiIndexPostgresAdapter } from "../multi-index-postgres-adapter";

const ORG_A = "org-alpha-search";
const ORG_B = "org-beta-search";
const OWNER_HUMAN_ID = "human-owner-search";

describe("MultiIndexPostgresAdapter", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let adapter: MultiIndexPostgresAdapter | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(await readSearchMigrationSql());
    // The banned-owner filter reads "Human" and "OrgMember"; nobody is banned here.
    await pool.query(OWNER_STANDING_TABLES_SQL);
    process.env.DATABASE_URL = pgContainer.databaseUrl;
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    adapter = new MultiIndexPostgresAdapter({ prisma });
  }, 300_000);

  beforeEach(async () => {
    if (!prisma || !adapter) return;
    await prisma.$executeRawUnsafe(`TRUNCATE "SearchDocument"`);
    const result = await adapter.upsertDocuments({
      documents: makeSeedDocuments(),
    });
    if (!result.ok) throw result.error;
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pgContainer) await pgContainer.stop();
  });

  test("reports health, index readiness, and grouped stats", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    await expectOk(search.ensureIndexes());
    const health = await search.health();
    expect(health.ok).toBe(true);

    const stats = await expectOk(search.getStats());
    expect(stats.events.count).toBe(12);
    expect(stats.humans.count).toBe(5);
    expect(stats.places.count).toBe(4);
    expect(stats.organizations.count).toBe(3);
    expect(stats.events.lastIndexedAt).toBeInstanceOf(Date);
  });

  // Map precision survives the REAL SQL round trip (column names, the
  // ::integer cast, the ON CONFLICT update). Venues: pin / circle / nothing.
  test("round-trips map precision: exact pin, approximate circle, hidden → no coordinates", async () => {
    const search = adapter!;
    const redacted = (
      id: string,
      overrides: Record<string, unknown>,
    ): MultiSearchDocument =>
      ({
        type: "place",
        id,
        placeId: id.replace("place-", "plc-"),
        name: `Mapcheck ${id}`,
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
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
        listedInDirectory: true,
        ...overrides,
      }) as MultiSearchDocument;

    await expectOk(
      search.upsertDocuments({
        documents: [
          redacted("place-mapcheck-exact", {
            formattedAddress: "1 Exact St",
            lat: 36.16,
            lng: -86.78,
            locationIsExact: true,
            locationHidden: false,
          }),
          redacted("place-mapcheck-circle", {
            lat: 36.18,
            lng: -86.74,
            locationHidden: false,
            locationRadiusMeters: 1000,
          }),
          redacted("place-mapcheck-hidden", {}),
        ],
      }),
    );
    // Upsert again with a changed radius — the ON CONFLICT branch must carry it.
    await expectOk(
      search.upsertDocuments({
        documents: [
          redacted("place-mapcheck-circle", {
            lat: 36.18,
            lng: -86.74,
            locationHidden: false,
            locationRadiusMeters: 2000,
          }),
        ],
      }),
    );

    const rows = await suggestions(search, {
      query: "Mapcheck",
      filters: { types: ["place"] },
      limit: 10,
    });
    const byId = new Map(rows.map((row) => [row.id, row as unknown as Record<string, unknown>]));
    expect(byId.get("place-mapcheck-exact")).toMatchObject({
      lat: 36.16,
      lng: -86.78,
      locationIsExact: true,
      locationRadiusMeters: null,
    });
    expect(byId.get("place-mapcheck-circle")).toMatchObject({
      lat: 36.18,
      lng: -86.74,
      locationIsExact: false,
      locationRadiusMeters: 2000,
    });
    expect(byId.get("place-mapcheck-hidden")).toMatchObject({
      lat: null,
      lng: null,
      locationIsExact: false,
      locationRadiusMeters: null,
      locationHidden: true,
    });
    expect(byId.get("place-mapcheck-exact")).toMatchObject({ locationHidden: false });
    expect(byId.get("place-mapcheck-circle")).toMatchObject({ locationHidden: false });
  });

  test("matches title, subtitle, tags, fuzzy text, prefix text, and geo proximity", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    await expectIds(
      search,
      { query: "Neon Skyline", filters: { types: ["event"] } },
      ["event-neon-skyline"],
    );
    await expectIds(
      search,
      { query: "River Hall", filters: { types: ["event"] }, limit: 1 },
      ["event-neon-skyline"],
    );
    await expectIds(
      search,
      { query: "", filters: { types: ["event"], tags: ["wellness"] } },
      ["event-free-yoga"],
    );
    await expectIds(
      search,
      { query: "coachell", filters: { types: ["event"] } },
      ["event-coachella"],
    );
    await expectIds(
      search,
      { query: "coachela valey", filters: { types: ["event"] } },
      ["event-coachella"],
    );
    await expectIds(
      search,
      { query: "Electro", filters: { types: ["event"] }, limit: 1 },
      ["event-electronic-night"],
    );

    const geoMatches = await suggestions(search, {
      query: "",
      filters: {
        types: ["event"],
        geo: { lat: 37.775, lng: -122.419, radiusKm: 10 },
      },
      limit: 5,
    });
    expect(geoMatches.map((suggestion) => suggestion.id)).toEqual([
      "event-neon-skyline",
      "event-summer-jazz",
    ]);
  });

  describe("sort modes (event ordering)", () => {
    // Three events with DELIBERATELY divergent date vs. distance orders, so a
    // sort mode's ordering is unambiguous. Query point: (37.0, -122.0).
    // - A: soonest date, FARTHEST (~111 km)
    // - B: middle date,  NEAREST (~1 km)
    // - C: latest date,  MIDDLE  (~11 km)
    const SORT_TAG = "sorttest";
    const queryGeo = { lat: 37.0, lng: -122.0, radiusKm: 200 };

    function sortFixture() {
      return [
        eventDoc({
          id: "event-sort-a",
          title: "Sort A Far Soon",
          tags: [SORT_TAG],
          venueName: "Venue A",
          city: "Aville",
          regionCode: "CA",
          lat: 38.0,
          lng: -122.0,
          orgId: ORG_A,
          startsAt: new Date("2026-06-01T00:00:00.000Z"),
          popularityScore: 10,
          lowestBuyerTotalCents: 1_000,
        }),
        eventDoc({
          id: "event-sort-b",
          title: "Sort B Near Mid",
          tags: [SORT_TAG],
          venueName: "Venue B",
          city: "Bville",
          regionCode: "CA",
          lat: 37.01,
          lng: -122.0,
          orgId: ORG_A,
          startsAt: new Date("2026-06-15T00:00:00.000Z"),
          popularityScore: 10,
          lowestBuyerTotalCents: 1_000,
        }),
        eventDoc({
          id: "event-sort-c",
          title: "Sort C Middle Late",
          tags: [SORT_TAG],
          venueName: "Venue C",
          city: "Cville",
          regionCode: "CA",
          lat: 37.1,
          lng: -122.0,
          orgId: ORG_A,
          startsAt: new Date("2026-07-01T00:00:00.000Z"),
          popularityScore: 10,
          lowestBuyerTotalCents: 1_000,
        }),
      ];
    }

    beforeEach(async () => {
      if (!adapter) return;
      await expectOk(adapter.upsertDocuments({ documents: sortFixture() }));
    });

    test("sort:'date' orders soonest-first (nearer breaks same-time ties)", async () => {
      await expectIds(
        adapter!,
        {
          query: "",
          filters: { types: ["event"], tags: [SORT_TAG], geo: queryGeo },
          sort: "date",
        },
        ["event-sort-a", "event-sort-b", "event-sort-c"],
      );
    });

    test("sort:'date' with NO geo is pure soonest-first", async () => {
      await expectIds(
        adapter!,
        {
          query: "",
          filters: { types: ["event"], tags: [SORT_TAG] },
          sort: "date",
        },
        ["event-sort-a", "event-sort-b", "event-sort-c"],
      );
    });

    test("sort:'distance' (with geo) orders nearest-first, soonest tiebreak", async () => {
      await expectIds(
        adapter!,
        {
          query: "",
          filters: { types: ["event"], tags: [SORT_TAG], geo: queryGeo },
          sort: "distance",
        },
        ["event-sort-b", "event-sort-c", "event-sort-a"],
      );
    });

    test("sort:'distance' with NO geo gracefully falls back to date order", async () => {
      await expectIds(
        adapter!,
        {
          query: "",
          filters: { types: ["event"], tags: [SORT_TAG] },
          sort: "distance",
        },
        ["event-sort-a", "event-sort-b", "event-sort-c"],
      );
    });

    test("sort:'relevance' with geo is byte-identical to omitting sort (regression guard)", async () => {
      const withRelevance = await suggestions(adapter!, {
        query: "",
        filters: { types: ["event"], tags: [SORT_TAG], geo: queryGeo },
        sort: "relevance",
      });
      const omitted = await suggestions(adapter!, {
        query: "",
        filters: { types: ["event"], tags: [SORT_TAG], geo: queryGeo },
      });

      expect(withRelevance.map((s) => s.id)).toEqual(omitted.map((s) => s.id));
      // With geo present, relevance orders by distance first (today's behavior).
      expect(withRelevance.map((s) => s.id)).toEqual([
        "event-sort-b",
        "event-sort-c",
        "event-sort-a",
      ]);
    });
  });

  // Browse-all (empty query, no types) must interleave the types: popularity
  // sits on a different scale per type, so ranking them in one list let one
  // type fill the page and the /search All tab showed "No events yet".
  describe("browse-all interleaves types (empty query, relevance)", () => {
    const PLACE_IDS = [1, 2, 3, 4, 5, 6].map((n) => `place-interleave-${n}`);
    const EVENT_IDS = [1, 2, 3].map((n) => `event-interleave-${n}`);

    beforeEach(async () => {
      if (!prisma || !adapter) return;
      // Own the whole index: the outer seed would add rows of every type.
      await prisma.$executeRawUnsafe(`TRUNCATE "SearchDocument"`);
      const places = PLACE_IDS.map((id, i) =>
        placeDoc(
          id,
          `Interleave Hall ${i + 1}`,
          "interleave fixture",
          "Nashville",
          "TN",
          36.16,
          -86.78,
          true,
          "ACTIVE",
          200,
          1_000 + i,
        ),
      );
      const events = EVENT_IDS.map((id, i) =>
        eventDoc({
          id,
          title: `Interleave Show ${i + 1}`,
          tags: [],
          venueName: "Interleave Hall 1",
          city: "Nashville",
          regionCode: "TN",
          lat: 36.16,
          lng: -86.78,
          orgId: ORG_A,
          startsAt: new Date(`2030-06-0${i + 1}T00:00:00.000Z`),
          popularityScore: 1,
          lowestBuyerTotalCents: 1_000,
        }),
      );
      await expectOk(
        adapter.upsertDocuments({ documents: [...places, ...events] }),
      );
    });

    async function walk(input: MultiSearchAutocompleteInput) {
      const ids: string[] = [];
      const totals: number[] = [];
      for (const offset of [0, 4, 8]) {
        const result = await adapter!.autocomplete({
          ...input,
          limit: 4,
          offset,
        });
        if (!result.ok) throw result.error;
        ids.push(...result.value.suggestions.map((s) => s.id));
        totals.push(result.value.estimatedTotalHits);
      }
      return { ids, totals };
    }

    // Production's router turns absent/[] types into all three (length 3).
    test.each([
      ["types absent", undefined],
      ["types []", { types: [] }],
      [
        "all three types",
        { types: ["event", "place", "organization"] as const },
      ],
    ] as const)(
      "first page mixes types instead of filling with the popular one (%s)",
      async (_label, filters) => {
        const page = await suggestions(adapter!, {
          query: "",
          limit: 4,
          offset: 0,
          sort: "relevance",
          ...(filters ? { filters: { types: [...filters.types] } } : {}),
        });
        expect(page.filter((s) => s.type === "event")).toHaveLength(2);
        expect(page.filter((s) => s.type === "place")).toHaveLength(2);
      },
    );

    test("paging returns every doc exactly once with a stable total", async () => {
      const { ids, totals } = await walk({ query: "", sort: "relevance" });
      expect([...ids].sort()).toEqual([...PLACE_IDS, ...EVENT_IDS].sort());
      expect(new Set(totals)).toEqual(new Set([9]));
    });

    test("a text query keeps the old order (popular type first)", async () => {
      const page = await suggestions(adapter!, {
        query: "interleave",
        limit: 9,
        sort: "relevance",
      });
      expect(page).toHaveLength(9);
      expect(page.slice(0, 6).every((s) => s.type === "place")).toBe(true);
    });

    test("geo browse interleaves types and keeps nearest-first within each type", async () => {
      // Query point (36.0, -86.0). Places 1..6 sit 0.01..0.06 deg north; events
      // 1..3 sit 0.03..0.01 deg north, so event 3 is the nearest event and the
      // order is the REVERSE of the id order (proves distance, not title/id).
      const geoDocs = [
        ...PLACE_IDS.map((id, i) =>
          placeDoc(
            id,
            `Geo Hall ${i + 1}`,
            "geo",
            "Nashville",
            "TN",
            36.0 + 0.01 * (i + 1),
            -86.0,
            true,
            "ACTIVE",
            200,
            1_000 + i,
          ),
        ),
        ...EVENT_IDS.map((id, i) =>
          eventDoc({
            id,
            title: `Geo Show ${i + 1}`,
            tags: [],
            venueName: "Geo Hall",
            city: "Nashville",
            regionCode: "TN",
            lat: 36.0 + 0.01 * (3 - i),
            lng: -86.0,
            orgId: ORG_A,
            startsAt: new Date(`2030-06-0${i + 1}T00:00:00.000Z`),
            popularityScore: 1,
            lowestBuyerTotalCents: 1_000,
          }),
        ),
      ];
      await expectOk(adapter!.upsertDocuments({ documents: geoDocs }));
      const page = await suggestions(adapter!, {
        query: "",
        limit: 4,
        offset: 0,
        sort: "relevance",
        filters: { geo: { lat: 36.0, lng: -86.0, radiusKm: 50 } },
      });
      expect(page.filter((s) => s.type === "event")).toHaveLength(2);
      expect(page.filter((s) => s.type === "place")).toHaveLength(2);
      expect(page.filter((s) => s.type === "event").map((s) => s.id)).toEqual([
        "event-interleave-3",
        "event-interleave-2",
      ]);
      expect(page.filter((s) => s.type === "place").map((s) => s.id)).toEqual([
        "place-interleave-1",
        "place-interleave-2",
      ]);
    });

    test("single-type browse is unchanged", async () => {
      await expectIds(
        adapter!,
        { query: "", filters: { types: ["event"] }, sort: "relevance" },
        ["event-interleave-1", "event-interleave-2", "event-interleave-3"],
      );
    });
  });

  // A city word every place shares ("Nashville" sits in each trigram_corpus)
  // must not make a multi-word query match the whole directory: the typo
  // tolerance runs per token and keeps the rows matching the most tokens.
  describe("multi-word queries (trigram arms run per token)", () => {
    beforeEach(async () => {
      if (!prisma || !adapter) return;
      await prisma.$executeRawUnsafe(`TRUNCATE "SearchDocument"`);
      // Like the real indexer, an exact place with no bio carries its street
      // address (which names the city) as the subtitle, and so in trigram_corpus.
      const place = (
        id: string,
        name: string,
        city: string,
        region: string,
      ): MultiSearchDocument => ({
        ...placeDoc(
          id,
          name,
          "",
          city,
          region,
          36.16,
          -86.78,
          true,
          "ACTIVE",
          200,
          1,
        ),
        bio: null,
        locationIsExact: true,
        formattedAddress: `123 Broadway ${city} ${region}`,
      });
      await expectOk(
        adapter.upsertDocuments({
          documents: [
            place("place-mw-cobra", "The Cobra", "Nashville", "TN"),
            place("place-mw-1865", "1865 Club", "Nashville", "TN"),
            place("place-mw-bowery", "The Bowery Vault", "Nashville", "TN"),
            place(
              "place-mw-springwater",
              "Springwater Supper Club",
              "Nashville",
              "TN",
            ),
            place("place-mw-austin", "Austin Music Hall", "Austin", "TX"),
            place("place-mw-basement", "Basement", "Nashville", "TN"),
            place("place-mw-musica", "Musica Viva", "Nashville", "TN"),
          ],
        }),
      );
    });

    async function ids(query: string): Promise<string[]> {
      const result = await expectOk(
        adapter!.autocomplete({
          query,
          limit: 20,
          filters: { types: ["place"] },
          sort: "relevance",
        }),
      );
      return result.suggestions.map((s) => s.id);
    }

    test("'Cobra Nashville' returns only the Cobra, not every Nashville place", async () => {
      expect(await ids("Cobra Nashville")).toEqual(["place-mw-cobra"]);
    });

    test("single token 'Springwater' is unchanged", async () => {
      expect(await ids("Springwater")).toEqual(["place-mw-springwater"]);
    });

    test("single token 'Nashville' still returns every Nashville place", async () => {
      expect((await ids("Nashville")).sort()).toEqual([
        "place-mw-1865",
        "place-mw-basement",
        "place-mw-bowery",
        "place-mw-cobra",
        "place-mw-musica",
        "place-mw-springwater",
      ]);
    });

    test("a typo in one token still matches: 'Springwatr Nashville'", async () => {
      expect(await ids("Springwatr Nashville")).toEqual([
        "place-mw-springwater",
      ]);
    });

    test("a short token is skipped: 'Springwater in Nashville'", async () => {
      expect(await ids("Springwater in Nashville")).toEqual([
        "place-mw-springwater",
      ]);
    });

    test("a query of only short tokens does not return everything: 'DJ'", async () => {
      expect(await ids("DJ")).toEqual([]);
    });

    // No row has both words, so the best (1 of 2) wins: an extra word the
    // place lacks must not empty the page.
    test("an extra word the place lacks still matches: 'Cobra bar'", async () => {
      expect(await ids("Cobra bar")).toEqual(["place-mw-cobra"]);
    });

    test("a leading article the title lacks still matches: 'The Basement'", async () => {
      expect(await ids("The Basement")).toContain("place-mw-basement");
    });

    test("a numeric title ranks first: '1865 Club'", async () => {
      expect((await ids("1865 Club"))[0]).toBe("place-mw-1865");
    });

    test("an accented query matches an unaccented title: 'Música Viva'", async () => {
      expect(await ids("Música Viva")).toContain("place-mw-musica");
    });

    // Too short for the trigram arms: only the prefix arm can match, and it
    // split on the letter "s" until its '\s+' was escaped for Prisma.sql.
    test("partial words match by prefix: 'Spr Nas'", async () => {
      expect(await ids("Spr Nas")).toEqual(["place-mw-springwater"]);
    });

    test("in the All scope an event matching more words does not hide the place", async () => {
      await expectOk(
        adapter!.upsertDocuments({
          documents: [
            eventDoc({
              id: "event-mw-springwater-mic",
              title: "Springwater Open Mic",
              tags: [],
              venueName: "Springwater Supper Club",
              city: "Nashville",
              regionCode: "TN",
              lat: 36.16,
              lng: -86.78,
              orgId: ORG_A,
              startsAt: new Date("2026-11-01T01:00:00.000Z"),
              popularityScore: 1,
              lowestBuyerTotalCents: 0,
            }),
          ],
        }),
      );
      const result = await expectOk(
        adapter!.autocomplete({
          query: "Springwater open mic",
          limit: 20,
          sort: "relevance",
        }),
      );
      // The event matches 3 of 3 words, the place 1 of 3: each type keeps its
      // own best, so the place is still in its section.
      expect(result.suggestions.map((s) => s.id).sort()).toEqual([
        "event-mw-springwater-mic",
        "place-mw-springwater",
      ]);
    });

    test("the place matching more words wins: 'Cobra Nashville rooftop'", async () => {
      // Cobra matches 2 of 3 words; every other Nashville place only 1 of 3.
      expect(await ids("Cobra Nashville rooftop")).toEqual(["place-mw-cobra"]);
    });

    // Documented trade-off: no place has "karaoke", so the best available
    // match is 1 of 2 words, which every Nashville place reaches.
    test("a word nobody has falls back to the best partial: 'Nashville karaoke'", async () => {
      expect((await ids("Nashville karaoke")).sort()).toEqual([
        "place-mw-1865",
        "place-mw-basement",
        "place-mw-bowery",
        "place-mw-cobra",
        "place-mw-musica",
        "place-mw-springwater",
      ]);
    });

    // The match rule is computed over the whole filtered set, so every page
    // sees the same one: page 2 of a best-partial result is not empty.
    test("a best-partial result pages consistently: 'Nashville karaoke'", async () => {
      const page = (offset: number) =>
        expectOk(
          adapter!.autocomplete({
            query: "Nashville karaoke",
            limit: 3,
            offset,
            filters: { types: ["place"] },
            sort: "relevance",
          }),
        );
      const first = await page(0);
      const second = await page(3);
      const firstIds = first.suggestions.map((s) => s.id);
      const secondIds = second.suggestions.map((s) => s.id);

      expect(firstIds).toHaveLength(3);
      expect(secondIds).toHaveLength(3);
      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
      expect(first.estimatedTotalHits).toBe(6);
      expect(second.estimatedTotalHits).toBe(6);
    });
  });

  // Price / popularity / date_desc need values that DIFFER per row — the
  // date+distance fixture above deliberately holds price and popularity equal
  // so those sorts stay isolated, which makes it useless here.
  describe("price, popularity, and date_desc ordering", () => {
    const PRICE_TAG = "pricesorttest";

    // - CHEAP:   $5,  popularity 5,  soonest
    // - MID:     $25, popularity 50, middle
    // - DEAR:    $80, popularity 1,  latest
    // - UNKNOWN: no price on file,   middle date, popularity 99
    function priceFixture() {
      const base = {
        tags: [PRICE_TAG],
        city: "Priceville",
        regionCode: "CA",
        lat: 37.0,
        lng: -122.0,
        orgId: ORG_A,
      };
      return [
        eventDoc({
          ...base,
          id: "event-price-cheap",
          title: "Price Cheap",
          venueName: "Venue Cheap",
          startsAt: new Date("2026-06-01T00:00:00.000Z"),
          popularityScore: 5,
          lowestBuyerTotalCents: 500,
        }),
        eventDoc({
          ...base,
          id: "event-price-mid",
          title: "Price Mid",
          venueName: "Venue Mid",
          startsAt: new Date("2026-06-15T00:00:00.000Z"),
          popularityScore: 50,
          lowestBuyerTotalCents: 2_500,
        }),
        eventDoc({
          ...base,
          id: "event-price-dear",
          title: "Price Dear",
          venueName: "Venue Dear",
          startsAt: new Date("2026-07-01T00:00:00.000Z"),
          popularityScore: 1,
          lowestBuyerTotalCents: 8_000,
        }),
        eventDoc({
          ...base,
          id: "event-price-unknown",
          title: "Price Unknown",
          venueName: "Venue Unknown",
          startsAt: new Date("2026-06-20T00:00:00.000Z"),
          popularityScore: 99,
          lowestBuyerTotalCents: null,
        }),
      ];
    }

    const filters = { types: ["event"] as const, tags: [PRICE_TAG] };

    beforeEach(async () => {
      if (!adapter) return;
      await expectOk(adapter.upsertDocuments({ documents: priceFixture() }));
    });

    test("sort:'price_asc' orders cheapest-first, unpriced LAST", async () => {
      await expectIds(
        adapter!,
        { query: "", filters: { ...filters }, sort: "price_asc" },
        [
          "event-price-cheap",
          "event-price-mid",
          "event-price-dear",
          "event-price-unknown",
        ],
      );
    });

    // The load-bearing half of NULLS LAST: an event with no priced tier has an
    // UNKNOWN price, not a zero one. If it led price_asc it would outrank
    // genuinely free events and read as "$0".
    test("sort:'price_desc' orders dearest-first, unpriced STILL last", async () => {
      await expectIds(
        adapter!,
        { query: "", filters: { ...filters }, sort: "price_desc" },
        [
          "event-price-dear",
          "event-price-mid",
          "event-price-cheap",
          "event-price-unknown",
        ],
      );
    });

    test("sort:'popularity' orders by score descending", async () => {
      await expectIds(
        adapter!,
        { query: "", filters: { ...filters }, sort: "popularity" },
        [
          "event-price-unknown",
          "event-price-mid",
          "event-price-cheap",
          "event-price-dear",
        ],
      );
    });

    test("sort:'date_desc' orders latest-first (inverse of date)", async () => {
      await expectIds(
        adapter!,
        { query: "", filters: { ...filters }, sort: "date_desc" },
        [
          "event-price-dear",
          "event-price-unknown",
          "event-price-mid",
          "event-price-cheap",
        ],
      );

      await expectIds(
        adapter!,
        { query: "", filters: { ...filters }, sort: "date" },
        [
          "event-price-cheap",
          "event-price-mid",
          "event-price-unknown",
          "event-price-dear",
        ],
      );
    });
  });

  test("applies type, visibility, region, date, price, org, owner, and directory filters", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    await expectIds(search, { query: "Alex", filters: { types: ["human"] } }, [
      "human-alex",
    ]);
    await expectIds(
      search,
      { query: "Hidden", filters: { types: ["event", "human", "place"] } },
      [],
    );

    await expectIds(
      search,
      {
        query: "",
        filters: {
          types: ["event"],
          regionCodes: ["CA"],
          tags: ["electronic"],
          orgId: ORG_A,
          dateRange: {
            from: "2026-06-01T00:00:00.000Z",
            to: "2026-07-01T00:00:00.000Z",
          },
          priceRange: { minCents: 1_000, maxCents: 3_000 },
          publishedOnly: true,
        },
      },
      ["event-neon-skyline"],
    );

    await expectIds(
      search,
      { query: "", filters: { types: ["event"], freeOnly: true } },
      ["event-free-yoga"],
    );
    await expectIds(
      search,
      {
        query: "",
        filters: { types: ["event"], ownerHumanId: OWNER_HUMAN_ID },
      },
      ["event-bedroom-pop"],
    );
    await expectIds(
      search,
      { query: "", filters: { types: ["event"], orgId: ORG_B } },
      ["event-coachella", "event-electronic-night", "event-mountain-folk"],
    );
    await expectIds(
      search,
      { query: "", filters: { types: ["place"], listedInDirectoryOnly: true } },
      ["place-river-hall", "place-desert-stage"],
    );
  });

  test("public path excludes PRIVATE events but keeps PUBLIC ones", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    // No bypass flag → PRIVATE events are gated out entirely.
    await expectIds(
      search,
      { query: "Private Alpha", filters: { types: ["event"] } },
      [],
    );
    await expectIds(
      search,
      { query: "Private Beta", filters: { types: ["event"] } },
      [],
    );

    // A PUBLIC published event is unaffected by the new gate.
    await expectIds(
      search,
      { query: "Neon Skyline", filters: { types: ["event"] } },
      ["event-neon-skyline"],
    );
  });

  test("owner-scoped bypass reveals the owner's OWN private events", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    await expectIds(
      search,
      {
        query: "Private Alpha",
        filters: {
          types: ["event"],
          includeNonPublicEvents: true,
          orgId: ORG_A,
        },
      },
      ["event-private-alpha"],
    );
  });

  test("CROSS-TENANT: bypass + ORG_A scope never leaks ORG_B's private events", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    // "Private" matches BOTH galas by title, but the ORG_A owner scope must
    // constrain the surfaced private events to ORG_A only — ORG_B's private
    // gala is excluded.
    await expectIds(
      search,
      {
        query: "Private",
        filters: {
          types: ["event"],
          includeNonPublicEvents: true,
          orgId: ORG_A,
        },
      },
      ["event-private-alpha"],
    );
  });

  test("ADAPTER fail-closed: bypass flag with NO owner scope returns no private events", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    // Direct adapter call, flag set but NO orgId/ownerHumanId. Defense in
    // depth: the adapter itself keeps the gate applied, so neither private
    // gala leaks even though the bypass flag is present.
    await expectIds(
      search,
      {
        query: "Private",
        filters: { types: ["event"], includeNonPublicEvents: true },
      },
      [],
    );
  });

  test("placeIds filter scopes events to the given venue place ids", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    // Only the PUBLIC event at plc-venue-river surfaces on the public path;
    // the PRIVATE event sharing that venue is still gated out.
    await expectIds(
      search,
      {
        query: "",
        filters: { types: ["event"], placeIds: ["plc-venue-river"] },
      },
      ["event-neon-skyline"],
    );

    // A place with no indexed events yields nothing.
    await expectIds(
      search,
      {
        query: "",
        filters: { types: ["event"], placeIds: ["plc-does-not-exist"] },
      },
      [],
    );

    // Composed with the owner-scoped bypass, the shared-venue PRIVATE event is
    // revealed to its owner.
    await expectIds(
      search,
      {
        query: "",
        filters: {
          types: ["event"],
          placeIds: ["plc-venue-river"],
          includeNonPublicEvents: true,
          orgId: ORG_A,
        },
      },
      ["event-neon-skyline", "event-private-alpha"],
    );
  });

  test("tags filter scopes events to a category slug value", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    // The indexer appends the event's categorySlug into `tags`, so a category
    // value filters through the same array-overlap mechanism.
    await expectIds(
      search,
      { query: "", filters: { types: ["event"], tags: ["wellness"] } },
      ["event-free-yoga"],
    );
  });

  test("upserts idempotently and replaces existing document fields", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    const docs = makeSeedDocuments();
    const original = docs.find(
      (doc): doc is EventSearchDocument => doc.id === "event-neon-skyline",
    )!;
    const updated: EventSearchDocument = {
      ...original,
      title: "Neon Skyline Afterparty",
      summary: "Updated late-night electronic gathering",
      popularityScore: 120,
    };

    await expectOk(search.upsertDocuments({ documents: [updated] }));
    await expectOk(search.upsertDocuments({ documents: [updated] }));

    const stats = await expectOk(search.getStats());
    expect(stats.events.count).toBe(12);

    const matches = await suggestions(search, {
      query: "Afterparty",
      filters: { types: ["event"] },
    });
    expect(matches[0]).toMatchObject({
      id: "event-neon-skyline",
      title: "Neon Skyline Afterparty",
    });
  });

  test("persists and round-trips endsAt, addressText, and isPublic on event docs", async () => {
    expect(adapter).toBeDefined();
    expect(prisma).toBeDefined();
    const search = adapter!;
    const db = prisma!;

    const endsAt = new Date("2026-06-12T05:30:00.000Z");
    const doc: EventSearchDocument = {
      ...(makeSeedDocuments().find(
        (d): d is EventSearchDocument => d.id === "event-neon-skyline",
      )!),
      endsAt,
      addressText: "500 Hidden Way, Brooklyn, NY",
      isPublic: false,
    };

    await expectOk(search.upsertDocuments({ documents: [doc] }));

    const rows = await db.$queryRaw<
      Array<{
        ends_at: Date | null;
        address_text: string | null;
        is_public: boolean;
      }>
    >`
      SELECT ends_at, address_text, is_public
      FROM "SearchDocument"
      WHERE id = ${doc.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ends_at?.toISOString()).toBe(endsAt.toISOString());
    expect(rows[0]!.address_text).toBe("500 Hidden Way, Brooklyn, NY");
    expect(rows[0]!.is_public).toBe(false);

    // Upsert is idempotent AND updates the new columns via ON CONFLICT.
    const updated: EventSearchDocument = {
      ...doc,
      addressText: "1 New Address Rd, Brooklyn, NY",
      isPublic: true,
      endsAt: null,
    };
    await expectOk(search.upsertDocuments({ documents: [updated] }));
    const after = await db.$queryRaw<
      Array<{
        ends_at: Date | null;
        address_text: string | null;
        is_public: boolean;
      }>
    >`
      SELECT ends_at, address_text, is_public
      FROM "SearchDocument"
      WHERE id = ${doc.id}
    `;
    expect(after[0]!.ends_at).toBeNull();
    expect(after[0]!.address_text).toBe("1 New Address Rd, Brooklyn, NY");
    expect(after[0]!.is_public).toBe(true);
  });

  test("event suggestion carries endsAt, city, region, and location (the embed render payload)", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    const matches = await suggestions(search, {
      query: "Neon Skyline",
      filters: { types: ["event"] },
    });
    const skyline = matches.find((m) => m.id === "event-neon-skyline");
    expect(skyline).toBeDefined();
    if (!skyline || skyline.type !== "event") {
      throw new Error("expected the neon skyline event suggestion");
    }

    // startsAt + 2h from eventDoc().
    expect(skyline.endsAt?.toISOString()).toBe("2026-06-12T05:00:00.000Z");
    expect(skyline.city).toBe("San Francisco");
    expect(skyline.region).toBe("CA");
    // addressText from eventDoc(): `${venueName}, ${city}`.
    expect(skyline.location).toBe("River Hall, San Francisco");
  });

  // The card stamps its date/time in the DTO's zone; without it stored, a
  // 10:30 PM Pacific show read "12:30 AM" beside a date of "Oct 15".
  test("persists the event's timezone and returns it on the suggestion; a pre-column row reads null", async () => {
    expect(adapter).toBeDefined();
    expect(prisma).toBeDefined();
    const search = adapter!;
    const db = prisma!;

    const doc: EventSearchDocument = {
      ...(makeSeedDocuments().find(
        (d): d is EventSearchDocument => d.id === "event-neon-skyline",
      )!),
      timezone: "America/Los_Angeles",
    };
    await expectOk(search.upsertDocuments({ documents: [doc] }));

    const rows = await db.$queryRaw<Array<{ timezone: string | null }>>`
      SELECT timezone FROM "SearchDocument" WHERE id = ${doc.id}
    `;
    expect(rows[0]!.timezone).toBe("America/Los_Angeles");

    const find = async () => {
      const matches = await suggestions(search, {
        query: "Neon Skyline",
        filters: { types: ["event"] },
      });
      const hit = matches.find((m) => m.id === "event-neon-skyline");
      if (!hit || hit.type !== "event") {
        throw new Error("expected the neon skyline event suggestion");
      }
      return hit;
    };
    expect((await find()).timezone).toBe("America/Los_Angeles");

    // A row written before the column existed has NULL there.
    await db.$executeRaw`
      UPDATE "SearchDocument" SET timezone = NULL WHERE id = ${doc.id}
    `;
    expect((await find()).timezone).toBeNull();
  });

  // category-translations spec: a Music event carries "Música" in
  // `categoryNames`, so a Spanish query finds it with no match in its title.
  test("finds an event by its category's translated name", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;
    await expectOk(
      search.upsertDocuments({
        documents: [
          eventDoc({
            id: "event-category-names",
            title: "Quiet Evening Set",
            tags: ["music"],
            categoryNames: ["Music", "Música"],
            venueName: "Back Room",
            city: "Austin",
            regionCode: "TX",
            lat: 30.27,
            lng: -97.74,
            orgId: ORG_A,
            startsAt: new Date("2026-07-02T02:00:00.000Z"),
            popularityScore: 10,
            lowestBuyerTotalCents: null,
          }),
        ],
      }),
    );

    for (const query of ["música", "musica", "Music"]) {
      const matches = await suggestions(search, {
        query,
        filters: { types: ["event"] },
      });
      expect(
        matches.some((m) => m.id === "event-category-names"),
        `query "${query}"`,
      ).toBe(true);
    }
    // Not a tag: the category filter still keys on the slug alone.
    const tagged = await suggestions(search, {
      query: "",
      filters: { types: ["event"], tags: ["Música"] },
    });
    expect(tagged.some((m) => m.id === "event-category-names")).toBe(false);
  });

  // Owner ruling 2026-10-06 (F2): floor-0 pay-what-you-want is its own flag,
  // apart from has_free_tier, so a listing can say "Pay what you want".
  test("round-trips hasPayWhatYouWantTier apart from hasFreeTier", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    const upsert = await search.upsertDocuments({
      documents: [
        eventDoc({
          id: "event-pass-the-hat",
          title: "Pass The Hat Session",
          tags: ["jazz"],
          venueName: "Back Room",
          city: "Austin",
          regionCode: "TX",
          lat: 30.27,
          lng: -97.74,
          orgId: ORG_A,
          startsAt: new Date("2026-07-02T02:00:00.000Z"),
          popularityScore: 10,
          lowestPriceCents: 0,
          lowestBuyerTotalCents: null,
          hasPayWhatYouWantTier: true,
        }),
      ],
    });
    if (!upsert.ok) throw upsert.error;

    const matches = await suggestions(search, {
      query: "Pass The Hat",
      filters: { types: ["event"] },
    });
    const hat = matches.find((m) => m.id === "event-pass-the-hat");
    if (!hat || hat.type !== "event") {
      throw new Error("expected the pass-the-hat event suggestion");
    }
    expect(hat.hasPayWhatYouWantTier).toBe(true);
    expect(hat.hasFreeTier).toBe(false);
    expect(hat.lowestPriceCents).toBe(0);

    // A seeded free-tier event keeps the other flag only.
    const yoga = (
      await suggestions(search, {
        query: "Free Sunrise Yoga",
        filters: { types: ["event"] },
      })
    ).find((m) => m.id === "event-free-yoga");
    if (!yoga || yoga.type !== "event") {
      throw new Error("expected the free yoga event suggestion");
    }
    expect(yoga.hasFreeTier).toBe(true);
    expect(yoga.hasPayWhatYouWantTier).toBe(false);
  });

  // A place has ONE slug: its `EntityPage.slug` (flat, the only value
  // `/places/[slug]` resolves on). The document persists it as `pageSlug` on
  // the SHARED entity-page-slug column `profile_slug` — a human's page slug
  // lives there too — so no schema migration was needed.
  //
  // The shared `slug` column stays NULL for a place. It used to hold
  // `Place.slug`, a multi-segment DIRECTORY key nothing routed on, and
  // conflating the two put a dead link on every venue result in search. That
  // column is deprecated; both facts are pinned here.
  test("place suggestion carries pageSlug, persisted on the shared profile_slug column", async () => {
    expect(adapter).toBeDefined();
    expect(prisma).toBeDefined();
    const search = adapter!;
    const db = prisma!;

    const rows = await db.$queryRaw<
      Array<{ slug: string | null; profile_slug: string | null }>
    >`
      SELECT slug, profile_slug
      FROM "SearchDocument"
      WHERE id = 'place-river-hall'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBeNull();
    expect(rows[0]!.profile_slug).toBe("place-river-hall-a1b2c3d4");

    const matches = await suggestions(search, {
      query: "River Hall",
      filters: { types: ["place"] },
    });
    const riverHall = matches.find((m) => m.id === "place-river-hall");
    if (!riverHall || riverHall.type !== "place") {
      throw new Error("expected the river hall place suggestion");
    }
    expect(riverHall.pageSlug).toBe("place-river-hall-a1b2c3d4");
    expect(riverHall).not.toHaveProperty("slug");
    // `/places/[slug]` is a single non-catch-all segment — a `/` in the
    // routable value means a directory key leaked back in.
    expect(riverHall.pageSlug).not.toContain("/");
  });

  test("deletes by id, type, org ownership, and human ownership", async () => {
    expect(adapter).toBeDefined();
    const search = adapter!;

    const byId = await expectOk(
      search.deleteDocuments({ ids: ["event-food-fair"] }),
    );
    expect(byId.deleted).toBe(1);
    await expectIds(
      search,
      { query: "Cedar Food", filters: { types: ["event"] } },
      [],
    );

    const byHuman = await expectOk(
      search.deleteDocuments({ ownerHumanId: OWNER_HUMAN_ID }),
    );
    expect(byHuman.deleted).toBe(1);
    await expectIds(
      search,
      { query: "Bedroom Pop", filters: { types: ["event"] } },
      [],
    );
    await expectIds(search, { query: "Alex", filters: { types: ["human"] } }, [
      "human-alex",
    ]);

    // ORG_B owns 4 event docs now: 3 public + the PRIVATE cross-tenant probe.
    const byOrg = await expectOk(search.deleteDocuments({ orgId: ORG_B }));
    expect(byOrg.deleted).toBe(4);
    await expectIds(
      search,
      { query: "Mountain Folk", filters: { types: ["event"] } },
      [],
    );
    await expectIds(
      search,
      { query: "Night Archive", filters: { types: ["organization"] } },
      ["org-night-archive"],
    );

    const byType = await expectOk(
      search.deleteDocuments({ type: "organization" }),
    );
    expect(byType.deleted).toBe(3);
    await expectIds(
      search,
      { query: "Collective", filters: { types: ["organization"] } },
      [],
    );
  });
});

async function suggestions(
  adapter: MultiIndexPostgresAdapter,
  input: MultiSearchAutocompleteInput,
): Promise<MultiSearchSuggestion[]> {
  const result = await adapter.autocomplete(input);
  if (!result.ok) throw result.error;
  return result.value.suggestions;
}

async function expectIds(
  adapter: MultiIndexPostgresAdapter,
  input: MultiSearchAutocompleteInput,
  expectedIds: string[],
): Promise<void> {
  const matches = await suggestions(adapter, input);
  expect(matches.map((suggestion) => suggestion.id)).toEqual(expectedIds);
}

async function expectOk<T>(
  promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
): Promise<T> {
  const result = await promise;
  if (!result.ok) throw result.error;
  return result.value;
}

function makeSeedDocuments(): MultiSearchDocument[] {
  return [
    eventDoc({
      id: "event-neon-skyline",
      title: "Neon Skyline",
      tags: ["electronic", "nightlife"],
      venueName: "River Hall",
      city: "San Francisco",
      regionCode: "CA",
      lat: 37.775,
      lng: -122.419,
      orgId: ORG_A,
      startsAt: new Date("2026-06-12T03:00:00.000Z"),
      popularityScore: 90,
      lowestBuyerTotalCents: 2_500,
      venueId: "plc-venue-river",
    }),
    // PRIVATE event owned by ORG_A. Excluded from the public path by the
    // visibility gate; only visible via the owner-scoped bypass. Shares the
    // "plc-venue-river" venue to prove the placeId filter still honors the gate.
    eventDoc({
      id: "event-private-alpha",
      title: "Private Alpha Gala",
      tags: ["gala"],
      venueName: "River Hall",
      city: "San Francisco",
      regionCode: "CA",
      lat: 37.775,
      lng: -122.419,
      orgId: ORG_A,
      startsAt: new Date("2026-06-30T03:00:00.000Z"),
      popularityScore: 60,
      lowestBuyerTotalCents: 5_000,
      isPublic: false,
      venueId: "plc-venue-river",
    }),
    // PRIVATE event owned by ORG_B — the cross-tenant probe. Must NEVER surface
    // for an ORG_A-scoped bypass query.
    eventDoc({
      id: "event-private-beta",
      title: "Private Beta Gala",
      tags: ["gala"],
      venueName: "Underground Warehouse",
      city: "Oakland",
      regionCode: "CA",
      lat: 37.804,
      lng: -122.271,
      orgId: ORG_B,
      startsAt: new Date("2026-07-05T03:00:00.000Z"),
      popularityScore: 50,
      lowestBuyerTotalCents: 5_000,
      isPublic: false,
    }),
    eventDoc({
      id: "event-summer-jazz",
      title: "Summer Jazz Festival",
      tags: ["music", "jazz"],
      venueName: "River Hall Annex",
      city: "San Francisco",
      regionCode: "CA",
      lat: 37.79,
      lng: -122.41,
      orgId: ORG_A,
      startsAt: new Date("2026-06-22T20:00:00.000Z"),
      popularityScore: 70,
      lowestBuyerTotalCents: 3_500,
    }),
    eventDoc({
      id: "event-electronic-night",
      title: "Electronic Music Night",
      tags: ["electronic"],
      venueName: "Underground Warehouse",
      city: "Oakland",
      regionCode: "CA",
      lat: 37.804,
      lng: -122.271,
      orgId: ORG_B,
      startsAt: new Date("2026-08-02T04:00:00.000Z"),
      popularityScore: 40,
      lowestBuyerTotalCents: 2_200,
    }),
    eventDoc({
      id: "event-coachella",
      title: "Coachella Valley Picnic",
      tags: ["festival", "outdoor"],
      venueName: "Desert Stage",
      city: "Indio",
      regionCode: "CA",
      lat: 33.68,
      lng: -116.24,
      orgId: ORG_B,
      startsAt: new Date("2026-09-15T21:00:00.000Z"),
      popularityScore: 110,
      lowestBuyerTotalCents: 7_500,
    }),
    eventDoc({
      id: "event-haunted-theatre",
      title: "Haunted Theatre Walk",
      tags: ["theater", "walking-tour"],
      venueName: "Old Lyric Theatre",
      city: "New York",
      regionCode: "NY",
      lat: 40.712,
      lng: -74.006,
      orgId: ORG_A,
      startsAt: new Date("2026-10-29T23:00:00.000Z"),
      popularityScore: 55,
      lowestBuyerTotalCents: 1_800,
    }),
    eventDoc({
      id: "event-free-yoga",
      title: "Free Sunrise Yoga",
      tags: ["wellness", "free"],
      venueName: "Zilker Lawn",
      city: "Austin",
      regionCode: "TX",
      lat: 30.267,
      lng: -97.743,
      orgId: ORG_A,
      startsAt: new Date("2026-07-01T12:00:00.000Z"),
      popularityScore: 30,
      lowestPriceCents: 0,
      lowestBuyerTotalCents: 0,
      hasFreeTier: true,
    }),
    eventDoc({
      id: "event-bedroom-pop",
      title: "Bedroom Pop Night",
      tags: ["indie", "pop"],
      venueName: "The Workshop",
      city: "Seattle",
      regionCode: "WA",
      lat: 47.606,
      lng: -122.332,
      orgId: null,
      ownerHumanId: OWNER_HUMAN_ID,
      startsAt: new Date("2026-08-12T03:00:00.000Z"),
      popularityScore: 25,
      lowestBuyerTotalCents: 1_200,
    }),
    eventDoc({
      id: "event-mountain-folk",
      title: "Mountain Folk Picnic",
      tags: ["folk", "outdoor"],
      venueName: "Pine Ridge",
      city: "Boulder",
      regionCode: "CO",
      lat: 40.015,
      lng: -105.27,
      orgId: ORG_B,
      startsAt: new Date("2026-08-19T18:00:00.000Z"),
      popularityScore: 22,
      lowestBuyerTotalCents: 1_000,
    }),
    eventDoc({
      id: "event-food-fair",
      title: "Cedar Food Fair",
      tags: ["food", "market"],
      venueName: "Cedar Plaza",
      city: "Chicago",
      regionCode: "IL",
      lat: 41.878,
      lng: -87.629,
      orgId: ORG_A,
      startsAt: new Date("2026-05-20T18:00:00.000Z"),
      popularityScore: 12,
      lowestBuyerTotalCents: 900,
    }),
    eventDoc({
      id: "event-hidden-draft",
      title: "Hidden Draft Rave",
      tags: ["electronic"],
      venueName: "Secret Room",
      city: "San Francisco",
      regionCode: "CA",
      lat: 37.77,
      lng: -122.42,
      orgId: ORG_A,
      startsAt: new Date("2026-11-01T04:00:00.000Z"),
      popularityScore: 200,
      lowestBuyerTotalCents: 4_000,
      status: "DRAFT",
    }),
    humanDoc(
      "human-alex",
      "Alex Rivera",
      "arivera",
      "Neon curator and concert promoter",
      "CA",
      true,
      12,
    ),
    humanDoc(
      "human-maya",
      "Maya Chen",
      "maya",
      "Community event organizer",
      "CA",
      true,
      5,
    ),
    humanDoc(
      "human-lila",
      "Lila Brooks",
      "lila",
      "Outdoor festival producer",
      "CO",
      true,
      7,
    ),
    humanDoc(
      "human-theo",
      "Theo Morgan",
      "theo",
      "Theatre host",
      "NY",
      true,
      3,
    ),
    humanDoc(
      "human-hidden",
      "Hidden Person",
      "hidden",
      "Hidden private profile",
      "CA",
      false,
      100,
    ),
    placeDoc(
      "place-river-hall",
      "River Hall",
      "Live room beside the water",
      "San Francisco",
      "CA",
      37.775,
      -122.419,
      true,
      "ACTIVE",
      900,
      24,
    ),
    placeDoc(
      "place-underground",
      "Underground Warehouse",
      "Converted warehouse venue",
      "Oakland",
      "CA",
      37.804,
      -122.271,
      false,
      "ACTIVE",
      600,
      8,
    ),
    placeDoc(
      "place-desert-stage",
      "Desert Stage",
      "Outdoor desert amphitheater",
      "Indio",
      "CA",
      33.68,
      -116.24,
      true,
      "ACTIVE",
      2500,
      18,
    ),
    placeDoc(
      "place-hidden-chapel",
      "Hidden Chapel",
      "Suspended room",
      "Portland",
      "OR",
      45.515,
      -122.678,
      true,
      "SUSPENDED",
      200,
      99,
    ),
    organizationDoc(
      "org-bay-collective",
      ORG_A,
      "Bay Collective",
      "bay-collective",
      "Active music collective",
      14,
      30,
    ),
    organizationDoc(
      "org-night-archive",
      ORG_B,
      "Night Archive",
      "night-archive",
      "Late-night event crew",
      9,
      12,
    ),
    organizationDoc(
      "org-civic-arts",
      "org-civic-search",
      "Civic Arts League",
      "civic-arts",
      null,
      4,
      80,
    ),
  ];
}

async function readSearchMigrationSql(): Promise<string> {
  // Apply the base table migration THEN the incremental column adds, so the
  // test schema matches the live one (ends_at + address_text columns).
  const base = await readFile(
    new URL(
      "../../../../db/prisma/migrations/20260512_search_documents/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const endsAtAddress = await readFile(
    new URL(
      "../../../../db/prisma/migrations/20260720120000_search_document_ends_at_address/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  // The map-precision columns (one ALTER per migration file).
  const precision = await Promise.all(
    [
      "20260928140000_search_document_location_is_exact",
      "20260928140001_search_document_location_radius_meters",
      // The non-destructive rebuild's write marker (every upsert sets it).
      "20260930210000_search_document_indexed_marker",
      // Floor-0 pay-what-you-want, apart from has_free_tier (F2).
      "20261006150000_search_document_has_pay_what_you_want_tier",
      // The event's IANA zone, so search-backed cards stamp in it.
      "20261015150000_search_document_timezone",
      // The category's names in every language, searchable at weight D.
      "20261016220000_search_document_category_names",
    ].map((dir) =>
      readFile(
        new URL(
          `../../../../db/prisma/migrations/${dir}/migration.sql`,
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  return [base, endsAtAddress, ...precision].join("\n");
}

function eventDoc(input: {
  id: string;
  title: string;
  tags: string[];
  venueName: string;
  city: string;
  regionCode: string;
  lat: number;
  lng: number;
  orgId: string | null;
  ownerHumanId?: string | null;
  startsAt: Date;
  popularityScore: number;
  lowestPriceCents?: number | null;
  lowestBuyerTotalCents: number | null;
  hasFreeTier?: boolean;
  hasPayWhatYouWantTier?: boolean;
  status?: "DRAFT" | "PUBLISHED" | "HIDDEN";
  isPublic?: boolean;
  venueId?: string | null;
  categoryNames?: string[];
}): EventSearchDocument {
  return {
    type: "event",
    id: input.id,
    eventId: input.id.replace("event-", "evt-"),
    slug: input.id,
    orgId: input.orgId,
    ownerType: input.orgId ? "ORG" : "HUMAN",
    ownerHumanId: input.ownerHumanId ?? null,
    title: input.title,
    artists: [],
    tags: input.tags,
    categoryNames: input.categoryNames ?? [],
    venueId: input.venueId ?? null,
    venueName: input.venueName,
    addressText: `${input.venueName}, ${input.city}`,
    city: input.city,
    regionCode: input.regionCode,
    countryCode: "US",
    lat: input.lat,
    lng: input.lng,
    startsAt: input.startsAt,
    endsAt: new Date(input.startsAt.getTime() + 2 * 60 * 60 * 1000),
    timezone: "America/Chicago",
    status: input.status ?? "PUBLISHED",
    isPublic: input.isPublic ?? true,
    popularityScore: input.popularityScore,
    recencyScore: 0,
    summary: `${input.title} summary`,
    imageUrl: null,
    lowestPriceCents: input.lowestPriceCents ?? input.lowestBuyerTotalCents,
    lowestBuyerTotalCents: input.lowestBuyerTotalCents,
    currency: "usd",
    paidTierCount:
      input.lowestBuyerTotalCents && input.lowestBuyerTotalCents > 0 ? 1 : 0,
    hasFreeTier: input.hasFreeTier ?? false,
    hasPayWhatYouWantTier: input.hasPayWhatYouWantTier ?? false,
  };
}

function humanDoc(
  id: string,
  displayName: string,
  username: string,
  bio: string,
  regionCode: string,
  isPublic: boolean,
  eventsHostedCount: number,
): MultiSearchDocument {
  return {
    type: "human",
    id,
    humanId: id.replace("human-", "hum-"),
    username,
    displayName,
    bio,
    profileSlug: username,
    eventsHostedCount,
    isPublic,
    city: regionCode === "NY" ? "New York" : "San Francisco",
    regionCode,
    countryCode: "US",
  };
}

function placeDoc(
  id: string,
  name: string,
  bio: string,
  city: string,
  region: string,
  lat: number,
  lng: number,
  listedInDirectory: boolean,
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED",
  capacity: number,
  eventCount: number,
): MultiSearchDocument {
  return {
    type: "place",
    id,
    placeId: id.replace("place-", "plc-"),
    name,
    // A place's ONE slug: the flat `EntityPage.slug` `/places/[slug]` resolves
    // on. There is deliberately no second `slug` — the deprecated `Place.slug`
    // is off the document, and the shared `slug` column must land NULL.
    pageSlug: `${id}-a1b2c3d4`,
    formattedAddress: `${name}, ${city}`,
    city,
    region,
    countryCode: "US",
    lat,
    lng,
    capacity,
    eventCount,
    bio,
    status,
    verificationStatus: "VERIFIED",
    listedInDirectory,
  };
}

function organizationDoc(
  id: string,
  orgId: string,
  name: string,
  slug: string,
  bio: string | null,
  eventCount: number,
  memberCount: number,
): MultiSearchDocument {
  return {
    type: "organization",
    id,
    orgId,
    name,
    slug,
    status: "ACTIVE",
    eventCount,
    memberCount,
    bio,
  };
}

/**
 * The slice of "Human" / "OrgMember" that SEARCH_DOC_NOT_WITHHELD_SQL
 * (db/prisma/banned-owner.ts) reads. Left empty: no owner is withheld.
 */
const OWNER_STANDING_TABLES_SQL = `
  CREATE TYPE "HumanStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'BANNED');
  CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'FINANCE', 'SCANNER', 'VIEWER');
  CREATE TABLE "Human" (id TEXT PRIMARY KEY, status "HumanStatus" NOT NULL DEFAULT 'ACTIVE');
  CREATE TABLE "OrgMember" ("orgId" TEXT NOT NULL, "humanId" TEXT NOT NULL, role "OrgRole" NOT NULL);
`;
