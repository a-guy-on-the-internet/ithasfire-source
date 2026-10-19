// ─────────────────────────────────────────────────────────────────────────────
// Palette — the SINGLE source of truth for raw brand / accent / status hex
// values.  Both themes, the `colorTokens.color` bag, and all component helpers
// derive from this object.  Never duplicate these values elsewhere.
//
//   Brand:   steel blue #35589A  ·  warm orange #FF5721
//   Warm:    vivid orange #FF5721 (accent highlights)
// ─────────────────────────────────────────────────────────────────────────────
const palette = {
  brandPrimary: "#35589A",
  brandSecondary: "#FF5721",
  /**
   * Darker orange. Despite the `Hover` in the name this is the primary button's
   * REST fill — `brandSecondary` (#E2481D) has no AA-compliant label in either
   * polarity, so the ladder starts one rung deep (see the fill-ladder block
   * below and Button's `primary` variant). The name is kept because hundreds of
   * call sites reference it; renaming is a later cleanup.
   *
   * Tuned so dark ink (`onBrandSecondary` #181818) keeps WCAG AA (4.61:1) on
   * this fill — the previous #E04A18 dipped to 4.36:1 with ink and 4.07:1 with
   * white, leaving no compliant label color.
   */
  brandSecondaryHover: "#E84B19",
  warmAccent: "#FF5721",
  neutral100: "#F5F5F5",
  neutral300: "#D4D4D4",
  neutral700: "#707070",
  neutral900: "#181818",
  /** Steel-blue tinted light grey (Swiss spec background wash). */
  accentSubtle: "#E8EDF5",
  accent: "#35589A",
  accentHard: "#2A4578",
  success: "#22C55E",
  warning: "#FACC15",
  danger: "#EF4444",
  /**
   * Amber "support" highlight (design-system v2) — FREE price callouts and
   * hot claimed bars. Theme-independent: the same amber is used in every theme.
   */
  support: "#F59E0B",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Light theme — Swiss minimalism: white-dominant, high-contrast, maximum clarity.
//
//   Page: pure white background, dark text for maximum readability
//   Primary buttons: orange (#FF5721) for action, steel blue (#35589A) for structure
//   Accent: steel blue (#35589A)
//   backgroundStrong: steel blue for headers, heroes, navs
// ─────────────────────────────────────────────────────────────────────────────
export const lightTheme = {
  name: "swiss" as const,

  // Semantic status
  success: "#22C55E",
  warning: "#FACC15",
  danger: "#EF4444",
  info: "#35589A",
  focus: "#35589A",
  // Status TEXT variants — the bright fills above fail WCAG AA as small text
  // on this theme's canvas (#FACC15 ≈ 1.4:1, #EF4444 ≈ 4.0:1 on white), so
  // status COPY and destructive-ghost affordances use these legible reds/ambers.
  // red-700 (not red-600 #DC2626, which is only 4.43:1 on surfaceMuted #F5F5F5)
  // so the token clears AA on the raised light surfaces too, not just pure white.
  dangerSoft: "#B91C1C", // red-700 ≈ 6.7:1 on #FFFFFF, ≈6.4:1 on #F5F5F5
  warningSoft: "#B45309", // amber-700 ≈ 5.0:1 on #FFFFFF, ≈4.9:1 on #F5F5F5

  // Backgrounds — white-dominant Swiss canvas
  background: "#FFFFFF",
  backgroundHover: "#F0F0F0",
  backgroundPress: "#E8E8E8",
  backgroundFocus: "#F0F3F9",
  backgroundInverted: "#181818",
  backgroundStrong: "#35589A",

  // Surfaces — clean whites with subtle warm grey for muted
  surface: "#FFFFFF",
  surfaceMuted: "#F5F5F5",
  surfaceRaised: "#FFFFFF",
  surfaceStrong: "#35589A",
  surfaceOverlay: "rgba(24, 24, 24, 0.04)",

  // Text / color (Tamagui maps `color` to text color)
  color: "#181818",
  colorMuted: "#707070",
  colorInverted: "#FFFFFF",
  muted: "#707070",
  mutedSurface: "#F5F5F5",

  // ── Foregrounds on the INVERTED surface (`backgroundInverted`) ────────
  //
  // `colorInverted` already names the PRIMARY foreground on that surface.
  // These two name the other two rungs the same surface needs, and they exist
  // because an inverted panel is not just "the theme with the polarity
  // flipped": `colorMuted` and `dangerSoft` are each tuned for THIS theme's
  // canvas, so on `backgroundInverted` they measure 2.5:1 and 2.6:1 (Stub) —
  // invisible, not merely dim.
  //
  // Added for the ink auth card (`[data-auth-card]` in apps/web globals.css),
  // which re-binds the semantic layer for its own subtree the way a theme
  // does. Any inverted panel wants the same two values.
  //
  //   colorMutedInverted — muted copy, placeholders, disabled labels.
  //   dangerSoftInverted — error copy and error rules. NOT `support`: on a
  //     form surface, collapsing "this failed" and "this is a caution" into
  //     one hue costs a distinction the reader needs, and a bright red is
  //     legal here (Stub #F87171 = 6.11:1 on #211C16) where the canvas-tuned
  //     #B91C1C is not (2.61:1).
  // On this theme's `backgroundInverted` #181818: 7.47:1.
  colorMutedInverted: "#A8A8A8",
  // red-400 on #181818 = 6.42:1. (`dangerSoft` #B91C1C there is 2.75:1.)
  dangerSoftInverted: "#F87171",

  // Borders — visible structural lines, Swiss grid presence.
  // #8C8C8C reaches 3.36:1 on white, clearing WCAG 1.4.11 (3:1) for the
  // input-vs-page boundary with margin while staying a subtle Swiss hairline;
  // the old #D4D4D4 was only 1.48:1 (FAIL). Stays light enough not to
  // over-weight card edges and dividers that also read this token.
  borderColor: "#8C8C8C",
  borderColorStrong: "#181818",
  borderColorHover: "#35589A",
  borderColorPress: "#2A4578",
  borderColorFocus: "#35589A",
  outlineColor: "#35589A",

  // Accent (steel blue)
  accent: "#35589A",
  accentSoft: "rgba(53, 88, 154, 0.08)",
  accentHard: "#2A4578",
  accentHover: "#4170B0",

  // ── Accent-as-small-text ladder ────────────────────────────────────────
  // READ THIS BEFORE TOUCHING ANY `accentText*` VALUE.
  //
  // `accent` is a LARGE-SURFACE / GRAPHIC value: legal for fills, 2px borders
  // and rules, where the 3:1 (AA-large / non-text) floor applies. It is NOT
  // always legal as an 11-13px button label. On Stub, `accent` #E2481D is only
  // 3.57:1 on the cream canvas — the same failing pair as the primary CTA, just
  // INVERTED (accent-on-paper instead of paper-on-accent).
  //
  // `accentText` is the accent hue pulled to small-text legibility on THIS
  // theme's canvas. It names BOTH sides of the outlined Button, because that
  // variant inverts around it:
  //   rest  → label + border = accentText (on the canvas)
  //   hover → fill = accentText, label = colorInverted   (a true inversion)
  //   press → fill = accentTextPress, label = colorInverted
  //
  // THE RULE (same as the primary ladder below): hover -> press moves the fill
  // AWAY from `colorInverted`, so label contrast RISES. Stub carries a PAPER
  // label so it deepens (5.68 -> 7.77); Swiss carries a WHITE label so it also
  // deepens (6.97 -> 9.46); Ember carries an INK label so it BRIGHTENS
  // (5.61 -> 7.07). Never move the press rung toward the label colour.
  //
  // Swiss's accent already clears AA as text (6.97:1 on white), so both rungs
  // are just today's accent/accentHard — this theme is unchanged by design.
  //
  // DO NOT use this for DECORATIVE accent text (the mono kicker, tags, index
  // numerals, prices). Those are aria-hidden ornament that deliberately ride
  // `accent`; deepening them is a product-wide visual change, not an a11y fix.
  accentText: "#35589A",
  accentTextPress: "#2A4578",

  // ── Primary-CTA fill ladder ────────────────────────────────────────────
  // READ THIS BEFORE TOUCHING ANY `brandSecondary*` VALUE.
  //
  // `brandSecondary` is the BRAND accent: correct for large fills, borders and
  // graphics, where the 3:1 (AA-large / non-text) floor applies. It is NOT a
  // legal substrate for an 11-13px bold button label. On Stub the accent
  // #E2481D has NO WCAG-AA small-text foreground AT ALL — white is 4.06:1 and
  // ink is 4.38:1, so you cannot rescue it by swapping the label. That is why
  // the Button primary variant and the page CTAs both REST on
  // `brandSecondaryHover`, not on `brandSecondary`. The `Hover` in that name is
  // historical; read it as "the accent fill that can carry small text".
  //
  // The three rungs the primary CTA actually uses:
  //   rest  → brandSecondaryHover
  //   hover → brandSecondaryStrong
  //   press → brandSecondaryPress
  //
  // THE RULE: every rung moves the fill AWAY from `onBrandSecondary`, so label
  // contrast RISES at each step. The two theme families therefore travel in
  // OPPOSITE directions, from one rule: Stub carries a WHITE label so it
  // deepens (5.92 → 8.10 → 10.38); Swiss/Ember carry an INK label so they
  // brighten (4.61 → 5.61 → 7.07) — the coal ignites under the cursor.
  // Never move a rung toward the label colour: that is the bug this ladder
  // encodes against.
  brandSecondary: "#FF5721",
  brandSecondaryHover: "#E84B19",
  brandSecondaryStrong: "#FF5721",
  brandSecondaryPress: "#FF7E52",
  // Foreground on the orange brand fill. Dark ink (#181818) clears WCAG AA
  // (4.5:1) on every rung of the ladder above: 4.61 / 5.61 / 7.07. White on
  // the same oranges is only 3.85 / 3.16 / 2.51 (all FAIL).
  onBrandSecondary: "#181818",

  // Overlay
  overlay: "rgba(0, 0, 0, 0.64)",

  // ── Design System v2 additions (Phase 1, additive) ──
  // Amber support highlight (FREE price, hot claimed bars) — theme-independent.
  support: "#F59E0B",
  // Dark ink on amber clears WCAG AA on #F59E0B.
  onSupport: "#181818",
  // Structural steel-blue rules (v2 --color-structure / --color-structure-press).
  structure: "#35589A",
  structurePress: "#2A4578",
  // Foreground on the structure fill. White on #35589A ≈ 6.9:1 (WCAG AA).
  onStructure: "#FFFFFF",

  // ── The scrim trio: a dark ground for reversed-out type over imagery ──
  //
  // `structure` is NOT this. It is a structural steel-blue in Swiss and Ember
  // and the ink only in Stub, so the poster card's documented invariant — "the
  // art panel's ground is INK, always" — was true in exactly one theme. In
  // Ember the poster's ground and its scrim ramp resolved to #35589A, a
  // MID-TONE, and everything reversed out of it lost its headroom at once:
  // measured on the rendered card, the accent rule came in at 1.81:1 against
  // the 3:1 graphic floor and a dimmed tier row at 1.22:1 against 4.5:1.
  //
  // So the ground moves to its own token, dark in every theme, and its two
  // foreground rungs travel WITH it — a fill and its foregrounds are one unit
  // or they drift apart, which is the whole bug class `contrast-pairs.test.ts`
  // exists to catch.
  //
  // The rule drawn on it is `brandSecondary`, not `accent`: identical hex in
  // Stub and Ember, and the one that still clears the 3:1 non-text floor on
  // Swiss, where `accent` IS the steel-blue.
  // Swiss's own near-black, the value its inverted panels already use.
  scrim: "#181818",
  // 17.76:1 on #181818.
  onScrim: "#FFFFFF",
  // 7.47:1 on #181818 — the same rung `colorMutedInverted` uses for this
  // theme's inverted panel, which is the same darkness.
  onScrimMuted: "#A8A8A8",

  // Soft hairline divider — light borderColor #8C8C8C at 40% alpha.
  borderColorSoft: "rgba(140, 140, 140, 0.4)",

  // ── The FAIL verdict fill (full-bleed scan verdicts) ──
  //
  // PINNED — the same value in all three themes, deliberately, and NOT the
  // themed `brandSecondary`/`brandSecondaryHover` ladder.
  //
  // The scan surface used to run FOUR verdict families on green and red
  // (`successFill` / `support` / `structure` / `dangerFill`). The Ithas Fire
  // Design System specifies TWO tones — pass and fail — with the WORD carrying
  // the instruction (DECISIONS.md D-123). Green and red were never in this
  // brand's palette; flame and amber are. So:
  //
  //   PASS = `support` + `onSupport` — swiss 8.27:1, ember 7.98:1, stub 7.87:1
  //   FAIL = `verdictFail` + `onVerdictFail` — 5.92:1 in ALL THREE
  //
  // ## Why FAIL is pinned rather than themed
  //
  // Every themed candidate loses AA on at least one theme, measured:
  //   `brandSecondaryHover` is #E84B19 on swiss/ember → the small state line
  //     fails there; `brandSecondary` is #E2481D on stub → 4.06:1; `accentHard`
  //     is navy #2A4578 on swiss/ember → 1.88:1 against the amber pass fill.
  //   `accent` itself (#E2481D) has NO legal foreground in either polarity and
  //     may never be a verdict fill.
  // Pinning flame-600 also keeps the two fills 2.75:1 apart on every theme —
  // the colour channel survives in the dark-venue theme, which is the one
  // condition this surface exists for — and it is the value the NATIVE scanner
  // pins (`packages/ui-native/src/palette.ts` → `verdictFail`), so both
  // surfaces speak one value. The DS agrees: it has a single
  // `--color-accent-fill`, not a per-theme one.
  //
  // No alpha-muted foreground is ever legal on a verdict fill: the DS's own
  // `.if-verdict__state { opacity: .85 }` measures 4.67:1 on the FAIL pair
  // (5.92:1 at full opacity) — clearing AA by only 0.17 — and
  // an alpha foreground on a tone fill is the exact bug this surface already
  // shipped once (70% white on the old green fill = 4.40:1, missed AA by a
  // tenth, nobody caught it by eye). Hierarchy is size and weight only.
  /** FAIL verdict fill — flame-600, theme-invariant. */
  verdictFail: "#B93312",
  /** The ONLY foreground legal on `verdictFail` — 5.92:1 on every theme. */
  onVerdictFail: "#FFFFFF",

  // ── Danger FILL ──
  //
  // NOT a verdict tone (see above). This is checkout's expired-hold chip and
  // the booking hold picker's invalid edge: `DANGER_FILL` / `ON_DANGER_FILL`
  // in `apps/web/src/lib/design-tokens.ts`. Theme-invariant PAIR — white on
  // #B91C1C = 6.47:1 — because a themed fill with a fixed foreground drifts
  // apart. It is deliberately not `danger` (#EF4444 on swiss/ember), which has
  // no legal foreground as a full-bleed fill at all.
  dangerFill: "#B91C1C",
  onDangerFill: "#FFFFFF",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Dark theme — Swiss minimalism in dark mode: deep background, crisp white text.
//
//   Page: near-black (#0F1B33), white text
//   Accent highlights: orange (#FF5721) for action
//   Steel blue (#35589A) for structural accents
//
//   NOTE: this is the "Ember" dark theme (design-system v2). Its runtime
//   Tamagui key AND name are both `ember` — deliberately NOT prefixed with
//   "dark" so Tamagui never emits it into a prefers-color-scheme :root rule
//   (that prefix-driven root emission was the cause of the OS-dark first-paint
//   flash). Consumers that select it by name — scanner App.tsx and mobile
//   App.tsx (`theme="ember"`) — have been updated to match. The exported JS
//   identifier stays `darkTheme` to avoid churn; only the name/key are `ember`.
// ─────────────────────────────────────────────────────────────────────────────
export const darkTheme = {
  name: "ember" as const,

  // Semantic status
  success: "#22C55E",
  warning: "#FACC15",
  danger: "#EF4444",
  info: "#5E8AD4",
  focus: "#5E8AD4",
  // Status TEXT variants — legible reds/ambers on the deep-navy canvas. The
  // #EF4444 danger fill is only ~4.0:1 as text on #0F1B33; several sites kept
  // raw #F87171 for exactly this reason. Now tokenised (danger/warning-Soft)
  // and consumed by status COPY + the destructive-ghost Button variant.
  dangerSoft: "#F87171", // red-400 ≈ 5.9:1 on the navy canvas
  warningSoft: "#FBBF24", // amber-400 ≈ 9:1 on the navy canvas

  // Backgrounds — deep navy derived from #35589A
  background: "#0F1B33",
  backgroundHover: "#162240",
  backgroundPress: "#1A2847",
  backgroundFocus: "#1E2E52",
  backgroundInverted: "#FFFFFF",
  backgroundStrong: "#1A2847",

  // Surfaces — slightly raised navy panels
  surface: "#162240",
  surfaceMuted: "#1E2E52",
  surfaceRaised: "#1A2847",
  surfaceStrong: "#2A4578",
  surfaceOverlay: "rgba(53, 88, 154, 0.12)",

  // Text / color
  color: "#FFFFFF",
  colorMuted: "#A0B0CC",
  colorInverted: "#181818",
  muted: "#A0B0CC",
  mutedSurface: "#1E2E52",

  // ── Foregrounds on the INVERTED surface (`backgroundInverted`) ────────
  //
  // `colorInverted` already names the PRIMARY foreground on that surface.
  // These two name the other two rungs the same surface needs, and they exist
  // because an inverted panel is not just "the theme with the polarity
  // flipped": `colorMuted` and `dangerSoft` are each tuned for THIS theme's
  // canvas, so on `backgroundInverted` they measure 2.5:1 and 2.6:1 (Stub) —
  // invisible, not merely dim.
  //
  // Added for the ink auth card (`[data-auth-card]` in apps/web globals.css),
  // which re-binds the semantic layer for its own subtree the way a theme
  // does. Any inverted panel wants the same two values.
  //
  //   colorMutedInverted — muted copy, placeholders, disabled labels.
  //   dangerSoftInverted — error copy and error rules. NOT `support`: on a
  //     form surface, collapsing "this failed" and "this is a caution" into
  //     one hue costs a distinction the reader needs, and a bright red is
  //     legal here (Stub #F87171 = 6.11:1 on #211C16) where the canvas-tuned
  //     #B91C1C is not (2.61:1).
  // Ember's `backgroundInverted` is #FFFFFF — the inverted panel is LIGHT
  // here, so both values invert with it. #707070 on white = 4.95:1.
  colorMutedInverted: "#707070",
  // red-700 on white = 6.47:1. (`dangerSoft` #F87171 there is 2.63:1.)
  dangerSoftInverted: "#B91C1C",

  // Borders — visible structural lines. Resting borderColor must clear WCAG
  // 1.4.11 (>=3:1) against the input surface (#162240); #2A3E66 was only
  // 1.48:1. #5A78A6 = 3.49:1 on surface (and >=3:1 on the page/raised
  // surfaces), matching the light theme's #8C8C8C hairline treatment.
  borderColor: "#5A78A6",
  borderColorStrong: "#F5F5F5",
  borderColorHover: "#FF5721",
  borderColorPress: "#E04A18",
  borderColorFocus: "#FF7E52",
  outlineColor: "#FF5721",

  // Accent — orange for warm highlights
  accent: "#FF5721",
  accentSoft: "rgba(255, 87, 33, 0.18)",
  accentHard: "#2A4578",
  accentHover: "#FF7E52",

  // Accent-as-small-text ladder. See the block comment on `lightTheme`.
  //
  // Ember's accent #FF5721 already clears AA as text on the navy canvas
  // (5.42:1 on `background`, 4.96:1 on `surface`), so the rest rung is the
  // accent itself — Stub's "deepen it" reasoning does NOT transfer here.
  //
  // The press rung, however, must BRIGHTEN, not deepen: Ember's `colorInverted`
  // is dark ink #181818, so moving away from the label means going lighter.
  // This is why it is NOT `accentHard` — that token is steel-blue #2A4578 in
  // this theme, and ink on it lands at 1.88:1 (an invisible pressed label).
  // Consumers that fill with `accentHard` here pair it with `onStructure`
  // (near-white), which is why they are fine and this one was not.
  accentText: "#FF5721",
  accentTextPress: "#FF7E52",

  // Brand secondary (orange) — the primary-CTA fill ladder. See the block
  // comment on `lightTheme` above for the rule; Ember matches Swiss because
  // both carry the INK label, so both BRIGHTEN as the ladder climbs
  // (rest 4.61 → hover 5.61 → press 7.07 against #181818).
  brandSecondary: "#FF5721",
  brandSecondaryHover: "#E84B19",
  brandSecondaryStrong: "#FF5721",
  brandSecondaryPress: "#FF7E52",
  // Foreground on the orange brand fill. Dark ink (#181818) clears WCAG AA
  // (4.5:1) on every rung — white on these oranges fails on all three.
  onBrandSecondary: "#181818",

  // Overlay
  overlay: "rgba(0, 0, 0, 0.60)",

  // ── Design System v2 additions (Phase 1, additive) ──
  // Amber support highlight — theme-independent fill.
  support: "#F59E0B",
  // Deep navy ink on amber (matches the page canvas) — clears WCAG AA on #F59E0B.
  onSupport: "#0F1B33",
  // Structural steel-blue rules (v2 --color-structure / --color-structure-press).
  structure: "#35589A",
  structurePress: "#2A4578",
  // Foreground on the structure fill. White on #35589A ≈ 6.9:1 (WCAG AA).
  onStructure: "#FFFFFF",

  // ── The scrim trio: a dark ground for reversed-out type over imagery ──
  //
  // `structure` is NOT this. It is a structural steel-blue in Swiss and Ember
  // and the ink only in Stub, so the poster card's documented invariant — "the
  // art panel's ground is INK, always" — was true in exactly one theme. In
  // Ember the poster's ground and its scrim ramp resolved to #35589A, a
  // MID-TONE, and everything reversed out of it lost its headroom at once:
  // measured on the rendered card, the accent rule came in at 1.81:1 against
  // the 3:1 graphic floor and a dimmed tier row at 1.22:1 against 4.5:1.
  //
  // So the ground moves to its own token, dark in every theme, and its two
  // foreground rungs travel WITH it — a fill and its foregrounds are one unit
  // or they drift apart, which is the whole bug class `contrast-pairs.test.ts`
  // exists to catch.
  //
  // The rule drawn on it is `brandSecondary`, not `accent`: identical hex in
  // Stub and Ember, and the one that still clears the 3:1 non-text floor on
  // Swiss, where `accent` IS the steel-blue.
  // Ember's deep navy page ground — the darkest value the theme owns, and the
  // only one in the navy family that reads as ink rather than as a chip.
  scrim: "#0F1B33",
  // 17.14:1 on #0F1B33.
  onScrim: "#FFFFFF",
  // A cool blue-grey pulled back from white: 7.96:1 on #0F1B33, and 2.4x
  // dimmer in luminance than `onScrim`, so "dimmed" still reads as a step down
  // rather than as a second white. (`colorMutedInverted` is NOT this value —
  // it is muted on Ember's INVERTED panel, which is white.)
  onScrimMuted: "#9FB2D0",

  // Soft hairline divider — dark borderColor #5A78A6 at 40% alpha.
  borderColorSoft: "rgba(90, 120, 166, 0.4)",

  // ── Verdict FAIL fill + danger fill — identical in all three themes ON
  // PURPOSE. Do NOT "brighten `verdictFail` for Ember": the point of pinning it
  // is that amber (#F59E0B) against Ember's #FF5721 is 1.47:1, i.e. the two
  // verdicts become the same colour at a glance in the dark-venue theme. See
  // the block on `lightTheme` for the full rule.
  verdictFail: "#B93312",
  onVerdictFail: "#FFFFFF",
  dangerFill: "#B91C1C",
  onDangerFill: "#FFFFFF",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Stub theme — "Stub" from design-system v2: ticket-stub warm paper light theme.
//
//   Page: cream (#F6F0E4), warm ink text (#211C16)
//   Accent: burnt orange (#E2481D), hover/press deepens to #B93312
//   Borders ARE the ink — hard print-style edges, no grey hairlines
//
//   Key set must stay identical to lightTheme (getThemeTokenKeys derives from
//   lightTheme; ActiveThemeInjector mirrors keys as CSS vars).
// ─────────────────────────────────────────────────────────────────────────────
export const stubTheme = {
  name: "stub" as const,

  // Semantic status — darkened vs the light theme so each clears WCAG AA
  // (≥4.5:1) as TEXT on the cream canvas (#F6F0E4): success/warning ≈ 6.3:1,
  // danger ≈ 5.7:1. (Tailwind's 700-step greens/ambers — #15803D / #B45309 —
  // only reach ≈4.4:1 on cream, AA-large but not AA.) The light theme's bright
  // fills (#22C55E / #FACC15 / #EF4444) wash out entirely on warm paper.
  success: "#166534",
  warning: "#92400E",
  danger: "#B91C1C",
  info: "#211C16",
  focus: "#E2481D",
  // Status TEXT variants — the stub status colors are already darkened for
  // legibility on cream, so the Soft variants match the fills (both AA as
  // text: dangerSoft ≈ 5.7:1, warningSoft ≈ 6.3:1 on #F6F0E4).
  dangerSoft: "#B91C1C",
  warningSoft: "#92400E",

  // Backgrounds — warm paper canvas
  background: "#F6F0E4",
  backgroundHover: "#EFE7D6",
  backgroundPress: "#E6DCC6",
  backgroundFocus: "#EFE7D6",
  backgroundInverted: "#211C16",
  backgroundStrong: "#211C16",

  // Surfaces — brighter paper panels over the cream page
  surface: "#FDFAF3",
  surfaceMuted: "#EFE7D6",
  surfaceRaised: "#EFE7D6",
  surfaceStrong: "#211C16",
  surfaceOverlay: "rgba(33, 28, 22, 0.04)",

  // Text / color — warm ink
  color: "#211C16",
  colorMuted: "#5C544A",
  colorInverted: "#FDFAF3",
  muted: "#5C544A",
  mutedSurface: "#EFE7D6",

  // ── Foregrounds on the INVERTED surface (`backgroundInverted`) ────────
  //
  // `colorInverted` already names the PRIMARY foreground on that surface.
  // These two name the other two rungs the same surface needs, and they exist
  // because an inverted panel is not just "the theme with the polarity
  // flipped": `colorMuted` and `dangerSoft` are each tuned for THIS theme's
  // canvas, so on `backgroundInverted` they measure 2.5:1 and 2.6:1 (Stub) —
  // invisible, not merely dim.
  //
  // Added for the ink auth card (`[data-auth-card]` in apps/web globals.css),
  // which re-binds the semantic layer for its own subtree the way a theme
  // does. Any inverted panel wants the same two values.
  //
  //   colorMutedInverted — muted copy, placeholders, disabled labels.
  //   dangerSoftInverted — error copy and error rules. NOT `support`: on a
  //     form surface, collapsing "this failed" and "this is a caution" into
  //     one hue costs a distinction the reader needs, and a bright red is
  //     legal here (Stub #F87171 = 6.11:1 on #211C16) where the canvas-tuned
  //     #B91C1C is not (2.61:1).
  // Warm paper pulled back to muted on the ink panel: 8.24:1 on #211C16.
  // (`colorMuted` #5C544A there is 2.06:1 — FAIL.)
  colorMutedInverted: "#BDB4A6",
  // red-400 on #211C16 = 6.11:1. (`dangerSoft` #B91C1C there is 2.61:1.)
  dangerSoftInverted: "#F87171",

  // Borders — the ink itself (print-style hard edges)
  borderColor: "#211C16",
  borderColorStrong: "#000000",
  borderColorHover: "#E2481D",
  borderColorPress: "#B93312",
  borderColorFocus: "#E2481D",
  outlineColor: "#E2481D",

  // Accent — burnt orange
  accent: "#E2481D",
  accentSoft: "rgba(226, 72, 29, 0.10)",
  accentHard: "#B93312",
  accentHover: "#B93312",

  // Accent-as-small-text ladder. See the block comment on `lightTheme`.
  //
  // This is the theme the ladder exists for. `accent` #E2481D as a LABEL is
  // 3.57:1 on the cream canvas and 3.89:1 on `surface` — both fail the 4.5:1
  // small-text floor. It stays the accent for large fills, borders and rules
  // (>=3:1 there), exactly as `brandSecondary` does for the primary CTA.
  //
  // Both rungs continue down the same burnt-orange hue line the primary ladder
  // already walks, so an outlined button and a primary button pressed side by
  // side are the same family, one rung apart.
  //   rest/hover #A8300F → 5.98 on canvas, 6.51 inverted
  //   press      #7A1F08 → 9.94 inverted
  // `accentTextPress` is NOT `accentHard` here: that is #B93312, i.e. the fill
  // ladder's REST rung, so reusing it would flatten this ladder against that
  // one and cost the button its press affordance.
  //
  // Reconciled 2026-09-03 with the design system's `tokens/colors.css`, which
  // is the source for these hues: `--color-accent-text` is flame-800 #A8300F
  // ("text-safe accent ON CREAM"), not flame-600. The old #B93312 cleared AA at
  // 5.22 but is the fill ladder's rest rung doing double duty as text; the
  // folder separates the two, and every rung of this ladder rises under the
  // change (5.22 → 5.98 as text, 5.68 → 6.51 and 7.77 → 9.94 inverted).
  accentText: "#A8300F",
  accentTextPress: "#7A1F08",

  // Brand secondary (burnt orange) — the primary-CTA fill ladder. See the
  // block comment on `lightTheme` above for the rule. Stub carries a WHITE
  // label, so it travels the OPPOSITE way to Swiss/Ember: it DEEPENS as the
  // ladder climbs (rest 5.92 → hover 8.22 → press 10.36 against #FFFFFF).
  //
  // The three rungs are the design system's flame-600 / flame-700 / flame-900
  // (`tokens/colors.css`), reconciled 2026-09-03. They were #B93312 / #98240B /
  // #7D1A07 — the same hue line hand-stepped, landing within ~0.1 of the
  // folder's contrast at every rung, but off its palette by a few points each.
  //
  // brandSecondary (#E2481D, flame-500) is deliberately NOT a rung: it is the
  // only value here with no AA small-text foreground in either polarity (white
  // 4.06:1, ink 4.38:1). Keep it for large fills, borders and graphics only.
  brandSecondary: "#E2481D",
  brandSecondaryHover: "#B93312",
  brandSecondaryStrong: "#94270C",
  brandSecondaryPress: "#7A1F08",
  // White clears WCAG AA on every rung of the ladder above (5.92 / 8.22 /
  // 10.36) — but NOT on `brandSecondary` (#E2481D, 4.06:1), which is exactly
  // why the CTA rests on `brandSecondaryHover`.
  onBrandSecondary: "#FFFFFF",

  // Overlay
  overlay: "rgba(33, 28, 22, 0.5)",

  // ── Design System v2 additions (Phase 1, additive) ──
  // Amber support highlight — theme-independent fill; ink foreground on paper.
  support: "#F59E0B",
  onSupport: "#211C16",
  // Structure is the ink in Stub (press deepens to pure black).
  structure: "#211C16",
  structurePress: "#000000",
  // Foreground on the structure (ink) fill — paper on ink (#211C16).
  onStructure: "#FDFAF3",

  // ── The scrim trio: a dark ground for reversed-out type over imagery ──
  //
  // `structure` is NOT this. It is a structural steel-blue in Swiss and Ember
  // and the ink only in Stub, so the poster card's documented invariant — "the
  // art panel's ground is INK, always" — was true in exactly one theme. In
  // Ember the poster's ground and its scrim ramp resolved to #35589A, a
  // MID-TONE, and everything reversed out of it lost its headroom at once:
  // measured on the rendered card, the accent rule came in at 1.81:1 against
  // the 3:1 graphic floor and a dimmed tier row at 1.22:1 against 4.5:1.
  //
  // So the ground moves to its own token, dark in every theme, and its two
  // foreground rungs travel WITH it — a fill and its foregrounds are one unit
  // or they drift apart, which is the whole bug class `contrast-pairs.test.ts`
  // exists to catch.
  //
  // The rule drawn on it is `brandSecondary`, not `accent`: identical hex in
  // Stub and Ember, and the one that still clears the 3:1 non-text floor on
  // Swiss, where `accent` IS the steel-blue.
  // Stub's scrim IS its structure — the ink. The trio is a no-op in the
  // shipped default theme, by construction: it exists to make the other two
  // behave the way Stub already did.
  scrim: "#211C16",
  // 16.22:1 on #211C16.
  onScrim: "#FDFAF3",
  // 8.24:1 on #211C16 — warm paper pulled back to muted.
  onScrimMuted: "#BDB4A6",

  // Soft hairline divider — ink at 30% alpha.
  borderColorSoft: "rgba(33, 28, 22, 0.3)",

  // ── Verdict FAIL fill + danger fill — identical in all three themes ON
  // PURPOSE. `verdictFail` is Stub's own `brandSecondaryHover` value, which is
  // why the pinned pair reads as native here and still clears AA everywhere
  // else. See the block on `lightTheme`.
  verdictFail: "#B93312",
  onVerdictFail: "#FFFFFF",
  dangerFill: "#B91C1C",
  onDangerFill: "#FFFFFF",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Role view — derived from the themes above so there's a single source of truth.
// Some consumers (EventCard, Chip, shared.ts) use the `text` / `border`
// key names instead of Tamagui's `color` / `borderColor`. This adapter keeps
// them working without duplicating values.
// ─────────────────────────────────────────────────────────────────────────────
type ThemeObj = typeof lightTheme | typeof darkTheme | typeof stubTheme;

const toRoles = (t: ThemeObj) =>
  ({
    background: t.background,
    backgroundHover: t.backgroundHover,
    backgroundPress: t.backgroundPress,
    backgroundFocus: t.backgroundFocus,
    backgroundInverted: t.backgroundInverted,
    backgroundStrong: t.backgroundStrong,
    surface: t.surface,
    surfaceMuted: t.surfaceMuted,
    surfaceRaised: t.surfaceRaised,
    surfaceStrong: t.surfaceStrong,
    surfaceOverlay: t.surfaceOverlay,
    text: t.color,
    textMuted: t.colorMuted,
    textInverted: t.colorInverted,
    border: t.borderColor,
    borderStrong: t.borderColorStrong,
    borderHover: t.borderColorHover,
    borderPress: t.borderColorPress,
    borderFocus: t.borderColorFocus,
    outlineColor: t.outlineColor,
    accent: t.accent,
    accentSoft: t.accentSoft,
    accentHard: t.accentHard,
    accentHover: t.accentHover,
    accentText: t.accentText,
    accentTextPress: t.accentTextPress,
    brandSecondary: t.brandSecondary,
    brandSecondaryHover: t.brandSecondaryHover,
    brandSecondaryStrong: t.brandSecondaryStrong,
    brandSecondaryPress: t.brandSecondaryPress,
    onBrandSecondary: t.onBrandSecondary,
    overlay: t.overlay,
    support: t.support,
    onSupport: t.onSupport,
    structure: t.structure,
    structurePress: t.structurePress,
    onStructure: t.onStructure,
    scrim: t.scrim,
    onScrim: t.onScrim,
    onScrimMuted: t.onScrimMuted,
    // Role name intentionally drops the "Color" infix to match the existing
    // border/borderStrong role convention (theme key: borderColorSoft).
    borderSoft: t.borderColorSoft,
  }) as const;

// ─────────────────────────────────────────────────────────────────────────────
// Series palette — 8 visually distinct colors for recurring-series accents
// (left-border tint + icon fill on event calendar chips).
//
// Design constraints:
//   The web app's base theme is `stub` (warm cream), but these recurring-series
//   accents are tuned for the Ember (dark) surfaces where the EventChip calendar
//   renders (navy surfaces #162240 – #1E2E52).
//   EventChip backgrounds vary:
//     PUBLISHED  → rgba(241,74,22,0.18)  ≈ #2D1F1B over #162240
//     DRAFT      → #1E2E52
//     COMPLETED  → rgba(34,197,94,0.25)  ≈ #1B3330 over #162240
//     CANCELLED  → rgba(239,68,68,0.25)  ≈ #3A1F24 over #162240
//
//   • ≥ 4.5:1 contrast against #1E2E52 (darkest chip) — WCAG AA text
//   • ≥ 3:1 against same — WCAG AA graphical elements (3px border)
//   • Slot 0 re-uses brand orange for system coherence (the "fire")
//   • Remaining slots are luminous, desaturated pastels that stay legible
//     on deep navy while harmonizing with the Swiss architectural aesthetic
//   • No pure neons — every value is tempered for visual comfort
// ─────────────────────────────────────────────────────────────────────────────
const seriesPalette = [
  palette.brandSecondary, // #FF5721  warm orange — brand anchor (9.2:1 vs #1E2E52)
  "#6BA3E0", // sky blue             — cool, airy    (5.8:1)
  "#5EC882", // mint green            — fresh, legible (6.4:1)
  "#C084D8", // lavender              — distinct hue  (5.2:1)
  "#E8A44C", // marigold              — warm gold     (6.0:1)
  "#4CC9C9", // aqua teal             — cool accent   (6.2:1)
  "#E8728A", // coral rose            — warm, unique  (5.4:1)
  "#9BA4D0", // periwinkle            — cool, subdued (5.0:1)
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Exported token bag — consumed by Tamagui `createTokens`, Card, Chip, etc.
// ─────────────────────────────────────────────────────────────────────────────
export const colorTokens = {
  palette,
  seriesPalette,
  semantic: {
    success: "#22C55E",
    warning: "#FACC15",
    danger: "#EF4444",
    info: "#35589A",
    focus: "#35589A",
  },
  roles: {
    light: toRoles(lightTheme),
    dark: toRoles(darkTheme),
    stub: toRoles(stubTheme),
  },
  // Flat color bag — derived from `palette` to avoid duplicating hex values.
  // Only add keys here that are genuinely theme-independent (raw brand swatches).
  color: {
    ...palette,
    accentSoft: "rgba(53, 88, 154, 0.08)",
    borderColorFocus: palette.accent,
    // Aliases: info and focus map to the brand primary for semantic consumers.
    info: palette.accent,
    focus: palette.accent,
  },
} as const;

export type ColorTokenName = keyof typeof colorTokens.color;

// ─────────────────────────────────────────────────────────────────────────────
// Theme introspection — used by the platform theme editor to enumerate tokens.
// ─────────────────────────────────────────────────────────────────────────────
export type ThemeTokenKey = Exclude<keyof typeof lightTheme, "name">;

/** Human-readable labels & grouping for theme editor UI. */
export const THEME_TOKEN_GROUPS = [
  {
    label: "Status",
    tokens: [
      "success",
      "warning",
      "danger",
      "dangerSoft",
      // Danger copy/rules on `backgroundInverted` — `dangerSoft` is tuned for
      // the theme's own canvas and collapses on the inverted one.
      "dangerSoftInverted",
      "warningSoft",
      "info",
      "focus",
      // Verdict FAIL fill — a theme-invariant fill/foreground PAIR. Edit one
      // without the other and the scan verdict loses its only legal foreground.
      "verdictFail",
      "onVerdictFail",
      "dangerFill",
      "onDangerFill",
    ] as ThemeTokenKey[],
  },
  {
    label: "Backgrounds",
    tokens: [
      "background",
      "backgroundHover",
      "backgroundPress",
      "backgroundFocus",
      "backgroundInverted",
      "backgroundStrong",
    ] as ThemeTokenKey[],
  },
  {
    label: "Surfaces",
    tokens: [
      "surface",
      "surfaceMuted",
      "surfaceRaised",
      "surfaceStrong",
      "surfaceOverlay",
    ] as ThemeTokenKey[],
  },
  {
    label: "Text",
    tokens: [
      "color",
      "colorMuted",
      "colorInverted",
      // Muted foreground on `backgroundInverted` — pairs with `colorInverted`.
      "colorMutedInverted",
      "muted",
      "mutedSurface",
    ] as ThemeTokenKey[],
  },
  {
    label: "Borders",
    tokens: [
      "borderColor",
      "borderColorStrong",
      "borderColorHover",
      "borderColorPress",
      "borderColorFocus",
      "outlineColor",
      "borderColorSoft",
    ] as ThemeTokenKey[],
  },
  {
    label: "Accent",
    tokens: [
      "accent",
      "accentSoft",
      "accentHard",
      "accentHover",
      "accentText",
      "accentTextPress",
      "brandSecondary",
      "brandSecondaryHover",
      "brandSecondaryStrong",
      "brandSecondaryPress",
      "onBrandSecondary",
    ] as ThemeTokenKey[],
  },
  {
    label: "Structure & Support",
    tokens: [
      "structure",
      "structurePress",
      "onStructure",
      "scrim",
      "onScrim",
      "onScrimMuted",
      "support",
      "onSupport",
    ] as ThemeTokenKey[],
  },
  {
    label: "Overlay",
    tokens: ["overlay"] as ThemeTokenKey[],
  },
] as const;

/** Returns the full set of token keys (minus `name`) for a theme. */
export const getThemeTokenKeys = (): ThemeTokenKey[] =>
  (Object.keys(lightTheme) as (keyof typeof lightTheme)[]).filter(
    (k): k is ThemeTokenKey => k !== "name",
  );

/** Snapshot of all current dark theme values, keyed by token name. */
export const getDarkThemeSnapshot = (): Record<ThemeTokenKey, string> => {
  const snapshot = {} as Record<ThemeTokenKey, string>;
  for (const key of getThemeTokenKeys()) {
    snapshot[key] = darkTheme[key];
  }
  return snapshot;
};

/** Snapshot of all current light theme values, keyed by token name. */
export const getLightThemeSnapshot = (): Record<ThemeTokenKey, string> => {
  const snapshot = {} as Record<ThemeTokenKey, string>;
  for (const key of getThemeTokenKeys()) {
    snapshot[key] = lightTheme[key];
  }
  return snapshot;
};

/** Snapshot of all current stub theme values, keyed by token name. */
export const getStubThemeSnapshot = (): Record<ThemeTokenKey, string> => {
  const snapshot = {} as Record<ThemeTokenKey, string>;
  for (const key of getThemeTokenKeys()) {
    snapshot[key] = stubTheme[key];
  }
  return snapshot;
};
