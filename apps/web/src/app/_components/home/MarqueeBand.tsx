"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useRouter } from "@bprogress/next/app";

import { NextLinkAnchor } from "@th/ui";

import { ACCENT, ON_STRUCTURE, STRUCTURAL } from "@/lib/design-tokens";

// ─────────────────────────────────────────────────────────────────────────────
// "S2 Signal" marquee shell (v2 grammar) — the item-agnostic band machinery.
//
// A full-bleed band directly below the hero that scrolls a list of linked
// items. Content is caller-supplied (`MarqueeItem[]`): CityMarquee and
// EventMarquee are thin adapters over this shell. Seamless infinite loop via N
// identical copies translated 0 → -(one copy width). The v2 look is clean
// Swiss, NOT the old LED/stock-ticker aesthetic.
//
// Composition rule (do not "fix"): the page allows exactly ONE accent-dominant
// band, and S6 (HostConvertBand) already owns it. So this strip is an INK band
// — near-black #181818 fill, light primary text, muted-grey secondary text.
// Accent (#FF5721) appears ONLY as the tiny ◆ separator glyph and the focus
// ring, never as the band fill; links stay light (not links-blue).
//
// Seamless on FULL-BLEED: a two-copy loop only hides its restart seam when one
// copy is wider than the container. With as few as 3 short items on a 1920px
// desktop one copy is ~500px, so a blank ~1300px would sweep across every
// cycle. We measure one copy's width + the band width and render enough copies
// (N = ceil(bandW / copyW) + 1) that content always overruns the viewport, then
// animate by exactly one copy width so the wrap is invisible. Speed is constant
// in px/s regardless of N or content width: the duration is derived from the
// measured copy width (copyW / SPEED_PX_PER_SECOND), so a 12-item copy takes
// proportionally longer than a 3-item copy instead of flying past.
//
// A11y of the interactive loop: only the FIRST copy carries real, focusable,
// announced links. Every duplicate copy is aria-hidden with tabIndex={-1} links,
// so there is exactly ONE accessible link per item — no double focus stops, no
// focusable content inside aria-hidden. The scroll pauses on hover and
// focus-within so a moving item can be clicked/read.
//
// Self-hiding signal strip: renders null below `minItems` — no skeleton (a
// below-hero strip must not shift layout). It is NOT a numbered section and
// carries no ordinal.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Constant scroll speed, px/s. Duration is derived per-band from the measured
 * copy width (`copyW / SPEED_PX_PER_SECOND`) so the pixel speed never depends
 * on how much content the caller feeds in. 40px/s is a comfortable reading
 * speed for this 13px uppercase strip — roughly one short item label per
 * second, slow enough to read and click a moving link. (The old fixed 25s
 * "22–28s spec window" predates the event content and made speed scale with
 * copy width — a 12-event copy flew.)
 */
const SPEED_PX_PER_SECOND = 40;

/**
 * Duration for the un-measured first client frame only (shiftPx == null,
 * shift defaults to -50% of a two-copy track). Replaced by the derived
 * duration as soon as `recompute()` lands, typically before first paint.
 */
const FALLBACK_LOOP_SECONDS = 25;

export interface MarqueeSegment {
  text: string;
  tone: "primary" | "muted";
}

export interface MarqueeItem {
  key: string;
  href: string;
  ariaLabel: string;
  segments: MarqueeSegment[];
}

// Measure before paint on the client (so the copy count lands without a
// first-frame gap flash on wide viewports); a no-op useEffect during SSR to
// silence React's server-side useLayoutEffect warning.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

// ── Styles ───────────────────────────────────────────────────────────────────

const bandStyle: CSSProperties = {
  width: "100%",
  overflow: "hidden",
  position: "relative",
  boxSizing: "border-box",
  // `structure` IS "the ink band" (ink on Stub, steel blue on Ember) and pairs with `onStructure`.
  // Was `FOREGROUND`, which is now themed too — but `structure`/`onStructure` are the pair that
  // MEANS this, so the fill and its foreground move together by construction.
  backgroundColor: STRUCTURAL, // ink band — NOT accent
  borderRadius: 0,
};

const trackStyle: CSSProperties = {
  display: "flex",
  width: "max-content",
  alignItems: "center",
  // Fallback duration only — `dynamicTrackStyle` replaces this whole shorthand
  // with the constant-speed value once the copy width is measured.
  animation: `marquee-band-scroll ${FALLBACK_LOOP_SECONDS}s linear infinite`,
  willChange: "transform",
};

/** One measured copy of the item list. */
const copyStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexShrink: 0,
};

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexShrink: 0,
  whiteSpace: "nowrap",
  height: 40, // ≤ 44px per S2 spec
};

const linkStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8, // between segments
  textDecoration: "none",
  color: "inherit",
  cursor: "pointer",
  height: 40, // full-height hit target within the ≤44px band
  paddingInline: 2,
};

const primarySegmentStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: 13,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  // Routed to `onStructure` — the literal `white` here was correct only while `bandStyle` painted
  // a FIXED literal fill. It no longer does: the band is `STRUCTURAL`, so a fixed foreground would
  // be the drift the old note warned about, just inverted. `onStructure` is light in every theme
  // (paper #FDFAF3 on Stub, white on Ember) and is by definition the foreground for this fill —
  // 16.22:1. Fill and foreground now move as a UNIT.
  color: ON_STRUCTURE,
  lineHeight: 1,
};

const mutedSegmentStyle: CSSProperties = {
  fontWeight: 500,
  fontSize: 12,
  letterSpacing: 0.5,
  // Muted foreground on the band — a tint of the SAME `onStructure` the track uses, so it can't
  // drift off the fill. (Was a literal `palette.neutral300`, correct only while the band was fixed.)
  color: `color-mix(in srgb, ${ON_STRUCTURE} 70%, transparent)`,
  lineHeight: 1,
};

const separatorStyle: CSSProperties = {
  fontSize: 9,
  color: ACCENT, // the one sanctioned accent touch
  margin: "0 18px",
  lineHeight: 1,
  userSelect: "none",
};

// ── Keyframes + interaction CSS (injected once) ───────────────────────────────

const KEYFRAMES_ID = "marquee-band-scroll-keyframes";

function ensureKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement("style");
  style.id = KEYFRAMES_ID;
  // Shift distance comes from a per-element CSS var so we can scroll by exactly
  // one measured copy width regardless of how many copies are rendered. Default
  // -50% keeps the two-copy pre-measurement render seamless.
  //
  // Pause on hover so a moving item can be clicked (mouse). Keyboard focus is
  // handled in JS instead — it DISABLES the animation (animation:none) and pins
  // the track via inline transform, because a merely *paused* animation still
  // wins over an inline transform. Reduced motion parks the track statically.
  // focus-visible ring uses the accent (a focus ring, not band fill); hover /
  // keyboard focus underlines the primary text so it reads as clickable.
  style.textContent = `
    @keyframes marquee-band-scroll {
      from { transform: translateX(0); }
      to { transform: translateX(var(--marquee-band-shift, -50%)); }
    }
    .marquee-band-track:hover {
      /* !important: the track's animation is an INLINE shorthand (which resets
         play-state to running and outranks any non-important stylesheet rule),
         so without it this pause never applies — same reason the reduced-motion
         park below needs it. */
      animation-play-state: paused !important;
    }
    .marquee-band-link:hover .marquee-band-primary,
    .marquee-band-link:focus-visible .marquee-band-primary {
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .marquee-band-link:focus-visible {
      outline: 2px solid ${ACCENT};
      outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      .marquee-band-track { animation: none !important; }
    }
  `;
  document.head.appendChild(style);
}

// ── Component ──────────────────────────────────────────────────────────────────

export function MarqueeBand({
  items,
  minItems = 3,
  sectionAriaLabel,
}: {
  items: MarqueeItem[];
  /** Below this the strip stays hidden — a thin marquee reads as broken chrome. */
  minItems?: number;
  sectionAriaLabel: string;
}) {
  const router = useRouter();

  const bandRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  // Start at 2 copies (safe default = old -50% behavior); grow after measuring.
  const [copyCount, setCopyCount] = useState(2);
  const [shiftPx, setShiftPx] = useState<number | null>(null);
  // Keyboard focus override: while a copy-0 link is focused we DISABLE the
  // animation and pin the track so the focused link (+ its ring) is inside the
  // clipped band. null = not focused (animate normally). See WCAG 2.4.7 note.
  const [focusShiftPx, setFocusShiftPx] = useState<number | null>(null);

  // Hover/focus prefetch — only the pointed-at item, so a 20-link marquee
  // doesn't eagerly prefetch every target page. Wired to first-copy links only.
  const prefetchHref = useCallback(
    (href: string) => {
      try {
        router.prefetch(href);
      } catch {
        // best-effort — a failed prefetch must never break interaction
      }
    },
    [router],
  );

  // On focus, pin the track so the focused link is fully visible in the band.
  // offsetInTrack is transform-invariant: subtracting the track's rect (which
  // already carries the current animation transform) from the anchor's rect
  // cancels the transform, leaving the anchor's static layout offset within the
  // track content. Clamp to [0, trackW - bandW] so we never reveal a blank edge.
  const bringFocusIntoView = useCallback((anchor: HTMLElement) => {
    const track = trackRef.current;
    const band = bandRef.current;
    if (!track || !band) return;
    const PAD = 16;
    const offsetInTrack =
      anchor.getBoundingClientRect().left - track.getBoundingClientRect().left;
    const maxShift = Math.max(0, track.scrollWidth - band.clientWidth);
    const target = Math.min(Math.max(offsetInTrack - PAD, 0), maxShift);
    setFocusShiftPx(-target);
  }, []);

  useEffect(() => {
    ensureKeyframes();
  }, []);

  // Measure one copy + the (full-bleed) band and render enough copies that the
  // content always exceeds the viewport, so no blank gap sweeps through.
  // Worst case with the copy fully shifted out is |t| = copyW; content must
  // still fill from copyW to copyW + bandW, i.e. copyW + bandW ≤ N·copyW ⇒
  // N ≥ bandW/copyW + 1. Idempotent: re-running with more copies doesn't change
  // the measured copyW/bandW, so it converges immediately (no render loop).
  const recompute = useCallback(() => {
    const band = bandRef.current;
    const copy = copyRef.current;
    if (!band || !copy) return;
    const bandW = band.clientWidth;
    const copyW = copy.getBoundingClientRect().width;
    if (copyW <= 0 || bandW <= 0) return;
    const needed = Math.max(2, Math.ceil(bandW / copyW) + 1);
    setCopyCount(needed);
    setShiftPx(copyW);
  }, []);

  useIsomorphicLayoutEffect(() => {
    // Refs only exist once the band renders (items ≥ minItems).
    const band = bandRef.current;
    const copy = copyRef.current;
    if (!band || !copy) return;
    recompute();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(band);
    ro.observe(copy);
    return () => ro.disconnect();
  }, [recompute, items]);

  // Self-hide when thin — no skeleton (avoids layout shift below the hero).
  // Callers surface loading/error as an empty list, so those hide too.
  if (items.length < minItems) return null;

  // `decorative` copies (every copy after the first) are aria-hidden and their
  // links are removed from the tab order — the first copy is the sole
  // accessible layer, so each item is announced/focusable exactly once.
  const renderItem = (item: MarqueeItem, decorative: boolean): ReactNode => (
    <div key={`${item.key}-${decorative ? "d" : "a"}`} style={itemStyle}>
      <NextLinkAnchor
        href={item.href}
        prefetch={false}
        className="marquee-band-link"
        style={linkStyle}
        tabIndex={decorative ? -1 : undefined}
        aria-hidden={decorative ? true : undefined}
        aria-label={item.ariaLabel}
        onMouseEnter={decorative ? undefined : () => prefetchHref(item.href)}
        onFocus={
          decorative
            ? undefined
            : (e) => {
                prefetchHref(item.href);
                bringFocusIntoView(e.currentTarget as HTMLElement);
              }
        }
      >
        {item.segments.map((segment, i) => (
          <span
            // Positional content, not a reorderable list — index keys are fine.
            key={i}
            className={
              segment.tone === "primary" ? "marquee-band-primary" : undefined
            }
            style={
              segment.tone === "primary"
                ? primarySegmentStyle
                : mutedSegmentStyle
            }
          >
            {segment.text}
          </span>
        ))}
      </NextLinkAnchor>
      {/* Trailing separator keeps the copy→copy seam spacing identical to the
          within-copy spacing. Decorative — not part of any link. */}
      <span style={separatorStyle} aria-hidden="true">
        {"◆"}
      </span>
    </div>
  );

  // While a link is focused, disable the animation and pin the track — a paused
  // animation's transform would otherwise override the inline one, leaving the
  // focused link (and ring) clipped outside the band (WCAG 2.4.7).
  //
  // Constant speed: once measured, the duration is derived from the copy width
  // so pixel speed stays SPEED_PX_PER_SECOND regardless of content. The whole
  // `animation` SHORTHAND is owned here — never a shorthand + longhand mix,
  // which React's per-key style diffing mishandles (re-applying the shorthand
  // on blur while skipping the "unchanged" longhand would silently revert to
  // the fallback duration). `shiftPx` is React state and `recompute()` sets
  // the same value on no-op resize ticks, so the style (and any
  // duration-change restart) only updates when the width actually changes.
  const dynamicTrackStyle = {
    ...trackStyle,
    animation:
      focusShiftPx != null
        ? "none"
        : shiftPx != null
          ? `marquee-band-scroll ${shiftPx / SPEED_PX_PER_SECOND}s linear infinite`
          : trackStyle.animation, // pre-measure fallback (FALLBACK_LOOP_SECONDS, -50%)
    "--marquee-band-shift": shiftPx != null ? `-${shiftPx}px` : "-50%",
    ...(focusShiftPx != null
      ? { transform: `translateX(${focusShiftPx}px)` }
      : {}),
  } as CSSProperties;

  return (
    <section aria-label={sectionAriaLabel} ref={bandRef} style={bandStyle}>
      {/* Scrolling track: N identical copies for a seamless loop. Only the
          first copy is accessible (real links); the rest are decorative
          (aria-hidden, tabIndex=-1). Pauses on hover/focus-within so a moving
          item is clickable; parks statically under prefers-reduced-motion. */}
      <div
        className="marquee-band-track"
        ref={trackRef}
        style={dynamicTrackStyle}
        // Clear the focus pin only when focus leaves the track entirely — Tabbing
        // between copy-0 links keeps it pinned (each link's onFocus re-pins), so
        // no flicker; leaving resumes the animation from translateX(0).
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setFocusShiftPx(null);
        }}
      >
        {Array.from({ length: copyCount }, (_, g) => {
          const decorative = g > 0;
          return (
            <div
              key={g}
              ref={g === 0 ? copyRef : undefined}
              style={copyStyle}
              aria-hidden={decorative ? true : undefined}
            >
              {items.map((item) => renderItem(item, decorative))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

MarqueeBand.displayName = "MarqueeBand";
