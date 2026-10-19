/**
 * Shared CSS custom-property strings for the DataTable family (web render
 * paths only — native paths consume Tamagui `$tokens` directly).
 *
 * Every value is `var(--<semanticToken>, <stub-hex>)`. The fallback is the
 * **Stub** (warm paper, default) theme value — it is what SSR / first paint
 * renders before `ActiveThemeInjector` mirrors the live theme onto `<body>`,
 * so a wrong fallback flashes. Canonical values live in
 * `packages/ui/src/ui/tamagui/tokens/colors.ts`; update both together.
 */

/** Structure border (2px rules, outer frames). Stub: ink. */
export const DT_BORDER = "var(--borderColor, #211C16)";

/** Hairline row separators (1px). Stub: 30% ink. */
export const DT_BORDER_SOFT = "var(--borderColorSoft, rgba(33, 28, 22, 0.3))";

/** Strongest rule — the header baseline. Stub: black. */
export const DT_BORDER_STRONG = "var(--borderColorStrong, #000000)";

/** Table/card surface. Stub: raised paper. */
export const DT_SURFACE = "var(--surface, #FDFAF3)";

/** Muted surface (skeleton blocks, expanded-row wells). */
export const DT_SURFACE_MUTED = "var(--surfaceMuted, #EFE7D6)";

/** Row hover wash. */
export const DT_BACKGROUND_HOVER = "var(--backgroundHover, #EFE7D6)";

/** Primary text. Stub: ink. */
export const DT_INK = "var(--color, #211C16)";

/** Secondary text (placeholders, inactive sort carets). */
export const DT_INK_MUTED = "var(--colorMuted, #5C544A)";

/**
 * Accent — graphic/border use only (selected-row rail, active sort underline, resize handle, focus ring).
 * NOT AA as small text; use `DT_ACCENT_TEXT` for accent-coloured labels.
 */
export const DT_ACCENT = "var(--accent, #E2481D)";

/** Accent at label legibility (active sort header + caret). */
export const DT_ACCENT_TEXT = "var(--accentText, #A8300F)";

/** Accent tint for selected rows. */
export const DT_ACCENT_SOFT = "var(--accentSoft, rgba(226, 72, 29, 0.10))";

/** Focus-visible outline colour. */
export const DT_FOCUS = "var(--accent, #E2481D)";
