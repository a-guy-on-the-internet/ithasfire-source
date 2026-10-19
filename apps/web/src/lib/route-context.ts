import { isUnderPath } from "@/middleware/path-match";
import type { ThemeMode } from "@/lib/theme-mode";
import {
  parseAppLocale,
  SUPPORTED_LOCALES,
  type AppLocale,
} from "@/i18n/config";
import { urlLocaleForPath } from "@/i18n/public-paths";

/**
 * Route CONTEXT resolved before the root layout renders: "this is an embed",
 * or "this public page's language is fixed by its URL".
 *
 * `/embed/*` renders inside organisers' own websites. The host controls that
 * page's look, so a visitor who once toggled dark on ithasfire.com must not get
 * a dark widget on a light church website. Embeds therefore always render the
 * PLATFORM's light theme — Stub plus whatever preset is active — which is what
 * lets a token change or a preset reach every embed with no embed-side edits.
 *
 * The root layout cannot see the pathname, so middleware resolves the context
 * and hands it over as a request header. The layout then:
 *   - paints `<html data-theme>`, the inline body vars and `AppThemeProvider`'s
 *     mode from the LOCKED mode instead of the account preference / `th-theme`
 *     cookie, so Tamagui's theme, the plain-CSS body vars and
 *     `ActiveThemeInjector`'s preset overlay agree from the first byte;
 *   - renders `data-th-embed` on `<body>` (the hook for the embed rules in
 *     globals.css — transparent canvas, host `--hf-*` layers). It MUST be a
 *     rendered prop: React strips every `<body>` attribute it doesn't render
 *     when it re-acquires the body singleton (`releaseSingletonInstance`), which
 *     is what silently wiped the old script-added `th-embed-body` class.
 *
 * Public pages (Spanish SEO spec R21, FR-002) carry `public:<locale>`: the
 * language their URL fixes (`/es/...` → es; the English R1 pages and the
 * twinless event/place/org pages → en; see `i18n/public-paths.ts`). The layout
 * renders that language and ignores the `th-locale` cookie and Accept-Language,
 * so a page Cloudflare caches with no language in its key is the same for
 * everyone. Embeds and public pages never overlap (`/embed` is not public).
 *
 * Kept free of imports beyond types, the import-free path matcher and the
 * import-free `i18n/public-paths` + `i18n/config`: middleware bundles this
 * module, and `theme-mode.ts` pulls in `@th/ui`.
 */
export const ROUTE_CONTEXT_HEADER = "x-th-route-context";

export type RouteContext = "embed" | `public:${AppLocale}`;

const PUBLIC_CONTEXTS: ReadonlyArray<RouteContext> = SUPPORTED_LOCALES.map(
  (locale) => `public:${locale}` as const,
);

const CONTEXT_PREFIXES: ReadonlyArray<{
  prefix: string;
  context: RouteContext;
}> = [{ prefix: "/embed", context: "embed" }];

/** The context a path belongs to, or `null` for an ordinary app route. */
export const routeContextForPath = (pathname: string): RouteContext | null => {
  for (const { prefix, context } of CONTEXT_PREFIXES) {
    if (isUnderPath(pathname, prefix)) {
      return context;
    }
  }
  const urlLocale = urlLocaleForPath(pathname);
  return urlLocale ? `public:${urlLocale}` : null;
};

/**
 * Narrow the header's value. Anything unknown is "no context" — the header is
 * set by our own middleware, which strips any client-supplied copy first.
 */
export const parseRouteContext = (
  value: string | null | undefined,
): RouteContext | null => {
  if (value === "embed") return "embed";
  return PUBLIC_CONTEXTS.find((context) => context === value) ?? null;
};

/** The language a public route's URL fixes, or `null` (embeds, app pages). */
export const urlLocaleForContext = (
  context: RouteContext | null,
): AppLocale | null =>
  context?.startsWith("public:")
    ? (parseAppLocale(context.slice("public:".length)) ?? null)
    : null;

/** The appearance mode a context pins, or `null` when the viewer's choice applies. */
export const themeLockForContext = (
  context: RouteContext | null,
): ThemeMode | null => (context === "embed" ? "light" : null);
