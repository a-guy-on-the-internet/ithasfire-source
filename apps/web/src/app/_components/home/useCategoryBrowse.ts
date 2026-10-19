"use client";

import { useMemo } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";
import { useLocale, type EventSummary } from "@th/ui";

import { withCategoryDisplayNames } from "@/lib/category-display-name";
import { trpc } from "@/trpc";

type RouterOutputs = inferRouterOutputs<AppRouter>;

const QUERY_OPTIONS = {
  staleTime: 120_000, // 2 min — categories change rarely
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Category list
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryItem {
  id: string;
  slug: string;
  /**
   * The name in the viewer's language (English when it has none): the hooks
   * below swap it in from `names`, so every chip and heading reads it as is.
   */
  name: string;
  /** Every name the category has (`{ en, es? }`); absent from an older API. */
  names?: Partial<Record<string, string>>;
  /**
   * The current URL slug per language (`{ en, es? }`); absent from an older
   * API. Links go through `categoryLinkSlugs` (`@/i18n/public-paths`).
   */
  slugs?: Partial<Record<string, string>>;
}

export interface UseCategoryListResult {
  categories: CategoryItem[];
  isLoading: boolean;
  isError: boolean;
}

type CategoryListQuery = {
  data?: { categories: CategoryItem[] } | undefined;
  isLoading: boolean;
  isError: boolean;
};

const useListResult = (query: CategoryListQuery): UseCategoryListResult => {
  // The provider's locale: the server-resolved one on the first render, so
  // the server and the hydrating client pick the same name.
  const locale = useLocale();
  return useMemo((): UseCategoryListResult => {
    if (query.data) {
      return {
        categories: withCategoryDisplayNames(query.data.categories, locale),
        isLoading: false,
        isError: false,
      };
    }

    return {
      categories: [],
      isLoading: query.isLoading,
      isError: query.isError,
    };
  }, [query.data, query.isLoading, query.isError, locale]);
};

/**
 * Fetches all active categories, sorted by sortOrder, empty ones included.
 * For pickers and filters; browse entry points use
 * {@link useBrowseCategoryList}.
 */
export function useCategoryList(): UseCategoryListResult {
  return useListResult(
    trpc.categories.list.useQuery(undefined, QUERY_OPTIONS),
  );
}

/**
 * Fetches the categories worth offering as a browse entry point: active ones
 * whose page lists at least one upcoming event, sorted by sortOrder (owner
 * ruling 2026-10-14). The homepage's hero chips, "Browse by category" section
 * and its show/hide gate all read this one list, so they agree. The home page
 * server-prefetches it (`server/home-discovery.ts`), so the chips are in the
 * HTML.
 */
export function useBrowseCategoryList(): UseCategoryListResult {
  return useListResult(
    trpc.categories.listBrowsable.useQuery(undefined, QUERY_OPTIONS),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Events by category (Meilisearch-backed)
// ─────────────────────────────────────────────────────────────────────────────

export interface UseCategoryEventsResult {
  events: EventSummary[];
  isLoading: boolean;
  isError: boolean;
}

/**
 * Fill a search-ordered list with the fields the search index does not carry.
 *
 * Order comes from `primary` (search relevance). For each event, any field the
 * search row is missing — or is carrying a placeholder for — is taken from the
 * DB row with the same id. Nothing is invented: an event absent from the DB
 * result passes through untouched.
 */
export const mergeCategoryEvents = (
  primary: EventSummary[],
  fallback: EventSummary[] | undefined,
): EventSummary[] => {
  if (!fallback?.length) return primary;
  const byId = new Map(fallback.map((event) => [event.id, event]));

  return primary.map((event) => {
    const other = byId.get(event.id);
    if (!other) return event;

    // "See details" (`listingPrice: null`) is the mappers' shared "we don't
    // know", so it loses to a real price from either side rather than
    // counting as an answer. The structured price travels WITH the English
    // label: the card words `listingPrice` and ignores `priceLabel` when it
    // is present, so copying one without the other would drop the price.
    const hasRealPrice = (e: EventSummary) =>
      e.listingPrice !== undefined
        ? e.listingPrice !== null
        : Boolean(e.priceLabel) && e.priceLabel !== "See details";

    return {
      ...event,
      media: event.media ?? other.media,
      badge: event.badge ?? other.badge,
      gateType: event.gateType ?? other.gateType,
      startsAt: event.startsAt ?? other.startsAt,
      timezone: event.timezone ?? other.timezone,
      ...(hasRealPrice(event)
        ? {}
        : hasRealPrice(other)
          ? {
              priceLabel: other.priceLabel,
              listingPrice: other.listingPrice,
              isFree: other.isFree,
            }
          : {}),
    };
  });
};

/**
 * A server read of the first page, handed to {@link useCategoryEvents} so the
 * category page carries its events in the initial HTML. Each answer seeds the
 * query with the SAME input the hook issues, so the client hydrates from it
 * instead of fetching the first page again.
 */
export interface CategoryEventsSeed {
  /** `search.discoverEventsByCategory`; null when search failed on the server. */
  search: RouterOutputs["search"]["discoverEventsByCategory"] | null;
  /** `categories.eventsByCategory`, offset 0. */
  db: RouterOutputs["categories"]["eventsByCategory"];
  /**
   * When the server read them (ISO). Becomes `initialDataUpdatedAt`, so a seed
   * older than the staleTime is refetched on mount rather than trusted.
   */
  fetchedAt: string;
}

/**
 * Loads published events for a category.
 * Prefers search results when available, but falls back to the DB-backed
 * category listing so local seeded data remains visible when search is stale
 * or unavailable.
 */
export function useCategoryEvents(
  categorySlug: string | null,
  limit = 12,
  coords?: { lat: number; lng: number } | null,
  seed?: CategoryEventsSeed | null,
): UseCategoryEventsResult {
  // A seed answers only the plain first-page query: with coords the search
  // input differs from what the server read.
  const seedUpdatedAt = seed ? Date.parse(seed.fetchedAt) : undefined;
  const searchSeed =
    seed?.search && !coords
      ? { initialData: seed.search, initialDataUpdatedAt: seedUpdatedAt }
      : {};
  const dbSeed = seed
    ? { initialData: seed.db, initialDataUpdatedAt: seedUpdatedAt }
    : {};

  const searchQuery = trpc.search.discoverEventsByCategory.useQuery(
    {
      categorySlug: categorySlug ?? "",
      limit,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
    },
    {
      ...QUERY_OPTIONS,
      ...searchSeed,
      enabled: !!categorySlug,
    },
  );

  const dbQuery = trpc.categories.eventsByCategory.useQuery(
    {
      categorySlug: categorySlug ?? "",
      limit,
      offset: 0,
    },
    {
      ...QUERY_OPTIONS,
      ...dbSeed,
      enabled: !!categorySlug,
    },
  );

  return useMemo((): UseCategoryEventsResult => {
    if (searchQuery.data?.events.length) {
      return {
        // The two sources are COMPLEMENTARY, not redundant, so taking either
        // one wholesale loses half the card.
        //
        // Measured on one batch of the same 7 events: the search path carries
        // a real `priceLabel` ("$51.29") and NO media for any of them; the DB
        // path carries media for all of them and `priceLabel: "See details"`.
        // Preferring search therefore rendered every category card with a
        // price and a ghosted-initials placeholder where its photo should be.
        //
        // Both gaps are real and upstream — the event search document has no
        // image field at all (`packages/ports/src/search/schemas.ts`), and the
        // DB category query computes no pricing rollup — so neither can be
        // fixed here. What CAN be fixed here is throwing away data we already
        // fetched: both queries are in the same tRPC batch, keyed by the same
        // event ids. Search keeps ordering and relevance; the DB row supplies
        // the presentation fields search does not index.
        events: mergeCategoryEvents(
          searchQuery.data.events,
          dbQuery.data?.events,
        ),
        isLoading: false,
        isError: false,
      };
    }

    if (dbQuery.data) {
      return {
        events: dbQuery.data.events,
        isLoading: false,
        isError: false,
      };
    }

    if (searchQuery.data && !dbQuery.isLoading) {
      return {
        events: searchQuery.data.events,
        isLoading: false,
        isError: false,
      };
    }

    return {
      events: [],
      isLoading: searchQuery.isLoading || dbQuery.isLoading,
      isError: searchQuery.isError && dbQuery.isError,
    };
  }, [
    searchQuery.data,
    searchQuery.isLoading,
    searchQuery.isError,
    dbQuery.data,
    dbQuery.isLoading,
    dbQuery.isError,
  ]);
}
