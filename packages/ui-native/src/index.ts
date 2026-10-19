/**
 * `@th/ui-native` — the shared Design System v2 layer for React Native surfaces
 * (`apps/scanner`, `apps/mobile`).
 *
 * Source-only: there is no build step, and consumers import TypeScript directly
 * through the workspace link. Metro compiles it with the app.
 *
 * Layering, from the bottom up:
 *
 *   `palette.ts`  — the token layer. RN has no CSS variables, so this module IS
 *                   the cascade. Two themes (Ember/Stub) + a theme-INVARIANT
 *                   `FIXED` block for surfaces we don't control (camera feed,
 *                   native splash, vendor brand marks).
 *   `styles.ts`   — one StyleSheet per theme, built once at module load.
 *   `theme.tsx`   — provider + hooks (`useColors`, `useStyles`,
 *                   `useThemedSheet`, `useIsDarkTheme`).
 *   `primitives.tsx` / `geometric-background.tsx` — components built on the above.
 *
 * Narrow subpath imports (`@th/ui-native/palette`, `/theme`, `/primitives`) are
 * available for consumers that want to avoid pulling the component layer.
 */

// ── Tokens ──────────────────────────────────────────────────────────────────
export {
  DEFAULT_NATIVE_THEME,
  emberPalette,
  FIXED,
  palettes,
  stubPalette,
  type ColorToken,
  type NativePalette,
  type NativeThemeName,
} from "./palette";

// ── Stylesheets ─────────────────────────────────────────────────────────────
export { SHEETS, type NativeStyles } from "./styles";

// ── Theme provider + hooks ──────────────────────────────────────────────────
export {
  NativeThemeProvider,
  useColors,
  useIsDarkTheme,
  useNativeTheme,
  useStyles,
  useThemedSheet,
  type NativeThemeProviderProps,
} from "./theme";

// ── Verdict tones (the full-bleed verdict axis — NOT `BadgeTone`) ───────────
export {
  TONE_FILL_TOKENS,
  VERDICT_TONES,
  toneColors,
  type ToneColors,
  type TonePair,
  type VerdictTone,
} from "./tone";

// ── Components ──────────────────────────────────────────────────────────────
export { GeometricBackground } from "./geometric-background";
export { Text, type NativeTextProps, type NativeTextTone } from "./text";
export { Column, Row } from "./layout";
export { MetaChip } from "./meta-chip";
export {
  HERO_GLYPH_SIZE,
  HERO_STROKE_WIDTH,
  ToneResultState,
  verdictWordFontSize,
  type ToneResultStateProps,
} from "./tone-result-state";
export {
  EXPRESS_RULE_HEIGHT,
  ExpressDwellFooter,
  type ExpressDwellFooterProps,
  type ExpressDwellPhase,
} from "./express-dwell-footer";
export { StatsStrip } from "./stats-strip";
export {
  CAPACITY_WORD,
  capacityBand,
  planStatsStrip,
  type CapacityBand,
  type StatsStripInput,
  type StatsStripPlan,
} from "./stats-strip-plan";
export {
  BADGE_TONES,
  EmailInput,
  FieldInput,
  ModeCard,
  Panel,
  PasswordInput,
  ScreenSurface,
  SquareCard,
  SquarePrimaryButton,
  SquareSecondaryButton,
  StatusBadge,
  TopBar,
  type BadgeTone,
} from "./primitives";
