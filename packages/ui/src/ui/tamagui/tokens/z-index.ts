// Stacking order.
//
// The design system's seven-layer scale (base/raised/sticky/dropdown/drawer/
// modal/toast/tooltip) is the same idea at different numbers, and it orders
// `sticky` BELOW `dropdown` where this file has had it above since before the
// port. The existing numbering is left alone deliberately: it is load-bearing
// across the app, and renumbering to match a document would trade a real
// regression risk for a cosmetic agreement. The missing layers were added
// (2026-08-26) in the gaps instead.
//
// Gaps of 100 between the named layers exist so a future layer can land between
// two without a renumber. Use a name, never a literal.
export const zIndexTokens = {
  auto: "auto" as const,
  base: 0,
  /** Lifted within the normal flow — a hovered card, a focused row. */
  raised: 10,
  dropdown: 1000,
  sticky: 1100,
  banner: 1200,
  overlay: 1300,
  /** Slides in beside the list it came from; sits above the scrim. */
  drawer: 1350,
  modal: 1400,
  popover: 1500,
  /** Above popovers: a toast confirms something that already happened, and
      must not be obscured by chrome the user opened afterwards. */
  toast: 1550,
  tooltip: 1600,
  true: 0,
} as const;

export type ZIndexTokenName = keyof typeof zIndexTokens;
