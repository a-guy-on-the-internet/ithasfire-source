"use client";

import { useEffect, useState } from "react";

interface CyclingPlaceholderOptions {
  /** Milliseconds between advancing to the next value. Default 2200. */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 2200;

/**
 * Cycles through a list of strings on an interval, looping forever, and returns
 * the currently-active value. Built for animating search placeholders (e.g.
 * "Search events…" → "Search venues…" → "Search people…").
 *
 * SSR-safe: `index` starts at 0 on the server AND the first client render, so
 * there is no hydration mismatch. The interval only starts after mount (inside
 * an effect). `matchMedia` / `Date` / `Math.random` are never read during
 * render.
 *
 * Reduced-motion: when `(prefers-reduced-motion: reduce)` is set, the interval
 * never starts and the hook stays parked on `values[0]`. It also subscribes to
 * changes to that media query so toggling the OS preference starts/stops the
 * animation live.
 *
 * Safety: a single value (or none) never starts an interval; an empty array
 * returns "". The interval is cleared on unmount and whenever `values` /
 * `intervalMs` / the motion preference change, so there are no leaks or
 * post-unmount state updates.
 */
export function useCyclingPlaceholder(
  values: string[],
  opts?: CyclingPlaceholderOptions,
): string {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const [index, setIndex] = useState(0);

  const count = values.length;
  // A primitive fingerprint of the values so the effect only re-runs when the
  // *contents* change — not on every render when the caller passes a fresh
  // array literal (which would otherwise restart the interval forever and stop
  // it advancing). U+001F is a control char that won't appear in copy.
  const key = values.join("");

  useEffect(() => {
    // Reset to the first value whenever the value set changes.
    setIndex(0);

    // Nothing to cycle through.
    if (count <= 1) return;

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let id: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
      if (id !== undefined) {
        clearInterval(id);
        id = undefined;
      }
    };

    const start = () => {
      stop();
      // Reduced motion: park on the first value, no interval.
      if (mq.matches) {
        setIndex(0);
        return;
      }
      id = setInterval(() => {
        setIndex((prev) => (prev + 1) % count);
      }, intervalMs);
    };

    start();
    // Live-react to the OS motion preference toggling on/off.
    mq.addEventListener("change", start);

    return () => {
      stop();
      mq.removeEventListener("change", start);
    };
    // `key` fingerprints `values`; `count` is derived from it.
  }, [key, count, intervalMs]);

  if (count === 0) return "";
  // Modulo guards against `index` briefly outrunning a shrunken array between
  // the render that shortens `values` and the effect that resets `index`.
  return values[index % count] ?? values[0];
}
