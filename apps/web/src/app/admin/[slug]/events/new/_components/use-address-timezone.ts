"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

import { trpc } from "@/trpc";

import {
  coordinateKey,
  resolveTimezoneForAddressCoordinates,
  shouldRequestTimezoneForCoordinates,
  type TimezoneAdoptionResult,
  type TimezoneCoordinates,
} from "./event-timezone";

/**
 * Adopt a FREEFORM address's zone, the way picking a venue already adopts
 * `Place.timezone`.
 *
 * A linked Place carries its zone in the picker row, so that path is a pure
 * function call. A freeform address carries only lat/lng, so the zone has to
 * be fetched — `places.resolveTimezone`, a thin authed pass-through to the
 * tz-lookup port. The ~150 KB boundary table stays on the server; the client
 * ships one query.
 *
 * Every DECISION here lives in `./event-timezone.ts` and is unit-tested there.
 * This hook is only the plumbing: when to ask, and priming.
 *
 * ## Not spamming the endpoint
 *
 * Three gates, cheapest first:
 *
 *  1. **Keyed on the point.** `shouldRequestTimezoneForCoordinates` compares a
 *     6-decimal key against the last point a lookup was started for. This is
 *     the one that matters: a single map drag calls `onLocationChange` TWICE
 *     with the same coordinates (once so the pin tracks, once when the
 *     reverse-geocoded address lands), and re-picking the same address from
 *     the autocomplete re-emits the identical point. Both collapse to nothing.
 *  2. **Debounced.** {@link ADDRESS_TIMEZONE_DEBOUNCE_MS} on top of the map's
 *     own 550 ms drag settle, so a flurry of address edits resolves once.
 *     (`CoordinatesSelectorMap` already fires only on `moveend`-after-drag,
 *     never per frame — the debounce is belt to that suspenders.)
 *  3. **Cached.** `staleTime: Infinity` on the fetch, so a there-and-back drag
 *     is answered from React Query's cache. A point's timezone does not change.
 *
 * ## Priming: hydration must never adopt
 *
 * Loading a saved event fills the address with stored coordinates. That is not
 * the organizer moving the show, and re-deriving a zone there would restamp an
 * event whose stored `timezone` is authoritative. So the first render in which
 * this hook is `enabled` RECORDS the current point as the baseline and asks
 * nothing; only a change away from it is a change. Callers must therefore keep
 * `enabled` false until hydration has landed.
 *
 * The same mechanic gives the mode toggle the right behaviour for free:
 * switching venue → address restores the stashed coordinates, re-primes, and
 * adopts nothing — clearing a venue must not move the zone.
 */

/** Debounce before a coordinate change turns into a request. */
export const ADDRESS_TIMEZONE_DEBOUNCE_MS = 400;

// Same reasoning as `./use-stable-handler.ts`: latest-value refs are written in
// a LAYOUT effect, never during render, so an abandoned render cannot poison
// them under concurrent rendering. A no-op passive effect on the server keeps
// React from warning about useLayoutEffect during SSR.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export type UseAddressTimezoneAdoptionArgs = {
  /**
   * Freeform-address mode is active AND the form has finished hydrating.
   * False parks the hook and clears its baseline, so the next enable re-primes.
   */
  enabled: boolean;
  /** The address's coordinates, or null when it has none. */
  coordinates: TimezoneCoordinates | null;
  /** The zone the builder is currently typing in. */
  currentTimezone: string;
  /**
   * Called ONLY when the zone actually moved. Receives the full result so the
   * caller can set the zone and announce it in one go.
   */
  onAdopt: (adopted: NonNullable<TimezoneAdoptionResult["adopted"]>) => void;
};

export function useAddressTimezoneAdoption({
  enabled,
  coordinates,
  currentTimezone,
  onAdopt,
}: UseAddressTimezoneAdoptionArgs): void {
  const utils = trpc.useUtils();

  // Read through refs so the effect below depends only on things that should
  // re-trigger a lookup — a re-render for an unrelated field, or the zone
  // moving for some other reason, must not re-ask. They also have to be read
  // at RESOLVE time, not at request time, for the staleness check to mean
  // anything.
  const currentTimezoneRef = useRef(currentTimezone);
  const onAdoptRef = useRef(onAdopt);
  const coordinatesRef = useRef(coordinates);
  useIsomorphicLayoutEffect(() => {
    currentTimezoneRef.current = currentTimezone;
    onAdoptRef.current = onAdopt;
    coordinatesRef.current = coordinates;
  });

  /** Key of the point a lookup was last started for (or primed with). */
  const lastRequestedKeyRef = useRef<string | null>(null);
  const primedRef = useRef(false);

  const key = coordinateKey(coordinates);

  useEffect(() => {
    if (!enabled) {
      primedRef.current = false;
      lastRequestedKeyRef.current = null;
      return;
    }

    if (!primedRef.current) {
      primedRef.current = true;
      lastRequestedKeyRef.current = key;
      return;
    }

    // The ref, not the closure: `coordinates` churns identity on every parent
    // render while `key` does not, so depending on the object directly would
    // reschedule the debounce on every keystroke elsewhere on the form. The
    // layout effect above has already flushed for this commit (layout effects
    // run before passive ones), so the ref holds this render's point.
    const requested = coordinatesRef.current;
    if (
      !requested ||
      !shouldRequestTimezoneForCoordinates({
        coordinates: requested,
        lastRequestedKey: lastRequestedKeyRef.current,
      })
    ) {
      return;
    }
    lastRequestedKeyRef.current = key;

    const { lat, lng } = requested;
    let cancelled = false;
    const timer = setTimeout(() => {
      void utils.places.resolveTimezone
        .fetch({ lat, lng }, { staleTime: Infinity })
        .then((result) => {
          if (cancelled) return;
          const { adopted } = resolveTimezoneForAddressCoordinates({
            currentTimezone: currentTimezoneRef.current,
            requestedCoordinates: { lat, lng },
            // Re-read at RESOLVE time: the organizer may have dragged on or
            // cleared the address while this was in flight.
            currentCoordinates: coordinatesRef.current,
            timezone: result.timezone,
          });
          if (adopted) onAdoptRef.current(adopted);
        })
        .catch(() => {
          // A failed lookup is indistinguishable from an unknown zone as far
          // as the organizer is concerned: keep the zone they are typing in.
          // Never surfaced as an error — nothing they did went wrong, and the
          // server re-derives its own zone on save regardless.
        });
    }, ADDRESS_TIMEZONE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, key, utils]);
}
