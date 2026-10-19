import { beforeEach, describe, expect, it, vi } from "vitest";

import * as eventsUseCases from "@th/core/use-cases/events";
import type { ReadThroughCachePort } from "@th/ports/read-through-cache";
import { ok } from "@th/ports/search";

import type { Ctx } from "../../context";
import {
  authedProcedure,
  optionalProcedure,
  publicProcedure,
  router,
} from "../../init";
import { isAnonymousRequest } from "../../anonymous-request";
import { categoriesRouter } from "../categories";
import { eventsRouter } from "../events";
import { unifiedSearchRouter } from "../unified-search";
import { buildBaseCtx } from "./test-helpers";

/**
 * The home page's discovery reads share one in-process cache. These pin the
 * rule that keeps that safe: only an ANONYMOUS request is ever handed the
 * cache, so nothing resolved for a signed-in caller is stored or served.
 */

const mapCache = () => {
  const store = new Map<string, unknown>();
  const cache: ReadThroughCachePort = {
    getOrLoad: vi.fn(async <T>(key: string, load: () => Promise<T>) => {
      if (store.has(key)) return store.get(key) as T;
      const value = await load();
      store.set(key, value);
      return value;
    }),
    clear: () => store.clear(),
  };
  return cache;
};

const ANON: Partial<Ctx> = {
  auth: null,
  authToken: null,
  apiKey: null,
  actorHumanId: null,
};

const SIGNED_IN: Partial<Ctx> = {
  auth: { userId: "user-1", sessionId: "sess-1", token: "token" },
  authToken: "token",
  actorHumanId: "11111111-1111-4111-8111-111111111111",
};

const callerFor = (
  routerDef: Parameters<typeof router>[0],
  overrides: Partial<Ctx>,
  publicDiscoveryCache: ReadThroughCachePort | null,
) =>
  router(routerDef).createCaller({
    ...buildBaseCtx(overrides),
    publicDiscoveryCache,
  }) as any;

describe("isAnonymousRequest", () => {
  it("is true only when the request carries no identity at all", () => {
    expect(
      isAnonymousRequest({
        auth: null,
        authToken: null,
        apiKey: null,
        actorHumanId: null,
      }),
    ).toBe(true);
  });

  it.each([
    ["a bearer token", { authToken: "t" }],
    ["an API key", { apiKey: "k" }],
    ["a resolved actor", { actorHumanId: "h" }],
    ["upstream auth claims", { auth: { userId: "u" } }],
    ["an upstream session id", { auth: { sessionId: "s" } }],
    ["a gate-unlock cookie", { cookieHeader: "th-theme=dark; th_eu_evt1=123.sig" }],
  ])("is false with %s", (_label, extra) => {
    expect(
      isAnonymousRequest({
        auth: null,
        authToken: null,
        apiKey: null,
        actorHumanId: null,
        ...extra,
      }),
    ).toBe(false);
  });
});

describe("isAnonymousRequest — ordinary cookies", () => {
  it("stays true for theme/consent cookies, which carry no entitlement", () => {
    expect(
      isAnonymousRequest({
        auth: null,
        authToken: null,
        apiKey: null,
        actorHumanId: null,
        cookieHeader: "th-theme=dark; th_consent=1",
      }),
    ).toBe(true);
  });
});

describe("actor mutations bump the public-read generation", () => {
  const bumpRouter = () =>
    router({
      write: authedProcedure.mutation(async () => "ok"),
      failingWrite: authedProcedure.mutation(async () => {
        throw new Error("committed, then idempotency.commit failed");
      }),
      optionalWrite: optionalProcedure.mutation(async () => "ok"),
      publicWrite: publicProcedure.mutation(async () => "ok"),
      read: authedProcedure.query(async () => "ok"),
    });
  const withGeneration = (overrides: Partial<Ctx>) => {
    const bump = vi.fn(async () => undefined);
    const caller = bumpRouter().createCaller({
      ...buildBaseCtx(overrides),
      publicReadGeneration: { current: vi.fn(), bump },
    }) as any;
    return { bump, caller };
  };

  it("bumps after a resolved actor's mutation, with the path as the reason", async () => {
    const { bump, caller } = withGeneration(SIGNED_IN);
    await caller.write();
    await caller.optionalWrite();
    expect(bump.mock.calls).toEqual([["write"], ["optionalWrite"]]);
  });

  it("bumps even when the mutation throws (it may have committed first)", async () => {
    const { bump, caller } = withGeneration(SIGNED_IN);
    await expect(caller.failingWrite()).rejects.toThrow();
    expect(bump).toHaveBeenCalledWith("failingWrite");
  });

  it("does not bump for an anonymous mutation", async () => {
    const { bump, caller } = withGeneration(ANON);
    await caller.optionalWrite();
    await caller.publicWrite();
    expect(bump).not.toHaveBeenCalled();
  });

  it("an unverified Bearer token or a th_eu_* cookie cannot force a bump", async () => {
    // `authn` in the base ctx resolves no provider user: the token is junk.
    const junk = withGeneration({ ...ANON, authToken: "junk.jwt" });
    await junk.caller.optionalWrite();
    await expect(junk.caller.write()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(junk.bump).not.toHaveBeenCalled();

    const cookie = withGeneration({ ...ANON, cookieHeader: "th_eu_evt1=1.sig" });
    await cookie.caller.optionalWrite();
    expect(cookie.bump).not.toHaveBeenCalled();
  });

  it("publicProcedure mutations never bump (they resolve no actor)", async () => {
    const { bump, caller } = withGeneration(SIGNED_IN);
    await caller.publicWrite();
    expect(bump).not.toHaveBeenCalled();
  });

  it("does not bump for a query", async () => {
    const { bump, caller } = withGeneration(SIGNED_IN);
    await caller.read();
    expect(bump).not.toHaveBeenCalled();
  });

  it("a generation port that rejects or throws never fails the mutation, and the swallow is reported", async () => {
    const reportError = vi.fn();
    const rejecting = bumpRouter().createCaller({
      ...buildBaseCtx({ ...SIGNED_IN, reportError }),
      publicReadGeneration: {
        current: vi.fn(),
        bump: vi.fn(async () => {
          throw new Error("redis");
        }),
      },
    }) as any;
    await expect(rejecting.write()).resolves.toBe("ok");
    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tags: { area: "public-read-generation", step: "bump" },
        extra: { path: "write" },
      }),
    );

    const throwing = bumpRouter().createCaller({
      ...buildBaseCtx({ ...SIGNED_IN, reportError }),
      publicReadGeneration: {
        current: vi.fn(),
        bump: () => {
          throw new Error("sync");
        },
      },
    }) as any;
    await expect(throwing.write()).resolves.toBe("ok");
    expect(reportError).toHaveBeenCalledTimes(2);
  });
});

describe("events.countryEvents — public discovery cache", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("hands the cache to the use case for an anonymous request", async () => {
    const spy = vi
      .spyOn(eventsUseCases, "listEventsByCountry")
      .mockResolvedValue({ events: [] });
    const cache = mapCache();

    await callerFor(eventsRouter, ANON, cache).countryEvents({
      countryCode: "US",
      limit: 12,
    });

    expect(spy.mock.calls[0]![0].cache).toBe(cache);
  });

  it("withholds the cache from a signed-in request", async () => {
    const spy = vi
      .spyOn(eventsUseCases, "listEventsByCountry")
      .mockResolvedValue({ events: [] });

    await callerFor(eventsRouter, SIGNED_IN, mapCache()).countryEvents({
      countryCode: "US",
      limit: 12,
    });

    expect(spy.mock.calls[0]![0].cache).toBeUndefined();
  });

  it("withholds the cache when only an (unverified) bearer token is present", async () => {
    const spy = vi
      .spyOn(eventsUseCases, "listEventsByCountry")
      .mockResolvedValue({ events: [] });

    await callerFor(
      eventsRouter,
      { ...ANON, authToken: "stale-token" },
      mapCache(),
    ).countryEvents({ countryCode: "US", limit: 12 });

    expect(spy.mock.calls[0]![0].cache).toBeUndefined();
  });
});

describe("events.countryEvents — gate-unlock cookie", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("withholds the cache from an otherwise anonymous request carrying th_eu_*", async () => {
    const spy = vi
      .spyOn(eventsUseCases, "listEventsByCountry")
      .mockResolvedValue({ events: [] });

    await callerFor(
      eventsRouter,
      { ...ANON, cookieHeader: "th_eu_evt1=1.sig" },
      mapCache(),
    ).countryEvents({ countryCode: "US", limit: 12 });

    expect(spy.mock.calls[0]![0].cache).toBeUndefined();
  });
});

describe("search.featuredEvents — public discovery cache", () => {
  const autocompleteResult = () =>
    ok({
      suggestions: [
        {
          type: "event" as const,
          id: "doc-1",
          eventId: "evt-1",
          title: "Sample Event",
          subtitle: null,
          helper: null,
          confidence: 0.9,
          slug: "sample-event",
          startsAt: null,
          imageUrl: null,
          lowestPriceCents: null,
          lowestBuyerTotalCents: null,
          currency: null,
          paidTierCount: 0,
          hasFreeTier: false,
        },
      ],
      latencyMs: 5,
    });

  it("anonymous repeats are served from the cache", async () => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue(autocompleteResult()),
    };
    const cache = mapCache();
    const input = { regionCode: "US", limit: 12 };

    const first = await callerFor(
      unifiedSearchRouter,
      { ...ANON, multiSearch: multiSearch as any },
      cache,
    ).featuredEvents(input);
    const second = await callerFor(
      unifiedSearchRouter,
      { ...ANON, multiSearch: multiSearch as any },
      cache,
    ).featuredEvents(input);

    expect(multiSearch.autocomplete).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("a signed-in request neither reads nor fills the cache", async () => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue(autocompleteResult()),
    };
    const cache = mapCache();
    const input = { regionCode: "US", limit: 12 };

    await callerFor(
      unifiedSearchRouter,
      { ...SIGNED_IN, multiSearch: multiSearch as any },
      cache,
    ).featuredEvents(input);
    await callerFor(
      unifiedSearchRouter,
      { ...SIGNED_IN, multiSearch: multiSearch as any },
      cache,
    ).featuredEvents(input);

    expect(multiSearch.autocomplete).toHaveBeenCalledTimes(2);
    expect(cache.getOrLoad).not.toHaveBeenCalled();
  });

  it("works unchanged with no cache wired", async () => {
    const multiSearch = {
      autocomplete: vi.fn().mockResolvedValue(autocompleteResult()),
    };

    const caller = callerFor(
      unifiedSearchRouter,
      { ...ANON, multiSearch: multiSearch as any },
      null,
    );
    await caller.featuredEvents({ regionCode: "US", limit: 12 });
    await caller.featuredEvents({ regionCode: "US", limit: 12 });

    expect(multiSearch.autocomplete).toHaveBeenCalledTimes(2);
  });
});

const CATEGORY = {
  id: "cat-1",
  slug: "comedy",
  name: "Comedy",
  active: true,
  sortOrder: 1,
  seoType: "ComedyEvent",
};

describe.each([
  {
    procedure: "list" as const,
    repoMethod: "listActive" as const,
    key: "categories.listCategories:v1",
  },
  {
    procedure: "listBrowsable" as const,
    repoMethod: "listActiveWithListedEvents" as const,
    key: "categories.listBrowseCategories:v1",
  },
])(
  "categories.$procedure — public discovery cache",
  ({ procedure, repoMethod, key }) => {
    const reposWith = (read: ReturnType<typeof vi.fn>) =>
      ({
        categories: {
          [repoMethod]: read,
          listCurrentSlugs: vi.fn().mockResolvedValue([]),
        },
      }) as any;
    const call = (
      overrides: Partial<Ctx>,
      read: ReturnType<typeof vi.fn>,
      cache: ReadThroughCachePort,
    ) =>
      callerFor(
        categoriesRouter,
        { ...overrides, repos: reposWith(read) },
        cache,
      )[procedure]();

    it("anonymous repeats share one load", async () => {
      const read = vi.fn().mockResolvedValue([CATEGORY]);
      const cache = mapCache();

      const first = await call(ANON, read, cache);
      const second = await call(ANON, read, cache);

      expect(read).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
      expect(first.categories.map((c: { slug: string }) => c.slug)).toEqual([
        "comedy",
      ]);
    });

    it("a signed-in request neither reads nor fills the cache", async () => {
      const read = vi.fn().mockResolvedValue([CATEGORY]);
      const cache = mapCache();

      await call(SIGNED_IN, read, cache);
      await call(SIGNED_IN, read, cache);

      expect(read).toHaveBeenCalledTimes(2);
      expect(cache.getOrLoad).not.toHaveBeenCalled();
    });

    // The key is a constant because the answer takes no input and carries
    // every locale's name. If it starts to vary (a locale, an input), the key
    // must grow with it, and this test is the reminder.
    it("caches under a constant key", async () => {
      const cache = mapCache();

      await call(ANON, vi.fn().mockResolvedValue([CATEGORY]), cache);

      expect(cache.getOrLoad).toHaveBeenCalledTimes(1);
      expect(vi.mocked(cache.getOrLoad).mock.calls[0]![0]).toBe(key);
    });
  },
);
