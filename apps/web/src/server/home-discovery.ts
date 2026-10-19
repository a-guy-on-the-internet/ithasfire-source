import "server-only";

import { cache } from "react";
import * as Sentry from "@sentry/nextjs";
import type { QueryClient } from "@tanstack/react-query";

import { getPublicTrpcClient } from "@/server/trpc-client";

const SECTION_LIMIT = 12;

/**
 * Re-exported so server callers (`page.tsx`) and the client `HomeLayout` read
 * the same literal. The constant itself lives in a client-safe module because
 * THIS one is `server-only` — see `@/lib/location/home-ssr-country` for why the
 * home page pins a single country.
 */
export { HOME_SSR_COUNTRY } from "@/lib/location/home-ssr-country";

/**
 * Server-side prefetch for the home page's event sections.
 *
 * Why country-only (no lat/lng): personalizing the cached HTML on user-granted
 * geolocation would fragment the edge cache to per-user, defeating the point.
 * Users who have granted location see the cached paint first, then the
 * client-side hooks refetch with their coords and the page upgrades to
 * "near you" content.
 *
 * Country codes are normalized to UPPERCASE here because that is the shape the
 * client hooks query with (`inferCountryCodeFromNavigator` returns "US", not
 * "us"). They previously disagreed on case, which silently made every hydration
 * key miss — the prefetch was fetched, shipped in the payload, and then never
 * read, so the client refetched both sections on every load anyway.
 *
 * Failures are isolated per-section so one slow backend can't tank the
 * whole home page. A failed section degrades to `null` (the client hook then
 * fetches it after paint), and that swallow is REPORTED, per section: a
 * section failing on every render would otherwise look like a page that works
 * and is just a little slower.
 *
 * `getPublicTrpcClient`, not the identity client: `/` is edge-cached, and
 * everything here must be a property of the resource, never of the viewer.
 * None of the three procedures needs a session (`countryEvents` and
 * `categories.listBrowsable` are public, `featuredEvents` only optionally
 * authed).
 *
 * The category list rides along so the hero's category chips are in the
 * first paint. Fetched on the client alone, the chip group arrived after
 * hydration and grew the hero 135 → 351px at 320, shoving "Upcoming events"
 * out of the viewport (most of `/`'s 0.265 CLS). It is safe in the edge-cached
 * HTML: `categories.listBrowsable` (the categories whose page lists something,
 * owner ruling 2026-10-14) is public, takes no input and returns the same
 * list to every viewer; it moves only as events are published or start. The
 * hero's "near you" kicker counts are NOT — they stay client-side, which is
 * why they are not prefetched here.
 */
export const prefetchHomeDiscovery = cache(
  async (input: { countryCode?: string }) => {
    const client = getPublicTrpcClient();
    const countryCode = input.countryCode?.trim().toUpperCase() || undefined;

    const fetchedAt = Date.now();
    const [country, featured, categories] = await Promise.allSettled([
      countryCode
        ? client.events.countryEvents.query({
            countryCode,
            limit: SECTION_LIMIT,
          })
        : Promise.resolve(null),
      client.search.featuredEvents.query({
        regionCode: countryCode,
        limit: SECTION_LIMIT,
      }),
      client.categories.listBrowsable.query(),
    ]);

    return {
      countryCode,
      // Epoch ms the lists were read. `hydrateHomeDiscovery` stamps the
      // categories seed with it, so cached HTML does not look fresh again
      // at hydration.
      fetchedAt,
      countryEvents: settledOrReport(country, "countryEvents"),
      featuredEvents: settledOrReport(featured, "featuredEvents"),
      categories: settledOrReport(categories, "categories"),
    };
  },
);

/**
 * The fulfilled value, or `null` after reporting the rejection to Sentry.
 *
 * The report is guarded: a throwing reporter must not take the home page down
 * with it, since degrading to `null` is the whole point of the branch.
 */
function settledOrReport<T>(
  result: PromiseSettledResult<T>,
  section: "countryEvents" | "featuredEvents" | "categories",
): T | null {
  if (result.status === "fulfilled") return result.value;
  try {
    Sentry.captureException(result.reason, {
      tags: { area: "home-ssr", section },
    });
  } catch {
    // Reporting is best-effort; the section still degrades to null.
  }
  return null;
}

export type HomeDiscoveryPrefetch = Awaited<
  ReturnType<typeof prefetchHomeDiscovery>
>;

/**
 * Hydrate a React Query client with prefetched home page data so the
 * matching client hooks (`useFeaturedEvents`, `usePopularEvents` with no
 * coords, `useBrowseCategoryList`) read from cache instead of firing fresh requests
 * on mount.
 *
 * Query keys mirror tRPC v11's `getQueryKeyInternal` output:
 *   [path, { input, type }]
 *
 * If the tRPC major version changes, regenerate via
 * `getQueryKey(trpc.<router>.<proc>, input, 'query')` and update here.
 */
export function hydrateHomeDiscovery(
  qc: QueryClient,
  data: HomeDiscoveryPrefetch,
): void {
  if (data.countryEvents) {
    qc.setQueryData(
      [
        ["events", "countryEvents"],
        {
          input: { countryCode: data.countryCode, limit: SECTION_LIMIT },
          type: "query",
        },
      ],
      data.countryEvents,
    );
  }

  if (data.featuredEvents) {
    qc.setQueryData(
      [
        ["search", "featuredEvents"],
        {
          input: { regionCode: data.countryCode, limit: SECTION_LIMIT },
          type: "query",
        },
      ],
      data.featuredEvents,
    );
  }

  // `useBrowseCategoryList` passes no input, so tRPC's key carries no
  // `input` field. `updatedAt` is the server fetch time, not now: the rule is
  // "has an event starting after now", and the home HTML is cached, so a seed
  // older than the hook's staleTime must refetch on mount.
  if (data.categories) {
    qc.setQueryData(
      [["categories", "listBrowsable"], { type: "query" }],
      data.categories,
      { updatedAt: data.fetchedAt },
    );
  }
}
