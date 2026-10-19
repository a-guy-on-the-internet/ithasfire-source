/**
 * The pure path builder for the R1 page families that have a language twin
 * (Spanish SEO spec FR-006, R12, R13). Shared by apps/web (links, canonicals,
 * hreflang, middleware) and apps/jobs (the sitemap), so a path word lives in
 * exactly one table. Import-free on purpose: middleware bundles it.
 *
 * Rules:
 *   - One language per URL. The default locale is unprefixed and no `/en/` URL
 *     ever exists; every other locale is a prefix (`/es`) (R12).
 *   - Five page families have twins (R1): home, category, city×category,
 *     about, contact. Path words are translated (R13); category slugs differ
 *     per language and come from data, so the CALLER passes the slug for the
 *     locale it is building. City segments are the same in every language (R17).
 *
 * Parsing a path back into a page stays in apps/web (`i18n/public-paths.ts`).
 */

/** Keep in step with `SUPPORTED_LOCALES` in apps/web `i18n/config.ts`. */
export type PublicLocale = "en" | "es";

export const DEFAULT_PUBLIC_LOCALE: PublicLocale = "en";

/** A page in one of the R1 families. Slugs are the slug FOR the locale in hand. */
export type PublicPage =
  | { kind: "home" }
  | { kind: "category"; slug: string }
  | { kind: "cityCategory"; slug: string; city: string }
  | { kind: "about" }
  | { kind: "contact" };

/** Path words per locale (R13). A new locale must add its row. */
export const PUBLIC_PATH_WORDS: Record<
  PublicLocale,
  { events: string; category: string; about: string; contact: string }
> = {
  en: {
    events: "events",
    category: "category",
    about: "about",
    contact: "contact",
  },
  es: {
    events: "eventos",
    category: "categoria",
    about: "acerca-de",
    contact: "contacto",
  },
};

const prefixFor = (locale: PublicLocale): string =>
  locale === DEFAULT_PUBLIC_LOCALE ? "" : `/${locale}`;

/** Build the path of `page` in `locale`. */
export const publicPath = (locale: PublicLocale, page: PublicPage): string => {
  const prefix = prefixFor(locale);
  const words = PUBLIC_PATH_WORDS[locale];
  switch (page.kind) {
    case "home":
      return prefix || "/";
    case "category":
      return `${prefix}/${words.events}/${words.category}/${encodeURIComponent(page.slug)}`;
    case "cityCategory":
      return `${prefix}/${words.events}/${words.category}/${encodeURIComponent(page.slug)}/${encodeURIComponent(page.city)}`;
    case "about":
      return `${prefix}/${words.about}`;
    case "contact":
      return `${prefix}/${words.contact}`;
  }
};
