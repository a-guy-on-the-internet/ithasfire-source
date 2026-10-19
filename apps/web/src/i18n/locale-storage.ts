import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  parseAppLocale,
  type AppLocale,
} from "./config";

/**
 * Where the visitor's EXPLICIT language choice is kept, client side: the
 * `th-locale` localStorage key (read on the client) and the `th-locale` cookie
 * (read by the server, and the fallback when localStorage was cleared). Only
 * the language picker and the R6 / "Ver en español" steps write it; navigator
 * detection never does. Moved out of `locale-provider.tsx` so the provider
 * and `public-twins.tsx` share it.
 */

const STORAGE_KEY = "th-locale";

/** The explicit choice stored in localStorage, if any (and supported). */
export const readStoredPreference = (): AppLocale | undefined => {
  try {
    return parseAppLocale(localStorage.getItem(STORAGE_KEY));
  } catch {
    // SSR / privacy mode
    return undefined;
  }
};

/** Read the raw `th-locale` cookie on the client (undefined if absent). */
export const readLocaleCookie = (): string | undefined => {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${LOCALE_COOKIE}=`));
  return match?.slice(LOCALE_COOKIE.length + 1);
};

/** Mirror the choice into the cookie the server reads for the first paint. */
export const writeLocaleCookie = (locale: AppLocale) => {
  if (typeof document === "undefined") return;
  document.cookie = `${LOCALE_COOKIE}=${locale};path=/;max-age=${LOCALE_COOKIE_MAX_AGE};samesite=lax`;
};

/**
 * The visitor's explicit choice: localStorage, else the cookie. The cookie can
 * outlive localStorage (cleared, or unreadable), and the server painted from
 * it, so it still counts.
 */
export const readExplicitChoice = (): AppLocale | undefined =>
  readStoredPreference() ?? parseAppLocale(readLocaleCookie());

/** The browser's language, when it is a supported locale. Never a choice. */
export const readNavigatorLocale = (): AppLocale | undefined => {
  if (typeof navigator === "undefined") return undefined;
  return parseAppLocale(navigator.language?.split("-")[0]);
};

/**
 * Persist the user's explicit choice: localStorage (read on the client) and
 * the `th-locale` cookie (read by the server, so the next full load paints in
 * this language from the first byte).
 */
export const setLocalePreference = (locale: AppLocale) => {
  // Callers pass an AppLocale, but this is exported: never persist (or put in
  // a cookie) anything that is not a supported locale.
  if (!parseAppLocale(locale)) return;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Ignore quota / privacy errors
  }
  writeLocaleCookie(locale);
};
