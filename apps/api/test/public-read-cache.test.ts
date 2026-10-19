import { describe, expect, it, vi } from "vitest";

import {
  appRouter,
  authedProcedure,
  optionalProcedure,
  router,
  type Ctx,
} from "@th/trpc";
import {
  createCacheGeneration,
  type CacheGenerationStore,
} from "@th/adapters/decorators/cache-generation";
import { createTtlReadThroughCache } from "@th/adapters/decorators/ttl-read-through-cache";
import { withPublicReadBumpOnIndexWrites } from "@th/adapters/decorators/with-public-read-bump-on-search-writes";
import { buildOffsetPaginatedResult } from "@th/ports";
import { ok } from "@th/ports/search";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

/**
 * End-to-end over the REAL pieces the API composes (`dep.ts`): the real
 * `events.countryEvents` / `search.featuredEvents` procedures and use cases,
 * the real discovery cache, the real generation with its per-cache reader,
 * the real post-auth mutation middleware, and the real index-write decorator.
 * Only the database, the search index and Redis are fakes — one of each,
 * shared by two "API instances" and a "jobs process", as in production.
 */

const MEMO_MS = 10_000;
const TTL_MS = 15 * 60_000;
const STREET = "123 Main St, Nashville, TN 37203";
const ACTOR = "11111111-1111-4111-8111-111111111111";

function makeWorld() {
  let clock = 1_000_000;
  const now = () => clock;

  // ── The database ────────────────────────────────────────────────────────
  const place = {
    id: "place-1",
    name: "The Basement",
    locationMode: "EXACT" as "EXACT" | "OBSCURED",
    locationRadiusMeters: null as number | null,
    locationLabel: "East Nashville",
    city: "Nashville",
    region: "TN",
    countryCode: "US",
    orgIdsWithAccess: [] as string[],
    humanIdsWithAccess: [] as string[],
    acceptsCommunityListings: false,
  };
  const event = {
    id: "evt-1",
    orgId: "org-1",
    title: "Late Show",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    startsAt: new Date("2031-01-01T02:00:00Z"),
    endsAt: null,
    placeId: place.id,
    addressText: STREET,
    locality: "Nashville",
    region: "TN",
    countryCode: "US",
    regionCode: "TN",
    slug: "late-show",
    heroImageUrl: null,
    heroImageKey: null,
    attendanceMode: "TICKETED",
  };
  const listPublishedByCountry = vi.fn(async () =>
    buildOffsetPaginatedResult({
      items: [{ ...event }],
      total: 1,
      limit: 12,
      offset: 0,
    }),
  );
  const repos = {
    events: {
      listPublishedByCountry,
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
    places: { getById: vi.fn(async () => ({ ...place })) },
  };

  // ── The search index (written LATER than the database, by reindexers) ──
  const indexDoc = { subtitle: "The Basement" as string | null };
  const autocomplete = vi.fn(async () =>
    ok({
      suggestions: [
        {
          type: "event" as const,
          id: "event_evt-1",
          eventId: "evt-1",
          title: "Late Show",
          subtitle: indexDoc.subtitle,
          helper: null,
          confidence: 1,
          slug: "late-show",
          startsAt: new Date("2031-01-01T02:00:00Z"),
          imageUrl: null,
          lowestPriceCents: null,
          lowestBuyerTotalCents: null,
          currency: null,
          paidTierCount: 0,
          hasFreeTier: false,
        },
      ],
      latencyMs: 3,
    }),
  );
  const rawSearch = {
    autocomplete,
    upsertDocuments: vi.fn(async (input: { subtitle: string | null }) => {
      indexDoc.subtitle = input.subtitle;
      return ok({ indexed: 1 });
    }),
    deleteDocuments: vi.fn(async () => ok({ deleted: 0 })),
    getStats: vi.fn(),
    ensureIndexes: vi.fn(),
  } as unknown as MultiSearchPort;

  // ── Redis ───────────────────────────────────────────────────────────────
  let counter = 7_000_000;
  let redisDown = false;
  const redisStore: CacheGenerationStore = {
    read: vi.fn(async () => {
      if (redisDown) throw new Error("ECONNREFUSED");
      return String(counter);
    }),
    bump: vi.fn(async () => {
      if (redisDown) throw new Error("ECONNREFUSED");
      counter += 1;
      return String(counter);
    }),
  };

  const reportError = vi.fn();
  const logger = {
    child: () => logger,
    withTime: (_n: string, f: () => Promise<unknown>) => f(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  /** One process's generation + (for API instances) its caches. */
  const makeInstance = () => {
    const generation = createCacheGeneration({
      store: redisStore,
      now,
      reportError,
    });
    const discoveryGeneration = generation.reader(MEMO_MS);
    const publicDiscoveryCache = createTtlReadThroughCache({
      name: "public-discovery",
      ttlMs: TTL_MS,
      generation: discoveryGeneration,
      staleIfErrorMs: 0,
      now,
      reportError,
    });
    const multiSearch = withPublicReadBumpOnIndexWrites(rawSearch, generation);
    const baseCtx = {
      repos,
      multiSearch,
      clock: { now: () => new Date(clock) },
      logger,
      reportError,
      authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
      // Rate-limit backend absent: the default limiter fails open.
      rateLimit: undefined,
      publicDiscoveryCache,
      publicReadGeneration: discoveryGeneration,
      auth: null,
      authToken: null,
      apiKey: null,
      actorHumanId: null,
      viewerLocation: null,
      clientIp: "203.0.113.9",
      userAgent: "vitest",
      cookieHeader: null,
    } as unknown as Ctx;

    /** What the home page's SSR asks for. */
    const homepage = async () => {
      const { events } = await appRouter
        .createCaller(baseCtx)
        .events.countryEvents({ countryCode: "US", limit: 12 });
      return events[0]?.venue ?? null;
    };
    const featured = async () => {
      const { events } = await appRouter
        .createCaller(baseCtx)
        .search.featuredEvents({ regionCode: "TN", limit: 12 });
      return events[0]?.venue ?? null;
    };

    /**
     * Stand-ins for real mutations, on the REAL procedure chains, so the
     * real post-auth middleware runs. `withholdVenueAddress` changes the
     * database only — its search document is rewritten later by a reindexer.
     */
    const writes = router({
      withholdVenueAddress: authedProcedure.mutation(async () => {
        place.locationMode = "OBSCURED";
        place.locationRadiusMeters = 800;
        return true;
      }),
      anonymousWrite: optionalProcedure.mutation(async () => {
        place.locationMode = "OBSCURED";
        return true;
      }),
    });
    const actorWrite = () =>
      writes
        .createCaller({
          ...baseCtx,
          authToken: "owner-jwt",
          actorHumanId: ACTOR,
        } as Ctx)
        .withholdVenueAddress();
    const anonymousWrite = () => writes.createCaller(baseCtx).anonymousWrite();

    return { homepage, featured, actorWrite, anonymousWrite, multiSearch };
  };

  return {
    a: makeInstance(),
    b: makeInstance(),
    /** The jobs process: bump-only, writes the index. */
    jobs: makeInstance(),
    listPublishedByCountry,
    autocomplete,
    reportError,
    counter: () => counter,
    advance: (ms: number) => (clock += ms),
    setRedisDown: (down: boolean) => (redisDown = down),
  };
}

describe("public read cache — end to end", () => {
  it("repeat anonymous home-page reads within the TTL do not touch the database", async () => {
    const w = makeWorld();
    for (let i = 0; i < 20; i++) {
      expect(await w.a.homepage()).toContain("123 Main St");
      expect(await w.a.featured()).toBe("The Basement");
      w.advance(30_000); // 20 renders across 10 minutes
    }
    expect(w.listPublishedByCountry).toHaveBeenCalledTimes(1);
    expect(w.autocomplete).toHaveBeenCalledTimes(1);
  });

  it("a venue withholding its address: the writing instance serves the redacted label on the next read", async () => {
    const w = makeWorld();
    expect(await w.a.homepage()).toContain("123 Main St");

    await w.a.actorWrite();

    expect(await w.a.homepage()).toBe("Nashville, TN");
    expect(w.listPublishedByCountry).toHaveBeenCalledTimes(2);
  });

  it("…and ANOTHER instance serves it within the memo window, not the 15-minute TTL", async () => {
    const w = makeWorld();
    await w.a.homepage();
    expect(await w.b.homepage()).toContain("123 Main St");

    await w.a.actorWrite();
    await vi.waitFor(() => expect(w.counter()).toBe(7_000_001));

    w.advance(MEMO_MS);
    expect(await w.b.homepage()).toBe("Nashville, TN");
  });

  it("index lag: the mutation's bump reloads the OLD document, and the later index write (jobs) bumps again", async () => {
    const w = makeWorld();
    expect(await w.a.featured()).toBe("The Basement");
    expect(await w.b.featured()).toBe("The Basement");

    // The venue's confirmation is withdrawn: the DB changes, the index does
    // not yet (post-commit reindex is fire-and-forget; the drain is delayed).
    await w.a.actorWrite();
    w.advance(MEMO_MS);
    // Both instances reload — and can only get the old document.
    expect(await w.a.featured()).toBe("The Basement");
    expect(await w.b.featured()).toBe("The Basement");
    const loadsBeforeIndexWrite = w.autocomplete.mock.calls.length;

    // Minutes later the jobs drain rewrites the document.
    w.advance(5 * 60_000);
    await w.jobs.multiSearch.upsertDocuments({ subtitle: null } as never);

    // The writer's own bump is what moves the others: after their memo,
    // both show the new document — long before the 15-minute TTL.
    w.advance(MEMO_MS);
    expect(await w.a.featured()).toBe("Place TBA");
    expect(await w.b.featured()).toBe("Place TBA");
    expect(w.autocomplete.mock.calls.length).toBe(loadsBeforeIndexWrite + 2);
  });

  it("an anonymous mutation does not bump (it cannot make anything private)", async () => {
    const w = makeWorld();
    await w.a.homepage();
    await w.a.anonymousWrite();
    // The DB changed but nothing signalled it: still the cached answer —
    // which is what shows the actor's write above is what invalidates.
    expect(await w.a.homepage()).toContain("123 Main St");
    expect(w.listPublishedByCountry).toHaveBeenCalledTimes(1);
  });

  it("Redis down: every read goes to the database and nothing stale is served", async () => {
    const w = makeWorld();
    expect(await w.a.homepage()).toContain("123 Main St");
    w.setRedisDown(true);
    w.advance(MEMO_MS);

    // The write's INCR fails too; it is reported, and the write still succeeds.
    await expect(w.a.actorWrite()).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(w.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { area: "cache-generation", op: "bump" },
        }),
      ),
    );

    // B never saw the bump, but it cannot confirm its generation either:
    // fresh read, redacted.
    expect(await w.b.homepage()).toBe("Nashville, TN");
    expect(await w.a.homepage()).toBe("Nashville, TN");
    const calls = w.listPublishedByCountry.mock.calls.length;
    await w.a.homepage();
    expect(w.listPublishedByCountry).toHaveBeenCalledTimes(calls + 1);
  });

  describe("a privacy write DURING a Redis outage (the INCR fails)", () => {
    it("B served requests during the outage: after recovery its first read advances the epoch — fresh, not the pre-outage entry", async () => {
      const w = makeWorld();
      expect(await w.b.homepage()).toContain("123 Main St"); // cached pre-outage

      w.setRedisDown(true);
      w.advance(MEMO_MS);
      await w.b.homepage(); // B consulted while Redis is down (read fails)
      await w.a.actorWrite(); // A withholds the address; its INCR fails
      const counterDuringOutage = w.counter();

      w.setRedisDown(false);
      w.advance(MEMO_MS);
      // The shared counter did NOT move…
      expect(w.counter()).toBe(counterDuringOutage);
      // …but B must not match its pre-outage entry again.
      expect(await w.b.homepage()).toBe("Nashville, TN");
    });

    it("B saw no traffic during the outage: A's owed INCR goes out with A's next store read, and B follows within its memo", async () => {
      const w = makeWorld();
      expect(await w.b.homepage()).toContain("123 Main St"); // cached pre-outage

      w.setRedisDown(true);
      await w.a.actorWrite(); // INCR fails → owed
      const counterDuringOutage = w.counter();

      w.setRedisDown(false);
      w.advance(MEMO_MS);
      await w.a.homepage(); // any consult of A after recovery
      await vi.waitFor(() =>
        expect(w.counter()).toBe(counterDuringOutage + 1),
      );

      w.advance(MEMO_MS);
      expect(await w.b.homepage()).toBe("Nashville, TN");
    });
  });

  it("a database error is thrown, never answered from a stale entry", async () => {
    const w = makeWorld();
    await w.a.homepage();
    w.advance(TTL_MS);
    w.listPublishedByCountry.mockRejectedValueOnce(new Error("db down"));

    await expect(w.a.homepage()).rejects.toThrow();
  });
});
