/**
 * Button variant styles — Design System v2 grammar (Swiss International
 * Typographic Style).
 *
 * Deliberately dependency-free: this module imports NOTHING. `Button.tsx` pulls
 * in `react-native`, whose Flow syntax no plain-node runner can parse, so any
 * check that wanted these constants was confined to Vitest (which aliases
 * `react-native` to a stub). Keeping the variant ladder in a leaf module lets
 * Playwright — the only runner that can read a REAL computed colour — assert
 * against the same single source the atom renders from, instead of a hand-copied
 * table that would drift. See `src/storybook/__e2e__/button-label-color.spec.ts`.
 *
 * v2 core variants:
 * - `primary`   — accent fill (orange #FF5721), the fire.
 * - `secondary` — structure outline (steel blue) that fills with structure
 *                 on hover, the hearth.
 * - `ghost`     — transparent; hovers on the raised chrome fill.
 * - `destructiveGhost` — transparent danger affordance in the legible
 *                 $dangerSoft text color; fills soft-red on hover. Low-emphasis
 *                 remove/revoke actions (the full-fill `destructive` shouts).
 *
 * Legacy variants (kept for existing call sites; removals are a later
 * cleanup): `subtle`, `destructive`, `outlined` (old accent outline).
 *
 * Shared grammar: uppercase 700 labels, +1.5px tracking, zero radius,
 * instant color inversion on hover (no opacity fades), 1–3 word labels,
 * one icon max (stroke currentColor).
 *
 * THEME FILL-IN: every variant's `hoverStyle` and `pressStyle` set BOTH
 * `backgroundColor` and `borderColor`, even when the value equals the resting
 * one. The normal Button is `styled(TamaguiButton)`, and Tamagui's ButtonFrame
 * carries `hoverTheme` / `pressTheme`: any hover/press background or border a
 * variant leaves unset is filled with the theme's `$backgroundHover` /
 * `$borderColorHover` / `$backgroundPress` / `$borderColorPress`. That turned
 * a red `destructive` button the default grey on hover. The asChild frame
 * (`styled(View)`) has no such fill-in, so an unset key also made the two
 * frames disagree. Pinned by the parity suite in
 * `__tests__/Button.asChild.test.tsx`.
 *
 * NOTE: `hoverStyle`/`pressStyle` colours land on the FRAME only — Tamagui
 * never applies them to ButtonText. The label tracks them via `color: inherit`
 * (see the `textProps` block in Button.tsx) and, for `<Text>` children, via
 * `tone="inherit"` (enforced at call sites by
 * `__tests__/button-label-inheritance.test.ts`).
 */
const variantStyles = {
  /**
   * Primary: the accent fill — main action fire.
   *
   * RESTS ON `$brandSecondaryHover`, NOT `$brandSecondary`. Button labels are
   * 11-13px bold, so the 4.5:1 small-text floor applies, and Stub's
   * `$brandSecondary` (#E2481D) has NO AA foreground in either polarity
   * (white 4.06:1, ink 4.38:1) — it cannot be rescued by swapping the label.
   * v2 §3 prescribes the deeper fill for small-text-on-accent, and the primary CTA
   * already rests there. See the fill-ladder block comment in tokens/colors.ts.
   *
   * The rung → rung rule: each state moves the fill AWAY from
   * `$onBrandSecondary`, so label contrast RISES at every step. Stub (white
   * label) deepens 5.92 → 8.10 → 10.38; Swiss/Ember (ink label) brighten
   * 4.61 → 5.61 → 7.07. One rule, opposite directions, because the label
   * polarity is opposite. Enforced by `__tests__/contrast-pairs.test.ts`.
   */
  primary: {
    backgroundColor: "$brandSecondaryHover",
    borderColor: "$brandSecondaryHover",
    color: "$onBrandSecondary",
    hoverStyle: {
      backgroundColor: "$brandSecondaryStrong",
      borderColor: "$brandSecondaryStrong",
      color: "$onBrandSecondary",
    },
    pressStyle: {
      // Deepest/brightest rung — NOT a hue flip to `$accent`: that read as
      // steel-blue on Swiss, was invisible on Ember ($accent === the resting
      // orange there), and on Stub landed at 3.89:1 (FAIL).
      backgroundColor: "$brandSecondaryPress",
      borderColor: "$brandSecondaryPress",
      color: "$onBrandSecondary",
      scale: 0.98,
    },
  },
  // Secondary (v2): structure outline — steel-blue border, ink label,
  // fills with structure on hover.
  secondary: {
    backgroundColor: "transparent",
    borderColor: "$structure",
    color: "$color",
    hoverStyle: {
      backgroundColor: "$structure",
      borderColor: "$structure",
      color: "$onStructure",
    },
    pressStyle: {
      backgroundColor: "$structurePress",
      borderColor: "$structurePress",
      color: "$onStructure",
      scale: 0.98,
    },
  },
  // Subtle: Muted background, blends in. Every rung sets border = fill, like
  // the rest of the ladder (see THEME FILL-IN in the header).
  subtle: {
    backgroundColor: "$surfaceMuted",
    borderColor: "$surfaceMuted",
    color: "$colorMuted",
    hoverStyle: {
      backgroundColor: "$backgroundStrong",
      borderColor: "$backgroundStrong",
      color: "$color",
    },
    pressStyle: {
      backgroundColor: "$backgroundInverted",
      borderColor: "$backgroundInverted",
      color: "$colorInverted",
      scale: 0.98,
    },
  },
  // Ghost: Fully transparent until interaction (v2: hovers on the raised
  // chrome fill).
  ghost: {
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderWidth: 0,
    color: "$color",
    hoverStyle: {
      backgroundColor: "$surfaceRaised",
      borderColor: "transparent",
    },
    pressStyle: {
      backgroundColor: "$accentSoft",
      borderColor: "transparent",
      color: "$color",
      scale: 0.98,
    },
  },
  // Ghost-inverted: ghost for use on an inverted/filled surface (e.g. the
  // $accent paint-mode pill) — inverted ink at rest, flipping back to $color
  // when hover paints the raised chrome fill underneath. Press KEEPS the
  // inverted ink: $accentSoft is translucent (8–18% alpha), so the filled
  // surface still shows through — only the opaque hover fill earns $color.
  ghostInverted: {
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderWidth: 0,
    color: "$colorInverted",
    hoverStyle: {
      backgroundColor: "$surfaceRaised",
      borderColor: "transparent",
      color: "$color",
    },
    pressStyle: {
      backgroundColor: "$accentSoft",
      borderColor: "transparent",
      color: "$colorInverted",
      scale: 0.98,
    },
  },
  // Destructive: Red/danger color. Hover and press only fade the opacity; the
  // fill and border are restated so the button stays red (THEME FILL-IN).
  destructive: {
    backgroundColor: "$danger",
    borderColor: "$danger",
    color: "$colorInverted",
    hoverStyle: {
      backgroundColor: "$danger",
      borderColor: "$danger",
      opacity: 0.9,
    },
    pressStyle: {
      backgroundColor: "$danger",
      borderColor: "$danger",
      opacity: 0.8,
      scale: 0.96,
    },
  },
  // Destructive-ghost: a low-emphasis destructive affordance — transparent
  // frame with the theme's legible danger TEXT color ($dangerSoft, AA on every
  // canvas, unlike the $danger fill as small text). Fills with $dangerSoft on
  // hover/press with an inverted (ink/paper) label that stays AA on the fill.
  // For "remove / disconnect / revoke"-style actions that shouldn't shout.
  destructiveGhost: {
    backgroundColor: "transparent",
    borderColor: "$dangerSoft",
    borderWidth: 1,
    color: "$dangerSoft",
    hoverStyle: {
      backgroundColor: "$dangerSoft",
      borderColor: "$dangerSoft",
      color: "$colorInverted",
    },
    pressStyle: {
      backgroundColor: "$dangerSoft",
      borderColor: "$dangerSoft",
      color: "$colorInverted",
      scale: 0.98,
    },
  },
  /**
   * Outlined: Accent border, fills on hover.
   *
   * RIDES `$accentText`, NOT `$accent` — the inverse of the `primary` fix
   * above, and the same failing pair: `$accent` (#E2481D) as an 11-13px LABEL
   * is 3.57:1 on Stub's cream canvas / 3.89:1 on `$surface`, both under the
   * 4.5:1 small-text floor. `$accent` stays correct for the large fills and
   * rules it was tuned for (>=3:1); it is just not a legal label colour here.
   * `$accentText` is that same hue at label legibility (5.22 / 5.68 on Stub),
   * and is a no-op on Swiss, whose accent already clears AA as text.
   *
   * The variant INVERTS around one token: `$accentText` is the resting label
   * AND the hover fill, so hover is a true colour inversion (v2 §4) rather than
   * two loosely-related oranges.
   *
   * Press then takes `$accentTextPress`, obeying the same rung → rung rule as
   * `primary`: the fill moves AWAY from `$colorInverted`, so label contrast
   * RISES (Stub 5.68 → 7.77, Swiss 6.97 → 9.46, Ember 5.61 → 7.07). It is NOT
   * `$accentHard`: that token is #B93312 on Stub — identical to the rest rung,
   * so it would collapse hover === press — and steel-blue #2A4578 on Ember,
   * where the dark `$colorInverted` ink lands on it at 1.88:1 (an invisible
   * pressed label — the bug this variant shipped with). Enforced by
   * `__tests__/contrast-pairs.test.ts`.
   *
   * NOTE: decorative accent text (the mono kicker, tags, index numerals,
   * prices) deliberately keeps `$accent` — that is aria-hidden ornament, not a
   * control label, and it is out of scope here.
   *
   * @deprecated legacy accent outline — v2 secondary is the structure
   * outline; prefer variant="secondary".
   */
  outlined: {
    backgroundColor: "transparent",
    borderColor: "$accentText",
    color: "$accentText",
    hoverStyle: {
      backgroundColor: "$accentText",
      borderColor: "$accentText",
      color: "$colorInverted",
    },
    pressStyle: {
      backgroundColor: "$accentTextPress",
      borderColor: "$accentTextPress",
      color: "$colorInverted",
      scale: 0.98,
    },
  },
} as const;

export const BUTTON_VARIANT_STYLES = variantStyles;

export type ButtonVariant = keyof typeof BUTTON_VARIANT_STYLES;
