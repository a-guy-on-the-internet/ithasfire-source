/**
 * COLOR RULES — the SHORT list of files in `@th/ui` allowed to keep a raw color literal.
 *
 * ## This is NOT a debt grandfather list
 *
 * Every literal that was *debt* (an Ember-era fallback that is invisible or wrong on the shipped
 * Stub paper theme) was migrated off before the rule was switched on — the `theme.X?.val ?? "…"`
 * fallbacks across the form components now resolve to `stubTheme.X`. This file lists ONLY the
 * places where a raw literal is genuinely *correct*, and each entry states why.
 *
 * Before adding anything here, re-read `docs/design/design-system-v2.md` §2 and check that no
 * existing semantic token already covers the value. If a token covers it, use the token.
 *
 * ## Why each one is legitimate
 *
 *   - `src/ui/tamagui/components/shared.ts` — the badge / notification / intent token math. This
 *     module computes its palette at **module scope**, outside React, so it cannot read the active
 *     theme; its output must clear WCAG AA on all three themes (stub/swiss/ember) simultaneously.
 *     Its three literals are each a deliberate, contrast-tuned, theme-independent constant that no
 *     single semantic token can express:
 *       • `hexToRgba("#000000", 0.15 / 0.12)` — a black scrim tinting the icon well on a *solid
 *         badge fill*. The fill itself (danger/success/warning/accent) is identical in every
 *         theme, so darkening it by 12–15% is theme-independent by construction. It is a depth
 *         effect on a known color, not a surface color. `structurePress` is also `#000000` on Stub
 *         but means "pressed structural fill" — using it here would be a semantic lie, and it is
 *         `#2A4578` (navy) on Ember, which would break the effect.
 *       • `neutralAccent = "#7B8BA4"` — the neutral badge accent. `colorMuted` cannot be used: it
 *         is theme-dependent (#5C544A Stub / #A0B0CC Ember) and this value is resolved once at
 *         module load with no theme in scope. #7B8BA4 is the mid-slate tuned to stay legible on
 *         both paper and navy.
 *       • `warningTextAccent = "#B8860B"` — dark-goldenrod badge text. The bright `warning`
 *         (#FACC15) fails AA as text on both light and dark. `warningSoft` exists but is
 *         per-theme (#B45309 / #FBBF24 / #92400E) and, again, unreachable at module scope; this
 *         is the both-themes compromise.
 *     If `shared.ts` is ever refactored to resolve per-theme inside React (it would need a
 *     `ThemeName` argument threaded through `getBadgeVariantTokens`), delete this entry and use
 *     tokens.
 */
export const colorPermanents = ["src/ui/tamagui/components/shared.ts"];
