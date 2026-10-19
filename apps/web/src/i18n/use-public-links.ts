"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";

import type { AppLocale } from "./config";
import {
  linkLocaleForPath,
  publicLinkPath,
  type PublicLinkPage,
} from "./public-paths";

export type PublicLinks = {
  /** The language this page's links follow: its URL prefix, else English. */
  locale: AppLocale;
  /** Path of a link to an R1 page, in this page's language (FR-006, R7). */
  path: (page: PublicLinkPage) => string;
};

/**
 * Links to the five twin families (home, category, city×category, about,
 * contact) from the page in view: on an `/es/...` page they go to the Spanish
 * twins, everywhere else to the English pages. Every other link (events,
 * places, orgs, search, help, sign-in) has one URL and does not come here.
 *
 * Read from the URL, not the viewer's language, so the server render and the
 * hydrating client agree. A Server Component calls `linkLocaleForPath` /
 * `publicLinkPath` from `./public-paths` with the locale its route passes.
 */
export function usePublicLinks(): PublicLinks {
  const locale = linkLocaleForPath(usePathname());
  return useMemo(
    () => ({ locale, path: (page) => publicLinkPath(locale, page) }),
    [locale],
  );
}
