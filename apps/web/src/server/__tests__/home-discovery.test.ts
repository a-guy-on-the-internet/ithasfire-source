import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";

import { trpc } from "@/trpc";
import {
  hydrateHomeDiscovery,
  HOME_SSR_COUNTRY,
  prefetchHomeDiscovery,
  type HomeDiscoveryPrefetch,
} from "@/server/home-discovery";

const { captureExceptionMock, publicClient, serverClientMock } = vi.hoisted(
  () => ({
    captureExceptionMock: vi.fn(),
    publicClient: {
      events: { countryEvents: { query: vi.fn() } },
      search: { featuredEvents: { query: vi.fn() } },
      categories: { listBrowsable: { query: vi.fn() } },
    },
    serverClientMock: vi.fn(),
  }),
);

vi.mock("@sentry/nextjs", () => ({
  captureException: captureExceptionMock,
}));

vi.mock("@/server/trpc-client", () => ({
  getPublicTrpcClient: () => publicClient,
  // The identity client must never be used for the edge-cached home page.
  getServerTrpcClient: serverClientMock,
}));
import { inferCountryCodeFromNavigator } from "@/lib/location/infer-country";

const SECTION_LIMIT = 12;

/**
 * `hydrateHomeDiscovery` hand-writes the React Query keys rather than calling
 * `getQueryKey`, because it runs in an RSC where the client `trpc` proxy is not
 * available. That hand-written shape can drift from what the client hooks
 * actually query with, and when it does NOTHING FAILS — the prefetch is still
 * fetched on the server, still serialized into the payload, and the client
 * simply misses the cache and refetches. The page looks correct; it just pays
 * for both.
 *
 * That is exactly what happened: the server seeded lowercase ("us") while
 * `inferCountryCodeFromNavigator` returns uppercase ("US"), so every hydration
 * key missed. These tests pin the two shapes together.
 */
/**
 * The country the CLIENT will query with — derived the way `HomeLayout` derives
 * it, not read off `HOME_SSR_COUNTRY`. Using the constant on both sides would
 * make these tests self-consistent under ANY casing and blind to the exact
 * mismatch they exist to catch.
 */
function clientCountry(): string {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "en-US" },
    configurable: true,
  });
  try {
    const inferred = inferCountryCodeFromNavigator();
    if (!inferred) throw new Error("navigator inference returned null");
    return inferred;
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

const prefetch = (): HomeDiscoveryPrefetch =>
  ({
    countryCode: HOME_SSR_COUNTRY,
    fetchedAt: Date.parse("2026-10-14T12:00:00Z"),
    countryEvents: { events: [{ eventId: "evt_1" }] },
    featuredEvents: { events: [{ eventId: "evt_2" }] },
    categories: { categories: [{ id: "c1", slug: "music", name: "Music" }] },
  }) as unknown as HomeDiscoveryPrefetch;

describe("hydrateHomeDiscovery", () => {
  it("seeds countryEvents under the key the client hook queries with", () => {
    const qc = new QueryClient();
    hydrateHomeDiscovery(qc, prefetch());

    // Mirrors `usePopularEvents`: countryCode comes from the navigator-inferred
    // country, limit is SECTION_LIMIT, no coords.
    const clientKey = getQueryKey(
      trpc.events.countryEvents,
      { countryCode: clientCountry(), limit: SECTION_LIMIT },
      "query",
    );

    expect(qc.getQueryData(clientKey)).toEqual({
      events: [{ eventId: "evt_1" }],
    });
  });

  it("seeds featuredEvents under the key the client hook queries with", () => {
    const qc = new QueryClient();
    hydrateHomeDiscovery(qc, prefetch());

    // Mirrors `useFeaturedEvents` with no granted geolocation.
    const clientKey = getQueryKey(
      trpc.search.featuredEvents,
      { regionCode: clientCountry(), limit: SECTION_LIMIT },
      "query",
    );

    expect(qc.getQueryData(clientKey)).toEqual({
      events: [{ eventId: "evt_2" }],
    });
  });

  it("seeds categories under the key useBrowseCategoryList queries with", () => {
    const qc = new QueryClient();
    hydrateHomeDiscovery(qc, prefetch());

    // Mirrors `useBrowseCategoryList`: no input. The hero's chips render from
    // this on first paint, so a miss here is a layout shift, not just a
    // refetch.
    const clientKey = getQueryKey(
      trpc.categories.listBrowsable,
      undefined,
      "query",
    );

    expect(qc.getQueryData(clientKey)).toEqual({
      categories: [{ id: "c1", slug: "music", name: "Music" }],
    });
  });

  it("stamps the categories seed with the server fetch time, not hydration time", () => {
    const qc = new QueryClient();
    hydrateHomeDiscovery(qc, prefetch());

    const clientKey = getQueryKey(
      trpc.categories.listBrowsable,
      undefined,
      "query",
    );
    // Cached HTML hydrates long after the read; the seed must age from the read
    // so a stale chip list refetches on mount.
    expect(qc.getQueryState(clientKey)?.dataUpdatedAt).toBe(
      Date.parse("2026-10-14T12:00:00Z"),
    );
  });

  it("leaves the full category list unseeded", () => {
    // The browse list omits empty categories. Seeded under `categories.list`
    // it would hand pickers and filters a list missing categories.
    const qc = new QueryClient();
    hydrateHomeDiscovery(qc, prefetch());

    expect(
      qc.getQueryData(getQueryKey(trpc.categories.list, undefined, "query")),
    ).toBeUndefined();
  });

  it("seeds the case the navigator actually produces", () => {
    // The regression that motivated these tests: the server seeded "us" while
    // the client queried "US", so both hydration keys missed in silence.
    expect(HOME_SSR_COUNTRY).toBe(clientCountry());
  });
});

describe("prefetchHomeDiscovery", () => {
  const COUNTRY = { events: [{ eventId: "evt_1" }] };
  const FEATURED = { events: [{ eventId: "evt_2" }], latencyMs: 3 };
  const CATEGORIES = {
    categories: [{ id: "c1", slug: "music", name: "Music" }],
  };

  const arrange = () => {
    captureExceptionMock.mockReset();
    serverClientMock.mockReset();
    publicClient.events.countryEvents.query.mockResolvedValue(COUNTRY);
    publicClient.search.featuredEvents.query.mockResolvedValue(FEATURED);
  };

  /**
   * A failed section degrades to `null` so the page still renders. That swallow
   * has to reach Sentry, tagged with WHICH section failed: a categories
   * prefetch failing on every render would otherwise show up only as the chips
   * arriving late again.
   */
  it.each([
    ["categories", () => publicClient.categories.listBrowsable.query],
    ["countryEvents", () => publicClient.events.countryEvents.query],
    ["featuredEvents", () => publicClient.search.featuredEvents.query],
  ] as const)(
    "reports a failed %s prefetch and keeps the other sections",
    async (section, procedure) => {
      arrange();
      publicClient.categories.listBrowsable.query.mockResolvedValue(CATEGORIES);
      const boom = new Error(`${section} down`);
      procedure().mockRejectedValue(boom);

      const data = await prefetchHomeDiscovery({ countryCode: "US" });

      const expected = {
        countryEvents: COUNTRY,
        featuredEvents: FEATURED,
        categories: CATEGORIES,
        [section]: null,
      };
      expect(data).toMatchObject(expected);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      expect(captureExceptionMock).toHaveBeenCalledWith(boom, {
        tags: { area: "home-ssr", section },
      });
    },
  );

  it("still degrades to null when the reporter itself throws", async () => {
    arrange();
    publicClient.categories.listBrowsable.query.mockRejectedValue(new Error("down"));
    captureExceptionMock.mockImplementation(() => {
      throw new Error("sentry down");
    });

    const data = await prefetchHomeDiscovery({ countryCode: "US" });

    expect(data.categories).toBeNull();
    expect(data.featuredEvents).toEqual(FEATURED);
  });

  it("reads through the anonymous client, never the identity one", async () => {
    arrange();
    publicClient.categories.listBrowsable.query.mockResolvedValue({ categories: [] });

    const data = await prefetchHomeDiscovery({ countryCode: "US" });

    expect(data.categories).toEqual({ categories: [] });
    expect(serverClientMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
