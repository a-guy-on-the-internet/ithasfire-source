import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  parseAppLocale,
  type AppLocale,
} from "./config";
import { urlLocaleForContext, type RouteContext } from "@/lib/route-context";

/** Resolve a supported locale from an Accept-Language header value. */
export const resolveLocaleFromHeader = (
  acceptLanguage: string | null,
): AppLocale => {
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const preferred = acceptLanguage
    .split(",")
    .map((part) => part.split(";")[0]!.trim().split("-")[0]!.toLowerCase());

  for (const lang of preferred) {
    if ((SUPPORTED_LOCALES as readonly string[]).includes(lang)) {
      return lang as AppLocale;
    }
  }

  return DEFAULT_LOCALE;
};

/**
 * The server's pick for a request: the visitor's explicit choice (the
 * `th-locale` cookie) wins when it names a supported locale; otherwise the
 * browser's Accept-Language; otherwise the default. A garbage or unsupported
 * cookie value is ignored, never trusted.
 */
export const resolveLocale = ({
  cookie,
  acceptLanguage,
}: {
  cookie: string | null | undefined;
  acceptLanguage: string | null | undefined;
}): AppLocale =>
  parseAppLocale(cookie) ?? resolveLocaleFromHeader(acceptLanguage ?? null);

/**
 * The root layout's language for a request (Spanish SEO spec FR-002, R5).
 * A public page's URL fixes its language (`public:<locale>` route context,
 * set by middleware from the path): the cookie and Accept-Language are
 * ignored there, so a page Cloudflare caches without a language in its key is
 * the same HTML for everyone. Every other route (app pages, embeds) keeps
 * {@link resolveLocale}: explicit cookie > Accept-Language > default.
 */
export const pickServerLocale = ({
  routeContext,
  cookie,
  acceptLanguage,
}: {
  routeContext: RouteContext | null;
  cookie: string | null | undefined;
  acceptLanguage: string | null | undefined;
}): AppLocale =>
  urlLocaleForContext(routeContext) ??
  resolveLocale({ cookie, acceptLanguage });
