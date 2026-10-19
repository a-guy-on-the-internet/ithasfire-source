"use client";

import { useEffect, useState } from "react";

/**
 * Breakpoint (px) below which the web UI switches to mobile layout. Exported so
 * CSS-driven layouts (AppNavbar's media queries) switch at the same pixel.
 */
export const MOBILE_BREAKPOINT = 600;

/**
 * Returns `true` when the viewport is narrower than `MOBILE_BREAKPOINT`.
 *
 * Falls back to `false` during SSR / first render to avoid hydration mismatch,
 * then syncs via `matchMedia` on mount.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => setIsMobile(mql.matches);
    onChange(); // sync on mount
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
