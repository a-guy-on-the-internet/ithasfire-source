"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";

import { AppAuthGate } from "@/components/auth/AppAuthGate";
import { CartRecoveryProvider } from "@/components/cart/CartRecoveryProvider";
import { CookieConsentBanner } from "@/components/gdpr/CookieConsentBanner";
import { GoogleAnalyticsLoader } from "@/components/analytics/GoogleAnalyticsLoader";
import { PlausibleAnalytics } from "@/components/analytics/PlausibleAnalytics";
import { CloudflareAnalytics } from "@/components/analytics/CloudflareAnalytics";
import { AppShell } from "@/components/layout/AppShell";
import { GlobalOverlays } from "@/components/layout/GlobalOverlays";
import { FeatureGateGuard } from "@/components/guards/FeatureGateGuard";
import { PREFIXED_LOCALES } from "@/i18n/public-paths";
import { isUnderPath } from "@/middleware/path-match";
import { isPrintDocumentRoute } from "@/lib/print-route";
import type { FeatureGatesSnapshot } from "@/lib/feature-gates/types";
import { ServerFeatureGatesProvider } from "@/lib/feature-gates/ServerFeatureGatesContext";

const CHROME_BYPASS_PREFIXES = [
  "/auth",
  "/embed",
  "/sign-in",
  "/sign-up",
] as const;
/**
 * The native app's Turnstile step, opened signed out in a system-browser
 * sheet: no navbar, and above all no auth gate, which would bounce it to
 * /sign-in. Also kept free of cart recovery (see below).
 */
const MOBILE_CHALLENGE_PATH = "/challenge/turnstile";
const CHROME_BYPASS_PATHS = [
  "/login",
  "/access-denied",
  MOBILE_CHALLENGE_PATH,
] as const;
const SHELL_ONLY_PATHS = [
  "/",
  "/privacy",
  "/cookie-policy",
  "/terms",
  "/acceptable-use",
  "/about",
  "/contact",
  "/features",
  "/forgot-password",
  "/reset-password",
  "/house-shows",
  "/review-a-place",
  // Invitation accept pages render their OWN signed-out screen, whose Sign in
  // button stashes the bearer token in sessionStorage and sends
  // `?redirect=/invite/accept` with NO token. Through the auth gate, a
  // signed-out visit was bounced to `/sign-in?redirect=%2Finvite%2Faccept%3F
  // token%3D…`, putting the token in a URL analytics records.
  "/invite/accept",
  "/delegate/accept",
  // "Stop invites from this organiser": opened signed out from an email, and
  // its token must never ride into a `/sign-in?redirect=` URL.
  "/invites/stop",
] as const;
const SHELL_ONLY_PREFIXES = [
  "/events",
  "/account",
  "/search",
  "/help",
  // Community venue reviews are fully open to guests (venue-rating-block-and-
  // owner-optin FR-009): the standalone /rate-venue/[placeId] deep-link must
  // render the community form for logged-out visitors, not bounce them to
  // /sign-in. The form itself gathers guest name/email when signed out and
  // submits via the `optionalProcedure`-backed community endpoint.
  "/rate-venue",
  // Event short links (`/e/<shortId>`), mostly followed by signed-out people
  // from a flyer or a text. Behind the auth gate the server never rendered the
  // page, so its 307 / 404 went out as a 200 and a signed-out visitor was sent
  // to /sign-in. Matching is per segment, so "/e" does not catch /events,
  // /embed or /enroll-2fa.
  "/e",
] as const;
/**
 * Every `/<locale>/…` URL (today `/es/…`) is a public page: a Spanish twin or
 * the `/es/[...rest]` catch-all that answers 404 / 308 (spanish-seo R21; the
 * middleware gives all of them a `public:<locale>` route context). Behind the
 * auth gate the server rendered only its spinner, so crawlers got no content,
 * a signed-out visitor was sent to /sign-in, and the pages' `notFound()` /
 * `permanentRedirect()` never ran on the server and went out as a 200.
 * Safe because the catch-all only 308s to one of the public page families and
 * 404s everything else, private paths included; a gated route added under
 * `/es/` would NOT be covered by the auth gate.
 */
const LOCALE_PREFIXES = PREFIXED_LOCALES.map((locale) => `/${locale}`);
const CUSTOM_SHELL_PREFIXES = ["/admin", "/platform"] as const;
const PUBLIC_ENTITY_SEGMENTS = ["humans", "orgs", "places"] as const;
/**
 * Public sub-pages under `/p/[slug]/…`. Anything not listed here stays on the
 * auth-gated branch, so a new public sub-route must be added deliberately.
 *   · `acts` — every act that has played a venue (venue-track-record-and-
 *     review-switch FR-016); public and server-rendered, like the page above.
 */
const PUBLIC_ENTITY_SUBPAGES = ["acts"] as const;

const matchesPath = (pathname: string, paths: readonly string[]): boolean =>
  paths.includes(pathname);

/**
 * Prefixes match whole path segments: "/events" covers /events and
 * /events/…, never /eventsfoo. A bare `startsWith` would hand a sibling path
 * like /eventsfoo or /accounts-payable the public branch and skip the auth
 * gate.
 */
const matchesPrefix = (
  pathname: string,
  prefixes: readonly string[],
): boolean => prefixes.some((prefix) => isUnderPath(pathname, prefix));

type AppChromeProps = {
  children: ReactNode;
  /** Server-fetched feature gates — seeds ServerFeatureGatesProvider for first paint. */
  featureGates?: FeatureGatesSnapshot;
  /** Dehydrated React Query state carrying pre-fetched feature gates for HydrationBoundary. */
  dehydratedState?: DehydratedState;
};

const shouldBypassChrome = (pathname: string | null): boolean => {
  if (!pathname) {
    return false;
  }

  if (matchesPath(pathname, CHROME_BYPASS_PATHS)) {
    return true;
  }

  // Printable documents render bare, like /embed/*. NOTE this branch also skips
  // AppAuthGate — see the security note on `isPrintDocumentRoute` before adding
  // a new `…/print` route.
  if (isPrintDocumentRoute(pathname)) {
    return true;
  }

  return matchesPrefix(pathname, CHROME_BYPASS_PREFIXES);
};

const shouldBypassAuthGate = (pathname: string | null): boolean => {
  if (!pathname) {
    return false;
  }

  if (matchesPath(pathname, SHELL_ONLY_PATHS)) {
    return true;
  }

  if (isPublicEntityPage(pathname)) {
    return true;
  }

  return (
    matchesPrefix(pathname, SHELL_ONLY_PREFIXES) ||
    matchesPrefix(pathname, LOCALE_PREFIXES)
  );
};

const shouldBypassAppShell = (pathname: string | null): boolean => {
  if (!pathname) {
    return false;
  }

  // Admin & Platform routes own their own navigation chrome
  // (AdminShell / PlatformShell via NavigationShell).
  // Wrapping them in AppShell would render the consumer navbar on top.
  return matchesPrefix(pathname, CUSTOM_SHELL_PREFIXES);
};

/**
 * Public entity profile routes — /p/[slug] (and its listed public sub-pages,
 * `PUBLIC_ENTITY_SUBPAGES`) plus /places|orgs|humans/[slug]. They render
 * through the standard consumer shell WITHOUT the auth gate, exactly like
 * /events. /places/id/* is excluded — it stays on the full auth-gated branch.
 */
const isPublicEntityPage = (pathname: string): boolean => {
  const segments = pathname.split("/").filter(Boolean);
  const [baseSegment, slugSegment, subPage] = segments;
  const hasValidSlug = Boolean(slugSegment);

  if (baseSegment === "p") {
    if (segments.length === 1) return true;
    if (!hasValidSlug) return false;
    if (segments.length === 2) return true;
    return (
      segments.length === 3 &&
      PUBLIC_ENTITY_SUBPAGES.includes(
        subPage as (typeof PUBLIC_ENTITY_SUBPAGES)[number],
      )
    );
  }

  if (
    !PUBLIC_ENTITY_SEGMENTS.includes(
      baseSegment as (typeof PUBLIC_ENTITY_SEGMENTS)[number],
    )
  ) {
    return false;
  }

  if (segments.length !== 2 || !hasValidSlug) {
    return false;
  }

  // "id" and "new" are reserved sibling routes, not entity slugs — they must
  // stay on the auth-gated branch.
  return slugSegment !== "id" && slugSegment !== "new";
};

/**
 * Routing-level chrome that decides which shell / auth wrappers a route gets.
 *
 * AppOverlayProvider already lives in AppProviders (providers.tsx) so it is
 * NOT duplicated here — every branch inherits the single instance above.
 */
export const AppChrome = ({
  children,
  featureGates,
  dehydratedState,
}: AppChromeProps) => {
  const pathname = usePathname();

  // Don't show cart recovery on checkout pages (they handle their own holds)
  const isCheckoutPage =
    !!pathname && isUnderPath(pathname, "/events/checkout");

  // Flush shell padding on checkout so the flow fills the viewport on mobile
  const flushShell = isCheckoutPage;

  // A print document is a piece of paper being previewed. A cart-recovery
  // prompt popping over it is both wrong on screen and a candidate for landing
  // on the sheet; the print route takes the same opt-out checkout does.
  const isPrintDocument = isPrintDocumentRoute(pathname);

  // The app's Turnstile sheet shares cookies with the system browser, so a
  // signed-in visitor with a pending cart would get the resume-checkout banner
  // over the challenge. Same opt-out as print.
  const isMobileChallenge = pathname === MOBILE_CHALLENGE_PATH;

  const seededChildren = (
    <HydrationBoundary state={dehydratedState}>{children}</HydrationBoundary>
  );

  // The provider wraps each branch's WHOLE return, not just the page.
  // AppFooter (gates the Seller Hub link), FeatureGateGuard (maintenance mode)
  // and page/overlay content read gates through `useFeatureGates`, whose
  // `initialData` is this context; outside it they get `undefined` during SSR
  // while the client cache (seeded by the HydrationBoundary) already has the
  // gates, so a gated link (/sell) renders on the client only and hydration
  // fails.
  const withGates = (tree: ReactNode) => (
    <ServerFeatureGatesProvider gates={featureGates}>
      {tree}
    </ServerFeatureGatesProvider>
  );

  // Bare pages — no navbar, no shell (auth callbacks, embeds, login)
  if (shouldBypassChrome(pathname)) {
    return withGates(
      <>
        {!isCheckoutPage && !isPrintDocument && !isMobileChallenge && (
          <CartRecoveryProvider />
        )}
        {seededChildren}
      </>
    );
  }

  // Admin & Platform routes supply their own shell but still require auth
  if (shouldBypassAppShell(pathname)) {
    return withGates(
      <>
        {!isCheckoutPage && <CartRecoveryProvider />}
        <AppAuthGate>{seededChildren}</AppAuthGate>
        <GlobalOverlays />
        <CookieConsentBanner />
        <GoogleAnalyticsLoader />
        <PlausibleAnalytics />
        <CloudflareAnalytics />
      </>
    );
  }

  // Public consumer pages — shell, no auth gate
  if (shouldBypassAuthGate(pathname)) {
    return withGates(
      <>
        {!isCheckoutPage && <CartRecoveryProvider />}
        <FeatureGateGuard>
          <AppShell flush={flushShell}>{seededChildren}</AppShell>
        </FeatureGateGuard>
        <GlobalOverlays />
        <CookieConsentBanner />
        <GoogleAnalyticsLoader />
        <PlausibleAnalytics />
        <CloudflareAnalytics />
      </>
    );
  }

  // Everything else — full auth gate + shell
  return withGates(
    <>
      {!isCheckoutPage && <CartRecoveryProvider />}
      <FeatureGateGuard>
        <AppAuthGate>
          <AppShell flush={flushShell}>{seededChildren}</AppShell>
        </AppAuthGate>
      </FeatureGateGuard>
      <GlobalOverlays />
      <CookieConsentBanner />
      <GoogleAnalyticsLoader />
      <PlausibleAnalytics />
      <CloudflareAnalytics />
    </>
  );
};
