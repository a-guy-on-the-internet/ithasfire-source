/**
 * Design-system colours for components that can't consume Tamagui `$token` references
 * (raw `style={{}}` props, lucide-react `color=` props, CSS-in-JS objects).
 *
 * Prefer Tamagui tokens (`$accent`, `$color`, …) in styled() components.
 *
 * ## These are CSS `var()` STRINGS, not hex — and that matters
 *
 * Most constants here now resolve to `var(--token, #stubHex)` so they follow the active theme.
 * `ActiveThemeInjector` mirrors every theme key onto `<body>`, and the fallback is the **Stub**
 * value, which is what SSR paints before hydration.
 *
 * **So they are only valid in CSS/DOM value contexts.** They will NOT work in:
 *   - MapLibre GL paint expressions or `<canvas>` `fillStyle`/`strokeStyle` — no CSS cascade;
 *     read the live value (`useTheme().accent?.val`) with a `stubTheme.*` literal fallback.
 *   - Stripe's Appearance API — it renders in an iframe our vars never reach.
 *   - Anything that string-manipulates the colour: **never** concatenate an alpha suffix
 *     (`${ACCENT}CC` is invalid CSS) — use `color-mix(in srgb, … X%, transparent)`.
 *
 * For a genuine raw hex, import `palette.*` (the pre-v2 brand values) or `stubTheme.*` (the
 * shipped theme's values) explicitly: `palette` from `@/lib/design-tokens`,
 * `stubTheme` from `@th/ui/colors`.
 *
 * Canonical source: `packages/ui/src/ui/tamagui/tokens/colors.ts`
 */
import { colorTokens } from "@th/ui/colors";

export const { palette } = colorTokens;

// ─── Convenience aliases ─────────────────────────────────────────────────────
// These match the design spec naming used across component comments.

/**
 * Structural chrome color — theme-tracking. Resolves to the `structure` theme
 * token: ink (#211C16) on the light Stub theme, steel-blue (#35589A) on Ember.
 * (The var is set by globals.css `:root` + ActiveThemeInjector; the #211C16
 * fallback covers SSR/first-paint.) For the raw steel-blue brand hex, use
 * `palette.brandPrimary` directly. Used only in CSS/DOM contexts — never
 * concatenate an alpha suffix (`${STRUCTURAL}CC`); use color-mix instead.
 */
export const STRUCTURAL = "var(--structure, #211C16)";

/**
 * Burnt orange — primary CTAs, accent highlights, action feedback. Theme-tracking: resolves to
 * the `accent` theme token (#E2481D on Stub, #FF5721 on Ember).
 *
 * Was `palette.brandSecondary` — a FIXED #FF5721, the pre-v2 Ember orange, painted into 46 files
 * regardless of theme. That is not a first-paint flash you can wait out; it was simply the wrong
 * orange on the shipped cream theme, and neither colour gate could see it (an identifier is not a
 * `Literal`). For the raw pre-v2 brand hex, import `palette.brandSecondary` explicitly.
 */
export const ACCENT = "var(--accent, #E2481D)";

/** Darker orange — hover state for primary buttons. Theme-tracking (Stub: #B93312). */
export const ACCENT_HOVER = "var(--accentHover, #B93312)";

/**
 * The accent fill for any surface that CARRIES SMALL TEXT — the #B93312 rung.
 *
 * **Do not use `ACCENT` behind a label.** `#E2481D` is the one brand value with no AA-compliant
 * small-text foreground in EITHER polarity — white 4.06:1, ink 4.38:1 — as the ladder comment in
 * `packages/ui/…/tokens/colors.ts` says outright ("deliberately NOT a rung… keep it for large
 * fills, borders and graphics only") and `design-system-v2.md` §3 repeats. `ACCENT` stays correct
 * for large fills, borders, rules and graphics, which only need 3:1.
 *
 * Paired with `ON_ACCENT_FILL` this reaches **5.92:1**. It is the same rung the `@th/ui` Button
 * atom already rests on (`$brandSecondaryHover` — see `forms/button-variants.ts`, guarded by
 * `button.test.ts`), and PriceBlock makes the same trade.
 */
export const ACCENT_FILL = "var(--brandSecondaryHover, #B93312)";

/** The label colour on `ACCENT_FILL` — white, 5.92:1. (Ink on that rung is 2.85:1: unreadable.) */
export const ON_ACCENT_FILL = "var(--onBrandSecondary, #FFFFFF)";

/**
 * Accent-coloured TEXT on a light surface — #B93312, 5.22:1 on the cream canvas.
 *
 * The other half of the same rule: `ACCENT` (#E2481D) as a LABEL is 3.57:1 on cream and 3.89:1 on
 * `surface` — both under the small-text floor. This is the `$accentText` ladder rung. Use `ACCENT`
 * for the accent as a FILL/border/graphic; use this for the accent as INK.
 */
export const ACCENT_TEXT = "var(--accentText, #A8300F)";

/**
 * The hover rung above `ACCENT_FILL` — #98240B, 8.10:1 with `ON_ACCENT_FILL`.
 *
 * The ladder DEEPENS as it climbs (rest 5.92 → hover 8.10 → press 10.38 against white), the
 * opposite direction to swiss/ember. Do NOT use `ACCENT_HOVER` for this: it maps to `accentHover`,
 * which on Stub is the same #B93312 as the rest rung, so the hover would be a no-op.
 */
export const ACCENT_FILL_HOVER = "var(--brandSecondaryStrong, #94270C)";

/**
 * Primary text ink — theme-tracking (Stub: warm ink #211C16, was a fixed near-black #181818).
 * Tracks the `color` theme key, NOT globals.css's `--foreground`: the latter is a deliberate
 * scoped-override hook (e.g. `.hero-map-location-overlay` re-points it) and is not injected, so it
 * would never follow the active theme.
 */
export const FOREGROUND = "var(--color, #211C16)";

/**
 * The content surface: input fills, popups and cards on the page canvas. Theme-tracking (Stub:
 * warm paper #FDFAF3), so raw-style fields and listboxes sit on the same paper as Tamagui ones.
 */
export const SURFACE = "var(--surface, #FDFAF3)";

/**
 * Neutral muted surface — theme-tracking (Stub: warm paper panel #EFE7D6).
 *
 * Was `palette.neutral100` (#F5F5F5), a COOL grey that read off-temperature on warm cream. Its one
 * consumer is a hover fill (`UniversalSearchPage`), so `surfaceMuted` is the exact token.
 */
export const MUTED = "var(--surfaceMuted, #EFE7D6)";

/** Muted text, secondary information. Theme-tracking (Stub: warm muted ink #5C544A). */
export const MUTED_TEXT = "var(--colorMuted, #5C544A)";

/**
 * Light "on dark" ink — the foreground for text/graphics that sit on a FIXED
 * dark surface (a photo scrim, the `$structure` wash, an immersive hero veil),
 * where the themed `$color` ink would be invisible. Theme-tracking alias of the
 * existing `onStructure` token (Stub: near-white #FDFAF3). This is NOT a new
 * design token — it mirrors `$onStructure` for CSS/DOM value contexts, the same
 * way `STRUCTURAL`/`ACCENT` mirror their theme keys. Use it whenever a surface
 * is fixed-dark in every theme so BOTH the fill and this foreground stay fixed
 * (see the "migrate a fill and its foreground as a unit" rule).
 */
export const ON_STRUCTURE = "var(--onStructure, #FDFAF3)";

/**
 * SOFT border — theme-tracking (Stub: a 30% ink tint on paper).
 *
 * Was `palette.neutral300` (#D4D4D4), a fixed cool grey. It maps to `borderColorSoft`, **not**
 * `borderColor`: the old value was a LIGHT grey, i.e. semantically soft, and `borderColor` on Stub
 * is the ink itself (#211C16). Migrating it to ink would have been a silent redesign — and would
 * have broken `DashboardContent`'s `SectionDivider`, whose 2px track is this colour with a 48px
 * `STRUCTURAL` (ink) lead segment painted over it: track and segment would have collapsed to the
 * same colour and the accent segment would have vanished.
 *
 * This also matches the house convention — `PagePrimitives/tokens.ts`, both review
 * `_shared/tokens.ts`, and the help pages all define their local `BORDER` exactly this way.
 *
 * If you want the hard ink edge (v2's "print-style hard borders" for CONTENT), ask for it
 * explicitly: `var(--borderColor, #211C16)`.
 */
export const BORDER = "var(--borderColorSoft, rgba(33,28,22,0.3))";

/** Hover/pressed state for structural chrome — theme-tracking (Stub: near-black #000000). */
export const STRUCTURAL_HOVER = "var(--structurePress, #000000)";

/** Darker structural chrome — pressed / hard state — theme-tracking (Stub: near-black #000000). */
export const STRUCTURAL_HARD = "var(--structurePress, #000000)";

/** Status red — validation errors, destructive actions. Theme-tracking (Stub: #B91C1C). */
export const DANGER = "var(--danger, #B91C1C)";

/**
 * Status amber — "not an error, but not done either" (a payout under the
 * minimum, a pending verification). Theme-tracking; the Stub fallback is the
 * DARKENED amber (#92400E, 6.3:1 on cream) rather than the light theme's
 * #FACC15 fill, because a `var()` fallback is what SSR paints and a
 * yellow-on-cream first paint is unreadable.
 */
export const WARNING = "var(--warning, #92400E)";

/**
 * The danger FILL and the one legal foreground on it — a theme-invariant PAIR
 * (white on #B91C1C, 6.47:1). Use both or neither: a themed fill with a fixed
 * foreground drifts apart, which is how checkout's expired-hold chip ended up
 * painting `--dangerSoft` (#B91C1C on Stub — a DARK red) over a dark maroon
 * wash, with no fallback, so first paint dropped the colour entirely.
 *
 * ⚠️ **This is not a verdict tone.** The scan surface's FAIL fill is
 * `$verdictFail` / `$onVerdictFail` (flame-600, pinned in all three themes) —
 * see `packages/ui/src/ui/tamagui/tokens/colors.ts`. Red is not in this
 * brand's palette; this pair survives only because checkout's expired-hold
 * chip and `HoldDatePicker.module.css` still paint it. Its siblings
 * `successFill` / `onSuccessFill` were retired with the four-family verdict
 * system; retire these two as well when those two call sites move.
 */
export const DANGER_FILL = "var(--dangerFill, #B91C1C)";
/** The label colour on `DANGER_FILL`. Never use one without the other. */
export const ON_DANGER_FILL = "var(--onDangerFill, #FFFFFF)";

/**
 * Status red as TEXT on the page canvas — Stub #B91C1C, 5.7:1 on cream.
 * Distinct from `DANGER_FILL`: themes that run a bright status red darken this
 * one for legibility (ember: `danger` #EF4444 vs `dangerSoft` #F87171).
 *
 * Exists because several call sites wrote a bare `var(--dangerSoft)` with NO
 * fallback: on SSR/first paint the browser drops the declaration entirely and
 * the error text inherits ink, so a validation message is not red until
 * hydration.
 */
export const DANGER_TEXT = "var(--dangerSoft, #B91C1C)";
