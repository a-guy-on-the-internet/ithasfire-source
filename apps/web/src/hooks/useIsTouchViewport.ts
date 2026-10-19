"use client";

import { useEffect, useState } from "react";

/**
 * Mobile/touch presentation gate: viewport at or below the seat-map mobile
 * breakpoint AND a coarse primary pointer (real touch devices + DevTools
 * device emulation). Desktop windows (>900px or fine pointer) never match,
 * so mouse/keyboard behavior there is untouched.
 */
const TOUCH_VIEWPORT_QUERY = "(max-width: 900px) and (pointer: coarse)";

/**
 * Returns `true` on touch-first viewports (phones, small tablets).
 *
 * Falls back to `false` during SSR / first render to avoid hydration
 * mismatch, then syncs via `matchMedia` on mount.
 */
export function useIsTouchViewport(): boolean {
  const [isTouchViewport, setIsTouchViewport] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(TOUCH_VIEWPORT_QUERY);
    const onChange = () => setIsTouchViewport(mql.matches);
    onChange(); // sync on mount
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isTouchViewport;
}
