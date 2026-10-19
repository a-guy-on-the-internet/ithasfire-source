import { isUnderPath } from "@/middleware/path-match";

import {
  PUBLIC_PATH_WORDS,
  publicPath,
  type PublicLocale,
  type PublicPage,
} from "@th/types/seo/public-paths";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type AppLocale } from "./config";

/**
 * The ONE place that builds and parses public paths per language (Spanish SEO
 * spec FR-006, R12, R13). Links, canonicals, hreflang and the language
 * plumbing (middleware route context, root layout, client language steps) go
 * through here; the sitemap job builds its paths with the same builder in
 * `@th/types/seo/public-paths`, so a path word lives in exactly one table.
 *
 * Rules:
 *   - One language per URL. The default locale is unprefixed and no `/en/` URL
 *     ever exists; every other supported locale is a prefix (`/es`) (R12).
 *   - Five page families have twins (R1): home, category, city×category,
 *     about, contact. Path words are translated (R13); category slugs differ
 *     per language and come from data, so the CALLER passes the slug for the
 *     locale it is building. City segments are the same in every language
 *     (R17).
 *
 * Kept free of imports beyond the import-free path matcher, `./config`
 * (itself import-free) and the import-free `@th/types` builder: middleware
 * bundles this module via route-context.ts.
 */

/** Locales that live under a URL prefix: every supported locale but the default (R12). */
export const PREFIXED_LOCALES: ReadonlyArray<AppLocale> =
  SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);

// The pure builder (path words, `publicPath`, the page union) lives in
// `@th/types` so the sitemap job builds the same paths (FR-006).
export { publicPath, type PublicPage };

// Compile-time drift guard: the builder's locales must equal web's, both ways.
type LocalesMatch = [AppLocale] extends [PublicLocale]
  ? [PublicLocale] extends [AppLocale]
    ? true
    : never
  : never;
export const LOCALES_MATCH: LocalesMatch = true;

export type ParsedPublicPath = { locale: AppLocale; page: PublicPage };

/**
 * A category's current slug per language: English always, the others when
 * the category has one (the public category lists' `slugs`).
 */
export type CategorySlugs = { en: string } & Partial<Record<AppLocale, string>>;

/**
 * An R1 page to LINK to. Unlike {@link PublicPage}, a category carries every
 * slug it has, so the link builder picks the one for the page's language.
 */
export type PublicLinkPage =
  | { kind: "home" }
  | { kind: "category"; slugs: CategorySlugs }
  | { kind: "cityCategory"; slugs: CategorySlugs; city: string }
  | { kind: "about" }
  | { kind: "contact" };

/**
 * The path of a link to `page` from a page in `locale` (FR-006, R7). A
 * category with no slug in `locale` uses its English slug: its page in that
 * language lives at the English slug (the slug resolver renders it there).
 */
export const publicLinkPath = (
  locale: AppLocale,
  page: PublicLinkPage,
): string => {
  switch (page.kind) {
    case "category":
      return publicPath(locale, {
        kind: "category",
        slug: page.slugs[locale] ?? page.slugs.en,
      });
    case "cityCategory":
      return publicPath(locale, {
        kind: "cityCategory",
        slug: page.slugs[locale] ?? page.slugs.en,
        city: page.city,
      });
    default:
      return publicPath(locale, page);
  }
};

/**
 * A category's slugs from a list row: `slugs` when the API sent it, else
 * just the English `slug` (an API that predates `slugs`, a deploy window).
 */
export const categoryLinkSlugs = (category: {
  slug: string;
  slugs?: Partial<Record<string, string>> | null;
}): CategorySlugs => {
  const out: CategorySlugs = { en: category.slugs?.en || category.slug };
  for (const locale of PREFIXED_LOCALES) {
    const slug = category.slugs?.[locale];
    if (slug) out[locale] = slug;
  }
  return out;
};

const decodeSegment = (segment: string): string | null => {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
};

/** Split a pathname into its locale prefix (if any) and the remaining segments. */
const splitLocale = (
  pathname: string,
): { prefixed: AppLocale | null; segments: string[] } => {
  const trimmed =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  // "/" is home (no segments). Inner empties are kept, so "//x" never parses.
  const segments = trimmed === "/" ? [] : trimmed.split("/").slice(1);
  const first = segments[0];
  const prefixed = PREFIXED_LOCALES.find((locale) => locale === first) ?? null;
  return {
    prefixed,
    segments: prefixed ? segments.slice(1) : segments,
  };
};

/** Match segments against ONE locale's path words. */
const matchWords = (
  segments: string[],
  locale: AppLocale,
): PublicPage | null => {
  const words = PUBLIC_PATH_WORDS[locale];
  if (segments.length === 0) return { kind: "home" };
  if (segments.length === 1) {
    if (segments[0] === words.about) return { kind: "about" };
    if (segments[0] === words.contact) return { kind: "contact" };
    return null;
  }
  if (segments[0] !== words.events || segments[1] !== words.category) {
    return null;
  }
  if (segments.length === 3) {
    const slug = decodeSegment(segments[2]!);
    return slug ? { kind: "category", slug } : null;
  }
  if (segments.length === 4) {
    const slug = decodeSegment(segments[2]!);
    const city = decodeSegment(segments[3]!);
    return slug && city ? { kind: "cityCategory", slug, city } : null;
  }
  return null;
};

/**
 * Parse a pathname into an R1 page and the URL's language, or `null` when the
 * path is not an R1 page in its own language's words.
 */
export const parsePublicPath = (pathname: string): ParsedPublicPath | null => {
  const { prefixed, segments } = splitLocale(pathname);
  const locale = prefixed ?? DEFAULT_LOCALE;
  const page = matchWords(segments, locale);
  return page ? { locale, page } : null;
};

/**
 * A path under a locale prefix written with ANOTHER language's path words
 * (`/es/events/category/music`, `/es/about`): returns the page and the path in
 * the prefix's own words, so the caller can 308 there (R16). The slug is passed
 * through untouched; translating it is the slug resolver's job (FR-010).
 * `null` for anything else, including a path already in its own words.
 */
export const parseMisworded = (
  pathname: string,
): (ParsedPublicPath & { path: string }) | null => {
  const { prefixed, segments } = splitLocale(pathname);
  if (!prefixed || matchWords(segments, prefixed)) return null;
  for (const other of SUPPORTED_LOCALES) {
    if (other === prefixed) continue;
    const page = matchWords(segments, other);
    // Home has no words to translate; "/es" already parses in its own words.
    if (page && page.kind !== "home") {
      return { locale: prefixed, page, path: publicPath(prefixed, page) };
    }
  }
  return null;
};

/**
 * Public pages with NO language twin whose server HTML is English from the
 * first byte, whatever the `th-locale` cookie or Accept-Language say (R5, R22).
 *
 * Why: these are the routes `next.config.ts` serves with a public `s-maxage`,
 * and Cloudflare caches them with no language in the cache key, so a server
 * render that followed the cookie would hand the first filler's language to
 * everyone. A reader who chose Spanish gets the translatable chrome switched
 * after hydration (R22, FR-015); organiser text stays as written (R4).
 *
 * Keep in step with the public `Cache-Control` rules in `next.config.ts`:
 * events (minus checkout and resale, which that file excludes too), places,
 * orgs, humans, entity pages, and the legal pages. The R1 English pages
 * (home, category, city×category, about, contact) are English-first through
 * `parsePublicPath`, not this list.
 */
export const ENGLISH_FIRST_TWINLESS_PREFIXES: ReadonlyArray<string> = [
  "/events",
  "/places",
  "/orgs",
  "/humans",
  "/p",
  "/privacy",
  "/terms",
  "/acceptable-use",
  "/cookie-policy",
];

/** App routes under an English-first prefix that keep the viewer's language. */
const ENGLISH_FIRST_EXCLUSIONS: ReadonlyArray<string> = [
  "/events/checkout",
  "/events/resale",
];

/** An English-first public page with no twin (event, place, org, ...). */
export const isTwinlessEnglishFirstPath = (pathname: string): boolean =>
  ENGLISH_FIRST_TWINLESS_PREFIXES.some((p) => isUnderPath(pathname, p)) &&
  !ENGLISH_FIRST_EXCLUSIONS.some((p) => isUnderPath(pathname, p)) &&
  // An R1 English page (the category families live under /events) is
  // English-first too, but it HAS a twin; callers tell the two apart.
  parsePublicPath(pathname) === null;

/**
 * True when the server must render `pathname` in the default language
 * regardless of the cookie and Accept-Language: the unprefixed R1 pages and
 * the twinless public pages (R5, R22, FR-002).
 */
export const englishFirstPath = (pathname: string): boolean => {
  const parsed = parsePublicPath(pathname);
  if (parsed) return parsed.locale === DEFAULT_LOCALE;
  if (splitLocale(pathname).prefixed) return false;
  return isTwinlessEnglishFirstPath(pathname);
};

/**
 * The language a page's internal links follow (FR-006, R7): its URL prefix,
 * else the default. Decided by the URL, never by the viewer's preference, so
 * an English page links to English pages whatever the reader chose (R5),
 * and an unknown `/es/...` path (its 404) links back into Spanish.
 */
export const linkLocaleForPath = (
  pathname: string | null | undefined,
): AppLocale =>
  (pathname ? splitLocale(pathname).prefixed : null) ?? DEFAULT_LOCALE;

/**
 * The language the URL itself fixes, or `null` when the viewer's choice
 * applies (app pages). Anything under a locale prefix is that locale, an
 * unknown `/es/...` path included, so its 404 or 308 renders in the URL's
 * language. English-first pages are the default locale.
 */
export const urlLocaleForPath = (pathname: string): AppLocale | null => {
  const { prefixed } = splitLocale(pathname);
  if (prefixed) return prefixed;
  return englishFirstPath(pathname) ? DEFAULT_LOCALE : null;
};
