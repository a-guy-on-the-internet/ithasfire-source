import { getDarkThemeSnapshot, getStubThemeSnapshot } from "@th/ui";

/**
 * Light/dark theme mode — the user-facing appearance toggle.
 *
 * `light` renders the Stub (warm cream) base theme; `dark` renders Ember (navy).
 * The choice is persisted in a first-party cookie so the SERVER can read it and
 * paint the correct theme on first byte (no dark-mode flash on reload).
 *
 * This is a DIFFERENT axis from the platform colour PRESETS applied by
 * `ActiveThemeInjector` (per-org brand palettes). Mode picks the base theme;
 * a preset, if any, layers on top of whichever base is active.
 */
export type ThemeMode = "light" | "dark";

/** Tamagui theme key (also the `<html data-theme>` value) for a mode. */
export type ThemeName = "stub" | "ember";

/** Cookie name. Read server-side in the root layout; written client-side on toggle. */
export const THEME_COOKIE = "th-theme";

/** One year — the preference is sticky. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const DEFAULT_THEME_MODE: ThemeMode = "light";

export const themeNameForMode = (mode: ThemeMode): ThemeName =>
  mode === "dark" ? "ember" : "stub";

export const modeForThemeName = (name: ThemeName): ThemeMode =>
  name === "ember" ? "dark" : "light";

/** Narrow an untrusted cookie value to a valid mode (defaulting to light). */
export const parseThemeMode = (value: string | undefined | null): ThemeMode =>
  value === "dark" ? "dark" : "light";

/**
 * The theme's token values as `--<key>` CSS custom properties for a mode, sourced
 * from the canonical snapshot (colors.ts) — never literal hex here, so the colour
 * gate stays green and the values can never drift from the theme.
 *
 * Rendered inline on `<body>` at SSR for the active mode so plain-CSS consumers
 * (`var(--background)`, …) paint the right theme before hydration.
 */
/** The page/address-bar `theme-color` for a mode — the theme's page background. */
export const themeColorForMode = (mode: ThemeMode): string =>
  (mode === "dark" ? getDarkThemeSnapshot() : getStubThemeSnapshot()).background;

export const themeCssVarsForMode = (mode: ThemeMode): Record<string, string> => {
  const snapshot =
    mode === "dark" ? getDarkThemeSnapshot() : getStubThemeSnapshot();
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    vars[`--${key}`] = value;
  }
  // Legacy globals.css `:root` alias: `body { color: var(--foreground) }` and
  // friends predate the Tamagui token names and are NOT theme keys, so the
  // snapshot doesn't emit them. Map `--foreground` to the theme's ink `color`
  // (and `--background` is already emitted as the `background` token). Without
  // this, dark mode paints navy bg with the light `:root` ink → invisible text.
  vars["--foreground"] = snapshot.color;
  return vars;
};
