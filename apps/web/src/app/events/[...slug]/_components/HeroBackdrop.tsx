"use client";

import { useEffect, useRef } from "react";

/**
 * Full-bleed blurred hero image that sits behind the event detail page.
 *
 * - `position: fixed` so the backdrop spans the entire viewport width
 *   regardless of the content column's max-width.
 * - Parallax: the backdrop scrolls at ~35 % of the page scroll speed,
 *   giving a subtle depth illusion without a heavy library.
 * - A gradient overlay fades the image into the page background so lower
 *   sections remain clean and readable.
 * - Renders nothing when no image URL is provided.
 * - Does NOT affect document flow (no extra space at bottom).
 *
 * THE WINDOW. A page that only wants the backdrop behind part of itself marks
 * the element where it should end with `data-hero-backdrop-window` (the
 * poster-first event page marks its fade). The backdrop then clips itself to
 * that element's bottom edge on every frame. Without the clip the fixed layer
 * sat under the whole page and showed through anything transparent below it —
 * the site footer rendered as a muddy blur of the poster. The page brings its
 * own scrim there (the band), so the veil below is dropped in CSS
 * (`.hero-backdrop__veil`, event-content.css).
 */

const PARALLAX_SPEED = 0.35;
const WINDOW_SELECTOR = "[data-hero-backdrop-window]";

export function HeroBackdrop({ imageUrl }: { imageUrl?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!imageUrl) return;
    const root = rootRef.current;
    const el = ref.current;
    if (!root || !el) return;

    // Reduced motion skips the parallax, never the clip.
    const parallax = !window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches;

    const update = () => {
      // Queried per frame, not once: the page mounts the window after this
      // effect may already have run, and it moves as fonts and data land.
      // Both rects are read before any write, so no forced recalc.
      const win = document.querySelector(WINDOW_SELECTOR);
      const cut = win
        ? Math.max(
            0,
            root.getBoundingClientRect().bottom -
              win.getBoundingClientRect().bottom,
          )
        : null;
      if (parallax) {
        const y = window.scrollY * PARALLAX_SPEED;
        el.style.transform = `translate3d(0, -${y}px, 0)`;
      }
      root.style.clipPath = cut === null ? "" : `inset(0 0 ${cut}px 0)`;
    };

    let ticking = false;
    let frame = 0;
    const schedule = () => {
      if (ticking) return;
      ticking = true;
      frame = requestAnimationFrame(() => {
        update();
        ticking = false;
      });
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // Layout above the window can change with no scroll at all (a font swap
    // re-wrapping the title, the address reveal): follow the page's height.
    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [imageUrl]);

  if (!imageUrl) return null;

  return (
    /*
     * Fixed full-viewport container — sits behind all page content.
     * Uses `position: fixed` + `inset: 0` to guarantee full-bleed
     * even when the nearest parent has a max-width constraint.
     * `pointer-events: none` keeps it non-interactive.
     */
    <div
      ref={rootRef}
      aria-hidden
      /*
       * `hero-backdrop` is a styling CONTRACT, not decoration: globals.css uses
       * `body:has(.hero-backdrop)` to keep the top navbar on its frosted glass
       * instead of going fully transparent at the top of the page. Without it
       * the bar's ink chrome lands straight on this poster and disappears on
       * any dark image. Any future full-bleed backdrop under the app shell
       * should carry the same class.
       */
      className="hero-backdrop"
      style={{
        position: "fixed",
        // `inset: 0`, NOT `width: 100vw/100vh`: viewport units include the
        // scrollbar gutter on desktop and track the (stretchable) mobile
        // layout viewport, both of which can leave a fixed element wider
        // than the visible screen. Edge-pinned insets always match the
        // fixed containing block exactly.
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      {/* Blurred image layer — oversized to hide blur edge artefacts */}
      <div
        ref={ref}
        style={{
          position: "absolute",
          top: -60,
          left: -60,
          right: -60,
          /* Extra tall so parallax shift never reveals an empty gap */
          bottom: -60,
          backgroundImage: `url(${imageUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          filter: "blur(44px) saturate(1.4)",
          WebkitFilter: "blur(44px) saturate(1.4)",
          willChange: "transform",
          transform: "translate3d(0, 0, 0)" /* GPU-composite from the start */,
        }}
      />

      {/* Gradient fade-out overlay */}
      <div
        className="hero-backdrop__veil"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          background: [
            /* Top: slight darkening for nav/back link readability */
            "linear-gradient(to bottom, rgba(0,0,0,0.3) 0%, transparent 25%)",
            /* Bottom: solid fade into the page background colour. The fallback
               MUST be the Stub cream (#F6F0E4, the `--background` primitive) —
               it is what SSR/first paint renders before the theme injector
               resolves the var. A dark fallback here painted a navy band under
               the whole lower page on first paint (a DS dark-first-paint bug). */
            "linear-gradient(to top, var(--background, #F6F0E4) 0%, rgba(0,0,0,0.6) 50%, transparent 100%)",
          ].join(", "),
        }}
      />
    </div>
  );
}
