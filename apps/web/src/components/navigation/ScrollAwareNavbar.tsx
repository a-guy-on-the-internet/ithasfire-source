"use client";

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useIsDarkTheme } from "@/hooks/useIsDarkTheme";
import { setNavbarVisibleHeight } from "@/components/navigation/navbar-offset-store";
import { useNavbarHeldShown } from "@/components/navigation/navbar-hold-store";

// ── Constants ────────────────────────────────────────────────────────────
/** Distance (px) the user must scroll before the navbar begins to hide. */
const SCROLL_THRESHOLD = 80;

/** Minimum scroll delta (px) per frame to trigger show/hide. Prevents jitter. */
const SCROLL_DELTA_MIN = 8;

/** Height of the navbar (px) — used for slide-out offset. */
const NAV_HEIGHT = 68;

// ── Styles ───────────────────────────────────────────────────────────────

/**
 * CSS transition with a custom cubic-bezier that gives the bar a snappy
 * "bounce out / bounce in" personality. The overshoot at ~1.04 creates
 * the subtle elastic pop without a full spring physics engine.
 *
 * `will-change: transform` promotes to its own compositor layer so the
 * translation is GPU-accelerated and doesn't trigger layout reflows.
 */
/*
 * Both spellings stay listed here on purpose. This is a `transition-property`
 * *value* (unknown idents are ignored at runtime), not a property declaration,
 * so it is not subject to the Lightning CSS prefix-collapse that forces
 * `backdrop-filter` to be declared unprefixed-only in globals.css. Old Safari
 * animates the `-webkit-` name and won't match the standard one, so keeping the
 * prefixed entry preserves the fade there; it is inert everywhere else.
 */
const BG_TRANSITION =
  "background-color 300ms ease, backdrop-filter 300ms ease, -webkit-backdrop-filter 300ms ease, border-color 300ms ease";
const TRANSITION_BOUNCE = `transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1), ${BG_TRANSITION}`;
const TRANSITION_REDUCED = `transform 200ms ease-out, ${BG_TRANSITION}`;

// ── Component ────────────────────────────────────────────────────────────

interface ScrollAwareNavbarProps {
  children: ReactNode;
}

/**
 * Wraps the consumer navbar with scroll-aware slide behavior:
 *
 * Once the user scrolls past `SCROLL_THRESHOLD`, the navbar slides up and
 * out of view with a bouncy easing curve. Scrolling back up reveals it
 * again with the same elastic snap.
 *
 * Respects `prefers-reduced-motion`: when enabled, the transition is a
 * simple ease-out with no overshoot.
 */
/** Scroll distance (px) before the navbar backdrop fills in. */
const BACKDROP_THRESHOLD = 24;

/** Breakpoint (px) below which the navbar hides on scroll. Desktop stays pinned. */
const MOBILE_BREAKPOINT = 768;

export function ScrollAwareNavbar({ children }: ScrollAwareNavbarProps) {
  // What the SCROLL wants. The bar is only actually hidden when nothing is
  // holding it shown — an overlay hanging off the navbar (the alerts panel)
  // takes a hold while it is open, because restoring focus to a trigger that
  // scrolled off the top lands the user nowhere they can see.
  const [hiddenByScroll, setHiddenByScroll] = useState(false);
  const heldShown = useNavbarHeldShown();
  // The scroll handler is a stable callback, so it reads the hold through a
  // ref rather than closing over a stale value.
  const heldShownRef = useRef(heldShown);
  // Derived, never a second piece of state: a stored copy of this would drift
  // from the two inputs that feed it.
  const hidden = hiddenByScroll && !heldShown;
  const [scrolledPastTop, setScrolledPastTop] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Measured layout height of the bar (px). Published to the navbar-offset
  // store so the page-action bar (sticky inside the content area, a sibling
  // of this wrapper) can pin itself just under the navbar.
  const [measuredHeight, setMeasuredHeight] = useState(0);
  // Theme-aware navbar chrome: "ember" = dark (navy glass + white text/logo),
  // else Stub/light (paper glass + ink text/logo). The wrapper's CSS branches
  // on `data-navbar-theme`; keeps the bar legible against whichever theme the
  // hero renders under. Same detection HomeHero/AppNavbar use.
  const isDark = useIsDarkTheme();
  const lastScrollY = useRef(0);
  const ticking = useRef(false);
  const prefersReduced = useRef(false);
  const isMobile = useRef(false);

  useEffect(() => {
    prefersReduced.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    isMobile.current = window.innerWidth < MOBILE_BREAKPOINT;

    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => {
      isMobile.current = e.matches;
      if (!e.matches) setHiddenByScroll(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const handleScroll = useCallback(() => {
    if (ticking.current) return;

    ticking.current = true;
    requestAnimationFrame(() => {
      const currentY = window.scrollY;
      const delta = currentY - lastScrollY.current;

      setScrolledPastTop(currentY > BACKDROP_THRESHOLD);

      // Desktop: never hide — glass lets content show through.
      // Mobile: hide on scroll-down to reclaim screen real estate.
      if (isMobile.current && Math.abs(delta) >= SCROLL_DELTA_MIN) {
        // Not while held: the page can still scroll under the open panel
        // (iOS Safari only half honours `body { overflow: hidden }`), and an
        // intent recorded now would slide the bar away the moment the hold is
        // released, taking the bell that just got focus back with it.
        if (delta > 0 && currentY > SCROLL_THRESHOLD) {
          if (!heldShownRef.current) setHiddenByScroll(true);
        } else if (delta < 0) {
          setHiddenByScroll(false);
        }
      }

      if (currentY <= SCROLL_THRESHOLD / 2) {
        setHiddenByScroll(false);
      }

      lastScrollY.current = currentY;
      ticking.current = false;
    });
  }, []);

  useEffect(() => {
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // Track the bar's real height (the navbar reflows with the viewport and its
  // trailing controls), then publish the VISIBLE height — 0 while slid away —
  // so the page-action bar's `top` follows it. Cleared on unmount so an admin
  // shell (which has no scroll-aware navbar) never inherits a stale offset.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const update = () => setMeasuredHeight(el.offsetHeight);
    update();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);

  // A hold does not merely SUSPEND the hide, it cancels it. Releasing a
  // suspension would slide the bar away again the instant the overlay closed,
  // which puts the focus it just restored back on an off-screen trigger — the
  // whole defect this exists to fix. Clearing the scroll's own intent instead
  // leaves the bar shown until the user scrolls DOWN again, the same state a
  // scroll-up reveal leaves behind.
  useEffect(() => {
    heldShownRef.current = heldShown;
    if (heldShown) setHiddenByScroll(false);
  }, [heldShown]);

  useEffect(() => {
    setNavbarVisibleHeight(hidden ? 0 : measuredHeight);
  }, [hidden, measuredHeight]);

  useEffect(() => () => setNavbarVisibleHeight(0), []);

  return (
    <div
      ref={wrapperRef}
      className="swiss-navbar-wrapper"
      data-navbar-state={scrolledPastTop ? "solid" : "transparent"}
      data-navbar-theme={isDark ? "dark" : "light"}
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        // Slide transform
        transform: hidden
          ? `translateY(-${NAV_HEIGHT + 20}px)`
          : "translateY(0)",
        transition: prefersReduced.current
          ? TRANSITION_REDUCED
          : TRANSITION_BOUNCE,
        willChange: "transform",
        // Disable pointer events when hidden so content below is interactive.
        pointerEvents: hidden ? "none" : "auto",
      }}
    >
      <div style={{ position: "relative" }}>{children}</div>
    </div>
  );
}

ScrollAwareNavbar.displayName = "ScrollAwareNavbar";
