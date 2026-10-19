import {
  ACCENT,
  ACCENT_FILL,
  ON_ACCENT_FILL,
  STRUCTURAL,
} from "@/lib/design-tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Colours / tokens (plain CSS values — no Tailwind, no Tamagui)
// Swiss palette (stub light theme): ink text on warm cream, structural
// borders, orange action. Ink tones route through the injected theme vars
// (`--color`, `--colorMuted`, `--borderColorSoft`) where one exists, with an
// ink-alpha fallback tuned to match the original emphasis on cream.
// ─────────────────────────────────────────────────────────────────────────────

export const MUTED = "var(--colorMuted, #5C544A)";
// Bumped 0.5 → 0.65: at 0.5 this ink tint was 3.18:1 on cream — under AA, and it carries muted
// TEXT (captions, muted button labels). 0.65 = 5.00:1 on the cream page (worst-case light surface),
// still visibly lighter than MUTED (`colorMuted`, 6.56:1) so the muted-text hierarchy survives.
export const MUTED_LIGHT = "rgba(33,28,22,0.65)";
export const MUTED_STRONG = "var(--color, #211C16)";
export const BORDER = "var(--borderColorSoft, rgba(33,28,22,0.3))";
export const BORDER_STRONG = "rgba(33,28,22,0.3)";
export const SURFACE = "rgba(33,28,22,0.03)";
export const LABEL = "rgba(33,28,22,0.5)";
export const PILL_BG = "transparent";
export const PILL_BORDER = "rgba(33,28,22,0.25)";
export const PILL_TEXT = "var(--colorMuted, #5C544A)";
export const ACCENT_STRUCTURAL = STRUCTURAL;
/**
 * The label colour on `ACCENT_FILL` — white, 5.92:1.
 *
 * Was ink, justified by "white on #FF5721 is 3.16:1". That reasoning died with the pre-v2 orange:
 * on Stub's `#E2481D` BOTH polarities fail (white 4.06:1, ink 4.38:1), so the answer isn't a
 * different label — it's a different FILL. Primary fills here now ride `ACCENT_FILL` (#B93312),
 * where white clears AA. This is what the `@th/ui` Button atom has always done.
 */
export const ON_ACCENT = ON_ACCENT_FILL;

// ─── Neutral StatusScreen badge (404 / access-denied / enroll-2fa) ───────────
// A deliberately quiet, DECORATIVE glyph — the <h1> right beneath it carries the
// meaning, so this sits below the text-contrast floor on purpose. These were
// near-white (#EDEDED) tints tuned for the retired navy theme; on the cream Stub
// canvas that rendered invisible. Ported to the mirrored ink tint at the same
// alphas so the original emphasis survives the flip. Status-specific screens
// pass their own colors instead (ACCENT/STRUCTURAL, or success/danger).
/** Decorative status glyph — ink at 30%. */
export const STATUS_ICON = "rgba(33,28,22,0.3)";
/** Tile behind the status glyph — ink at 5%. */
export const STATUS_ICON_BG = "rgba(33,28,22,0.05)";

export { ACCENT, ACCENT_FILL, STRUCTURAL };
