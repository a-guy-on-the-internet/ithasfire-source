"use client";

import { useState, useEffect, useCallback } from "react";
import { safeGetItem, safeSetItem } from "@/lib/storage/web-storage";

// Locales whose users expect miles for everyday distance. Only the US (all
// measures) and the UK (road distances/speeds, despite being metric otherwise)
// qualify — Liberia and Myanmar are often listed as "non-metric" but use km for
// distance in practice, so they default to metric here.
const IMPERIAL_LOCALE_PREFIXES = ["en-us", "en-gb"];

/** localStorage key holding the user's manual km/mi preference, if any. */
const IMPERIAL_STORAGE_KEY = "ithasfire:units-imperial";

/** Read a persisted manual override; null means "never toggled, auto-detect". */
function readStoredOverride(): boolean | null {
  const raw = safeGetItem(IMPERIAL_STORAGE_KEY);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

// Country codes whose events default the distance slider to miles. See the
// locale note above — realistically just the US and the UK.
export const IMPERIAL_COUNTRY_CODES = new Set(["US", "GB"]);

/**
 * Decide whether to show miles / feet, in priority order:
 *   1. A persisted manual choice (the user tapped the km/mi toggle before) —
 *      stored in localStorage and applied globally, so the preference sticks.
 *   2. The event's country code (ISO 3166-1 alpha-2), when a caller passes one,
 *      so the radius slider reflects *where the event is*.
 *   3. The browser locale.
 *
 * Returns [imperial, toggle] so callers can let the user switch manually; once
 * toggled, the choice is persisted and wins over (2) and (3) everywhere.
 */
export function useImperial(
  locationCountryCode?: string | null,
): [boolean, () => void] {
  const [imperial, setImperial] = useState(false);
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  // Gate auto-detection until we've read the stored override, so a persisted
  // preference always wins over locale/country and we never flash the wrong
  // unit. Starts false (matching SSR) and flips after the mount-time read.
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the manual override from localStorage once on mount.
  useEffect(() => {
    setUserOverride(readStoredOverride());
    setHydrated(true);
  }, []);

  useEffect(() => {
    // Wait until we know whether a stored override exists.
    if (!hydrated) return;

    // A persisted manual choice wins over any auto-detection.
    if (userOverride !== null) {
      setImperial(userOverride);
      return;
    }

    // If we know the event's country, prefer that signal.
    if (locationCountryCode) {
      setImperial(
        IMPERIAL_COUNTRY_CODES.has(locationCountryCode.toUpperCase()),
      );
      return;
    }
    // Otherwise fall back to browser locale.
    const lang = (navigator.language ?? "").toLowerCase();
    setImperial(IMPERIAL_LOCALE_PREFIXES.some((p) => lang.startsWith(p)));
  }, [hydrated, locationCountryCode, userOverride]);

  const toggle = useCallback(() => {
    setImperial((prev) => {
      const next = !prev;
      setUserOverride(next);
      safeSetItem(IMPERIAL_STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return [imperial, toggle];
}

export const KM_TO_MI = 0.621371;
export const M_TO_FT = 3.28084;
