// ─────────────────────────────────────────────────────────────────────────────
// CSS custom-property strings for the calendar's raw-DOM render paths.
//
// Every value is `var(--<semanticToken>, <stub value>)`: the fallback is the
// Stub (warm paper, default) theme, which is what SSR / first paint renders
// before `ActiveThemeInjector` mirrors the live theme onto `<body>`. Canonical
// values live in `packages/ui/src/ui/tamagui/tokens/colors.ts`. Copied from
// the retired EventCalendar engine's `event-calendar-helpers.ts`, which has
// since been deleted.
// ─────────────────────────────────────────────────────────────────────────────

import type { CalendarEventStatus } from "./types";

/** Chip / tag fill per status. */
export const STATUS_BG: Record<CalendarEventStatus, string> = {
  PUBLISHED: "var(--accentSoft, rgba(226, 72, 29, 0.10))",
  DRAFT: "var(--surfaceMuted, #EFE7D6)",
  COMPLETED: "color-mix(in srgb, var(--success, #166534) 25%, transparent)",
  CANCELLED: "color-mix(in srgb, var(--danger, #B91C1C) 25%, transparent)",
};

/** Status bar (chip left edge, agenda row edge, filter swatch edge). */
export const STATUS_BAR: Record<CalendarEventStatus, string> = {
  PUBLISHED: "var(--accent, #E2481D)",
  DRAFT: "var(--color, #211C16)",
  COMPLETED: "color-mix(in srgb, var(--success, #166534) 70%, transparent)",
  CANCELLED: "color-mix(in srgb, var(--danger, #B91C1C) 70%, transparent)",
};

/** English status names — the views read the localised set from `useCalendarLabels()`. */
export const STATUS_LABEL: Record<CalendarEventStatus, string> = {
  PUBLISHED: "Published",
  DRAFT: "Draft",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/**
 * Sold-out frame (FR-022, public mode). The chip's status tint and 3px bar
 * step off the accent and onto the NEUTRAL muted pair, so a sold-out show
 * reads as closed by its frame alone. The whole chip used to carry
 * `opacity: 0.55`, which dragged the 12px semibold title down to 3.77:1 on
 * paper (3.62:1 over the accent wash) — under AA, and 12px semibold is not
 * "large text". Dim the frame, never the words (design-system-v2 §7:
 * sold-out cards stay at full contrast).
 *
 * The fill is a WASH, not `--surfaceMuted`: an opaque light token would paint
 * a cream block behind a dark-site embed's white text. A percentage of
 * `--colorMuted` composites over whatever surface the host set, and the embed
 * bridge points `--colorMuted` at the host's own font colour.
 */
export const CAL_SOLD_OUT_BG =
  "color-mix(in srgb, var(--colorMuted, #5C544A) 12%, transparent)";
export const CAL_SOLD_OUT_BAR = "var(--colorMuted, #5C544A)";

/** Paper — the page canvas. */
export const CAL_PAPER = "var(--background, #F6F0E4)";
/** Surface — the engine's frame fill. */
export const CAL_SURFACE = "var(--surface, #FDFAF3)";
export const CAL_SURFACE_MUTED = "var(--surfaceMuted, #EFE7D6)";
/** Ink. */
export const CAL_INK = "var(--color, #211C16)";
/** Paper-on-ink (the TODAY square's numeral). */
export const CAL_ON_INK = "var(--onStructure, #FDFAF3)";
export const CAL_MUTED = "var(--colorMuted, #5C544A)";
/** 2px structural frames. */
export const CAL_BORDER = "var(--borderColor, #211C16)";
/** 1px hairlines. */
export const CAL_BORDER_SOFT = "var(--borderColorSoft, rgba(33, 28, 22, 0.3))";
/** The weekday header baseline. */
export const CAL_BORDER_STRONG = "var(--borderColorStrong, #000000)";
/** Accent — bars, borders, dots, the now-line. Never small text. */
export const CAL_ACCENT = "var(--accent, #E2481D)";
/** Accent at label legibility. */
export const CAL_ACCENT_TEXT = "var(--accentText, #A8300F)";
export const CAL_ACCENT_SOFT = "var(--accentSoft, rgba(226, 72, 29, 0.10))";
/** Today column wash — 5% accent over the surface. */
export const CAL_TODAY_WASH =
  "color-mix(in srgb, var(--accent, #E2481D) 5%, transparent)";
/** Conflict / challenged-hold hue. A warning, not an error. */
export const CAL_WARNING = "var(--warning, #92400E)";
export const CAL_WARNING_SOFT =
  "color-mix(in srgb, var(--warning, #92400E) 18%, transparent)";
/** The primary CTA fill that carries small white text (AA at 5.92:1). */
export const CAL_CTA_FILL = "var(--brandSecondaryHover, #B93312)";
export const CAL_ON_CTA = "var(--onBrandSecondary, #FFFFFF)";
/** Offset hard shadow under the peek — no blur; ink at 12%, theme-tracking. */
export const CAL_PEEK_SHADOW =
  "6px 6px 0 0 color-mix(in srgb, var(--color, #211C16) 12%, transparent)";
/** Chip outline for unconfirmed listings and holds. */
export const CAL_DASHED_OUTLINE = `2px dashed ${CAL_BORDER}`;
