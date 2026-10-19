// Design System v2 elevation — per-theme shadow strings.
//
// These are plain exports keyed by the Tamagui theme name (like motionTokens):
// shadows are multi-part CSS strings that don't fit the color-token contract.
// Consume via `useThemeName()` and index this map — so the keys MUST match the
// live Tamagui theme keys (`swiss` / `ember` / `stub`), not the "light"/"dark"
// scheme vocabulary used by the separate `colorTokens.roles` badge system.
//
// Ember (dark) and Swiss (light) are flat — borders carry structure, so `card`
// is "none" and `pop` is a hard 2px ring. Stub uses hard offset print-style
// shadows (no blur) to match its ticket-stub paper aesthetic.
// The ladder has four live rungs. Two rules govern it:
//   - A surface may be at most ONE step above its parent. A card inside a modal
//     does not get the modal's shadow.
//   - Shadows always offset down and to the right. A shadow that offsets any
//     other way reads as a light source the rest of the page doesn't have.
//
// `subtle` and `overlay` were added 2026-08-26 porting the design system's
// five-step scale; `card` and `pop` keep their existing values and names.
export const elevationTokens = {
  swiss: {
    subtle: "none",
    card: "none",
    pop: "0 0 0 2px #8C8C8C",
    overlay: "0 0 0 2px #8C8C8C",
  },
  ember: {
    subtle: "none",
    card: "none",
    pop: "0 0 0 2px #5A78A6",
    overlay: "0 0 0 2px #5A78A6",
  },
  stub: {
    /** Chips and small controls in a raised state. */
    subtle: "2px 2px 0 rgba(33, 28, 22, 0.85)",
    /** Cards, panels, the primary button. */
    card: "4px 4px 0 rgba(33, 28, 22, 0.85)",
    /** Popovers, dropdowns, toasts. */
    pop: "6px 6px 0 rgba(33, 28, 22, 0.9)",
    /** Modals and drawers — the only step above `pop`. */
    overlay: "10px 10px 0 rgba(33, 28, 22, 0.9)",
  },
} as const;

export type ElevationThemeName = keyof typeof elevationTokens;
export type ElevationTokenName = keyof (typeof elevationTokens)["swiss"];

/**
 * How many pixels a shadow string paints *outside* the element's own box, to
 * the right and below it (our shadows are symmetric offsets with no blur, so
 * one number covers both edges).
 *
 * Box shadows never contribute to scrollable overflow, so any `overflow`
 * container holding a shadowed card (the event carousel's horizontal
 * ScrollView is `overflow-y: hidden`) clips the shadow unless it reserves this
 * much room. Returns 0 for the flat themes (`"none"`) so they gain no dead
 * space, and 0 for anything unparseable rather than guessing.
 */
export const getShadowOverflowPx = (shadow: string): number => {
  if (!shadow || shadow === "none") {
    return 0;
  }

  // Drop the colour, keep the leading geometry: "4px 4px 0 rgba(…)" → "4px 4px 0".
  const geometry = shadow.split(/rgba?\(|#|hsla?\(/)[0]?.trim() ?? "";
  if (geometry.length === 0) {
    return 0;
  }

  const parts = geometry.split(/\s+/).map((part) => Number.parseFloat(part));
  if (parts.length < 2 || parts.some((part) => Number.isNaN(part))) {
    return 0;
  }

  const [offsetX = 0, offsetY = 0, blur = 0, spread = 0] = parts;
  return Math.max(0, Math.ceil(Math.max(offsetX, offsetY) + blur + spread));
};
