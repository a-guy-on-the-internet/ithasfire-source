"use client";

import { useMemo } from "react";

import { inferCountryCodeFromNavigator } from "@/lib/location/infer-country";
import { DEFAULT_RADIUS_KM } from "@/lib/search/radius";
import { buildSearchQueryString } from "@/app/search/_components/search-url";
import { trpc } from "@/trpc";

import { MarqueeBand, type MarqueeItem } from "./MarqueeBand";

// ─────────────────────────────────────────────────────────────────────────────
// "S2 Signal" — city-by-city marquee content (v2 grammar).
//
// A full-bleed band that scrolls the names of cities with upcoming events.
// Each city is a real link into /search filtered to that city (geo-radius when
// a centroid is known, free-text otherwise).
//
// The item-agnostic band machinery (ink-band styling, seamless N-copy loop,
// a11y invariants, hover-pause, reduced-motion park, self-hide) now lives in
// the shared MarqueeBand shell — this file only supplies the city data and its
// mapping to marquee items. Retained for future multi-region launches; the
// home page currently runs EventMarquee here instead (single-region ⇒ the
// city list is too thin to render).
//
// Self-hiding signal strip: MarqueeBand renders null on <3 cities, while
// loading, and on error — no skeleton (a below-hero strip must not shift
// layout). It is NOT a numbered section and carries no ordinal.
// ─────────────────────────────────────────────────────────────────────────────

type ActiveCity = {
  city: string;
  regionCode: string | null;
  countryCode: string | null;
  eventCount: number;
  lat: number | null;
  lng: number | null;
};

/** Stable composite key/label suffix — city names repeat across regions. */
const cityKey = (c: ActiveCity) =>
  `${c.city}-${c.regionCode ?? ""}-${c.countryCode ?? ""}`;

/** Human label with region when present: "Portland, OR" vs "Portland". */
const cityLabel = (c: ActiveCity) =>
  c.regionCode ? `${c.city}, ${c.regionCode}` : c.city;

/**
 * /search deep-link for one city. Geo-radius scoped to events when a centroid
 * is known; free-text event search otherwise. Uses the search page's canonical
 * querystring contract (`buildSearchQueryString`) so it can't drift.
 */
const cityHref = (c: ActiveCity): string => {
  const qs =
    c.lat != null && c.lng != null
      ? buildSearchQueryString({
          query: "",
          scope: "event",
          categories: [],
          geo: { lat: c.lat, lng: c.lng, label: cityLabel(c) },
          radiusKm: DEFAULT_RADIUS_KM,
          nearMe: false,
        })
      : buildSearchQueryString({
          query: c.city,
          scope: "event",
          categories: [],
          geo: null,
          radiusKm: DEFAULT_RADIUS_KM,
          nearMe: false,
        });
  return `/search?${qs}`;
};

/**
 * City list for the marquee. Threads the navigator-inferred country code the
 * same way HomeLayout's client queries do (null → undefined = global list) and
 * mirrors the `featuredItemsQuery` fetch policy. Returns an empty array in every
 * non-ready state so callers treat loading/error/thin uniformly.
 */
export function useCityMarquee(): { cities: ActiveCity[] } {
  const inferredCountryCode = useMemo(
    () => inferCountryCodeFromNavigator(),
    [],
  );

  const query = trpc.events.discoverActiveCities.useQuery(
    { countryCode: inferredCountryCode ?? undefined },
    { staleTime: 120_000, retry: false, refetchOnWindowFocus: false },
  );

  return { cities: query.data?.cities ?? [] };
}

// ── Component ──────────────────────────────────────────────────────────────────

export function CityMarquee() {
  const { cities } = useCityMarquee();

  // Compute each city's /search href once; recompute only when the list changes.
  const items: MarqueeItem[] = useMemo(
    () =>
      cities.map((city) => ({
        key: cityKey(city),
        href: cityHref(city),
        ariaLabel: `Events in ${cityLabel(city)}`,
        segments: [
          { text: city.city, tone: "primary" as const },
          ...(city.eventCount > 0
            ? [{ text: `· ${city.eventCount}`, tone: "muted" as const }]
            : []),
        ],
      })),
    [cities],
  );

  return (
    <MarqueeBand items={items} sectionAriaLabel="Cities with upcoming events" />
  );
}

CityMarquee.displayName = "CityMarquee";
