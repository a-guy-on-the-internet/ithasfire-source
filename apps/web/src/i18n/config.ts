export const SUPPORTED_LOCALES = ["en", "es"] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";

/**
 * Cookie carrying the visitor's explicit language choice. Written client-side
 * when they pick a language (and backfilled from the `th-locale` localStorage
 * key for choices made before the cookie existed); read server-side so the
 * first paint, `<html lang>` and server-rendered pages (Help Center) follow it.
 */
export const LOCALE_COOKIE = "th-locale";

/** One year: the preference is sticky. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Narrow an arbitrary string to a supported locale, or `undefined`. */
export const parseAppLocale = (
  value: string | null | undefined,
): AppLocale | undefined =>
  value && (SUPPORTED_LOCALES as readonly string[]).includes(value)
    ? (value as AppLocale)
    : undefined;

export const LOCALE_LABELS: Record<AppLocale, string> = {
  en: "English",
  es: "Español",
} as const;

export const getLocaleDirection = (locale: string): "ltr" | "rtl" => {
  const normalized = locale.toLowerCase();

  if (
    normalized.startsWith("ar") ||
    normalized.startsWith("he") ||
    normalized.startsWith("fa")
  ) {
    return "rtl";
  }

  return "ltr";
};
