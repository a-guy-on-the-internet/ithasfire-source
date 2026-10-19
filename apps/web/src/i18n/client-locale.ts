import { DEFAULT_LOCALE, type AppLocale } from "./config";
import {
  isTwinlessEnglishFirstPath,
  parsePublicPath,
  urlLocaleForPath,
} from "./public-paths";

/**
 * Pure rules for the client's language on public pages (Spanish SEO spec R5,
 * R6, R22, FR-003, FR-004, FR-015). `locale-provider.tsx` and
 * `public-twins.tsx` wire them to React; they live here so every rule is
 * unit-testable without rendering.
 *
 * "Explicit choice" means a supported locale saved by the language picker:
 * the `th-locale` localStorage key or, when that is missing, the `th-locale`
 * cookie (both written by `setLocalePreference`). Navigator language is never
 * a choice.
 */

/** One language version of a page with twins. */
export type PublicTwin = {
  /** Path in that language (`publicPath(locale, page)`), no query string. */
  path: string;
  /**
   * Whether that version is indexable: has hreflang and a sitemap entry. An
   * /es/ category page whose category has no Spanish name renders but is
   * noindex (R9): the picker still goes there, the automatic move does not.
   */
  indexable: boolean;
};

/** Every language version of the page in view, keyed by locale. */
export type PublicTwinSet = Partial<Record<AppLocale, PublicTwin>>;

/** How the URL governs the client's language on a path. */
export type PathLanguage =
  /** A prefixed page (`/es/...`): the URL's language, always (R2, R5). */
  | { kind: "url"; locale: AppLocale }
  /** An unprefixed R1 page with a twin: always the default language (R5). */
  | { kind: "twinned" }
  /** An event/place/org page with no twin: English HTML, R22 chrome step. */
  | { kind: "twinless" }
  /** Everything else: the viewer's choice, as before. */
  | { kind: "app" };

export const pathLanguage = (pathname: string): PathLanguage => {
  const urlLocale = urlLocaleForPath(pathname);
  if (urlLocale && urlLocale !== DEFAULT_LOCALE) {
    return { kind: "url", locale: urlLocale };
  }
  if (isTwinlessEnglishFirstPath(pathname)) return { kind: "twinless" };
  if (urlLocale) return { kind: "twinned" };
  return { kind: "app" };
};

/**
 * The language the client renders on `pathname`.
 *   - `/es/...`: Spanish, even over a saved "en" (the URL wins).
 *   - unprefixed R1 page: English. A saved Spanish choice acts through the
 *     move to the twin ({@link twinMoveTarget}), never by flipping this page.
 *   - twinless public page: the explicit choice, else English (R22).
 *   - app page: explicit choice > navigator > default (unchanged).
 */
export const clientLocaleForPath = (
  pathname: string,
  {
    explicit,
    navigatorLocale,
  }: {
    explicit: AppLocale | undefined;
    navigatorLocale: AppLocale | undefined;
  },
): AppLocale => {
  const rule = pathLanguage(pathname);
  switch (rule.kind) {
    case "url":
      return rule.locale;
    case "twinned":
      return DEFAULT_LOCALE;
    case "twinless":
      return explicit ?? DEFAULT_LOCALE;
    case "app":
      return explicit ?? navigatorLocale ?? DEFAULT_LOCALE;
  }
};

/**
 * Registered twins, but only when they belong to the page in view: the set's
 * entry for the URL's own language must be this exact path. Guards the one
 * render where a client navigation has a new pathname but the previous page's
 * registration has not been replaced yet.
 */
export const currentPageTwins = (
  twins: PublicTwinSet | null,
  pathname: string,
): PublicTwinSet | null => {
  if (!twins) return null;
  const parsed = parsePublicPath(pathname);
  if (!parsed) return null;
  return twins[parsed.locale]?.path === pathname ? twins : null;
};

/**
 * FR-003 first half: on an unprefixed R1 page, a visitor whose EXPLICIT
 * choice is another language moves to that language's twin, when the twin is
 * indexable. `null` when nobody should move (no choice, chose the default,
 * no indexable twin, not an R1 default-language page).
 */
export const twinMoveTarget = ({
  pathname,
  twins,
  explicit,
}: {
  pathname: string;
  twins: PublicTwinSet | null;
  explicit: AppLocale | undefined;
}): string | null => {
  if (!explicit || explicit === DEFAULT_LOCALE) return null;
  if (pathLanguage(pathname).kind !== "twinned") return null;
  const twin = currentPageTwins(twins, pathname)?.[explicit];
  return twin?.indexable && twin.path !== pathname ? twin.path : null;
};
