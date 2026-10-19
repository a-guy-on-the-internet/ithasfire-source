import tzLookup from "tz-lookup";

import type { TimezoneLookupPort } from "@th/ports/timezone-lookup";

/**
 * TimezoneLookupPort over the `tz-lookup` library (venue-hierarchy FR-004):
 * a LOCAL pure-JS lookup against packed timezone-boundary data — no native
 * deps, no data download, no network call — which is what lets the port stay
 * synchronous (its doc pins that; place upserts must never gain a network
 * dependency through it).
 *
 * Precision note (library-documented): the boundary data is deliberately
 * coarse near borders/coastlines in exchange for a tiny footprint. That is
 * the right trade here — the value seeds `Place.timezone` from a venue
 * address, and a rare borderline miss still yields a *valid* IANA zone next
 * door, never garbage.
 *
 * `null` = unknown: `tz-lookup` THROWS on out-of-range coordinates rather
 * than returning a fallback — mapped to the port's `null` so callers keep
 * their existing/default timezone instead of failing the save.
 */
export function createTzLookupAdapter(): TimezoneLookupPort {
  return (lat, lng) => {
    try {
      return tzLookup(lat, lng);
    } catch {
      return null;
    }
  };
}
