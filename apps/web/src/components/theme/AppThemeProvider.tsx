"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Theme } from "tamagui";
import { IthasFireProvider, type IthasFireThemeName } from "@th/ui";
import {
  DEFAULT_THEME_MODE,
  parseThemeMode,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  themeNameForMode,
  type ThemeMode,
} from "@/lib/theme-mode";

/**
 * Swiss International Typographic Style — Theme Provider.
 *
 * Renders the Tamagui base theme for the active appearance MODE:
 *   light → "stub" (warm cream ticket-stub paper)
 *   dark  → "ember" (deep navy)
 *
 * `initialMode` comes from the server (the `th-theme` cookie, read in the root
 * layout), so SSR paints the right theme and there is no dark-mode flash. The
 * platform colour PRESET system (`ActiveThemeInjector`) layers on top of
 * whichever base this selects — a separate axis from light/dark.
 *
 * Components read the current appearance/mode + `toggle()` from `useAppTheme()`.
 */
type AppThemeContextValue = {
  /** The Tamagui base theme name: "stub" (light) or "ember" (dark). */
  appearance: IthasFireThemeName;
  /** The user-facing appearance mode. */
  mode: ThemeMode;
  /** Flip light ↔ dark, persist the choice, and update `<html data-theme>`. */
  toggle: () => void;
};

const AppThemeContext = createContext<AppThemeContextValue | undefined>(
  undefined,
);

export type AppThemeProviderProps = {
  children: ReactNode;
  /** Server-resolved initial mode (from the `th-theme` cookie). */
  initialMode?: ThemeMode;
  /**
   * The route pins `initialMode` regardless of the viewer's preference
   * (`/embed/*` — see `lib/route-context.ts`). A locked provider never touches
   * the `th-theme` cookie: the embed's forced light is not the VIEWER's
   * choice, so it must not overwrite the dark preference they set on the
   * main site. `toggle()` is a no-op.
   */
  locked?: boolean;
};

export const AppThemeProvider = ({
  children,
  initialMode = DEFAULT_THEME_MODE,
  locked = false,
}: AppThemeProviderProps) => {
  const [mode, setMode] = useState<ThemeMode>(initialMode);

  // Reconcile the device cookie to the server-resolved mode on first mount.
  // SSR now prefers the signed-in user's ACCOUNT preference over the cookie, so
  // after a cross-device change the stale local `th-theme` cookie can disagree
  // with what the server painted. Account wins (per the spec's precedence), so
  // rewrite the cookie to match `initialMode` — otherwise a subsequent SSR read
  // while signed out (or the viewport `themeColor`) would use the wrong value.
  useEffect(() => {
    // A locked route's mode is not the viewer's preference — never persist it.
    if (locked) return;
    const cookieMode = parseThemeMode(readThemeCookie());
    if (cookieMode !== initialMode) {
      document.cookie = `${THEME_COOKIE}=${initialMode};path=/;max-age=${THEME_COOKIE_MAX_AGE};samesite=lax`;
    }
    // First mount only — `initialMode` is server-provided and stable per load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback(() => {
    if (locked) return;
    setMode((prev) => {
      const next: ThemeMode = prev === "dark" ? "light" : "dark";
      const name = themeNameForMode(next);
      // Persist for the next SSR paint + reflect on <html> for plain-CSS
      // consumers that key off [data-theme]. The body CSS vars themselves are
      // re-mirrored by ActiveThemeInjector, which re-runs on this mode change.
      document.cookie = `${THEME_COOKIE}=${next};path=/;max-age=${THEME_COOKIE_MAX_AGE};samesite=lax`;
      const root = document.documentElement;
      root.dataset.theme = name;
      root.style.colorScheme = next === "dark" ? "dark" : "light";
      return next;
    });
  }, [locked]);

  const appearance = themeNameForMode(mode);

  const value = useMemo<AppThemeContextValue>(
    () => ({ appearance, mode, toggle }),
    [appearance, mode, toggle],
  );

  return (
    <AppThemeContext.Provider value={value}>
      <IthasFireProvider theme={appearance}>
        <Theme name={appearance}>{children}</Theme>
      </IthasFireProvider>
    </AppThemeContext.Provider>
  );
};

export const useAppTheme = (): AppThemeContextValue => {
  const context = useContext(AppThemeContext);
  if (!context) {
    throw new Error("useAppTheme must be used within AppThemeProvider");
  }
  return context;
};

/** Read the raw `th-theme` cookie value on the client (undefined if absent). */
const readThemeCookie = (): string | undefined => {
  if (typeof document === "undefined") {
    return undefined;
  }
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${THEME_COOKIE}=`));
  return match?.slice(THEME_COOKIE.length + 1);
};
