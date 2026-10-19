import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { cookies, headers } from "next/headers";
import { dehydrate } from "@tanstack/react-query";

import { getSiteName, getSiteUrl } from "@/config/site";
import { pickServerLocale } from "@/i18n/resolve-locale";
import { LOCALE_COOKIE } from "@/i18n/config";
import { AppChrome } from "@/components/layout/AppChrome";
import { UniverseDust } from "@/app/_components/home/UniverseDust";
import { getFeatureGatesServer } from "@/server/feature-gates";
import { makeQueryClient } from "@/lib/query-client";
import { featureGatesQueryKey } from "@/lib/feature-gates/query-key";
import "@/polyfills/dev-flag";

import { NavigationProgressProvider } from "@/app/_components/NavigationProgressProvider";
import { PageTransition } from "@/app/_components/PageTransition";
import { getServerThemeMode } from "@/lib/auth/get-server-theme-mode";

import "./globals.css";
import { AppProviders } from "./providers";
import {
  parseThemeMode,
  THEME_COOKIE,
  themeColorForMode,
  themeCssVarsForMode,
  themeNameForMode,
} from "@/lib/theme-mode";
import {
  parseRouteContext,
  ROUTE_CONTEXT_HEADER,
  themeLockForContext,
} from "@/lib/route-context";

const siteUrl = getSiteUrl();
const siteName = getSiteName();

const montserrat = localFont({
  src: [
    {
      path: "../../public/fonts/Montserrat-roman.var.woff2",
      style: "normal",
    },
  ],
  display: "swap",
  variable: "--th-font-body",
  weight: "100 900",
  // A metric-matched Arial stands in until the 205KB file arrives, so the
  // swap barely moves text. With `false` the raw system fallback reflowed
  // the page when Montserrat landed (checkout at 320, Slow 4G: the ticket
  // card grew 23px, CLS 0.031; with the adjusted fallback 0.008).
  adjustFontFallback: "Arial",
});

// IBM Plex Mono — the second brand font, reinstated 2026-08-26 (reverses the
// 2026-07-28 Montserrat-only decision). It carries the tracked-uppercase label
// idiom the design system calls its most identifying mark: labels, kickers,
// meta lines, prices, index numbers, table heads and code.
//
// Static instances, not variable — IBM ships Plex Mono as discrete weights.
// Latin subset only (~10KB each, 40KB total): the `latin` Google subset covers
// U+0000-00FF, which is every glyph `en` and `es` need, accents and inverted
// punctuation included. A locale outside that range needs the `latin-ext`
// files added as a second `localFont` declaration — subsets are disjoint, so
// they cannot be merged into these entries.
const plexMono = localFont({
  src: [
    { path: "../../public/fonts/IBMPlexMono-400.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/IBMPlexMono-500.woff2", weight: "500", style: "normal" },
    { path: "../../public/fonts/IBMPlexMono-600.woff2", weight: "600", style: "normal" },
    { path: "../../public/fonts/IBMPlexMono-700.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--th-font-mono",
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  metadataBase: new URL(`${siteUrl}/`),
  title: {
    default: siteName,
    template: `%s • ${siteName}`,
  },
  description: "Discover, promote, and sell tickets for unforgettable events.",
  manifest: "/manifest.json",
  alternates: {
    canonical: siteUrl,
  },
  openGraph: {
    type: "website",
    url: siteUrl,
    title: siteName,
    description: "Built for communities.",
    siteName,
    images: [
      {
        url: `${siteUrl}/og-image-v2.png`,
        width: 1200,
        height: 630,
        alt: "Ithas Fire — Built for communities",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: siteName,
    description: "Built for communities.",
    images: [`${siteUrl}/og-image-v2.png`],
  },
};

// Without this, Next.js doesn't emit the viewport <meta> and iOS Safari
// renders at its default 980px width and scales down — everything looks
// tiny/shifted/clipped on phones. `viewportFit: cover` lets us reach
// under the notch/home-indicator when needed.
export async function generateViewport(): Promise<Viewport> {
  // themeColor tracks the appearance cookie so the mobile address bar / PWA
  // chrome matches the active theme (was hardcoded to the light cream).
  // A route-locked mode (embeds — see lib/route-context.ts) outranks the cookie.
  const mode =
    themeLockForContext(
      parseRouteContext((await headers()).get(ROUTE_CONTEXT_HEADER)),
    ) ?? parseThemeMode((await cookies()).get(THEME_COOKIE)?.value);
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    // Shrink the layout viewport when the on-screen keyboard is shown (Android
    // Chrome) so the bottom-anchored support composer rides above the keyboard
    // instead of being covered by it.
    interactiveWidget: "resizes-content",
    themeColor: themeColorForMode(mode),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [gates, reqHeaders, cookieStore] = await Promise.all([
    getFeatureGatesServer(),
    headers(),
    cookies(),
  ]);

  // Appearance mode resolved server-side so the correct theme paints on first
  // byte (no dark-mode flash on reload). Precedence: the signed-in user's
  // account preference (follows them across devices) → the sticky `th-theme`
  // cookie → DEFAULT_THEME_MODE (light, via parseThemeMode). `getServerThemeMode`
  // fails soft to `null` (signed out / unset / API down) so we fall back cleanly.
  // `dark` is only painted where the user has opted in.
  //
  // A route LOCK outranks all three: `/embed/*` always paints the platform's
  // light theme (Stub + the active preset) because it lives on someone else's
  // website — see lib/route-context.ts. The account lookup is skipped there too;
  // its answer could never be used.
  const routeContext = parseRouteContext(reqHeaders.get(ROUTE_CONTEXT_HEADER));
  const themeLock = themeLockForContext(routeContext);
  const accountMode = themeLock ? null : await getServerThemeMode();
  const themeMode =
    themeLock ??
    accountMode ??
    parseThemeMode(cookieStore.get(THEME_COOKIE)?.value);
  const themeName = themeNameForMode(themeMode);
  // Mirror the active theme's tokens as inline body vars for BOTH modes.
  // globals.css `:root` only carries a hand-mirrored SUBSET of the tokens, so
  // "light needs nothing" was wrong: any Tamagui var outside that subset (e.g.
  // `--accentHard`, the filled-chip fill) was unresolved until
  // ActiveThemeInjector hydrated — a filled info Chip painted its
  // `--onStructure` (paper) label with NO fill on the cream canvas. Values come
  // from the snapshot, so no literal hex lands here.
  const themeBodyVars = themeCssVarsForMode(themeMode);

  // A public page's URL fixes its language (`/es/...` → es; the English R1
  // pages and the twinless event/place/org pages → en, whatever the cookie
  // says): Cloudflare caches those with no language in the key. Elsewhere the
  // visitor's explicit choice (`th-locale` cookie) beats Accept-Language, so
  // someone who picked Español on an English browser gets a Spanish first
  // paint instead of an English one that flips after hydration.
  const serverLocale = pickServerLocale({
    routeContext,
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: reqHeaders.get("accept-language"),
  });

  const serverQueryClient = makeQueryClient();
  serverQueryClient.setQueryData(featureGatesQueryKey(), gates);
  const dehydratedState = dehydrate(serverQueryClient);

  return (
    <html
      lang={serverLocale}
      data-theme={themeName}
      // Drives native UI (scrollbars, form controls) + the page canvas / iOS
      // overscroll to match the theme — without this, dark mode shows light
      // scrollbars and white overscroll bleed.
      style={{ colorScheme: themeMode === "dark" ? "dark" : "light" }}
      className={`${montserrat.variable} ${plexMono.variable}`}
    >
      {/* `data-th-embed` scopes the embed rules in globals.css (transparent
          canvas, host --hf-* layers). Rendered HERE, as a prop, because React
          strips any <body> attribute it doesn't render when it re-acquires the
          body singleton — a script-added class did not survive hydration.
          suppressHydrationWarning: Tamagui assigns body.className client-side. */}
      <body
        data-th-embed={routeContext === "embed" ? "" : undefined}
        style={{
          WebkitFontSmoothing: "antialiased",
          MozOsxFontSmoothing: "grayscale",
          ...themeBodyVars,
        }}
        suppressHydrationWarning
      >
        {/* Global navigation progress bar (soft chrome), mounted once at the
            root above every navigating component so the extended `useRouter`
            (from `@bprogress/next/app`) always finds its context. See the
            wrapper for why it needs its own "use client" boundary. */}
        <NavigationProgressProvider>
          <AppProviders
            serverLocale={serverLocale}
            initialThemeMode={themeMode}
            themeLocked={themeLock !== null}
          >
            {/* Global animated backdrop — mounted once at the root so its
                particle state persists across every navigation, including
                sign-in/sign-up ↔ home. The canvas is `position: fixed`
                (zIndex: -1) and pointer-events: none. */}
            <UniverseDust />
            <AppChrome featureGates={gates} dehydratedState={dehydratedState}>
              <PageTransition>{children}</PageTransition>
            </AppChrome>
          </AppProviders>
        </NavigationProgressProvider>
      </body>
    </html>
  );
}
