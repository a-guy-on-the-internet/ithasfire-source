import { describe, it, expect, vi } from "vitest";

import { listEventsByCategoryAndCity } from "./list-events-by-category-and-city";
import { describeCardVenueName } from "./__tests__/_card-venue-name-cases";
import type { EventRecord } from "@th/ports/repos/events";
import { buildOffsetPaginatedResult } from "@th/ports/pagination";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import type { ImageModerationStatus } from "@th/types/repos/image-moderation-records";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment; no fixture here carries a schedule, so
// the resolved price is the list price and every existing expectation holds.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

const CATEGORY = {
  id: "cat-1",
  slug: "open-mics",
  name: "Open Mics",
  active: true,
  sortOrder: 0,
  nameTranslations: { es: "Micrófonos abiertos" },
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: overrides.id ?? "evt-1",
    title: overrides.title ?? "Tuesday Open Mic",
    status: overrides.status ?? "PUBLISHED",
    slug: overrides.slug ?? "us/tn/tuesday-open-mic--abc123",
    startsAt: overrides.startsAt ?? new Date("2026-03-01T00:00:00Z"),
    addressText: overrides.addressText ?? "123 Broadway",
    regionCode: overrides.regionCode ?? "tn",
    heroImageUrl: overrides.heroImageUrl ?? null,
    heroImageKey: overrides.heroImageKey ?? null,
    locality: overrides.locality ?? "Nashville",
    // Ownership fields — community listings are ownerless & RSVP.
    humanId: overrides.humanId ?? null,
    orgId: overrides.orgId ?? null,
    stewardship: overrides.stewardship ?? "COMMUNITY",
    visibility: overrides.visibility ?? "PUBLIC",
    attendanceMode: overrides.attendanceMode ?? "RSVP",
    gateType: overrides.gateType ?? "NONE",
    recurrenceSchedule: overrides.recurrenceSchedule ?? null,
  } as unknown as EventRecord;
}

type TicketType = {
  eventId: string;
  status: string;
  priceCents: number;
};

function makeDeps(args: {
  category?: typeof CATEGORY | null;
  items?: EventRecord[];
  total?: number;
  /** Ungated matches; defaults to `total` (no gated events). */
  indexableTotal?: number;
  ticketTypes?: TicketType[];
  statusByKey?: Record<string, ImageModerationStatus>;
}) {
  const getBySlug = vi.fn(async () =>
    args.category === undefined ? CATEGORY : args.category,
  );
  const total = args.total ?? args.items?.length ?? 0;
  const listPublishedByCategoryAndCity = vi.fn(async () => ({
    ...buildOffsetPaginatedResult({
      items: args.items ?? [],
      total,
      limit: 48,
      offset: 0,
    }),
    indexableTotal: args.indexableTotal ?? total,
  }));
  const listTicketTypesForEventIds = vi.fn(async () => args.ticketTypes ?? []);
  const gate = makeImageModerationGateFake(args.statusByKey ?? {});
  return {
    deps: {
      repos: {
        categories: { getBySlug },
        events: {
          listPublishedByCategoryAndCity,
          listTicketTypesForEventIds,
          countPublishedByCategoryAndCityRegionCode: vi.fn(async () => 0),
        },
        imageModerationRecords: gate.imageModerationRecords,
        // The all-in price reads: no venue rows, no fee policy anywhere.
        places: { getById: vi.fn(async () => null) },
        savedLocations: { getById: vi.fn(async () => null) },
        payoutTerms: { listByEventIds: vi.fn(async () => new Map()) },
        feePolicies: {
          resolveEffective: vi.fn(async () => null),
          resolveEffectiveForScopes: vi.fn(async () => new Map()),
        },
      },
      clock: testClock,
    } as any,
    getBySlug,
    listPublishedByCategoryAndCity,
    listTicketTypesForEventIds,
    resolveByKeys: gate.imageModerationRecords.resolveByKeys,
  };
}

describe("listEventsByCategoryAndCity", () => {
  it("reads the clock ONCE: the page query and its prices share one instant", async () => {
    const { deps, listPublishedByCategoryAndCity } = makeDeps({
      items: [makeEvent()],
      total: 1,
    });
    const now = vi.fn(() => TEST_NOW);

    await listEventsByCategoryAndCity(
      { ...deps, clock: { now } },
      { categorySlug: "open-mics", citySegment: "san-jose-ca" },
    );

    expect(now).toHaveBeenCalledTimes(1);
    expect(listPublishedByCategoryAndCity.mock.calls[0]?.[0].startsAfter).toBe(
      TEST_NOW,
    );
  });

  it("lists gated events and reports the ungated count apart (owner ruling 2026-10-13)", async () => {
    // 3 listed, 1 gated: the page lists all 3, but only 2 count toward the
    // robots threshold, the count the geo×category sitemap thresholds on.
    const { deps } = makeDeps({
      items: [
        makeEvent({ id: "open-1" }),
        makeEvent({ id: "open-2" }),
        makeEvent({ id: "gated-1", gateType: "PASSWORD" }),
      ],
      total: 3,
      indexableTotal: 2,
    });

    const result = await listEventsByCategoryAndCity(deps, {
      categorySlug: "open-mics",
      citySegment: "nashville-tn",
    });

    expect(result.events.map((e) => e.id)).toEqual([
      "open-1",
      "open-2",
      "gated-1",
    ]);
    expect(result.events[2]!.gateType).toBe("PASSWORD");
    expect(result.total).toBe(3);
    expect(result.indexableTotal).toBe(2);
  });

  it("throws CATEGORY_NOT_FOUND when the category is missing", async () => {
    const { deps } = makeDeps({ category: null });
    await expect(
      listEventsByCategoryAndCity(deps, {
        categorySlug: "nope",
        citySegment: "nashville-tn",
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
  });

  it("throws CATEGORY_NOT_FOUND when the category is inactive", async () => {
    const { deps } = makeDeps({ category: { ...CATEGORY, active: false } });
    await expect(
      listEventsByCategoryAndCity(deps, {
        categorySlug: "open-mics",
        citySegment: "nashville-tn",
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
  });

  it("decodes the city segment and passes citySlug + region to the repo", async () => {
    const { deps, listPublishedByCategoryAndCity } = makeDeps({
      items: [makeEvent()],
      total: 1,
    });

    await listEventsByCategoryAndCity(deps, {
      categorySlug: "open-mics",
      citySegment: "san-jose-ca",
    });

    const args = listPublishedByCategoryAndCity.mock.calls[0][0];
    expect(args).toMatchObject({
      categorySlug: "open-mics",
      citySlug: "san-jose",
      region: "ca",
    });
    expect(args.startsAfter).toBeInstanceOf(Date);
  });

  it("retries region-less when a false-split region yields 0 events", async () => {
    // "foo-ba" false-splits into citySlug "foo" + region "ba". The first
    // (region-scoped) fetch is empty; the retry treats the whole segment as the
    // city slug with no region and finds the event.
    const getBySlug = vi.fn(async () => CATEGORY);
    const listPublishedByCategoryAndCity = vi
      .fn()
      .mockResolvedValueOnce({
        ...buildOffsetPaginatedResult({
          items: [],
          total: 0,
          limit: 48,
          offset: 0,
        }),
        indexableTotal: 0,
      })
      .mockResolvedValueOnce({
        ...buildOffsetPaginatedResult({
          items: [makeEvent({ id: "foo-ba-1", locality: "Foo Ba" })],
          total: 1,
          limit: 48,
          offset: 0,
        }),
        indexableTotal: 1,
      });
    const listTicketTypesForEventIds = vi.fn(async () => []);
    const deps = {
      repos: {
        categories: { getBySlug },
        events: { listPublishedByCategoryAndCity, listTicketTypesForEventIds },
      },
      clock: testClock,
    } as any;

    const result = await listEventsByCategoryAndCity(deps, {
      categorySlug: "open-mics",
      citySegment: "foo-ba",
    });

    expect(listPublishedByCategoryAndCity).toHaveBeenCalledTimes(2);
    expect(listPublishedByCategoryAndCity.mock.calls[0][0]).toMatchObject({
      citySlug: "foo",
      region: "ba",
    });
    expect(listPublishedByCategoryAndCity.mock.calls[1][0]).toMatchObject({
      citySlug: "foo-ba",
      region: null,
    });
    expect(result.total).toBe(1);
    // The false-split "ba" is dropped; the one match's own region (TN, the
    // fixture default) becomes the canonical region → "foo-ba-tn".
    expect(result.regionCode).toBe("tn");
    expect(result.cityLabel).toBe("Foo Ba");
  });

  describe("canonical region for a region-less segment", () => {
    it("resolves the region when every matched event shares one", async () => {
      const { deps, listPublishedByCategoryAndCity } = makeDeps({
        items: [
          makeEvent({ id: "a", regionCode: "TN" }),
          makeEvent({ id: "b", regionCode: "tn" }),
        ],
        total: 2,
      });

      const result = await listEventsByCategoryAndCity(deps, {
        categorySlug: "open-mics",
        citySegment: "nashville",
      });

      expect(result.regionCode).toBe("tn");
      // Every match was on the page: no extra count query.
      expect(listPublishedByCategoryAndCity).toHaveBeenCalledTimes(1);
      expect(
        deps.repos.events.countPublishedByCategoryAndCityRegionCode,
      ).not.toHaveBeenCalled();
      expect(listPublishedByCategoryAndCity.mock.calls[0][0]).toMatchObject({
        citySlug: "nashville",
        region: null,
      });
    });

    it("stays null when the matches span several regions (Portland OR + ME)", async () => {
      const { deps } = makeDeps({
        items: [
          makeEvent({ id: "or", locality: "Portland", regionCode: "or" }),
          makeEvent({ id: "me", locality: "Portland", regionCode: "me" }),
        ],
        total: 2,
      });

      const result = await listEventsByCategoryAndCity(deps, {
        categorySlug: "open-mics",
        citySegment: "portland",
      });

      expect(result.regionCode).toBeNull();
      expect(result.total).toBe(2);
    });

    it("stays null when any match carries no region code", async () => {
      const { deps } = makeDeps({
        items: [
          makeEvent({ id: "a", regionCode: "tn" }),
          { ...makeEvent({ id: "b" }), regionCode: null },
        ],
        total: 2,
      });

      const result = await listEventsByCategoryAndCity(deps, {
        categorySlug: "open-mics",
        citySegment: "nashville",
      });

      expect(result.regionCode).toBeNull();
    });

    it("stays null for a region code that cannot form a 2-letter segment", async () => {
      const { deps } = makeDeps({
        items: [makeEvent({ id: "a", locality: "Sydney", regionCode: "nsw" })],
        total: 1,
      });

      const result = await listEventsByCategoryAndCity(deps, {
        categorySlug: "open-mics",
        citySegment: "sydney",
      });

      expect(result.regionCode).toBeNull();
    });

    // The page holds 1 of 3 matches (TN); the strict regionCode count decides.
    function pagedDeps(strictTotal: number) {
      const { deps, listPublishedByCategoryAndCity } = makeDeps({
        items: [makeEvent({ id: "a", regionCode: "tn" })],
        total: 3,
      });
      const countPublishedByCategoryAndCityRegionCode = vi.fn(
        async () => strictTotal,
      );
      deps.repos.events.countPublishedByCategoryAndCityRegionCode =
        countPublishedByCategoryAndCityRegionCode;
      return {
        deps,
        listPublishedByCategoryAndCity,
        countPublishedByCategoryAndCityRegionCode,
      };
    }

    it("proves an off-page remainder with one strict regionCode count", async () => {
      const {
        deps,
        listPublishedByCategoryAndCity,
        countPublishedByCategoryAndCityRegionCode,
      } = pagedDeps(3);

      const result = await listEventsByCategoryAndCity(deps, {
        categorySlug: "open-mics",
        citySegment: "nashville",
      });

      expect(result.regionCode).toBe("tn");
      // A count, not a second list call.
      expect(listPublishedByCategoryAndCity).toHaveBeenCalledTimes(1);
      expect(countPublishedByCategoryAndCityRegionCode).toHaveBeenCalledTimes(1);
      expect(countPublishedByCategoryAndCityRegionCode).toHaveBeenCalledWith({
        categorySlug: "open-mics",
        citySlug: "nashville",
        regionCode: "tn",
        // Same instant as the page query.
        startsAfter: listPublishedByCategoryAndCity.mock.calls[0][0].startsAfter,
      });
    });

    it("stays null when an off-page match sits in another region", async () => {
      const { deps } = pagedDeps(2);

      const result = await listEventsByCategoryAndCity(deps, {
        categorySlug: "open-mics",
        citySegment: "nashville",
      });

      expect(result.regionCode).toBeNull();
    });

    it("stays null when off-page matches have a NULL code and only a free-text region", async () => {
      // Page 1: TN-coded. Beyond it: 2 rows with regionCode NULL and
      // region "TN" in free text. The sitemap lists those as a region-less
      // "nashville" group, so "nashville" must stay its own canonical page.
      // The strict count sees only the coded row (1 of 3).
      const { deps } = pagedDeps(1);

      const result = await listEventsByCategoryAndCity(deps, {
        categorySlug: "open-mics",
        citySegment: "nashville",
      });

      expect(result.regionCode).toBeNull();
    });

    it("preserves an explicit region without a second query", async () => {
      const { deps, listPublishedByCategoryAndCity } = makeDeps({
        items: [makeEvent({ id: "a", regionCode: "tn" })],
        total: 1,
      });

      const result = await listEventsByCategoryAndCity(deps, {
        categorySlug: "open-mics",
        citySegment: "Nashville-TN",
      });

      expect(result.regionCode).toBe("tn");
      expect(listPublishedByCategoryAndCity).toHaveBeenCalledTimes(1);
      expect(
        deps.repos.events.countPublishedByCategoryAndCityRegionCode,
      ).not.toHaveBeenCalled();
    });

    it("leaves an empty page's region null", async () => {
      const { deps, listPublishedByCategoryAndCity } = makeDeps({
        items: [],
        total: 0,
      });

      const result = await listEventsByCategoryAndCity(deps, {
        categorySlug: "open-mics",
        citySegment: "nashville",
      });

      expect(result.regionCode).toBeNull();
      expect(listPublishedByCategoryAndCity).toHaveBeenCalledTimes(1);
    });
  });

  it("includes community/ownerless listings and preserves the real city casing", async () => {
    const communityEvent = makeEvent({
      id: "community-1",
      humanId: null,
      orgId: null,
      stewardship: "COMMUNITY",
      locality: "Nashville",
      title: "Ownerless Community Open Mic",
    });
    const { deps } = makeDeps({ items: [communityEvent], total: 1 });

    const result = await listEventsByCategoryAndCity(deps, {
      categorySlug: "open-mics",
      citySegment: "nashville-tn",
    });

    expect(result.total).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("community-1");
    expect(result.categoryName).toBe("Open Mics");
    expect(result.names).toEqual({
      en: "Open Mics",
      es: "Micrófonos abiertos",
    });
    expect(result.cityLabel).toBe("Nashville");
    expect(result.regionCode).toBe("tn");
    // Ownerless RSVP listings have no ticket types → null pricing rollup, but
    // carry attendanceMode "RSVP" so the mapper can render "Free".
    expect(result.events[0].pricing).toBeNull();
    expect(result.events[0].attendanceMode).toBe("RSVP");
    // Single-date listing (no recurrence schedule) is not recurring.
    expect(result.events[0].isRecurring).toBe(false);
  });

  it("flags a recurring listing when the event carries a recurrence schedule", async () => {
    const recurringEvent = makeEvent({
      id: "recurring-1",
      title: "Weekly Open Mic",
      recurrenceSchedule: { kind: "RRULE", rrule: "FREQ=WEEKLY" },
    });
    const { deps } = makeDeps({ items: [recurringEvent], total: 1 });

    const result = await listEventsByCategoryAndCity(deps, {
      categorySlug: "open-mics",
      citySegment: "nashville-tn",
    });

    expect(result.events[0].id).toBe("recurring-1");
    expect(result.events[0].isRecurring).toBe(true);
  });

  it("attaches a paid pricing rollup from ACTIVE ticket types", async () => {
    const { deps } = makeDeps({
      items: [makeEvent({ id: "paid-1", attendanceMode: "TICKETED" })],
      total: 1,
      ticketTypes: [
        { eventId: "paid-1", status: "ACTIVE", priceCents: 2500 },
        { eventId: "paid-1", status: "ACTIVE", priceCents: 4000 },
        // Non-ACTIVE tiers are ignored.
        { eventId: "paid-1", status: "DRAFT", priceCents: 500 },
      ],
    });

    const result = await listEventsByCategoryAndCity(deps, {
      categorySlug: "open-mics",
      citySegment: "nashville-tn",
    });

    expect(result.events[0].pricing).toEqual({
      hasFreeTier: false,
      hasPayWhatYouWantTier: false,
      paidTierCount: 2,
      minPaidPriceCents: 2500,
      // Unstamped and no venue rate ⇒ quoted at 0% (as the event page does);
      // no fee policy ⇒ the all-in figure equals the face here.
      lowestBuyerTotalCents: 2500,
    });
  });

  it("marks a free ticket type as a free tier in the pricing rollup", async () => {
    const { deps } = makeDeps({
      items: [makeEvent({ id: "free-1", attendanceMode: "TICKETED" })],
      total: 1,
      ticketTypes: [{ eventId: "free-1", status: "ACTIVE", priceCents: 0 }],
    });

    const result = await listEventsByCategoryAndCity(deps, {
      categorySlug: "open-mics",
      citySegment: "nashville-tn",
    });

    expect(result.events[0].pricing).toEqual({
      hasFreeTier: true,
      hasPayWhatYouWantTier: false,
      paidTierCount: 0,
      minPaidPriceCents: null,
      lowestBuyerTotalCents: null,
    });
  });

  it("falls back to a title-cased city label when the page is empty", async () => {
    const { deps } = makeDeps({ items: [], total: 0 });

    const result = await listEventsByCategoryAndCity(deps, {
      categorySlug: "open-mics",
      citySegment: "san-jose-ca",
    });

    expect(result.events).toHaveLength(0);
    expect(result.cityLabel).toBe("San Jose");
    expect(result.regionCode).toBe("ca");
  });

  // ── Hero moderation gate (FR-005) ──────────────────────────────────────
  const HERO_KEY = "events/e/images/hero.png";
  const HERO_URL = "https://cdn.example/events/e/images/hero.png";
  const heroEvent = () =>
    makeEvent({
      heroImageUrl: HERO_URL,
      heroImageKey: HERO_KEY,
    } as Partial<EventRecord>);

  it("shows an APPROVED hero and batches one resolveByKeys call", async () => {
    const { deps, resolveByKeys } = makeDeps({
      items: [heroEvent()],
      total: 1,
      statusByKey: { [HERO_KEY]: "APPROVED" },
    });
    const result = await listEventsByCategoryAndCity(deps, {
      categorySlug: "open-mics",
      citySegment: "nashville-tn",
    });
    expect(result.events[0].heroImageUrl).toBe(HERO_URL);
    expect(resolveByKeys).toHaveBeenCalledTimes(1);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits a %s hero",
    async (status) => {
      const { deps } = makeDeps({
        items: [heroEvent()],
        total: 1,
        statusByKey: { [HERO_KEY]: status },
      });
      const result = await listEventsByCategoryAndCity(deps, {
        categorySlug: "open-mics",
        citySegment: "nashville-tn",
      });
      expect(result.events[0].heroImageUrl).toBeNull();
    },
  );

  it("shows a legacy hero with NO moderation record", async () => {
    const { deps } = makeDeps({ items: [heroEvent()], total: 1 });
    const result = await listEventsByCategoryAndCity(deps, {
      categorySlug: "open-mics",
      citySegment: "nashville-tn",
    });
    expect(result.events[0].heroImageUrl).toBe(HERO_URL);
  });
});

describeCardVenueName({
  makeEvent: () => makeEvent(),
  cardPlaceName: async (event, place) => {
    const { deps } = makeDeps({ items: [event], total: 1 });
    deps.repos.places = { getById: vi.fn(async () => place) };
    const result = await listEventsByCategoryAndCity(deps, {
      categorySlug: "open-mics",
      citySegment: "nashville-tn",
    });
    return result.events[0].placeName;
  },
});

// The transport mapper formats the card date in this zone; without it a UTC
// server printed a 7pm Chicago show as the next day (prod, 2026-10-13).
describe("listEventsByCategoryAndCity carries the event's timezone", () => {
  it("returns Event.timezone, and the platform default for an unknown or absent zone", async () => {
    const { deps } = makeDeps({
      items: [
        { ...makeEvent({ id: "evt-la" }), timezone: "America/Los_Angeles" },
        { ...makeEvent({ id: "evt-bad" }), timezone: "Mars/Olympus_Mons" },
        makeEvent({ id: "evt-none" }),
      ],
      total: 3,
    });

    const result = await listEventsByCategoryAndCity(deps, {
      categorySlug: "open-mics",
      citySegment: "nashville-tn",
    });

    expect(result.events.map((e) => e.timezone)).toEqual([
      "America/Los_Angeles",
      "America/Chicago",
      "America/Chicago",
    ]);
  });
});
