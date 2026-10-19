import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { buildOffsetPaginatedResult } from "@th/ports";
import type {
  EventGateType,
  EventRecord,
  EventVisibility,
  Repos,
  WaitlistStatus,
} from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import type { ImageModerationStatus } from "@th/types/repos/image-moderation-records";

import {
  listEventsByCountry,
  type ListEventsByCountryDeps,
} from "../list-events-by-country";
import { describeCardVenueName } from "./_card-venue-name-cases";

const eventFactory = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  id: overrides.id ?? "evt_1",
  orgId: overrides.orgId ?? randomUUID(),
  humanId: overrides.humanId ?? null,
  title: overrides.title ?? "Nashville Demo Show",
  status: overrides.status ?? "PUBLISHED",
  visibility: overrides.visibility ?? ("PUBLIC" as EventVisibility),
  gateType: overrides.gateType ?? ("NONE" as EventGateType),
  locationMode: overrides.locationMode ?? "EXACT",
  locationRadiusMeters: overrides.locationRadiusMeters ?? null,
  locationLabel: overrides.locationLabel ?? null,
  startsAt: overrides.startsAt ?? new Date("2025-01-01T02:00:00.000Z"),
  endsAt: overrides.endsAt ?? null,
  placeId: overrides.placeId ?? null,
  savedLocationId: overrides.savedLocationId ?? null,
  categoryId: overrides.categoryId ?? null,
  addressText: overrides.addressText ?? "123 Broadway",
  lat: overrides.lat ?? null,
  lng: overrides.lng ?? null,
  slug: overrides.slug ?? "nashville-demo-show",
  shortId: overrides.shortId ?? "abcd",
  regionCode: overrides.regionCode ?? "tn-nsh",
  publishedAt: overrides.publishedAt ?? new Date("2024-12-01T12:00:00.000Z"),
  agreementPrimaryId: overrides.agreementPrimaryId ?? randomUUID(),
  agreementResaleId: overrides.agreementResaleId ?? null,
  defaultLocale: overrides.defaultLocale ?? "en-US",
  listingPriority: overrides.listingPriority ?? null,
  passwordHash: overrides.passwordHash ?? null,
  passwordUpdatedAt: overrides.passwordUpdatedAt ?? null,
  waitlistStatus: overrides.waitlistStatus ?? ("CLOSED" as WaitlistStatus),
  waitlistPublishAt: overrides.waitlistPublishAt ?? null,
  waitlistDescription: overrides.waitlistDescription ?? null,
  waitlistCap: overrides.waitlistCap ?? null,
  payoutTermsId: overrides.payoutTermsId ?? null,
  resalePayoutTermsId: overrides.resalePayoutTermsId ?? null,
  placeLayoutId: overrides.placeLayoutId ?? null,
  currency: null,
  heroImageUrl: overrides.heroImageUrl ?? null,
  heroImageKey: overrides.heroImageKey ?? null,
});

const makeDeps = (
  events: EventRecord[] = [eventFactory()],
  overrides: Partial<ListEventsByCountryDeps> = {},
  statusByKey: Record<string, ImageModerationStatus> = {},
): ListEventsByCountryDeps & { resolveByKeys: ReturnType<typeof vi.fn> } => {
  const gate = makeImageModerationGateFake(statusByKey);
  const repos = {
    events: {
      listPublishedByCountry: vi.fn(async () =>
        buildOffsetPaginatedResult({
          items: events,
          total: events.length,
          limit: events.length === 0 ? 1 : events.length,
          offset: 0,
        }),
      ),
      // The use case now loads the tier rollup so its cards can quote a real
      // price instead of "See details". No tiers here: every event in these
      // fixtures gets no map entry, which is the documented "unknown" case.
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    imageModerationRecords: gate.imageModerationRecords,
  } as unknown as Repos;

  return {
    repos,
    clock: overrides.clock ?? { now: () => new Date("2026-01-01T00:00:00Z") },
    logger: overrides.logger ?? createTestLogger(),
    resolveByKeys: gate.imageModerationRecords.resolveByKeys,
  };
};

describe("listEventsByCountry", () => {
  it("normalizes countryCode and returns mapped summaries", async () => {
    const deps = makeDeps();

    const result = await listEventsByCountry(deps, {
      countryCode: " us ",
      limit: 5,
      offset: 2,
    });

    expect(deps.repos.events.listPublishedByCountry).toHaveBeenCalledWith({
      countryCode: "US",
      limit: 5,
      offset: 2,
      startsAfter: expect.any(Date),
      includeTotal: false,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: "evt_1",
      title: "Nashville Demo Show",
      countryCode: null,
      regionCode: "tn-nsh",
      slug: "nashville-demo-show",
    });
  });

  // Regression guard for docs/records/2026-08-25-db-load.md item 3. This use case
  // returns `{ events }` only, so the second COUNT(*) the repo used to issue
  // alongside the page query was 12,360 queries/week nobody could read — 7.7%
  // of all production SQL. If a future change starts reading `pageInfo`, flip
  // this back deliberately rather than letting the count creep in silently.
  it("does not ask the repo for a total it cannot return", async () => {
    const deps = makeDeps();

    await listEventsByCountry(deps, { countryCode: "US", limit: 5 });

    const call = vi.mocked(deps.repos.events.listPublishedByCountry).mock
      .calls[0][0];
    expect(call.includeTotal).toBe(false);
  });

  it("asks for events after the injected clock's now, not the wall clock", async () => {
    const deps = makeDeps([], {
      clock: { now: () => new Date("2030-05-05T00:00:00Z") },
    });
    await listEventsByCountry(deps, { countryCode: "US" });
    expect(
      vi.mocked(deps.repos.events.listPublishedByCountry).mock.calls[0][0]
        .startsAfter,
    ).toEqual(new Date("2030-05-05T00:00:00Z"));
  });

  it("logs query metadata", async () => {
    const logger = createTestLogger();
    const deps = makeDeps([], { logger });

    await listEventsByCountry(deps, { countryCode: "CA", limit: 3 });

    expect(logger.info).toHaveBeenCalledWith(
      "events.list_by_country",
      expect.objectContaining({
        countryCode: "CA",
        limit: 3,
      }),
    );
  });

  // ── Hero moderation gate (FR-005) ──────────────────────────────────────
  const HERO_KEY = "events/e/images/hero.png";
  const HERO_URL = "https://cdn.example/events/e/images/hero.png";
  const heroEvent = () =>
    eventFactory({ heroImageUrl: HERO_URL, heroImageKey: HERO_KEY });

  it("shows an APPROVED hero and batches one resolveByKeys call", async () => {
    const deps = makeDeps([heroEvent()], {}, { [HERO_KEY]: "APPROVED" });
    const result = await listEventsByCountry(deps, { countryCode: "US" });
    expect(result.events[0].heroImageUrl).toBe(HERO_URL);
    expect(deps.resolveByKeys).toHaveBeenCalledTimes(1);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits a %s hero",
    async (status) => {
      const deps = makeDeps([heroEvent()], {}, { [HERO_KEY]: status });
      const result = await listEventsByCountry(deps, { countryCode: "US" });
      expect(result.events[0].heroImageUrl).toBeNull();
    },
  );

  it("shows a legacy hero with NO moderation record", async () => {
    const deps = makeDeps([heroEvent()], {}, {});
    const result = await listEventsByCountry(deps, { countryCode: "US" });
    expect(result.events[0].heroImageUrl).toBe(HERO_URL);
  });

  // ── Optional whole-result cache ────────────────────────────────────────
  describe("with a cache", () => {
    const mapCache = () => {
      const store = new Map<string, unknown>();
      const getOrLoad = vi.fn(async <T,>(key: string, load: () => Promise<T>) => {
        if (store.has(key)) return store.get(key) as T;
        const value = await load();
        store.set(key, value);
        return value;
      });
      return { getOrLoad, clear: () => store.clear() };
    };

    it("serves a repeat of the same input without touching the repos", async () => {
      const deps = makeDeps();
      const cache = mapCache();

      const first = await listEventsByCountry(
        { ...deps, cache },
        { countryCode: "US", limit: 12 },
      );
      const second = await listEventsByCountry(
        { ...deps, cache },
        { countryCode: " us ", limit: 12 },
      );

      expect(second).toBe(first);
      expect(deps.repos.events.listPublishedByCountry).toHaveBeenCalledTimes(1);
      expect(
        deps.repos.events.listTicketTypesForEventIds,
      ).toHaveBeenCalledTimes(1);
    });

    it("keys on every input that changes the answer", async () => {
      const deps = makeDeps();
      const cache = mapCache();
      const run = (input: Record<string, unknown>) =>
        listEventsByCountry({ ...deps, cache }, input);

      await run({ countryCode: "US", limit: 12 });
      await run({ countryCode: "US", limit: 6 });
      await run({ countryCode: "CA", limit: 12 });
      await run({ countryCode: "US", limit: 12 });

      expect(deps.repos.events.listPublishedByCountry).toHaveBeenCalledTimes(3);
      expect(new Set(cache.getOrLoad.mock.calls.map(([k]) => k)).size).toBe(3);
    });

    it.each([
      ["a later page", { countryCode: "US", limit: 12, offset: 12 }],
      ["a non-country string", { countryCode: "USA", limit: 12 }],
      ["junk", { countryCode: "x'; --", limit: 12 }],
    ])("never caches %s", async (_label, input) => {
      const deps = makeDeps();
      const cache = mapCache();

      await listEventsByCountry({ ...deps, cache }, input);
      await listEventsByCountry({ ...deps, cache }, input);

      expect(cache.getOrLoad).not.toHaveBeenCalled();
      expect(deps.repos.events.listPublishedByCountry).toHaveBeenCalledTimes(2);
    });

    it("returns a degraded load (swallowed venue-read failure) but does not cache it", async () => {
      const reportError = vi.fn();
      const deps = makeDeps([eventFactory({ placeId: "place-1" })], {
        reportError,
      });
      const places = {
        getById: vi
          .fn()
          .mockRejectedValueOnce(new Error("db blip"))
          .mockResolvedValue(null),
      };
      (deps.repos as unknown as { places: typeof places }).places = places;
      const cache = mapCache();

      const first = await listEventsByCountry(
        { ...deps, reportError, cache },
        { countryCode: "US", limit: 12 },
      );
      expect(first.events).toHaveLength(1);
      expect(reportError).toHaveBeenCalledTimes(1);

      // Not stored: the next request loads again (and, healthy, is cached).
      await listEventsByCountry(
        { ...deps, reportError, cache },
        { countryCode: "US", limit: 12 },
      );
      await listEventsByCountry(
        { ...deps, reportError, cache },
        { countryCode: "US", limit: 12 },
      );
      expect(deps.repos.events.listPublishedByCountry).toHaveBeenCalledTimes(2);
    });

    it("a failed all-in price read degrades to null totals, reports, and is not cached", async () => {
      const reportError = vi.fn();
      const deps = makeDeps(
        [{ ...eventFactory(), admissionTaxRateBps: 0 } as EventRecord],
        { reportError },
      );
      const repos = deps.repos as unknown as Record<string, unknown> & {
        events: { listTicketTypesForEventIds: ReturnType<typeof vi.fn> };
      };
      repos.events.listTicketTypesForEventIds = vi.fn(async () => [
        {
          eventId: "evt_1",
          id: "tt-1",
          name: "GA",
          priceCents: 2500,
          pricingMode: "FIXED",
          minimumCents: null,
          status: "ACTIVE",
          salesOpenAt: null,
          salesCloseAt: null,
        },
      ]);
      Object.assign(repos, {
        places: { getById: vi.fn(async () => null) },
        savedLocations: { getById: vi.fn(async () => null) },
        payoutTerms: {
          listByEventIds: vi
            .fn()
            .mockRejectedValueOnce(new Error("db blip"))
            .mockResolvedValue(new Map()),
        },
        feePolicies: {
          resolveEffective: vi.fn(async () => null),
          resolveEffectiveForScopes: vi.fn(async () => new Map()),
        },
      });
      const cache = mapCache();
      const input = { countryCode: "US", limit: 12 };

      const first = await listEventsByCountry({ ...deps, reportError, cache }, input);
      // The listing survives; the paid card has no all-in figure (never the face).
      expect(first.events[0]?.pricing).toMatchObject({
        paidTierCount: 1,
        minPaidPriceCents: 2500,
        lowestBuyerTotalCents: null,
      });
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tags: { useCase: "listEventsByCountry", step: "loadListingBuyerTotals" },
        extra: { eventCount: 1 },
      });

      // Not cached: the healthy retry computes the figure (no policy, 0% ⇒ face).
      const second = await listEventsByCountry({ ...deps, reportError, cache }, input);
      expect(second.events[0]?.pricing?.lowestBuyerTotalCents).toBe(2500);
      expect(deps.repos.events.listPublishedByCountry).toHaveBeenCalledTimes(2);
    });

    it("still validates input before consulting the cache", async () => {
      const deps = makeDeps();
      const cache = mapCache();
      await expect(
        listEventsByCountry({ ...deps, cache }, { countryCode: "" }),
      ).rejects.toBeTruthy();
      expect(cache.getOrLoad).not.toHaveBeenCalled();
    });
  });
});

describeCardVenueName({
  makeEvent: () => eventFactory(),
  cardPlaceName: async (event, place) => {
    const deps = makeDeps([event]);
    (deps.repos as unknown as { places: unknown }).places = {
      getById: vi.fn(async () => place),
    };
    const result = await listEventsByCountry(deps, {
      countryCode: "US",
      limit: 5,
    });
    return result.events[0]!.placeName;
  },
});

// The transport mapper formats the card date in this zone; without it a UTC
// server printed a 7pm Chicago show as the next day (prod, 2026-10-13).
describe("listEventsByCountry carries the event's timezone", () => {
  it("returns Event.timezone, and the platform default for an unknown or absent zone", async () => {
    const deps = makeDeps([
      { ...eventFactory({ id: "evt-la" }), timezone: "America/Los_Angeles" },
      { ...eventFactory({ id: "evt-bad" }), timezone: "Mars/Olympus_Mons" },
      eventFactory({ id: "evt-none" }),
    ]);

    const result = await listEventsByCountry(deps, { countryCode: "US" });

    expect(result.events.map((e) => e.timezone)).toEqual([
      "America/Los_Angeles",
      "America/Chicago",
      "America/Chicago",
    ]);
  });
});
