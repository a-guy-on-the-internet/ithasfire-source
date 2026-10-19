/**
 * Swiss International Typographic Style tokens — Montserrat edition.
 *
 * Display: Black (900), ultra-tight tracking, compressed line-height for massive headlines.
 * Heading: Bold (700), tight tracking, structured line-height.
 * Body: Regular (400), neutral spacing for readability.
 * Mono: Regular (400), SYSTEM mono stack — genuine code blocks only. Montserrat
 * is the ONLY brand font; no mono webfont is loaded or prescribed. Numbers that
 * need alignment use Montserrat + `font-variant-numeric: tabular-nums`.
 *
 * Montserrat's geometric grotesque letterforms align naturally with the Swiss
 * tradition — high x-height, even stroke width, authoritative at large scales.
 */
export const typographyTokens = {
  display: {
    fontFamily: "var(--font-heading, var(--font-body, Montserrat))",
    fontWeight: "900",
    letterSpacing: -0.03,
    lineHeight: 1.05,
  },
  heading: {
    fontFamily: "var(--font-heading, var(--font-body, Montserrat))",
    fontWeight: "700",
    letterSpacing: -0.02,
    lineHeight: 1.15,
  },
  body: {
    fontFamily: "var(--font-body, Montserrat)",
    fontWeight: "400",
    letterSpacing: 0,
    lineHeight: 1.5,
  },
  mono: {
    // Web-only stack: the CSS var string can't resolve on React Native, where
    // an unresolvable fontFamily falls back to the platform sans. Web resolves
    // `--font-mono` to the self-hosted IBM Plex Mono (see apps/web layout.tsx);
    // native gets the platform monospace until the mobile pass lands.
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontWeight: "400",
    letterSpacing: 0,
    lineHeight: 1.4,
  },
} as const;

export type TypographyTokenName = keyof typeof typographyTokens;

/**
 * The mono ladder — IBM Plex Mono's five steps and their paired tracking.
 *
 * Tracked uppercase reads larger than it measures, so each step runs 1–3px
 * under its sans counterpart. **Size and tracking travel together**: a mono
 * step used without its `letterSpacing` is not the label idiom, it is just
 * small monospace text. Consume the pair, never one half.
 *
 * Mirrors `tokens/typescale.css` in the design system folder, and the
 * `--fs-mono-*` / `--tr-mono-*` custom properties in `apps/web/globals.css`.
 */
export const monoScale = {
  /** Prices, large meta, keyboard keys. */
  lg: { fontSize: 13, letterSpacing: 0.4 },
  /** Meta lines, table cells. */
  md: { fontSize: 11.5, letterSpacing: 1.4 },
  /** Labels, kickers, the meta-line workhorse. (Button labels stay on the
   *  sans — uppercase Montserrat 700 at +1.5px, per the design system.) */
  sm: { fontSize: 11, letterSpacing: 2 },
  /** Field labels, table heads. */
  xs: { fontSize: 10, letterSpacing: 2.5 },
  /** Tags, badges, stamps. */
  "2xs": { fontSize: 9.5, letterSpacing: 2.5 },
} as const;

export type MonoScaleName = keyof typeof monoScale;

/**
 * The two label idioms, as prop bags.
 *
 * `label` is the workhorse — field labels, table heads, meta rows.
 * `kicker` is the wider-tracked editorial variant that sits above a headline.
 * Both are always uppercase; the transform is included so a caller cannot
 * apply half the idiom.
 */
export const labelIdioms = {
  label: {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  kicker: {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: 11,
    letterSpacing: 3,
    fontWeight: "600",
    textTransform: "uppercase",
  },
} as const;

export type LabelIdiomName = keyof typeof labelIdioms;
