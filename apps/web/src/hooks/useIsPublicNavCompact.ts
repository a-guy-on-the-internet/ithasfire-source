"use client";

import { useEffect, useState } from "react";

/**
 * Viewport width (px) below which the public top bar sheds its overflow into
 * the hamburger sheet.
 *
 * This is the design system folder's number: `MobileNavSheet.prompt.md` opens
 * with "The public nav below 900px". The folder does not agree with itself —
 * its own CSS switches the burger in at `max-width:1100px`
 * (`navigation.css:33`) — and 900 is the one the prompt states, so 900 is what
 * we build to.
 *
 * It is deliberately NOT any of the three numbers already in the codebase:
 *
 * - `MOBILE_BREAKPOINT` (600, {@link import("./useIsMobile").useIsMobile}) is
 *   the point where the bar runs out of horizontal room and drops to identity +
 *   account. That is a space budget, not a navigation decision, and it still
 *   governs the bell, the saved-heart and the My Tickets button.
 * - `COMPACT_VIEWPORT_BREAKPOINT` (960,
 *   {@link import("./useIsCompactViewport").useIsCompactViewport}) governs the
 *   bottom nav and the admin drawer — a different affordance, which is why the
 *   two are not shared.
 *
 * So the public nav collapses in two stages: below 900 the burger appears and
 * the set-once preferences (theme, language) move into the sheet; below 600 the
 * narrow bar takes over entirely. Between them the bar keeps the controls it
 * still has room for, which is what stops the sheet from duplicating a toggle
 * sitting visibly next to it.
 */
export const PUBLIC_NAV_BREAKPOINT = 900;

/**
 * Returns `true` when the viewport is narrower than
 * {@link PUBLIC_NAV_BREAKPOINT}.
 *
 * Returns `false` during SSR and on the first client render (same contract as
 * {@link import("./useIsMobile").useIsMobile}) so nothing hydration-mismatches;
 * the real value arrives from `matchMedia` on mount.
 */
export function useIsPublicNavCompact(): boolean {
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(
      `(max-width: ${PUBLIC_NAV_BREAKPOINT - 1}px)`,
    );
    const onChange = () => setIsCompact(mql.matches);
    onChange(); // sync on mount
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isCompact;
}
