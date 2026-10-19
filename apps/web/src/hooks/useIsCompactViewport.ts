"use client";

import { useEffect, useState } from "react";

/**
 * Viewport width (px) at which the shell switches to its mobile chrome.
 *
 * Deliberately the SAME number as `DEFAULT_DRAWER_BREAKPOINT` in
 * `packages/ui/src/ui/shell/NavigationShell.tsx` (960): the consumer bottom
 * nav and the admin bottom nav are the same affordance, so they must appear
 * and disappear at the same width. Change one, change both.
 */
export const COMPACT_VIEWPORT_BREAKPOINT = 960;

/**
 * Returns `true` when the viewport is narrower than
 * {@link COMPACT_VIEWPORT_BREAKPOINT}.
 *
 * Returns `false` during SSR and on the first client render (same contract as
 * {@link import("./useIsMobile").useIsMobile}) so nothing hydration-mismatches;
 * the real value arrives from `matchMedia` on mount.
 */
export function useIsCompactViewport(): boolean {
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(
      `(max-width: ${COMPACT_VIEWPORT_BREAKPOINT - 1}px)`,
    );
    const onChange = () => setIsCompact(mql.matches);
    onChange(); // sync on mount
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isCompact;
}
