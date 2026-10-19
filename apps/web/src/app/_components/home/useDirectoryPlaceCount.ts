"use client";

import { trpc } from "@/trpc";

import { NEARBY_RADIUS_KM, type HeroCoords } from "./useHeroEvents";

// ─────────────────────────────────────────────────────────────────────────────
// useDirectoryPlaceCount — the S1 hero kicker's second number.
//
// "N venues": places that are ACTIVE and listed in the directory
// (`places.countDirectory`). Sibling of `useHeroEvents`. WITH coords the two
// are scoped identically — the same `NEARBY_RADIUS_KM` circle, which is why
// the radius is imported rather than restated. WITHOUT coords they diverge:
// this counts the whole directory, while the events overview is bounded to
// the continental-US box (`list-events-for-map-overview.ts`). Each number is
// an honest count of its own set; matching them everywhere would need the
// same box on `countDirectory`, which is deliberately not built yet.
//
// Same "no number, no band" contract as the events hook: the component only
// renders the count when `!isLoading && count > 0`. This hook never invents a
// zero to fill a gap — `count` is 0 before data only because the kicker's
// gate treats 0 and "unknown" the same way (absent).
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch policy — mirrors `useHeroEvents`'s `QUERY_OPTIONS` verbatim. */
const QUERY_OPTIONS = {
  staleTime: 120_000,
  retry: false,
  refetchOnWindowFocus: false,
} as const;

export type UseDirectoryPlaceCountResult = {
  /** Directory venues; nearby-scoped when coords exist. Rendered only when > 0. */
  count: number;
  isLoading: boolean;
};

/**
 * Directory venue count for the S1 hero kicker. `coords` null → the whole
 * directory; otherwise the `NEARBY_RADIUS_KM` circle shared with the events
 * count.
 */
export function useDirectoryPlaceCount(
  coords: HeroCoords | null,
): UseDirectoryPlaceCountResult {
  const query = trpc.places.countDirectory.useQuery(
    coords
      ? { near: { lat: coords.lat, lng: coords.lng, radiusKm: NEARBY_RADIUS_KM } }
      : {},
    QUERY_OPTIONS,
  );

  return {
    count: query.data?.count ?? 0,
    isLoading: query.isLoading,
  };
}
