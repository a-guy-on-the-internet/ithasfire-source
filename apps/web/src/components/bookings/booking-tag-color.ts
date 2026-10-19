// ─────────────────────────────────────────────────────────────────────────────
// BOOKING TAG COLOURS → design tokens (booking-holds spec 2026-08-25, FR-017).
//
// A tag stores a COLOUR NAME (`BookingTag.color`, core `BOOKING_TAG_COLORS`),
// never a hex: the palette is the theme's, so a tag reads the same on Stub and
// Ember and never drifts off the sanctioned intent hues. The wire type is a
// plain `string` (a future colour must not crash an old client), so an unknown
// name falls back to neutral here.
//
// Fills are 12% tints through `color-mix` — the same device the calendar's
// COMPLETED/CANCELLED chips use — and the LABEL sits on the intent's text-safe
// value (`$success` / `$warning` / `$danger` / `$info` all clear AA on the
// cream canvas; accent uses `$accentText`, because raw `$accent` does not).
// ─────────────────────────────────────────────────────────────────────────────

export const BOOKING_TAG_COLORS = [
  "neutral",
  "accent",
  "info",
  "success",
  "warning",
  "danger",
] as const;

export type BookingTagColor = (typeof BOOKING_TAG_COLORS)[number];

export function isBookingTagColor(value: string): value is BookingTagColor {
  return (BOOKING_TAG_COLORS as readonly string[]).includes(value);
}

export type BookingTagColorStyle = {
  /** Raw CSS (a `color-mix` tint) — for `style={{ backgroundColor }}`. */
  background: string;
  /** Raw CSS border colour. */
  border: string;
  /** Tamagui token for the label. */
  text: string;
  /** i18n key for the colour's name (the manager's colour picker). */
  labelKey: string;
};

const STYLES: Record<BookingTagColor, BookingTagColorStyle> = {
  neutral: {
    background: "var(--surfaceMuted, #EFE7D6)",
    border: "var(--borderColorSoft, rgba(33,28,22,0.3))",
    text: "$colorMuted",
    labelKey: "admin.bkTagColorNeutral",
  },
  accent: {
    background: "var(--accentSoft, rgba(226,72,29,0.10))",
    border: "color-mix(in srgb, var(--accent, #E2481D) 55%, transparent)",
    text: "$accentText",
    labelKey: "admin.bkTagColorAccent",
  },
  info: {
    background: "color-mix(in srgb, var(--info, #211C16) 10%, transparent)",
    border: "color-mix(in srgb, var(--info, #211C16) 45%, transparent)",
    text: "$info",
    labelKey: "admin.bkTagColorInfo",
  },
  success: {
    background: "color-mix(in srgb, var(--success, #166534) 12%, transparent)",
    border: "color-mix(in srgb, var(--success, #166534) 50%, transparent)",
    text: "$success",
    labelKey: "admin.bkTagColorSuccess",
  },
  warning: {
    background: "color-mix(in srgb, var(--warning, #92400E) 12%, transparent)",
    border: "color-mix(in srgb, var(--warning, #92400E) 50%, transparent)",
    text: "$warning",
    labelKey: "admin.bkTagColorWarning",
  },
  danger: {
    background: "color-mix(in srgb, var(--danger, #B91C1C) 12%, transparent)",
    border: "color-mix(in srgb, var(--danger, #B91C1C) 50%, transparent)",
    text: "$danger",
    labelKey: "admin.bkTagColorDanger",
  },
};

export function bookingTagColorStyle(color: string): BookingTagColorStyle {
  return STYLES[isBookingTagColor(color) ? color : "neutral"];
}
