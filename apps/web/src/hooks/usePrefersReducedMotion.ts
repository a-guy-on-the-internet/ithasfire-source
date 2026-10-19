"use client";

import { useEffect, useState } from "react";

/**
 * Returns `true` when the user has requested reduced motion
 * (`prefers-reduced-motion: reduce`).
 *
 * SSR-safe: defaults to `false` on the server / first render, then syncs via
 * `matchMedia` on mount and stays in sync with system preference changes.
 * Mirrors the inline pattern used in FeaturedHeroCarousel so motion handling is
 * consistent across the home surfaces.
 */
export function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (event: MediaQueryListEvent) =>
      setReducedMotion(event.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return reducedMotion;
}
