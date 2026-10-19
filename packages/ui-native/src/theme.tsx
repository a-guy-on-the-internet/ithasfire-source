import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as SecureStore from "expo-secure-store";

import {
  DEFAULT_NATIVE_THEME,
  palettes,
  type NativePalette,
  type NativeThemeName,
} from "./palette";
import { SHEETS, type NativeStyles } from "./styles";

/**
 * Scanner theme state — Stub (warm paper, default) ↔ Ember (navy, opt-in).
 *
 * ## Why the theme has its own SecureStore key
 *
 * It would be tidier to fold this into `ScannerPreferences`
 * (`src/lib/storage.ts`), but two things argue against it:
 *
 *   1. **Load order.** Preferences are loaded by `useScannerSession`, which
 *      lives *inside* the React tree. The theme provider has to sit ABOVE that
 *      (it wraps `IthasFireProvider`), so it cannot read preferences without
 *      hoisting the whole session bootstrap.
 *   2. **Write races.** `saveScannerPreferences` serialises the entire blob. A
 *      theme write from Settings and a `soundEnabled` write from the same
 *      screen would be two read-modify-write cycles against one key, and the
 *      loser silently reverts the winner.
 *
 * The theme is device chrome, not shift state, so a separate key is also the
 * more honest model: it survives a preferences reset and doesn't sync with
 * anything server-side.
 */
/**
 * ## Why the DEFAULT key still says "scanner"
 *
 * The scanner shipped this key first and has already written it to operators'
 * devices. Renaming the default would not migrate anything — it would simply
 * stop finding the stored value and silently reset every operator's theme on
 * their next launch. Apps that want their own namespace pass `storageKey`
 * explicitly (mobile does); the default stays bug-for-bug compatible.
 */
const DEFAULT_THEME_STORAGE_KEY = "th.scanner.theme.v1";

const ALL_THEMES: readonly NativeThemeName[] = ["ember", "stub"];

const isThemeName = (v: unknown): v is NativeThemeName =>
  v === "ember" || v === "stub";

async function loadTheme(
  storageKey: string,
  fallback: NativeThemeName,
  enabled: readonly NativeThemeName[],
): Promise<NativeThemeName> {
  try {
    const raw = await SecureStore.getItemAsync(storageKey);
    // A stored theme the host app no longer offers must not win — an app that
    // dropped a theme would otherwise render one it doesn't ship.
    return isThemeName(raw) && enabled.includes(raw) ? raw : fallback;
  } catch (error) {
    if (__DEV__) {
      console.warn("[native-theme] failed to load theme", error);
    }
    return fallback;
  }
}

async function saveTheme(
  storageKey: string,
  name: NativeThemeName,
): Promise<void> {
  try {
    await SecureStore.setItemAsync(storageKey, name, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  } catch (error) {
    if (__DEV__) {
      console.warn("[native-theme] failed to save theme", error);
    }
  }
}

type NativeThemeContextValue = {
  /** Active theme name. Also the value to pass to `IthasFireProvider theme=`. */
  name: NativeThemeName;
  /** Active palette — prefer the `useColors()` shorthand. */
  colors: NativePalette;
  /** Active StyleSheet — prefer the `useStyles()` shorthand. */
  styles: NativeStyles;
  /** Persisted; takes effect immediately. */
  setTheme: (name: NativeThemeName) => void;
  /** Convenience for the Settings toggle. */
  toggleTheme: () => void;
  /**
   * False until the stored preference has been read from SecureStore.
   *
   * Callers do NOT need to gate rendering on this — the splash is fixed black
   * in both themes, so the theme resolving a beat late is invisible there. It
   * exists for controls that display the theme as STATE: the Settings toggle
   * would otherwise render OFF for one frame on an Ember device, which reads as
   * "your preference was lost". `settings-screen.tsx` consumes it to render the
   * row as busy until the real value is known.
   */
  isHydrated: boolean;
};

const NativeThemeContext = createContext<NativeThemeContextValue | null>(
  null,
);

export type NativeThemeProviderProps = {
  children: ReactNode;
  /**
   * SecureStore key for the persisted preference. Each app MUST pass its own —
   * sharing one key across apps only works because iOS keychains are per-app,
   * and relying on that is fragile.
   */
  storageKey?: string;
  /** Theme before hydration, and the fallback when nothing is stored. */
  defaultTheme?: NativeThemeName;
  /**
   * Themes the host app offers. Pass a single-element list to PIN one theme:
   * the stored preference is then ignored, `toggleTheme()` is a no-op, and
   * `setTheme()` only accepts that theme.
   */
  enabledThemes?: readonly NativeThemeName[];
};

export const NativeThemeProvider = ({
  children,
  storageKey = DEFAULT_THEME_STORAGE_KEY,
  defaultTheme = DEFAULT_NATIVE_THEME,
  enabledThemes = ALL_THEMES,
}: NativeThemeProviderProps) => {
  // A `defaultTheme` the host app didn't enable would leave a pinned app
  // rendering a theme it does not ship, so the pin wins. This lets a caller
  // pass `enabledThemes={["ember"]}` alone without restating `defaultTheme`.
  const resolvedDefault: NativeThemeName = enabledThemes.includes(defaultTheme)
    ? defaultTheme
    : (enabledThemes[0] ?? defaultTheme);
  const isPinned = enabledThemes.length <= 1;

  const [name, setName] = useState<NativeThemeName>(resolvedDefault);
  // Nothing to read when pinned, so hydration starts already settled.
  const [isHydrated, setIsHydrated] = useState(isPinned);

  // Read inside callbacks so `setTheme` / `toggleTheme` keep a stable identity
  // across prop changes (they are handed to memoised consumers).
  const configRef = useRef({ storageKey, enabledThemes, isPinned });
  configRef.current = { storageKey, enabledThemes, isPinned };

  // Compared by CONTENT, not identity: a caller passing an inline array literal
  // would otherwise re-run hydration on every single render.
  const enabledKey = enabledThemes.join(",");

  useEffect(() => {
    if (isPinned) {
      setName(resolvedDefault);
      setIsHydrated(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      const stored = await loadTheme(storageKey, resolvedDefault, enabledThemes);
      if (cancelled) return;
      setName(stored);
      setIsHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- enabledThemes tracked by content via enabledKey
  }, [storageKey, resolvedDefault, isPinned, enabledKey]);

  const setTheme = useCallback((next: NativeThemeName) => {
    const { storageKey: key, enabledThemes: enabled } = configRef.current;
    if (!enabled.includes(next)) return;
    // Optimistic: flip the UI now, persist in the background. A failed write
    // costs the operator their preference on next launch, not their session.
    setName(next);
    void saveTheme(key, next);
  }, []);

  const toggleTheme = useCallback(() => {
    const {
      storageKey: key,
      enabledThemes: enabled,
      isPinned: pinned,
    } = configRef.current;
    if (pinned) return;
    setName((current) => {
      const next: NativeThemeName = current === "ember" ? "stub" : "ember";
      if (!enabled.includes(next)) return current;
      void saveTheme(key, next);
      return next;
    });
  }, []);

  const value = useMemo<NativeThemeContextValue>(
    () => ({
      name,
      colors: palettes[name],
      styles: SHEETS[name],
      setTheme,
      toggleTheme,
      isHydrated,
    }),
    [name, setTheme, toggleTheme, isHydrated],
  );

  return (
    <NativeThemeContext.Provider value={value}>
      {children}
    </NativeThemeContext.Provider>
  );
};

export const useNativeTheme = (): NativeThemeContextValue => {
  const ctx = useContext(NativeThemeContext);
  if (!ctx) {
    throw new Error(
      "useNativeTheme must be used inside <NativeThemeProvider>. It wraps the app in App.tsx.",
    );
  }
  return ctx;
};

/** The active palette. The RN analogue of Tamagui's `useTheme()`. */
export const useColors = (): NativePalette => useNativeTheme().colors;

/** The shared StyleSheet for the active theme (see `./styles.ts`). */
export const useStyles = (): NativeStyles => useNativeTheme().styles;

/**
 * Per-theme cache for screen-local stylesheets, keyed by the factory function.
 *
 * A factory is a module-level constant, so each one is built at most once per
 * theme for the lifetime of the app — no `StyleSheet.create` churn on render,
 * and no native style-registry growth. The `WeakMap` means a factory from a
 * hot-reloaded module doesn't pin its old sheets.
 */
const sheetCache = new WeakMap<
  object,
  Partial<Record<NativeThemeName, unknown>>
>();

/**
 * Theme a screen-local StyleSheet.
 *
 * ## Which pattern to use where
 *
 * There are two sanctioned ways to theme a component in this app, and the
 * choice is by size, not taste:
 *
 *   - **Large colour-bearing sheet** (a screen with dozens of styled rows) →
 *     `useThemedSheet`. Keep the sheet's shape exactly as it was and take
 *     `colors` as a parameter:
 *
 *     ```ts
 *     const makeSheet = (colors: NativePalette) =>
 *       StyleSheet.create({ row: { borderColor: colors.borderColor } });
 *     // inside the component:
 *     const styles = useThemedSheet(makeSheet);
 *     ```
 *
 *   - **Geometry sheet with one or two themed values** → leave the sheet as
 *     plain geometry and apply the colour inline from `useColors()`
 *     (`style={[styles.row, { borderColor: colors.borderColor }]}`). Wrapping a
 *     three-line sheet in a factory is more ceremony than it buys.
 *
 * Either way the invariant holds: no component names a colour, and both themes
 * are covered from one definition.
 */
export function useThemedSheet<T>(factory: (colors: NativePalette) => T): T {
  const { name, colors } = useNativeTheme();
  let perTheme = sheetCache.get(factory);
  if (!perTheme) {
    perTheme = {};
    sheetCache.set(factory, perTheme);
  }
  if (!(name in perTheme)) {
    perTheme[name] = factory(colors);
  }
  return perTheme[name] as T;
}

/**
 * True when the dark theme is active.
 *
 * Mirrors the web's `useIsDarkTheme` (`useThemeName() === "ember"`). Note the
 * web trap this avoids: `startsWith("dark")` never matches, because the theme
 * keys are `stub`/`swiss`/`ember` — it shipped as dead code once already.
 */
export const useIsDarkTheme = (): boolean => useNativeTheme().name === "ember";
