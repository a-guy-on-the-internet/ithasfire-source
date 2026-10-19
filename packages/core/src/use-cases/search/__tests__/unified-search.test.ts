import { describe, expect, it, vi } from "vitest";
import type { MultiSearchSort } from "@th/ports/search/multi-index.types";

import { unifiedSearch } from "../unified-search";

describe("unifiedSearch", () => {
  it.each([{ orgId: "not-a-uuid" }, { ownerHumanId: "not-a-uuid" }])(
    "rejects invalid scope UUIDs before calling the search port: %j",
    async (invalidScope) => {
      const search = {
        autocomplete: vi.fn(),
      };

      await expect(
        unifiedSearch(
          {
            search: search as any,
          },
          {
            query: "party",
            ...invalidScope,
          },
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expect(search.autocomplete).not.toHaveBeenCalled();
    },
  );

  it("forwards listedInDirectoryOnly to the search port when true", async () => {
    const search = {
      autocomplete: vi.fn().mockResolvedValue({
        ok: true,
        value: { suggestions: [], latencyMs: 1 },
      }),
    };

    await unifiedSearch({ search: search as any }, {
      query: "venue",
      listedInDirectoryOnly: true,
    });

    expect(search.autocomplete).toHaveBeenCalledTimes(1);
    const call = search.autocomplete.mock.calls[0][0];
    expect(call.filters.listedInDirectoryOnly).toBe(true);
  });

  it("threads lat/lng from the event suggestion through to the output", async () => {
    const search = {
      autocomplete: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          suggestions: [
            {
              type: "event",
              id: "evt-doc-1",
              eventId: "evt-1",
              title: "Show at the Basement",
              subtitle: "The Basement",
              helper: "Jul 18",
              slug: "show-at-the-basement",
              startsAt: new Date("2026-07-18T00:00:00.000Z"),
              lat: 36.1447,
              lng: -86.7681,
              imageUrl: null,
              lowestPriceCents: 1500,
              lowestBuyerTotalCents: 1800,
              currency: "USD",
              paidTierCount: 1,
              hasFreeTier: false,
              confidence: 0.9,
            },
          ],
          latencyMs: 3,
        },
      }),
    };

    const result = await unifiedSearch({ search: search as any }, {
      query: "basement",
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      type: "event",
      eventId: "evt-1",
      lat: 36.1447,
      lng: -86.7681,
    });
  });

  it("emits null lat/lng when the event has no geocoded pin", async () => {
    const search = {
      autocomplete: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          suggestions: [
            {
              type: "event",
              id: "evt-doc-2",
              eventId: "evt-2",
              title: "TBA venue show",
              subtitle: null,
              helper: null,
              slug: null,
              startsAt: null,
              lat: null,
              lng: null,
              imageUrl: null,
              lowestPriceCents: null,
              lowestBuyerTotalCents: null,
              currency: null,
              paidTierCount: 0,
              hasFreeTier: false,
              confidence: 0.5,
            },
          ],
          latencyMs: 2,
        },
      }),
    };

    const result = await unifiedSearch({ search: search as any }, {
      query: "tba",
    });

    expect(result.suggestions[0]).toMatchObject({
      type: "event",
      lat: null,
      lng: null,
    });
  });

  it("omits listedInDirectoryOnly from filters when not provided", async () => {
    const search = {
      autocomplete: vi.fn().mockResolvedValue({
        ok: true,
        value: { suggestions: [], latencyMs: 1 },
      }),
    };

    await unifiedSearch({ search: search as any }, {
      query: "venue",
    });

    expect(search.autocomplete).toHaveBeenCalledTimes(1);
    const call = search.autocomplete.mock.calls[0][0];
    expect(call.filters).not.toHaveProperty("listedInDirectoryOnly");
  });

  const ORG_ID = "33333333-3333-4333-8333-333333333333";
  const OWNER_HUMAN_ID = "22222222-2222-4222-8222-222222222222";

  const okSearch = () => ({
    autocomplete: vi.fn().mockResolvedValue({
      ok: true,
      value: { suggestions: [], latencyMs: 1 },
    }),
  });

  it("forwards includeNonPublicEvents ONLY when an owner scope is present", async () => {
    // With an org scope, the bypass is honored.
    const withOrg = okSearch();
    await unifiedSearch({ search: withOrg as any }, {
      query: "gala",
      includeNonPublicEvents: true,
      orgId: ORG_ID,
    });
    expect(withOrg.autocomplete.mock.calls[0][0].filters).toMatchObject({
      includeNonPublicEvents: true,
      orgId: ORG_ID,
    });

    // With a human owner scope, likewise honored.
    const withOwner = okSearch();
    await unifiedSearch({ search: withOwner as any }, {
      query: "gala",
      includeNonPublicEvents: true,
      ownerHumanId: OWNER_HUMAN_ID,
    });
    expect(withOwner.autocomplete.mock.calls[0][0].filters).toMatchObject({
      includeNonPublicEvents: true,
      ownerHumanId: OWNER_HUMAN_ID,
    });
  });

  it("DROPS includeNonPublicEvents when no owner scope is present (fail-closed)", async () => {
    const search = okSearch();

    await unifiedSearch({ search: search as any }, {
      query: "gala",
      includeNonPublicEvents: true,
    });

    // No orgId/ownerHumanId → the flag is stripped, so the adapters keep the
    // PRIVATE-event gate applied.
    expect(search.autocomplete.mock.calls[0][0].filters).not.toHaveProperty(
      "includeNonPublicEvents",
    );
  });

  it("omits includeNonPublicEvents from filters by default", async () => {
    const search = okSearch();

    await unifiedSearch({ search: search as any }, {
      query: "gala",
      orgId: ORG_ID,
    });

    expect(search.autocomplete.mock.calls[0][0].filters).not.toHaveProperty(
      "includeNonPublicEvents",
    );
  });

  it("forwards placeIds to the search port when provided", async () => {
    const search = okSearch();

    await unifiedSearch({ search: search as any }, {
      query: "",
      placeIds: [ORG_ID, OWNER_HUMAN_ID],
    });

    expect(search.autocomplete.mock.calls[0][0].filters.placeIds).toEqual([
      ORG_ID,
      OWNER_HUMAN_ID,
    ]);
  });

  it("omits placeIds from filters when not provided", async () => {
    const search = okSearch();

    await unifiedSearch({ search: search as any }, { query: "venue" });

    expect(search.autocomplete.mock.calls[0][0].filters).not.toHaveProperty(
      "placeIds",
    );
  });

  it("defaults sort to 'relevance' so existing callers are unchanged", async () => {
    const search = okSearch();

    await unifiedSearch({ search: search as any }, { query: "party" });

    expect(search.autocomplete.mock.calls[0][0].sort).toBe("relevance");
  });

  it.each([
    "date",
    "distance",
    "relevance",
    "date_desc",
    "price_asc",
    "price_desc",
    "popularity",
  ] as const)("forwards an explicit sort=%s to the search port", async (sort) => {
    const search = okSearch();

    await unifiedSearch({ search: search as any }, { query: "", sort });

    expect(search.autocomplete.mock.calls[0][0].sort).toBe(sort);
  });

  it("rejects an unknown sort value", async () => {
    const search = okSearch();

    await expect(
      unifiedSearch({ search: search as any }, {
        query: "",
        sort: "cheapest",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(search.autocomplete).not.toHaveBeenCalled();
  });

  // The core schema MIRRORS `MultiSearchSort`. If someone widens the port union
  // and forgets this enum, the transport starts accepting a value the use case
  // rejects at runtime — a 500 that no typecheck catches, because the two are
  // hand-written zod enums rather than one derived type.
  it("accepts every member of the port's MultiSearchSort union", async () => {
    const portModes: MultiSearchSort[] = [
      "relevance",
      "date",
      "date_desc",
      "distance",
      "price_asc",
      "price_desc",
      "popularity",
    ];

    for (const sort of portModes) {
      const search = okSearch();
      await expect(
        unifiedSearch({ search: search as any }, { query: "", sort }),
      ).resolves.toBeDefined();
    }
  });
  // ── Place suggestions carry the ENTITY PAGE slug, and only that ─────────
  //
  // `/places/[slug]` is a single non-catch-all segment resolving on
  // `EntityPage.slug`. A place suggestion used to ALSO carry `Place.slug` — a
  // multi-segment DIRECTORY key nothing routes on — and clients that reached
  // for it 404'd twice over (wrong path shape, wrong column). That column is
  // deprecated, so the suggestion now exposes ONE slug and the projection must
  // STRIP any second one a search backend still emits.

  it("threads a place suggestion's pageSlug through, and strips a stale Place.slug", async () => {
    const search = {
      autocomplete: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          suggestions: [
            {
              type: "place",
              id: "place-doc-1",
              placeId: "00000000-0000-4000-8000-00000000b001",
              title: "The Basement East",
              subtitle: "917 Woodland St",
              helper: null,
              slug: "us/tn/the-basement-east--a1b2c3d4e5",
              pageSlug: "the-basement-east-a1b2c3d4",
              city: "Nashville",
              capacity: 400,
              confidence: 0.9,
            },
          ],
          latencyMs: 2,
        },
      }),
    };

    const result = await unifiedSearch({ search: search as any }, {
      query: "basement",
    });

    const place = result.suggestions[0] as {
      type: string;
      pageSlug: string | null;
    };
    expect(place.type).toBe("place");
    expect(place.pageSlug).toBe("the-basement-east-a1b2c3d4");
    expect(place.pageSlug).not.toContain("/");
    // The backend fixture above still emits the old directory key. It must not
    // reach the client — a stale index is exactly how a dead link comes back.
    expect(place).not.toHaveProperty("slug");
  });

  it("emits a null pageSlug (not a substitute) for a venue with no entity page", async () => {
    const search = {
      autocomplete: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          suggestions: [
            {
              type: "place",
              id: "place-doc-2",
              placeId: "00000000-0000-4000-8000-00000000b002",
              title: "Imported Venue",
              subtitle: null,
              helper: null,
              slug: "us/tn/imported-venue--0f1e2d3c4b",
              // Bulk-imported venue: a Place row, no EntityPage.
              pageSlug: null,
              city: "Nashville",
              capacity: null,
              confidence: 0.4,
            },
          ],
          latencyMs: 2,
        },
      }),
    };

    const result = await unifiedSearch({ search: search as any }, {
      query: "imported",
    });

    const place = result.suggestions[0] as { pageSlug: string | null };
    expect(place.pageSlug).toBeNull();
  });
});

// ── Map precision: pin vs approximate circle vs not plotted ─────────────────
//
// The /search map draws venues and events from these fields. An approximate
// location drawn as a pin reads as "the house is HERE", so the contract fails
// closed: coordinates travel only with something honest to draw.
describe("unifiedSearch — map precision on place + event suggestions", () => {
  const place = (extra: Record<string, unknown>) => ({
    type: "place",
    id: "place-doc-m",
    placeId: "00000000-0000-4000-8000-00000000b0a1",
    title: "Venue",
    subtitle: null,
    helper: null,
    pageSlug: "venue-b0a1",
    city: "Nashville",
    capacity: null,
    confidence: 0.5,
    ...extra,
  });
  const event = (extra: Record<string, unknown>) => ({
    type: "event",
    id: "event-doc-m",
    eventId: "00000000-0000-4000-8000-00000000e0a1",
    title: "Show",
    subtitle: null,
    helper: null,
    slug: "show",
    startsAt: null,
    endsAt: null,
    city: "Nashville",
    region: "TN",
    location: "Nashville, TN",
    lat: 36.17,
    lng: -86.78,
    imageUrl: null,
    lowestPriceCents: null,
    lowestBuyerTotalCents: null,
    currency: null,
    paidTierCount: 0,
    hasFreeTier: false,
    confidence: 0.5,
    ...extra,
  });
  const run = async (suggestions: unknown[]) =>
    (
      await unifiedSearch(
        {
          search: {
            autocomplete: vi.fn().mockResolvedValue({
              ok: true,
              value: { suggestions, latencyMs: 1 },
            }),
          } as any,
        },
        { query: "" },
      )
    ).suggestions as unknown as Array<Record<string, unknown>>;

  it("an EXACT venue carries its pin and no radius", async () => {
    const [p] = await run([
      place({ lat: 36.1, lng: -86.7, locationIsExact: true, locationRadiusMeters: 500 }),
    ]);
    expect(p).toMatchObject({ lat: 36.1, lng: -86.7, locationIsExact: true, locationRadiusMeters: null });
  });

  it("an approximate venue carries the circle centre + radius, never exact", async () => {
    const [p] = await run([
      place({ lat: 36.2, lng: -86.6, locationIsExact: false, locationRadiusMeters: 1000 }),
    ]);
    expect(p).toMatchObject({ lat: 36.2, lng: -86.6, locationIsExact: false, locationRadiusMeters: 1000 });
  });

  it("a hidden venue (no radius) carries NO coordinates, whatever the backend sent", async () => {
    const [p] = await run([
      place({ lat: 36.3, lng: -86.5, locationIsExact: false, locationRadiusMeters: null }),
    ]);
    expect(p).toMatchObject({ lat: null, lng: null, locationIsExact: false, locationRadiusMeters: null });
  });

  it("a STALE venue document (no precision fields) fails closed to not plotted, and is NOT claimed private", async () => {
    const [p] = await run([place({ lat: 36.3, lng: -86.5 })]);
    expect(p).toMatchObject({
      lat: null,
      lng: null,
      locationIsExact: false,
      locationRadiusMeters: null,
      locationHidden: false,
    });
  });

  it("locationHidden passes through only with no coordinates", async () => {
    const [hidden, contradictory, exactNoPoint] = await run([
      place({ lat: null, lng: null, locationIsExact: false, locationRadiusMeters: null, locationHidden: true }),
      // A backend claiming hidden while sending a circle: the circle wins, no claim.
      place({ id: "p2", lat: 36.2, lng: -86.6, locationIsExact: false, locationRadiusMeters: 1000, locationHidden: true }),
      place({ id: "p3", lat: null, lng: null, locationIsExact: true, locationHidden: false }),
    ]);
    expect(hidden).toMatchObject({ locationHidden: true, lat: null });
    expect(contradictory).toMatchObject({ locationHidden: false, locationRadiusMeters: 1000 });
    expect(exactNoPoint).toMatchObject({ locationHidden: false, lat: null });
  });

  it("an event carries its precision; a stale event document reads as not exact", async () => {
    const [exact, approx, stale] = await run([
      event({ locationIsExact: true, locationRadiusMeters: null }),
      event({ id: "e2", eventId: "00000000-0000-4000-8000-00000000e0a2", locationIsExact: false, locationRadiusMeters: 500 }),
      event({ id: "e3", eventId: "00000000-0000-4000-8000-00000000e0a3" }),
    ]);
    expect(exact).toMatchObject({ locationIsExact: true, locationRadiusMeters: null });
    expect(approx).toMatchObject({ locationIsExact: false, locationRadiusMeters: 500 });
    expect(stale).toMatchObject({ locationIsExact: false, locationRadiusMeters: null });
  });
});

// ── Category filter: gated on `Category.active`, free-form tags are not ─────
//
// A category's slug sits in the event document's `tags` beside the event's own
// free-form tags, and the index does not carry `active`. So a category arrives
// as `categorySlugs`, is checked against the categories repo on each request,
// and only then joins the tag filter. `tags` passed directly is never checked:
// an organiser may have tagged an event "nightlife" by hand.
describe("unifiedSearch: categorySlugs are gated on Category.active", () => {
  const okSearch = () => ({
    autocomplete: vi.fn().mockResolvedValue({
      ok: true,
      value: { suggestions: [], latencyMs: 1 },
    }),
  });

  /** A categories repo holding `rows`; anything else is unknown. */
  const categoriesRepo = (rows: Record<string, { active: boolean }>) => ({
    categories: {
      getBySlug: vi.fn(async (slug: string) =>
        rows[slug] ? { slug, active: rows[slug]!.active } : null,
      ),
      listActive: vi.fn(async () =>
        Object.entries(rows)
          .filter(([, row]) => row.active)
          .map(([slug]) => ({ slug })),
      ),
    },
  });

  const filtersOf = (search: ReturnType<typeof okSearch>) =>
    search.autocomplete.mock.calls[0]![0].filters;

  it("an active slug reaches the search port in the tag filter", async () => {
    const search = okSearch();
    const repos = categoriesRepo({ music: { active: true } });

    await unifiedSearch({ search: search as any, repos: repos as any }, {
      query: "",
      categorySlugs: ["music"],
    });

    expect(filtersOf(search).tags).toEqual(["music"]);
    expect(filtersOf(search)).not.toHaveProperty("categorySlugs");
  });

  it.each([
    ["inactive", { nightlife: { active: false } }],
    ["unknown", {}],
  ] as const)(
    "a request whose only category is %s searches with NO category filter",
    async (_label, rows) => {
      const search = okSearch();
      const repos = categoriesRepo(rows);

      await expect(
        unifiedSearch({ search: search as any, repos: repos as any }, {
          query: "jazz",
          categorySlugs: ["nightlife"],
        }),
      ).resolves.toMatchObject({ suggestions: [] });

      // Searched, not skipped, and not filtered to nothing.
      expect(search.autocomplete).toHaveBeenCalledTimes(1);
      expect(filtersOf(search)).not.toHaveProperty("tags");
    },
  );

  it("one active and one inactive slug: only the active one filters", async () => {
    const search = okSearch();
    const repos = categoriesRepo({
      music: { active: true },
      nightlife: { active: false },
    });

    await unifiedSearch({ search: search as any, repos: repos as any }, {
      query: "",
      categorySlugs: ["nightlife", "music", "zz-no-such-category"],
    });

    expect(filtersOf(search).tags).toEqual(["music"]);
  });

  it("several active slugs keep their order and are read in one query", async () => {
    const search = okSearch();
    const repos = categoriesRepo({
      comedy: { active: true },
      music: { active: true },
    });

    await unifiedSearch({ search: search as any, repos: repos as any }, {
      query: "",
      categorySlugs: ["music", "comedy", "music"],
    });

    expect(filtersOf(search).tags).toEqual(["music", "comedy"]);
    expect(repos.categories.listActive).toHaveBeenCalledTimes(1);
    expect(repos.categories.getBySlug).not.toHaveBeenCalled();
  });

  it.each([[undefined], [[] as string[]]])(
    "categorySlugs=%j reads no category at all",
    async (categorySlugs) => {
      const search = okSearch();
      const repos = categoriesRepo({ music: { active: true } });

      await unifiedSearch({ search: search as any, repos: repos as any }, {
        query: "",
        tags: ["music"],
        ...(categorySlugs ? { categorySlugs } : {}),
      });

      expect(repos.categories.getBySlug).not.toHaveBeenCalled();
      expect(repos.categories.listActive).not.toHaveBeenCalled();
      expect(filtersOf(search).tags).toEqual(["music"]);
    },
  );

  it("a free-form tag equal to an inactive category's slug is still forwarded", async () => {
    const search = okSearch();
    const repos = categoriesRepo({ nightlife: { active: false } });

    // Via `tags` alone: no category read, forwarded as given.
    await unifiedSearch({ search: search as any, repos: repos as any }, {
      query: "",
      tags: ["nightlife"],
    });
    expect(filtersOf(search).tags).toEqual(["nightlife"]);
    expect(repos.categories.getBySlug).not.toHaveBeenCalled();

    // Beside the same slug as a (dropped) category: the tag still stands.
    const second = okSearch();
    await unifiedSearch({ search: second as any, repos: repos as any }, {
      query: "",
      tags: ["nightlife"],
      categorySlugs: ["nightlife"],
    });
    expect(filtersOf(second).tags).toEqual(["nightlife"]);
  });

  it("direct tags and active categories share one tag filter, tags first", async () => {
    const search = okSearch();
    const repos = categoriesRepo({ music: { active: true } });

    await unifiedSearch({ search: search as any, repos: repos as any }, {
      query: "",
      tags: ["all-ages", "music"],
      categorySlugs: ["music"],
    });

    expect(filtersOf(search).tags).toEqual(["all-ages", "music"]);
  });

  it("a failed category read propagates and the search is not run", async () => {
    const search = okSearch();
    const boom = new Error("db down");
    const repos = {
      categories: {
        getBySlug: vi.fn().mockRejectedValue(boom),
        listActive: vi.fn(),
      },
    };

    await expect(
      unifiedSearch({ search: search as any, repos: repos as any }, {
        query: "",
        categorySlugs: ["music"],
      }),
    ).rejects.toBe(boom);
    expect(search.autocomplete).not.toHaveBeenCalled();
  });

  it("categorySlugs without the categories repo throws instead of searching ungated", async () => {
    const search = okSearch();

    await expect(
      unifiedSearch({ search: search as any }, {
        query: "",
        categorySlugs: ["music"],
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
    expect(search.autocomplete).not.toHaveBeenCalled();
  });

  it("rejects an over-long slug and an over-long list", async () => {
    const search = okSearch();
    const repos = categoriesRepo({});

    await expect(
      unifiedSearch({ search: search as any, repos: repos as any }, {
        query: "",
        categorySlugs: ["x".repeat(65)],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      unifiedSearch({ search: search as any, repos: repos as any }, {
        query: "",
        categorySlugs: Array.from({ length: 51 }, (_, i) => `c-${i}`),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(search.autocomplete).not.toHaveBeenCalled();
  });
});
