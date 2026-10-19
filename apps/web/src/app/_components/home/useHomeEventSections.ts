"use client";

import { useMemo } from "react";
import type { EventSummary } from "@th/ui";

import { trpc } from "@/trpc";

const SECTION_LIMIT = 12;
const STALE_TIME = 60_000; // 1 minute
const QUERY_OPTIONS = {
  staleTime: STALE_TIME,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

export interface UserCoords {
  lat: number;
  lng: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiered Popular Events (smart geo fallback)
// ─────────────────────────────────────────────────────────────────────────────

export interface UsePopularEventsResult {
  events: EventSummary[];
  tier: "local" | "regional" | "country" | "global" | null;
  isLoading: boolean;
  isError: boolean;
  isUnavailable: boolean;
}

/**
 * Fetches popular events with intelligent geo fallback.
 * When user has coordinates, uses tiered search (local → regional → country → global).
 * When no coordinates, falls back to country events from DB.
 */
export function usePopularEvents(
  coords: UserCoords | null,
  regionCode: string | null | undefined,
): UsePopularEventsResult {
  // Tiered popular events (Meilisearch) - when we have coordinates
  const tieredQuery = trpc.search.tieredPopularEvents.useQuery(
    {
      lat: coords?.lat ?? 0,
      lng: coords?.lng ?? 0,
      regionCode: regionCode ?? undefined,
      minResults: 6,
      limit: SECTION_LIMIT,
    },
    {
      ...QUERY_OPTIONS,
      enabled: !!coords,
    },
  );

  // Country events fallback (DB) - when no coordinates
  const countryQuery = trpc.events.countryEvents.useQuery(
    {
      countryCode: regionCode ?? undefined,
      limit: SECTION_LIMIT,
    },
    {
      ...QUERY_OPTIONS,
      enabled: true,
    },
  );

  const tieredUnavailable =
    tieredQuery.error?.data?.code === "PRECONDITION_FAILED";

  const result = useMemo((): UsePopularEventsResult => {
    if (coords && tieredQuery.data?.events.length) {
      return {
        events: tieredQuery.data.events,
        tier: tieredQuery.data.tier,
        isLoading: false,
        isError: false,
        isUnavailable: false,
      };
    }

    if (countryQuery.data?.events.length) {
      return {
        events: countryQuery.data.events,
        tier: "country",
        isLoading: false,
        isError: false,
        isUnavailable: false,
      };
    }

    if (coords && tieredQuery.data && !countryQuery.isLoading) {
      return {
        events: tieredQuery.data.events,
        tier: tieredQuery.data.tier,
        isLoading: false,
        isError: false,
        isUnavailable: false,
      };
    }

    if (!coords && countryQuery.data) {
      return {
        events: countryQuery.data.events,
        tier: "country",
        isLoading: false,
        isError: false,
        isUnavailable: false,
      };
    }

    return {
      events: [],
      tier: null,
      isLoading: coords
        ? tieredQuery.isLoading || countryQuery.isLoading
        : countryQuery.isLoading,
      isError: coords
        ? !tieredUnavailable && tieredQuery.isError && countryQuery.isError
        : countryQuery.isError,
      isUnavailable: Boolean(
        coords && tieredUnavailable && !countryQuery.data?.events.length,
      ),
    };
  }, [
    coords,
    tieredQuery.data,
    tieredQuery.isLoading,
    tieredQuery.isError,
    countryQuery.data,
    countryQuery.isLoading,
    countryQuery.isError,
    tieredUnavailable,
  ]);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Featured Events
// ─────────────────────────────────────────────────────────────────────────────

export interface UseFeaturedEventsResult {
  events: EventSummary[];
  isLoading: boolean;
  isError: boolean;
}

/**
 * Fetches featured events sorted by popularity.
 * Optionally scoped to a geographic region.
 */
export function useFeaturedEvents(
  coords: UserCoords | null,
  regionCode: string | null | undefined,
): UseFeaturedEventsResult {
  const query = trpc.search.featuredEvents.useQuery(
    {
      // Only pass geo if we have all coords
      ...(coords ? { lat: coords.lat, lng: coords.lng, radiusKm: 200 } : {}),
      regionCode: regionCode ?? undefined,
      limit: SECTION_LIMIT,
    },
    QUERY_OPTIONS,
  );

  const result = useMemo((): UseFeaturedEventsResult => {
    if (query.data) {
      return {
        events: query.data.events,
        isLoading: false,
        isError: false,
      };
    }

    return {
      events: [],
      isLoading: query.isLoading,
      isError: query.isError,
    };
  }, [query.data, query.isLoading, query.isError]);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Nearby Events
// ─────────────────────────────────────────────────────────────────────────────

export interface UseNearbyEventsResult {
  events: EventSummary[];
  isLoading: boolean;
  isError: boolean;
}

/**
 * Fetches events near the user's coordinates.
 * Only enabled when coordinates are available.
 */
export function useNearbyEvents(
  coords: UserCoords | null,
): UseNearbyEventsResult {
  const query = trpc.search.nearbyEvents.useQuery(
    {
      lat: coords?.lat ?? 0,
      lng: coords?.lng ?? 0,
      radiusKm: 80, // 80km radius
      limit: SECTION_LIMIT,
    },
    {
      ...QUERY_OPTIONS,
      enabled: !!coords,
    },
  );

  const result = useMemo((): UseNearbyEventsResult => {
    if (!coords) {
      return { events: [], isLoading: false, isError: false };
    }

    if (query.data) {
      return {
        events: query.data.events,
        isLoading: false,
        isError: false,
      };
    }

    return {
      events: [],
      isLoading: query.isLoading,
      isError: query.isError,
    };
  }, [coords, query.data, query.isLoading, query.isError]);

  return result;
}
