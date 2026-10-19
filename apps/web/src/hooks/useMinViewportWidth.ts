"use client";

import { useEffect, useState } from "react";

/**
 * Returns `true` while the viewport is at least `minWidthPx` wide.
 *
 * Companion to {@link import("./useIsMobile").useIsMobile} and
 * {@link import("./useIsCompactViewport").useIsCompactViewport}, for surfaces
 * that need a breakpoint those two do not already name — /search, which drops
 * its facet rail and then its map pane as the window narrows.
 *
 * SSR CONTRACT, and it is the opposite of the two hooks above on purpose.
 * They answer "is this narrow?" and default to `false` (assume desktop); this
 * one answers "is there room?", so defaulting to `true` is the SAME
 * assumption. Every one of them paints the desktop layout first and corrects
 * on mount, which keeps the common case free of a first-frame reflow.
 */
export function useMinViewportWidth(minWidthPx: number): boolean {
  const [matches, setMatches] = useState(true);

  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${minWidthPx}px)`);
    const onChange = () => setMatches(mql.matches);
    onChange(); // sync on mount
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [minWidthPx]);

  return matches;
}
