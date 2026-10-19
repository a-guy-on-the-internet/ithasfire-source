"use client";

import { useMemo } from "react";

import { trpc } from "@/trpc";

// ─────────────────────────────────────────────────────────────────────────────
// useHeroEvents — the S1 hero's data source for its one number.
//
// Extracted from the retired hero map, which owned these two queries. The hero
// kicker needs the SAME count the map's "N EVENTS · THIS WEEK" chip used to
// show, so the queries move here wholesale rather than being re-derived. The
// rows the old rail rendered are gone (D-136 removed the rail), so this hook
// now returns only the count — nothing here needs the event shapes.
//
// The window is FIXED at one week. The map's time-window chips ("This Week" /
// "This Month" / "6+ Months") were map chrome and retired with it, so there is
// no window to select any more.
//
// DELIBERATELY NOT GATED ON `isMapEnabled`. The old call sites carried
// `enabled: isMapEnabled && …`, but `isMapEnabled` is `Boolean(tileServerUrl)`
// (`@/config/maps`) — it gates the TILE SERVER, not the event data. Inheriting
// that gate here would blank the count whenever the tileserver is unconfigured
// or down, which has nothing to do with whether events exist. Do not re-add it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Matches the retired hero map's nearby lookup — 120 km.
 *
 * SHARED with `useDirectoryPlaceCount`: the kicker reads
 * "Near You · M venues · N events this week" as ONE scope, so the venue count
 * and the event count must be drawn on the same circle. The events query
 * takes metres and the places query takes kilometres; both derive from this
 * one number so they cannot drift apart.
 */
export const NEARBY_RADIUS_KM = 120;
const NEARBY_RADIUS_M = NEARBY_RADIUS_KM * 1000;

/**
 * Matches the retired hero map's fetch ceiling. It is also the COUNT ceiling:
 * `count` is `events.length` of a query capped here, so a week with more than
 * 50 events still reports 50. The hook surfaces that as `isCapped` and the
 * kicker renders "50+" rather than a flat "50 events this week".
 */
const HERO_LIMIT = 50;

/** Fetch policy carried over verbatim from the map's call sites. */
const QUERY_OPTIONS = {
  staleTime: 120_000,
  retry: false,
  refetchOnWindowFocus: false,
} as const;

export type HeroCoords = { lat: number; lng: number };

export type UseHeroEventsResult = {
  /**
   * Events starting within the next 7 days; nearby-scoped when coords exist.
   * The real number the kicker renders — and only when it is > 0.
   */
  count: number;
  /** `count` hit `HERO_LIMIT` — the true number is at least this, maybe more. */
  isCapped: boolean;
  isLoading: boolean;
  /** True when the count is scoped to the visitor's area rather than the US. */
  hasCoords: boolean;
};

/**
 * ISO range for the hero's fixed one-week window — the old `buildDateRange`
 * helper's `"week"` branch, which was its default.
 */
export function buildHeroDateRange(now: Date = new Date()): {
  startsAfter: string;
  startsBefore: string;
} {
  const end = new Date(now);
  end.setDate(end.getDate() + 7);
  return { startsAfter: now.toISOString(), startsBefore: end.toISOString() };
}

/**
 * Event count for the S1 hero kicker. Mirrors the retired map's branch: a
 * nearby radius search when the visitor's coords are known, a US-wide overview
 * box search otherwise.
 */
export function useHeroEvents(coords: HeroCoords | null): UseHeroEventsResult {
  const hasCoords = coords != null;

  // Pinned for the component's lifetime. `buildHeroDateRange()` embeds
  // `Date.now()`, so recomputing per render would mint a new query key every
  // render and refetch forever.
  const dateRange = useMemo(() => buildHeroDateRange(), []);

  const nearbyQuery = trpc.events.nearbyEventsForMap.useQuery(
    {
      lat: coords?.lat ?? 0,
      lng: coords?.lng ?? 0,
      radiusM: NEARBY_RADIUS_M,
      limit: HERO_LIMIT,
      startsAfter: dateRange.startsAfter,
      startsBefore: dateRange.startsBefore,
    },
    { ...QUERY_OPTIONS, enabled: hasCoords },
  );

  const overviewQuery = trpc.events.eventsForMapOverview.useQuery(
    {
      limit: HERO_LIMIT,
      startsAfter: dateRange.startsAfter,
      startsBefore: dateRange.startsBefore,
    },
    { ...QUERY_OPTIONS, enabled: !hasCoords },
  );

  const active = hasCoords ? nearbyQuery : overviewQuery;
  const rawEvents = active.data?.events;
  const count = rawEvents?.length ?? 0;

  return {
    count,
    isCapped: count >= HERO_LIMIT,
    // The disabled branch never reports loading: react-query v5 derives
    // `isLoading` as `isPending && isFetching`, and a disabled query never
    // fetches. So reading the ACTIVE query alone is correct.
    isLoading: active.isLoading,
    hasCoords,
  };
}
