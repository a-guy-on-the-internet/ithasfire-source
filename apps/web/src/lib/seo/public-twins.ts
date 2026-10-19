import type { Metadata } from "next";

import { buildCanonicalUrl, getSiteName, getSiteUrl } from "@/config/site";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type AppLocale,
} from "@/i18n/config";
import type { PublicTwinSet } from "@/i18n/client-locale";
import { publicPath } from "@/i18n/public-paths";

/**
 * Canonical, hreflang and twin registration for the pages that have a
 * language twin (spanish-seo R1, R8, R9, FR-005). Paths come from
 * `publicPath` (FR-006); this file only qualifies and pairs them.
 *
 * Alternates rule: a page lists `languages` (every twin plus `x-default` =
 * English) only when EVERY twin is indexable. A pair with a noindex member
 * lists none, on both sides, so hreflang is always reciprocal and never
 * points at a page that asks not to be indexed. That covers a category with
 * no Spanish name (R9: its /es/ page is noindex) and a thin page (noindex in
 * both languages, since both list the same events). The self-canonical stays
 * on every page.
 */

/** A path per language: what `publicPath(locale, page)` returns. */
export type TwinPaths = Record<AppLocale, string>;

/** Whether each language version may be indexed. */
export type TwinIndexable = Record<AppLocale, boolean>;

export const twinAlternates = (
  locale: AppLocale,
  paths: TwinPaths,
  indexable: TwinIndexable,
): NonNullable<Metadata["alternates"]> => {
  const canonical = buildCanonicalUrl(paths[locale]);
  if (!SUPPORTED_LOCALES.every((l) => indexable[l])) return { canonical };
  const languages: Record<string, string> = {};
  for (const l of SUPPORTED_LOCALES) languages[l] = buildCanonicalUrl(paths[l]);
  languages["x-default"] = buildCanonicalUrl(paths[DEFAULT_LOCALE]);
  return { canonical, languages };
};

/** The `<PublicTwins>` registration for a pair (FR-003, FR-004). */
export const twinSet = (
  paths: TwinPaths,
  indexable: TwinIndexable,
): PublicTwinSet => {
  const set: PublicTwinSet = {};
  for (const l of SUPPORTED_LOCALES) {
    set[l] = { path: paths[l], indexable: indexable[l] };
  }
  return set;
};

/** `{ en: v, es: v }`: every language the same. */
export const everyLocale = <T>(value: T): Record<AppLocale, T> =>
  Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, value])) as Record<
    AppLocale,
    T
  >;

/**
 * The site's share image, as the root layout declares it. A page that sets
 * its own `openGraph` replaces the layout's whole object, image included.
 */
export const siteShareImage = (alt: string) => {
  const siteUrl = getSiteUrl();
  return {
    url: `${siteUrl}/og-image-v2.png`,
    width: 1200,
    height: 630,
    alt,
  };
};

/**
 * Title, description, canonical, hreflang and share text for a twinned page
 * that uses the site share image (home, about, contact). `title` null keeps
 * the layout's default title (the site name).
 */
export const staticTwinMetadata = (input: {
  locale: AppLocale;
  paths: TwinPaths;
  title: string | null;
  description: string;
  socialDescription?: string;
  imageAlt: string;
}): Metadata => {
  const siteName = getSiteName();
  const url = buildCanonicalUrl(input.paths[input.locale]);
  const socialTitle = input.title ? `${input.title} • ${siteName}` : siteName;
  const socialDescription = input.socialDescription ?? input.description;
  const image = siteShareImage(input.imageAlt);
  return {
    ...(input.title ? { title: input.title } : {}),
    description: input.description,
    alternates: twinAlternates(input.locale, input.paths, everyLocale(true)),
    openGraph: {
      type: "website",
      url,
      title: socialTitle,
      description: socialDescription,
      siteName,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description: socialDescription,
      images: [image.url],
    },
  };
};

/**
 * The home page of `locale`, fully qualified: a breadcrumb's first item. The
 * English one stays the bare site URL, as the crumbs have always said.
 */
export const homeUrl = (locale: AppLocale): string =>
  locale === DEFAULT_LOCALE
    ? getSiteUrl()
    : buildCanonicalUrl(publicPath(locale, { kind: "home" }));
