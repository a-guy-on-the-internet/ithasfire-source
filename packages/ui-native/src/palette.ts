/**
 * Ithas Fire native palettes — Design System v2, themeable.
 *
 * The shared token layer for every React Native surface in the monorepo
 * (`apps/scanner`, `apps/mobile`). It ships TWO themes, mirroring the canonical
 * token set in `packages/ui/src/ui/tamagui/tokens/colors.ts`:
 *
 *   - **Stub** (warm paper, light) — the DEFAULT, matching the web app's
 *     shipped default so every surface reads as one product.
 *   - **Ember** (navy, dark) — opt-in from Settings. The better choice in a
 *     dark venue: a cream canvas at 100% brightness next to a dark stage is
 *     hostile to the operator's night vision.
 *
 * An app that wants only one of them pins it via `NativeThemeProvider`'s
 * `enabledThemes` prop rather than by forking this file.
 *
 * Neither theme touches the camera surfaces — see `FIXED` below.
 *
 * React Native has no CSS variables, so there is no `var(--token, fallback)`
 * cascade to resolve: the palette module IS the token layer. Both palettes
 * expose an IDENTICAL key set (enforced by `palette.test.ts`), so a component
 * reads `colors.surface` and gets the right value for the active theme without
 * knowing which theme is active.
 *
 * ## Rule: NO hex literals in any consuming app
 *
 * Import from here (via `useColors()` — see `./theme.tsx`). This file is the
 * sanctioned home for a raw colour literal; each app's `app.config.ts` and
 * vendor-mark modules are the narrow exceptions, listed in that app's own
 * eslint permanents file. The gate in this package and in each app enforces it.
 *
 * ## Naming follows the DS canon, NOT the scanner's old names
 *
 * The pre-v2 palette had `accent` = steel blue and `brandSecondary` = orange,
 * which is INVERTED from the design system (where `accent` IS the orange and
 * the steel blue is `structure`). That collision made every review of this app
 * start with a translation step. The names here match
 * `docs/design/design-system-v2.md` §2 exactly.
 *
 * ## Every foreground/background pair here is contrast-verified
 *
 * Ratios in the comments are measured, not estimated, and hold in BOTH themes.
 * The AA floors are 4.5:1 for text and 3:1 for borders/graphics (WCAG 1.4.3 /
 * 1.4.11). If you add a pair, measure it — several of the bugs this palette
 * replaces were "obviously fine" values that measured 2.1:1.
 */

/** The set of themes the scanner can render. */
export type NativeThemeName = "ember" | "stub";

/**
 * Theme-INVARIANT colours.
 *
 * These do not flip with the theme, and that is the whole point: they paint on
 * a surface whose colour we do not control. The camera feed is black in Stub
 * exactly as it is in Ember, so an overlay control on top of it must stay
 * light-on-dark or it becomes invisible in daylight mode. The pre-v2 audit rule
 * applies — judge every literal by the SURFACE IT PAINTS ON, never by the
 * theme it happens to sit inside.
 *
 * (This set used to also carry `verdict*` / `onVerdictFill` / `shadow`. Their
 * only consumer was the legacy `ticket-scan-screen`, whose full-bleed verdict
 * overlay was deleted when the two scan flows were consolidated — the unified
 * flow shows results as content cards on `surface`, which are theme-reactive.
 * They were removed rather than left as tokens nothing renders.)
 */
export const FIXED = {
  // ── Camera surfaces (always black — the video feed) ─────────────────────
  /** Viewfinder backdrop. The camera feed paints over this. */
  cameraBackdrop: "#000000",
  /** Scrim pill behind camera-overlay controls (torch). */
  cameraScrim: "rgba(0,0,0,0.5)",
  /** Hairline border on camera-overlay controls, on the black scrim. */
  cameraControlBorder: "rgba(255,255,255,0.3)",
  /** Resting viewfinder stroke — 21:1 on the black feed. */
  viewfinderStroke: "#FFFFFF",
  /** Locked/paused viewfinder stroke — 6.64:1 on the black feed. */
  viewfinderLocked: "#FF5721",
  /** Muted icon on a camera-overlay control — 9.58:1 on the black scrim. */
  cameraControlMuted: "#A0B0CC",
  /** Loading scrim over the camera. */
  cameraLoadingOverlay: "rgba(0,0,0,0.55)",

  // ── Splash ──────────────────────────────────────────────────────────────
  // The JS splash (App.tsx font-load gate → scanner-app.tsx bootstrap gate)
  // must be pixel-identical to the NATIVE splash, or the operator sees a
  // colour flash at each of the three hand-offs. The native splash paints
  // BEFORE any JS exists, so it cannot know the operator's theme — which is
  // precisely why these are fixed rather than themed.
  //
  // ⚠️ These two MUST stay in sync with `app.config.ts`:
  //   splashBackground ↔ splash.backgroundColor AND android.adaptiveIcon.backgroundColor
  // `app.config.ts` is resolved by the Expo CLI/EAS outside the RN runtime and
  // deliberately keeps its own literals (see eslint-color-permanents.mjs), so
  // this coupling is manual. Change one, change the other.
  /** Native-splash-matching backdrop for the JS splash screens. */
  splashBackground: "#000000",
  /** White flame tint on the splash backdrop. */
  splashTint: "#FFFFFF",

  // ── Machine-read surfaces (decoded by a camera, not read by a human) ────
  // A ticket QR is scanned off the buyer's screen by the scanner app. Its
  // contrast budget belongs to a camera under venue lighting, not to the
  // viewer's theme, so it stays maximum-contrast black-on-white in BOTH
  // themes. Rendering the modules in `color` on `surface` would "match the
  // theme" and quietly halve the decode margin on Stub — the exact failure
  // the surface-not-theme rule exists to prevent. Do not theme these, and do
  // not composite them under `opacity`: that blends BOTH the modules and the
  // quiet zone toward the canvas and collapses the margin to ~2.5:1.
  /** QR module (dark) fill. 21:1 on `qrQuietZone`. */
  qrModule: "#000000",
  /** QR quiet-zone / background fill. The decoder needs a white margin. */
  qrQuietZone: "#FFFFFF",

  // ── Third-party brand (vendor-fixed — NOT ours to theme) ────────────────
  // Sign-in provider buttons. Dictated by the vendors' brand guidelines and
  // the same in every theme BY CONTRACT — the one class of colour we are not
  // allowed to restyle. They live in the palette (rather than as an eslint
  // file exemption on the sign-in screen) precisely so that screen stays
  // fully gated: a vendor colour is still a colour.
  /** Google brand blue — Google sign-in button fill/border. */
  googleBrand: "#4285F4",
  /** Apple brand black — Apple sign-in button fill/border. */
  appleBrand: "#000000",
  /**
   * Label/mark colour on a vendor brand fill.
   *
   * White is what both Google's and Apple's sign-in button specifications
   * mandate on their respective fills, so it is fixed for the same reason the
   * fills are: it is part of the branding we are not permitted to restyle.
   * White on `googleBrand` measures **3.56:1** — below the 4.5:1 AA floor. That
   * is the vendor's specified pairing, and this is the one place in the app
   * where we cannot fix a shortfall by choosing a better value.
   *
   * It is made compliant the only other way available: by SIZE. WCAG's
   * large-text exception is >=18pt regular or >=14pt BOLD — and 14pt bold is
   * 18.66px, not 14px. The vendor labels are therefore set at 19px/700 (see
   * `oauthCtaText` in `sign-in-screen.tsx`) so the 3:1 large-text floor applies
   * legitimately. Do not shrink them back to 14px: that silently converts a
   * compliant pair into a 1.4.3 failure without changing a single colour.
   */
  onVendorBrand: "#FFFFFF",
} as const;

/**
 * Ember — deep navy, dark. Opt-in from Settings; Stub is the default.
 * Mirrors `darkTheme` in `packages/ui/src/ui/tamagui/tokens/colors.ts`.
 */
export const emberPalette = {
  name: "ember",

  // ── Surfaces ────────────────────────────────────────────────────────────
  /** Page canvas. */
  background: "#0F1B33",
  /** Raised panel over the canvas. */
  surface: "#162240",
  /** Second elevation step (nested panels, active rows). */
  surfaceRaised: "#1A2847",
  /** Muted/inset surface (inputs, tracks). */
  surfaceMuted: "#1E2E52",
  /** Strong surface — steel blue, carries `onStructure`. */
  surfaceStrong: "#2A4578",

  // ── Text ────────────────────────────────────────────────────────────────
  /** Primary text — 17.14:1 on the canvas, 15.71:1 on `surface`. */
  color: "#FFFFFF",
  /**
   * Secondary text — 7.82:1 on the canvas, 7.16:1 on `surface`, 6.66:1 on
   * `surfaceRaised`. This REPLACES the old translucent-white scale
   * (`muted06`…`muted85`), three rungs of which were used as label text at
   * 3.20–3.76:1 and failed AA. A real hue also reads as designed rather than
   * as washed-out white.
   */
  colorMuted: "#A0B0CC",
  /** Text on an inverted (light) surface. */
  colorInverted: "#181818",
  /** Input placeholder — same rung as `colorMuted`, which clears AA. */
  placeholder: "#A0B0CC",

  // ── Borders ─────────────────────────────────────────────────────────────
  /** Structural 2px border — 3.81:1 on the canvas, 3.49:1 on `surface` (AA non-text). */
  borderColor: "#5A78A6",
  /** Hairline divider for CHROME — `borderColor` at 40% alpha. */
  borderColorSoft: "rgba(90, 120, 166, 0.4)",
  /** Highest-emphasis border (near-white) — content edges that must dominate. */
  borderColorStrong: "#F5F5F5",

  // ── Accent (orange) ─────────────────────────────────────────────────────
  /** Large fills, 2px borders, rules, and DECORATIVE type only. */
  accent: "#FF5721",
  /** Low-alpha accent wash for tinted surfaces. */
  accentSoft: "rgba(255, 87, 33, 0.18)",
  /** Faint accent wash — icon backplates, queue badges. */
  accentTint: "rgba(255, 87, 33, 0.08)",
  /**
   * Accent AS an interactive control's accessible LABEL — 5.42:1 on the
   * canvas, 4.96:1 on `surface`. Ember's accent already clears AA as text, so
   * the rest rung is the accent itself (Stub's "deepen it" logic does not
   * transfer). The press rung BRIGHTENS, because Ember's inverted ink is dark.
   */
  accentText: "#FF5721",
  accentTextPress: "#FF7E52",

  // ── Primary-CTA fill ladder ─────────────────────────────────────────────
  /**
   * The primary button's resting FILL, paired with `onCta`.
   *
   * Ember rests on the accent itself because it carries the INK label:
   * #181818 on #FF5721 = 5.61:1. (White on these oranges is 3.16:1 and fails
   * — see the DS Divergences table.)
   */
  ctaFill: "#FF5721",
  /** Label on `ctaFill` — 5.61:1. NEVER white on an orange fill. */
  onCta: "#181818",
  /** Muted CTA fill for the role-gated `locked` treatment. */
  ctaFillLocked: "#E04A18",

  // ── Structure (steel blue) ──────────────────────────────────────────────
  /** Structural chrome fill — header strip, pressed secondary button. */
  structure: "#35589A",
  structurePress: "#2A4578",
  /** Label on the `structure` fill — 6.97:1. */
  onStructure: "#FFFFFF",
  /**
   * Hairline / low-emphasis edge ON the `structure` fill.
   *
   * `structure` is dark in BOTH themes (steel blue on Ember, ink on Stub), so
   * chrome that sits on it — the header's compact event chip — is light-on-dark
   * in both and must not use the page-relative `borderColorSoft`.
   */
  onStructureSoft: "rgba(255, 255, 255, 0.35)",

  // ── Support (amber) ─────────────────────────────────────────────────────
  /** Amber support highlight — theme-independent fill. */
  support: "#F59E0B",
  /**
   * Ink on the amber fill — 7.98:1. The platform-admin banner previously used
   * WHITE here, which measured 2.15:1: the single worst contrast defect in
   * the app, on a banner whose entire job is to be impossible to miss.
   */
  onSupport: "#0F1B33",
  /** Faint amber wash — capacity-warning surfaces. */
  supportTint: "rgba(245, 158, 11, 0.08)",

  // ── Semantic status ─────────────────────────────────────────────────────
  /** Success GRAPHIC (icon/border) — 6.89:1 on `surface`. */
  success: "#22C55E",
  /** Warning graphic. */
  warning: "#FACC15",
  /** Danger graphic — 4.17:1 on `surface`. */
  danger: "#EF4444",
  /** Danger as TEXT — 5.68:1 on `surface` (the #EF4444 fill is only ~4.0 as copy). */
  dangerSoft: "#F87171",
  /** Warning as TEXT — 9.41:1 on `surface`. */
  warningSoft: "#FBBF24",
  /** Faint danger wash — capacity-danger surfaces. */
  dangerTint: "rgba(239, 68, 68, 0.08)",

  // ── Verdict tone FILLS (scan door mode) ─────────────────────────────────
  //
  // Two tones, not four. This palette used to carry `successFill` /
  // `onSuccessFill` / `dangerFill` / `onDangerFill` for a four-family verdict
  // system built on green and red; the Ithas Fire Design System specifies TWO
  // — pass and fail — with the WORD carrying the instruction, and green and
  // red are not in this brand's palette. Flame and amber are.
  //
  // PASS reuses `support`/`onSupport` above (7.98:1 here, 7.87:1 on Stub).
  // FAIL gets the pinned pair below. See `./tone.ts` for the mapping.
  //
  // ## Why FAIL is PINNED and not the themed `ctaFill`
  //
  // `ctaFill` is #FF5721 here and #B93312 on Stub, and using it would make the
  // verdict fill follow the theme "for consistency". Measured, that costs the
  // colour channel outright on Ember: amber #F59E0B against orange #FF5721 is
  // **1.47:1**, so at a glance the two verdicts are the same colour. Ember is
  // the DARK-VENUE theme — the exact condition a door operator glances in — so
  // that is the worst possible place to spend the separation.
  //
  // Pinned to flame-600 it is **2.76:1 in both themes** (a 1.87× gain on
  // Ember), the word measures 5.92:1 rather than 5.61:1, and there is one value
  // instead of two. It is also closer to the DS, which has a single
  // `--color-accent-fill`, not a per-theme one.
  //
  // Do NOT "simplify" this back to `ctaFill`. The contrast guard asserts the
  // ≥2.7:1 separation and will fail, which is the intended outcome.
  /** FAIL verdict fill — flame-600, theme-invariant. */
  verdictFail: "#B93312",
  /** The ONLY foreground legal on `verdictFail` — 5.92:1 in both themes. */
  onVerdictFail: "#FFFFFF",

  // ── Scrims / overlays ───────────────────────────────────────────────────
  /** Backdrop scrim for modals (event picker). */
  modalScrim: "rgba(0, 0, 0, 0.60)",
  /** Track behind a progress bar. */
  progressTrack: "rgba(255, 255, 255, 0.08)",
  /** Translucent tint for the active row in a list. */
  activeRowTint: "rgba(255, 255, 255, 0.04)",

  // ── Elevation ───────────────────────────────────────────────────────────
  /**
   * Card elevation, mirroring `elevationTokens.ember.card` in
   * `packages/ui/src/ui/tamagui/tokens/elevation.ts`.
   *
   * Ember is FLAT — borders carry structure in the dark themes, so the web's
   * value is literally `"none"`. Consumers must not hand `"none"` to RN's
   * `boxShadow`; check before spreading (see `sign-in-screen.tsx`).
   */
  cardShadow: "none",

  // ── Decorative background geometry ──────────────────────────────────────
  /** Hairline in the geometric backdrop. */
  geoLine: "rgba(53, 88, 154, 0.18)",
  /** Filled block in the geometric backdrop. */
  geoBlock: "rgba(53, 88, 154, 0.12)",
  /** Warm hairline grid on the sign-in screen. */
  signInGridLine: "rgba(231, 206, 150, 0.04)",
} as const;

/**
 * Stub — warm paper, light. Mirrors `stubTheme` in
 * `packages/ui/src/ui/tamagui/tokens/colors.ts`.
 *
 * Note the two places Stub deliberately DIVERGES from a naive inversion of
 * Ember, both documented in the DS Divergences table:
 *   1. `ctaFill` is `brandSecondaryHover` (#B93312), NOT `accent` (#E2481D).
 *      White on #E2481D is 4.06:1 and FAILS AA; on #B93312 it reaches 5.92:1.
 *      #E2481D is the one value with no AA foreground in either polarity
 *      (white 4.06, ink 4.38), so it stays a fill/border/graphic value only.
 *   2. `accentText` DEEPENS to #B93312 rather than staying `accent`, because
 *      #E2481D as a label is 3.57:1 on the cream canvas.
 */
export const stubPalette = {
  name: "stub",

  // ── Surfaces ────────────────────────────────────────────────────────────
  background: "#F6F0E4",
  surface: "#FDFAF3",
  surfaceRaised: "#EFE7D6",
  surfaceMuted: "#EFE7D6",
  /** Strong surface — the ink itself, carries `onStructure`. */
  surfaceStrong: "#211C16",

  // ── Text ────────────────────────────────────────────────────────────────
  /** Warm ink — 14.89:1 on the canvas, 16.22:1 on `surface`. */
  color: "#211C16",
  /** Secondary text — 6.56:1 on the canvas, 7.14:1 on `surface`. */
  colorMuted: "#5C544A",
  /** Text on an inverted (dark) surface. */
  colorInverted: "#FDFAF3",
  placeholder: "#5C544A",

  // ── Borders ─────────────────────────────────────────────────────────────
  /** The ink itself — print-style hard edges, 14.89:1 on the canvas. */
  borderColor: "#211C16",
  /** Hairline divider for CHROME — ink at 30% alpha. */
  borderColorSoft: "rgba(33, 28, 22, 0.3)",
  borderColorStrong: "#000000",

  // ── Accent (burnt orange) ───────────────────────────────────────────────
  /** Large fills, 2px borders, rules, and DECORATIVE type only. */
  accent: "#E2481D",
  accentSoft: "rgba(226, 72, 29, 0.10)",
  accentTint: "rgba(226, 72, 29, 0.08)",
  /** Accent as a control LABEL — 5.22:1 on the canvas, 5.68:1 on `surface`. */
  accentText: "#B93312",
  accentTextPress: "#98240B",

  // ── Primary-CTA fill ladder ─────────────────────────────────────────────
  /** Resting CTA fill. #B93312, NOT #E2481D — see the class docblock. */
  ctaFill: "#B93312",
  /** Label on `ctaFill` — white at 5.92:1. */
  onCta: "#FFFFFF",
  ctaFillLocked: "#7D1A07",

  // ── Structure (the ink, in Stub) ────────────────────────────────────────
  structure: "#211C16",
  structurePress: "#000000",
  /** Paper on ink — 16.22:1. */
  onStructure: "#FDFAF3",
  /** Paper at 35% on the ink fill — see the Ember note; `structure` is dark here too. */
  onStructureSoft: "rgba(253, 250, 243, 0.35)",

  // ── Support (amber) ─────────────────────────────────────────────────────
  support: "#F59E0B",
  /** Ink on amber — 7.87:1. */
  onSupport: "#211C16",
  supportTint: "rgba(245, 158, 11, 0.08)",

  // ── Semantic status ─────────────────────────────────────────────────────
  // Darkened vs Ember so each clears AA as TEXT on warm paper; Ember's bright
  // fills (#22C55E / #FACC15 / #EF4444) wash out entirely on cream.
  /** 6.84:1 on `surface`. */
  success: "#166534",
  warning: "#92400E",
  /** 6.21:1 on `surface`. */
  danger: "#B91C1C",
  /** Already AA as text on paper, so the Soft rungs match the fills. */
  dangerSoft: "#B91C1C",
  warningSoft: "#92400E",
  dangerTint: "rgba(185, 28, 28, 0.08)",

  // ── Verdict tone FILLS (scan door mode) ─────────────────────────────────
  // Byte-identical to Ember's, and that is the whole point — see the argument
  // there. `palette.test.ts` asserts the identical key set, and
  // `apps/scanner/src/__tests__/tone-contrast.test.ts` asserts both the AA
  // floors and the pass↔fail separation in BOTH themes.
  verdictFail: "#B93312",
  onVerdictFail: "#FFFFFF",

  // ── Scrims / overlays ───────────────────────────────────────────────────
  modalScrim: "rgba(33, 28, 22, 0.5)",
  progressTrack: "rgba(33, 28, 22, 0.08)",
  activeRowTint: "rgba(33, 28, 22, 0.04)",

  // ── Elevation ───────────────────────────────────────────────────────────
  /**
   * Hard offset print shadow, no blur — the ticket-stub paper aesthetic.
   * Byte-identical to `elevationTokens.stub.card` on the web.
   */
  cardShadow: "4px 4px 0 rgba(33, 28, 22, 0.85)",

  // ── Decorative background geometry ──────────────────────────────────────
  geoLine: "rgba(33, 28, 22, 0.10)",
  geoBlock: "rgba(33, 28, 22, 0.05)",
  signInGridLine: "rgba(33, 28, 22, 0.05)",
} as const;

/**
 * The scanner palette contract.
 *
 * Derived from `emberPalette` so the two can never drift structurally — adding
 * a key to Ember without adding it to Stub is a type error at the `palettes`
 * declaration below, not a runtime `undefined` that paints transparent.
 */
export type NativePalette = {
  readonly name: NativeThemeName;
} & {
  readonly [K in Exclude<keyof typeof emberPalette, "name">]: string;
};

export const palettes: Record<NativeThemeName, NativePalette> = {
  ember: emberPalette,
  stub: stubPalette,
};

/**
 * Stub is the default, matching the web app's shipped default theme so an
 * operator moving between the two doesn't change visual language mid-shift.
 *
 * Ember is opt-in from Settings, and remains the better choice for a dark room
 * — a full-brightness cream canvas next to a dark stage costs the operator
 * their night vision. Note that switching the default does NOT make the camera
 * surfaces light: the viewfinder, its overlay controls and the verdict overlay
 * all paint on the video feed and stay on the `FIXED` values in both themes.
 */
export const DEFAULT_NATIVE_THEME: NativeThemeName = "stub";

export type ColorToken = keyof NativePalette;
