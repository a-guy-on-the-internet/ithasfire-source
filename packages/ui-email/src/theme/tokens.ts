import { type CSSProperties } from "react";

/**
 * Email template tokens — the Ithas Fire Design System v2 palette, as LITERALS.
 *
 *   Brand:   ink #211C16 (structure) · burnt orange #B93312 (accent)
 *   Body:    Montserrat / system sans-serif (email-safe fallback stack)
 *   Labels:  IBM Plex Mono / system monospace (printed-frame emails only)
 *   Radius:  0 (Swiss International style)
 *
 * ## Email is a different medium — read this before "syncing" with the web tokens
 *
 * Mail clients strip CSS custom properties and `<style>` theming, so there is NO `var(--token)`
 * and NO theme switching here: every value is an inline LITERAL, and email is always the one
 * light palette. So this file carries the *Stub* values directly (see
 * `packages/ui/src/ui/tamagui/tokens/colors.ts`), not `var()` strings.
 *
 * Two v2 rules matter most:
 *   - **The accent that carries text/CTAs is the #B93312 rung, not #E2481D.** `#E2481D` has no
 *     AA-compliant small-text foreground in either polarity (white 4.06:1, ink 4.38:1) —
 *     design-system-v2.md §3. Every accent use in these templates is a link, a label, or a
 *     fill-with-white-text, so `brandAccent` is #B93312 (white on it = 5.92:1; as text on white =
 *     5.9:1). The pre-v2 #FF5721 was 3.16:1 in BOTH roles — the old CTA and links failed AA.
 *   - **Status colours are the DARKENED Stub values** (`success #166534`, `danger #B91C1C`) so they
 *     clear AA as text on white (7.1 / 6.5); the bright #22C55E / #EF4444 were ~1.9 / ~4 as text.
 *
 * `surface` (the CARD) stays WHITE. Behind it, the printed-frame emails (the applicant application
 * emails, `templates/components/PrintedFrame.tsx`) sit on a cream PAGE, `canvas` #FDFAF3. This
 * replaced an older rule that a cream canvas "reads as a rendering bug": the owner approved the
 * cream page on 2026-09-30 (direction B, "Printed"), with Arc as the precedent: it ships a cream
 * email canvas and it reads as intentional, not broken.
 * Templates on the plain `Shell` still use a white page; the cream is opt-in per frame, not global.
 * The `color-scheme: light` lock keeps Gmail/Apple Mail from auto-inverting either.
 *
 * Mono labels are allowed in email (same 2026-09-30 approval): kickers, status-bar labels, ledger
 * keys and the "From the organizer" label use `typography.monoFamily`, the DS label idiom. See the
 * note on that field for how it degrades.
 */
export const tokens = {
  colors: {
    // Structural brand — ink. Was steel-blue #35589A (retired in v2). Used for headings, the
    // verification-code block, and secondary-button outlines: ink-on-white is 16.9:1.
    brand: "#211C16",
    // Accent — the AA-safe #B93312 rung (see the header note). Was #FF5721.
    brandAccent: "#B93312",
    text: "#211C16", // warm ink, was near-black #181818
    mutedText: "#5C544A", // warm muted, was cool #707070
    surface: "#FFFFFF",
    // `surfaceMuted` is for tinted card backgrounds (security panels, CTA cards) that need to read
    // as "subtle inset" without falling into Gmail/Apple Mail's auto-invert dark-mode trap a
    // near-white tint triggers — kept just barely off white, now WARM (was cool #F8FAFC).
    surfaceMuted: "#FAF6EE",
    border: "#DED7CC", // warm light hairline, was cool #D4D4D4
    success: "#166534", // darkened for AA-as-text on white (was bright #22C55E, ~1.9:1)
    danger: "#B91C1C", // darkened for AA-as-text on white (was bright #EF4444)
    warningBg: "#FEF3C7",
    warningBorder: "#FDE68A",
    // Cream PAGE behind the white card in the printed-frame emails (see the header note). Never a
    // card or text colour; `surface` stays the card.
    canvas: "#FDFAF3",
    // DS support (amber). A FILL ONLY (the waitlist segment of the application status bar) and
    // never text: white on it is ~2.1:1 and it is ~2.2:1 as text on white.
    support: "#F59E0B",
  },
  typography: {
    /**
     * Montserrat is the Ithas Fire typeface for everything readable (design-system-v2.md §2) — the
     * web, native and email surfaces all sit on it. Labels may use `monoFamily` below; nothing
     * else gets a second face. This stack is shared by all ~30 templates on purpose: one email in
     * a different face is worse than either choice made everywhere. Revert by editing THIS string
     * plus the Google Fonts `<link>` in `templates/Shell.tsx` and
     * `templates/components/PrintedFrame.tsx`.
     *
     * Everything after `Montserrat` is a real fallback chain, not decoration: many clients
     * (Outlook desktop, Gmail on Android, most webmail with remote CSS off) never fetch the
     * webfont, so no layout here may depend on Montserrat's metrics. Deliberately no Inter and no
     * Roboto — the DS bans both by name; Android still lands on Roboto via the trailing
     * `sans-serif`, which is the system font doing its job rather than us naming a second brand.
     */
    fontFamily:
      "Montserrat, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
    /**
     * IBM Plex Mono, the DS label idiom (kickers, status labels, ledger keys), approved for email on
     * 2026-09-30. Only the printed frame loads it (its Google Fonts `<link>` in
     * `templates/components/PrintedFrame.tsx`). Where webfonts don't load (Outlook desktop, Gmail,
     * most webmail: roughly 76% of opens) the label falls back to the system monospace, which still
     * reads as a label because it is also uppercase, tracked and small. No layout here may depend
     * on Plex's metrics.
     */
    monoFamily: "'IBM Plex Mono', Menlo, Consolas, 'Courier New', monospace",
    baseSize: 14,
    lineHeight: 1.5,
    headingTightLH: 1.25,
  },
  spacing: [4, 8, 12, 16, 24, 32],
  radius: 0,
} as const;

export type ThemeTokens = typeof tokens;

export const spacing = (index: number) => {
  const value = tokens.spacing[index] ?? tokens.spacing[0];
  return `${value}px`;
};

export const px = (value: number) => `${value}px`;

/**
 * Shared button style constants so individual templates don't duplicate CTA CSS.
 */
export const primaryButtonStyle: CSSProperties = {
  display: "inline-block",
  padding: "16px 28px",
  // `brandAccent` is the #B93312 rung, so white here is 5.92:1. Do NOT swap the fill to a brighter
  // #E2481D/#FF5721 "for pop" — 14px/700 is not WCAG-large, and white on those is <4.5:1.
  backgroundColor: tokens.colors.brandAccent,
  color: "#FFFFFF",
  borderRadius: tokens.radius,
  textDecoration: "none",
  fontWeight: 700,
};

export const secondaryButtonStyle: CSSProperties = {
  display: "inline-block",
  padding: "16px 28px",
  backgroundColor: "#FFFFFF",
  color: tokens.colors.brand,
  borderRadius: tokens.radius,
  textDecoration: "none",
  fontWeight: 700,
  border: `1px solid ${tokens.colors.brand}`,
};
