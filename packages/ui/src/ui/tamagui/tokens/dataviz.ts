// Data visualization — eight ordinal series and one sequential ramp.
//
// No hue exists here that isn't already a paper, an ink, a flame, an amber or a
// printer's spot colour. That is what keeps a chart looking like part of the
// product rather than a widget dropped into it.
//
// Three rules travel with this file:
//   1. Series 1 is always the primary metric. Ordinal position carries meaning.
//   2. Charts get ink axes and a hairline grid. Nothing else is chrome.
//   3. No chart may introduce a colour that isn't here. If a chart needs a
//      ninth series, it needs fewer series.
//
// Charts are canvas/SVG and cannot resolve `var()`, so these are real hex —
// import the values directly rather than routing through a CSS custom property.
// Ported from the design system's `tokens/dataviz.css`.

export interface VizPalette {
  /** Eight ordinal series, in assignment order. */
  series: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  /** Sequential ramp, low → high. Heatmaps, check-in density, calendar load. */
  ramp: readonly [string, string, string, string, string];
  axis: string;
  grid: string;
  label: string;
}

/**
 * Stub (warm paper) — the designed palette. This is the one the design system
 * specified and the one the product ships on by default.
 */
const stubViz: VizPalette = {
  series: [
    "#E2481D", // flame — primary series, always
    "#211C16", // ink
    "#F59E0B", // amber
    "#7A5C3E", // clay
    "#4A5F7A", // slate
    "#8A8072", // stone
    "#B93312", // flame dark
    "#C9BFA8", // paper dark
  ],
  ramp: ["#F6F0E4", "#F3D9C6", "#EDB398", "#E88159", "#E2481D"],
  axis: "#211C16",
  grid: "rgba(33, 28, 22, 0.18)",
  label: "#5C544A",
};

/**
 * Ember (navy dark) — DERIVED, not designed.
 *
 * The design system deleted its dark theme, so there is no authored dark viz
 * palette to port. This keeps the signal hues that carry meaning (flame, amber)
 * and inverts the paper/ink ends so series stay legible on navy; the earths are
 * lightened to clear the dark canvas. It is a working default, not a design
 * decision — a real dark viz pass is outstanding, and a chart that looks wrong
 * on Ember is more likely this file's fault than the chart's.
 */
const emberViz: VizPalette = {
  series: [
    "#FF5721", // flame — primary series, always
    "#FDFAF3", // paper (the ink role, inverted)
    "#F59E0B", // amber
    "#C39A72", // clay, lightened
    "#8FA8C9", // slate, lightened
    "#A0B0CC", // stone → the theme's muted text value
    "#E84B19", // flame dark
    "#5A78A6", // steel, standing in for paper-dark
  ],
  ramp: ["#0F1B33", "#3A2A33", "#6B3A2D", "#B34320", "#FF5721"],
  axis: "#A0B0CC",
  grid: "rgba(90, 120, 166, 0.4)",
  label: "#A0B0CC",
};

/**
 * Swiss (legacy white) — the embed theme. Reuses the Stub series on a white
 * canvas, where they all still clear contrast; only the neutrals change.
 */
const swissViz: VizPalette = {
  ...stubViz,
  ramp: ["#FFFFFF", "#F7D9CB", "#EFB29C", "#E9805B", "#E2481D"],
  grid: "rgba(24, 24, 24, 0.14)",
  label: "#707070",
};

/**
 * Keyed by live Tamagui theme name — the same contract `elevationTokens` uses.
 * Consume via `useThemeName()` and index this map.
 */
export const vizTokens = {
  stub: stubViz,
  ember: emberViz,
  swiss: swissViz,
} as const;

export type VizThemeName = keyof typeof vizTokens;

/**
 * Pick a series colour by index, wrapping rather than running out.
 *
 * Wrapping is deliberate: a chart handed nine series should repeat a hue (and
 * look obviously wrong to whoever built it) rather than throw at render time in
 * front of a user, or silently draw an invisible ninth line.
 */
export const vizSeries = (
  theme: VizThemeName,
  index: number,
): string => {
  const { series } = vizTokens[theme];
  return series[((index % series.length) + series.length) % series.length]!;
};
