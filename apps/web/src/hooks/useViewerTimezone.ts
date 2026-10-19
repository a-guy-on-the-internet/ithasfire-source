"use client";

import { useEffect, useState } from "react";

/** What the server (and the first client paint) assume when no better zone is known. */
export const DEFAULT_VIEWER_TIMEZONE = "America/Chicago";

/**
 * The viewer's browser zone, SSR-safe (event-calendar-redesign FR-018).
 *
 * Reading `Intl.DateTimeFormat().resolvedOptions().timeZone` during render
 * would differ between the server and the browser, so the first render
 * returns `fallback` on BOTH sides (no hydration drift) and the real zone
 * lands in an effect right after mount. Callers pass the best server-side
 * guess they have — a place mount passes the venue zone, a dashboard the
 * owner's most common event zone — and get the browser's answer afterwards.
 */
export function useViewerTimezone(
  fallback: string = DEFAULT_VIEWER_TIMEZONE,
): string {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    try {
      const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (resolved) setZone(resolved);
    } catch {
      // An exotic runtime with no Intl zone support keeps the fallback.
    }
  }, []);
  return zone ?? fallback;
}
