/**
 * SpotlightSearch — shared inline-style objects.
 *
 * Extracted verbatim from `SpotlightSearch.tsx` so the admin facet row
 * (`SpotlightAdminFacets.tsx`) can reuse the exact same pill / panel / label
 * treatments instead of forking a second set that drifts.
 *
 * ── Swiss International Style ──────────────────────────────────────────
 *   No border-radius. Thick structural borders. Uppercase labels.
 *   Orange for action, structural ink for structure.
 *
 * Colours come from `@/lib/design-tokens` (theme-tracking `var(--token, hex)`
 * strings) or a `var(--token, <stub-hex>)` literal — never a bare hex.
 */

import type { CSSProperties } from "react";

import {
  ACCENT,
  ACCENT_FILL,
  ACCENT_TEXT,
  ON_ACCENT_FILL,
  ON_STRUCTURE,
  STRUCTURAL,
} from "@/lib/design-tokens";

export const styles = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 9999,
    backgroundColor: "rgba(15, 27, 51, 0.72)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: "min(12vh, 120px)",
    paddingLeft: 16,
    paddingRight: 16,
  } satisfies CSSProperties,

  panel: {
    width: "100%",
    maxWidth: 640,
    backgroundColor: "var(--surface, #FDFAF3)",
    border: `2px solid var(--borderColorStrong, ${STRUCTURAL})`,
    borderRadius: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    maxHeight: "min(70vh, 560px)",
  } satisfies CSSProperties,

  inputRow: {
    display: "flex",
    alignItems: "center",
    borderBottom: "2px solid var(--borderColor, #211C16)",
    height: 56,
    paddingLeft: 16,
    paddingRight: 8,
    gap: 12,
  } satisfies CSSProperties,

  input: {
    flex: 1,
    // Without minWidth: 0, the input refuses to shrink below its
    // `placeholder` text width inside a flex row — pushing the close
    // button (and the whole panel content) past the panel edge on
    // narrow viewports.
    minWidth: 0,
    width: "100%",
    height: "100%",
    border: "none",
    backgroundColor: "transparent",
    fontSize: 16,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    fontWeight: 500,
    color: "var(--color, #211C16)",
    letterSpacing: "0.01em",
  } satisfies CSSProperties,

  closeButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    border: "1px solid var(--borderColor, #211C16)",
    borderRadius: 0,
    backgroundColor: "transparent",
    cursor: "pointer",
    flexShrink: 0,
    color: "var(--colorMuted, #5C544A)",
    transition: "background-color 120ms ease-out, color 120ms ease-out",
  } satisfies CSSProperties,

  pillsRow: {
    display: "flex",
    gap: 6,
    padding: "8px 16px",
    borderBottom: "1px solid var(--borderColor, #211C16)",
    flexWrap: "wrap",
  } satisfies CSSProperties,

  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 10px",
    border: "1px solid var(--borderColor, #211C16)",
    borderRadius: 0,
    backgroundColor: "transparent",
    cursor: "pointer",
    fontSize: 11,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--colorMuted, #5C544A)",
    transition: "all 120ms ease-out",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,

  /**
   * Touch-target override (NFR-003). The desktop pill is ~23px tall — well
   * under the 44px floor — so mobile grows the padding instead of the type,
   * keeping the desktop density untouched.
   */
  pillMobile: {
    padding: "12px 14px",
    minHeight: 44,
    fontSize: 12,
  } satisfies CSSProperties,

  /**
   * `border` (shorthand), not `borderColor` — `pill` sets the shorthand, and
   * mixing the two makes React warn ("Removing a style property during
   * rerender…") and drop the colour every time a pill toggles off.
   */
  pillActive: {
    backgroundColor: STRUCTURAL,
    border: `1px solid ${STRUCTURAL}`,
    color: ON_STRUCTURE,
  } satisfies CSSProperties,

  /**
   * An ACTIVE facet pill carries a label on an accent fill, so it rests on the
   * `#B93312` rung (white 5.92:1). `ACCENT` #E2481D behind small text is 4.06:1
   * — under AA in both polarities. Same trade the geo pill already makes.
   */
  pillAccent: {
    backgroundColor: ACCENT_FILL,
    border: `1px solid ${ACCENT_FILL}`,
    color: ON_ACCENT_FILL,
  } satisfies CSSProperties,

  resultsArea: {
    flex: 1,
    overflowY: "auto",
    padding: 0,
  } satisfies CSSProperties,

  groupHeader: {
    padding: "10px 16px 6px",
    fontSize: 10,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    // Accent as TEXT → the #B93312 rung (5.22:1 on cream). `ACCENT` #E2481D as 10px text is ~3.6:1.
    color: ACCENT_TEXT,
    borderBottom: "1px solid var(--borderColor, #211C16)",
  } satisfies CSSProperties,

  resultItem: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    cursor: "pointer",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    transition: "background-color 100ms ease-out",
    minHeight: 48,
  } satisfies CSSProperties,

  resultItemActive: {
    backgroundColor: "var(--surfaceMuted, #EFE7D6)",
  } satisfies CSSProperties,

  resultIcon: {
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--borderColor, #211C16)",
    borderRadius: 0,
    flexShrink: 0,
    color: STRUCTURAL,
  } satisfies CSSProperties,

  resultTitle: {
    fontSize: 14,
    fontWeight: 700,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    color: "var(--color, #211C16)",
    lineHeight: 1.3,
  } satisfies CSSProperties,

  resultSubtitle: {
    fontSize: 12,
    fontWeight: 400,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    color: "var(--colorMuted, #5C544A)",
    lineHeight: 1.3,
  } satisfies CSSProperties,

  /**
   * Admin rows only — an attendee subtitle carries an email PLUS up to three
   * event titles, which wraps to four lines on a phone. Clamp it to one line;
   * the consumer subtitle keeps its wrapping behaviour untouched.
   */
  resultSubtitleClamp: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } satisfies CSSProperties,

  emptyState: {
    padding: "32px 16px",
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
  } satisfies CSSProperties,

  emptyTitle: {
    fontSize: 13,
    fontWeight: 700,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--color, #211C16)",
  } satisfies CSSProperties,

  emptyHint: {
    fontSize: 12,
    fontWeight: 400,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    color: "var(--colorMuted, #5C544A)",
    maxWidth: 280,
  } satisfies CSSProperties,

  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 16px",
    borderTop: "2px solid var(--borderColor, #211C16)",
    fontSize: 11,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    fontWeight: 500,
    color: "var(--colorMuted, #5C544A)",
    gap: 12,
  } satisfies CSSProperties,

  footerAction: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    // The #B93312 rung, NOT `--accent`: this 11px/700 pill needs AA (4.5:1) and white on #E2481D is
    // 4.06:1. On the rung it is 5.92:1. (The old `${STRUCTURAL}` fallback was also a mismatch — ink,
    // not an accent value.)
    border: `1px solid ${ACCENT_FILL}`,
    borderRadius: 0,
    backgroundColor: ACCENT_FILL,
    color: ON_ACCENT_FILL,
    cursor: "pointer",
    fontSize: 11,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    transition: "opacity 120ms ease-out",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,

  // Secondary footer action (Surprise me) — outlined/neutral so it reads as
  // chrome next to the accent-filled "View all" primary.
  footerActionSecondary: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    border: "1px solid var(--borderColorStrong, #000000)",
    borderRadius: 0,
    backgroundColor: "transparent",
    color: "var(--color, #211C16)",
    cursor: "pointer",
    fontSize: 11,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    transition: "background-color 120ms ease-out",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,

  kbd: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 20,
    height: 20,
    padding: "0 4px",
    border: "1px solid var(--borderColor, #211C16)",
    borderRadius: 0,
    fontSize: 10,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    fontWeight: 700,
    color: "var(--colorMuted, #5C544A)",
    backgroundColor: "var(--surfaceMuted, #EFE7D6)",
    lineHeight: 1,
  } satisfies CSSProperties,

  kbdRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  } satisfies CSSProperties,

  loadingDot: {
    width: 6,
    height: 6,
    backgroundColor: ACCENT,
    borderRadius: 0,
    animation: "spotlight-pulse 800ms ease-in-out infinite",
  } satisfies CSSProperties,

  /** Screen-reader-only live region (counts on settle — NFR-003). */
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
  } satisfies CSSProperties,

  // ── Geo panel styles ──────────────────────────────────────────────
  geoPanel: {
    padding: "10px 16px 12px",
    borderBottom: "2px solid var(--borderColor, #211C16)",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } satisfies CSSProperties,

  geoPanelRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  } satisfies CSSProperties,

  geoLabel: {
    fontSize: 10,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    color: STRUCTURAL,
  } satisfies CSSProperties,

  geoLocationBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    border: `1px solid ${STRUCTURAL}`,
    borderRadius: 0,
    fontSize: 11,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    fontWeight: 700,
    color: STRUCTURAL,
    backgroundColor: "transparent",
    maxWidth: 240,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,

  geoSlider: {
    flex: 1,
    minWidth: 120,
    height: 4,
    appearance: "none",
    backgroundColor: "var(--borderColor, #211C16)",
    cursor: "pointer",
  } satisfies CSSProperties,

  geoRadiusValue: {
    fontSize: 11,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    fontWeight: 700,
    // Accent as TEXT (the radius value) → the #B93312 rung; `ACCENT` #E2481D at 11px is ~3.6:1.
    color: ACCENT_TEXT,
    minWidth: 48,
    textAlign: "right",
  } satisfies CSSProperties,

  geoClearButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    border: "1px solid var(--borderColor, #211C16)",
    borderRadius: 0,
    backgroundColor: "transparent",
    cursor: "pointer",
    color: "var(--colorMuted, #5C544A)",
    padding: 0,
  } satisfies CSSProperties,

  /** 44px floor for the small square clear buttons on touch (NFR-003). */
  geoClearButtonMobile: {
    width: 44,
    height: 44,
  } satisfies CSSProperties,

  unitToggle: {
    display: "inline-flex",
    alignItems: "center",
    padding: "3px 8px",
    border: `1px solid ${STRUCTURAL}`,
    borderRadius: 0,
    backgroundColor: "transparent",
    cursor: "pointer",
    fontSize: 10,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    color: STRUCTURAL,
    minWidth: 36,
    justifyContent: "center",
  } satisfies CSSProperties,

  // ── Admin facet row (FR-004) ──────────────────────────────────────
  /**
   * Second pill row, under the entity pills. Hairline top rule only — the
   * entity row already draws the 1px separator above it, so this reads as one
   * two-line control block rather than two stacked bands.
   */
  facetRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 16px",
    borderBottom: "1px solid var(--borderColor, #211C16)",
    flexWrap: "wrap",
  } satisfies CSSProperties,

  /** Expander body — mirrors the geo panel so the two read as one pattern. */
  facetPanel: {
    padding: "10px 16px 12px",
    borderBottom: "2px solid var(--borderColor, #211C16)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } satisfies CSSProperties,

  facetOptionRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  } satisfies CSSProperties,

  /** Category lists can run long — cap the panel and scroll inside it. */
  facetScroll: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    maxHeight: 148,
    overflowY: "auto",
  } satisfies CSSProperties,

  facetDateField: {
    flex: 1,
    // See the consumer search page's NativeDateField: without min-width the
    // native date input refuses to shrink and two side-by-side fields overlap
    // on narrow phones.
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  } satisfies CSSProperties,

  facetDateInput: {
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    padding: "8px 10px",
    fontFamily: "var(--font-body, Inter, sans-serif)",
    fontSize: 13,
    fontWeight: 500,
    color: "var(--color, #211C16)",
    backgroundColor: "var(--surfaceMuted, #EFE7D6)",
    border: "1px solid var(--borderColor, #211C16)",
    borderRadius: 0,
    colorScheme: "light",
  } satisfies CSSProperties,

  /**
   * 44px floor for the native date inputs on touch (NFR-003). Without it these
   * land at ~33px while every other control on the facet bar takes the floor —
   * the two fields inside the Custom range panel were the only controls left
   * below it.
   */
  facetDateInputMobile: {
    minHeight: 44,
    padding: "12px 10px",
    fontSize: 14,
  } satisfies CSSProperties,
} as const;
