/**
 * Shared style tokens for the checkout page.
 *
 * All colour values reference the Tamagui theme CSS custom properties
 * injected by `ActiveThemeInjector` (e.g. `--color`, `--colorMuted`,
 * `--borderColor`, `--surface`).  Fallbacks are the stub light-theme
 * hex values from `packages/ui/src/ui/tamagui/tokens/colors.ts` (they only
 * show during SSR/first-paint before `ActiveThemeInjector` hydrates the
 * live theme vars).
 *
 * The COLOUR/SIZE constants below are module-level primitives: never recreated
 * per render, safe in dependency arrays. The `primaryAction*` HELPERS are not —
 * they build a fresh object per call, so never put `primaryActionStyle(busy)`
 * in a `useMemo` dep list.
 */

import {
  ACCENT_FILL,
  ACCENT_FILL_HOVER,
  ON_ACCENT_FILL,
} from "@/lib/design-tokens";

// ── Core colour tokens ───────────────────────────────────────────────────────
/** Primary foreground / text colour. */
export const FG = "var(--color, #211C16)";
/** Page / shell background colour. */
export const BG = "var(--background, #F6F0E4)";
/** Muted / secondary text colour. */
export const FG_MUTED = "var(--colorMuted, #5C544A)";

// ── Border / divider tokens ──────────────────────────────────────────────────
/** Subtle card/section border. */
export const BORDER_SUBTLE = "1px solid var(--borderColor, #211C16)";
/** Hairline divider between sections. */
export const DIVIDER_COLOR = "var(--borderColor, #211C16)";

// ── Surface tokens ───────────────────────────────────────────────────────────
/** Slightly raised card / panel background. */
export const SURFACE = "var(--surface, #FDFAF3)";
/** Muted panel / tinted background. */
export const SURFACE_MUTED = "var(--surfaceMuted, #EFE7D6)";
/** Semi-transparent overlay tint (e.g. header rows, skeleton shimmers). */
export const SURFACE_OVERLAY = "var(--surfaceOverlay, rgba(33,28,22,0.04))";

// ── Accent ───────────────────────────────────────────────────────────────────
export const ACCENT = "var(--accent, #E2481D)";
export const ACCENT_SOFT = "var(--accentSoft, rgba(226,72,29,0.10))";

// ── Primary action ───────────────────────────────────────────────────────────
/**
 * The checkout's one primary CTA treatment — step 1 "Hold tickets" (sidebar)
 * and step 2 "Continue to payment". Shared so the two steps can never disagree
 * about what a primary looks like; both used to render the muted ink wash,
 * which read as disabled.
 *
 * Colour is the brand-secondary rung (`ACCENT_FILL` #B93312), NOT `$accent`
 * (#E2481D): these labels are 15–16px/700 sitting ON the fill, and #E2481D
 * clears AA in neither polarity (white 4.06:1, ink 4.38:1). White on #B93312
 * reaches 5.92:1, and the hover rung #94270C reaches 8.22:1.
 *
 * `borderRadius: 0` — a checkout CTA is content, not chrome.
 *
 * Callers must also carry `className="checkout-primary-action"`, which owns the
 * `:focus-visible` ring (checkout.css). Inline styles cannot express a pseudo-
 * class, and the deep fill is too close in value to a UA default ring to leave
 * the keyboard indicator to chance.
 */
export const primaryActionStyle = (
  busy: boolean,
  overrides?: React.CSSProperties,
): React.CSSProperties => ({
  width: "100%",
  padding: "14px 24px",
  fontSize: 16,
  fontWeight: 700,
  fontFamily: "inherit",
  color: ON_ACCENT_FILL,
  background: ACCENT_FILL,
  border: `1px solid ${ACCENT_FILL}`,
  borderRadius: 0,
  cursor: busy ? "not-allowed" : "pointer",
  opacity: busy ? 0.6 : 1,
  transition: "background 0.15s, border-color 0.15s",
  ...overrides,
});

/** Hover swap for `primaryActionStyle` — rest rung ↔ hover rung. */
export const primaryActionHoverProps = (busy: boolean) => ({
  onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
    if (busy) return;
    e.currentTarget.style.background = ACCENT_FILL_HOVER;
    e.currentTarget.style.borderColor = ACCENT_FILL_HOVER;
  },
  // NO `busy` guard here, unlike enter. These handlers write the inline style
  // imperatively, and React's diff skips a style key whose value is unchanged
  // between renders — `primaryActionStyle` returns the same `background` string
  // busy or not, so a render can never repaint over them. Guarding leave meant:
  // hover (rest→hover rung) → click → busy → pointer leaves → early return →
  // button stranded on the hover rung until it unmounted. Always restore.
  onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = ACCENT_FILL;
    e.currentTarget.style.borderColor = ACCENT_FILL;
  },
});

// ── Type scale ───────────────────────────────────────────────────────────────
/**
 * The rungs checkout is allowed to use, as `var()` references to the ladders in
 * `globals.css` (which mirror the design system's `tokens/typescale.css`).
 *
 * Checkout used to run 10, 12, 13, 14 and 15px — five sizes where the system
 * defines three below body, and one of them (10px) below the smallest sans rung
 * entirely. Fallbacks are the Stub values, which is what SSR paints.
 *
 * `MONO_SM` carries its tracking as a pair: a mono size without its
 * `letterSpacing` is small monospace text, not the label idiom.
 */
export const FS_BODY = "var(--fs-body, 15px)";
export const FS_SM = "var(--fs-sm, 13.3px)";
export const FS_CAP = "var(--fs-cap, 11.9px)";
export const FS_MONO_SM = "var(--fs-mono-sm, 11px)";
export const TR_MONO_SM = "var(--tr-mono-sm, 2px)";
export const FONT_MONO = "var(--font-mono, ui-monospace, monospace)";

/** The label idiom — mono, uppercase, tracked. Size and tracking travel together. */
export const labelIdiomStyle: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: FS_MONO_SM,
  letterSpacing: TR_MONO_SM,
  fontWeight: 600,
  textTransform: "uppercase",
};

// ── Opacity helpers ──────────────────────────────────────────────────────────
// For fine-grained opacity blending where a semantic token doesn't exist.
export const fgAlpha = (pct: number) =>
  `color-mix(in srgb, ${FG} ${pct}%, transparent)`;
export const fgMutedAlpha = (pct: number) =>
  `color-mix(in srgb, ${FG_MUTED} ${pct}%, transparent)`;

// ── Layout / typography presets ──────────────────────────────────────────────
export const sectionHeadingStyle: React.CSSProperties = {
  marginBottom: 20,
  fontSize: FS_SM,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: FG,
  display: "flex",
  alignItems: "baseline",
  gap: 10,
};

/**
 * Step number prefix — Montserrat + tabular-nums.
 *
 * Rides `ACCENT` (#E2481D) at 3.57:1 on cream, and that is deliberate. The
 * numeral is `aria-hidden` ornament, and `tokens/colors.ts` rules on this case
 * by name: "DO NOT use [accentText] for DECORATIVE accent text (the mono
 * kicker, tags, index numerals, prices) — those are aria-hidden ornament that
 * deliberately ride `accent`; deepening them is a product-wide visual change,
 * not an a11y fix."
 *
 * This briefly used `ACCENT_TEXT` on the strength of the design system folder's
 * `colors.css`, which lists indices among the small accent text that must
 * darken. The two documents genuinely disagree; ours wins here, because
 * changing it in checkout alone also made this the one section index in the
 * product wearing a different colour from all the others.
 */
export const sectionNumStyle: React.CSSProperties = {
  fontSize: FS_SM,
  fontWeight: 700,
  letterSpacing: "0.14em",
  color: ACCENT,
  fontVariantNumeric: "tabular-nums",
  minWidth: "2.5ch",
  textTransform: "uppercase",
};

export const sectionPaddingStyle: React.CSSProperties = {
  padding: "24px 20px",
};

/** Visually hidden but readable by screen readers */
export const srOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};

/** Focus-visible outline for keyboard navigation. */
export const focusRingStyle = `
  *:focus-visible {
    outline: 2px solid var(--accent, #E2481D);
    outline-offset: 2px;
  }
  /* SVG seats need a different approach since outline doesn't follow shape */
  g[role="button"]:focus-visible circle {
    stroke: var(--accent, #E2481D) !important;
    stroke-width: 2.5 !important;
    stroke-opacity: 1 !important;
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
    }
  }
`;
