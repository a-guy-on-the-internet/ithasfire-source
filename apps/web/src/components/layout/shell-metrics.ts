/**
 * The consumer shell's horizontal grid — the ONE source of truth shared by the
 * navbar, the page body and the footer.
 *
 * design-system-v2.md §5: content 1200 / full-bleed chrome 1440, side padding
 * `$6` desktop and `$4` mobile, "never override them per page". The three bands
 * had each drifted to their own numbers (nav 1200/32, body 1440/12·16·32,
 * footer 1440/40 left·24 right·20 mobile), so nothing lined up vertically: at
 * 1600w the brand lockup sat 120px inboard of the hero headline, and the
 * footer's own left and right insets disagreed with each other by 16px.
 *
 * Page content that wants the narrower `content` rung (help, category pages)
 * still caps itself at 1200 INSIDE this band — that is the DS's two-rung model,
 * not drift. What must never differ again is the band itself.
 *
 * The gutters switch at Tamagui's `$gtSm` (641px). Bands built from Tamagui
 * primitives read these constants directly; the footer's Swiss grid is plain
 * DOM, so it reads `--shell-gutter` from the `.th-shell-band` rule in
 * `globals.css`, which mirrors these two numbers at the same breakpoint.
 * `shell-metrics.test.ts` fails if the mirror drifts. Never key any of this off
 * `useIsMobile()` — that hook flips at 600px and reports desktop during SSR.
 */

/** The `wide` container rung — full-bleed chrome caps here. */
export const SHELL_MAX_WIDTH = 1440;

/** `$6` — the gutter at and above `$gtSm` (641px). */
export const SHELL_GUTTER = 32;

/** `$4` — the gutter at and below 640px. */
export const SHELL_GUTTER_MOBILE = 16;

// The public entity page's `@container entity-page` breakpoints (388 / 448 /
// 568 / 608 / 836px) are old viewport breakpoints minus 2 x these gutters
// (see entity-page-shell.module.css). Changing a gutter shifts them.
