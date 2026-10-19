import { NextResponse, type NextRequest } from "next/server";

import { getSignInUrl } from "@/lib/auth/urls";
import { appendRedirectParam } from "@/lib/redirect";
import { isUnderPath } from "@/middleware/path-match";

/**
 * Middleware-level UX gate for the app's private (session-only) route
 * families.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS NOT AN AUTHORIZATION BOUNDARY. DO NOT TREAT IT AS ONE.
 * ─────────────────────────────────────────────────────────────────────────
 * All this does is look for the PRESENCE of a Better Auth session cookie.
 * A cookie's presence proves only that a cookie exists — not that it is
 * valid, unexpired, unrevoked, or that it belongs to a user entitled to
 * anything. Any client can send `better-auth.session_token=whatever` and
 * sail straight past this gate.
 *
 * Real enforcement is, and must remain, server-side: every private read and
 * every mutation is authenticated on the API (tRPC `protectedProcedure` +
 * `repos.authz` role checks inside the use cases). Nothing was removed or
 * relaxed on the strength of this gate, and nothing may be. If you are about
 * to delete a server-side check because "middleware already handles it",
 * stop — it does not.
 *
 * WHY IT EXISTS ANYWAY (three concrete problems it fixes):
 *  1. Posture consistency. `/admin/**`, `/moderate/**` and `/platform/**`
 *     already redirect anonymous requests at the middleware layer
 *     (`staff-route-gate.ts`),
 *     while `/account/**` did not — it returned a bare `200` and ~142KB of
 *     HTML to hand an anonymous visitor a "You're not signed in" card. Two
 *     private route families, two postures, no stated reason.
 *  2. A real hydration error. These pages are `"use client"` and gate on
 *     `authClient.useSession()`. During SSR the session is `isPending`, so
 *     the server renders the spinner branch; after hydration the session
 *     resolves to "no user" and the client renders entirely different chrome
 *     (`Spinner` vs. a `<button aria-label="Back">`) — a genuine
 *     server/client mismatch on `/account/settings`.
 *  3. Wasted work. SSRing a full document to tell someone to sign in is
 *     bytes, CPU and a layout shift for no benefit.
 *
 * Note that (unlike the admin gate) NO user data was leaking: every private
 * field on these pages is client-fetched with auth, so the anonymous HTML
 * contained zero settings content. This is a soft gate closing a soft hole.
 *
 * WHY COOKIE-PRESENCE AND NOT A REAL SESSION LOOKUP: `staff-route-gate.ts`
 * validates by `fetch`ing the API's `/api/auth/get-session`, and fails CLOSED
 * on any error. That is the right trade for `/admin`, `/moderate` and
 * `/platform` (small blast radius, staff-only, genuinely sensitive shells).
 * Doing it for every
 * `/account/**` request would add an API round-trip to the hot path and,
 * because it fails closed, would bounce legitimately signed-in users to
 * `/sign-in` for as long as the API is briefly unreachable. Since this layer
 * is explicitly not the thing keeping anyone out (see above), the cheap
 * synchronous check buys ~all of the benefit at none of that cost.
 *
 * `next/headers`' `cookies()` is unavailable in middleware, so this reads
 * `request.cookies` directly.
 */

/**
 * Private route families, longest-lived contract in this file — the e2e spec
 * `apps/web/e2e/private-routes.spec.ts` asserts every entry redirects an
 * anonymous request, and that a couple of public routes still return 200.
 *
 * INCLUSION RULE: a family belongs here only if (a) every page under it
 * requires a session to render anything meaningful, AND (b) it has no
 * tokenised / emailed entry point that a signed-out or account-less visitor
 * is expected to follow.
 *
 * Deliberately EXCLUDED, with reasons, so the next person doesn't have to
 * re-derive them:
 *  - `/my-rsvps` — renders a DELIBERATE signed-out promo
 *    (`data-testid="my-rsvps-signed-out"`, with an in-page sign-in overlay
 *    CTA), not a dead-end error card. Redirecting away would delete designed
 *    UX; that's a product call, not a cleanup.
 *  - `/my-lineups` — same reasoning as `/my-rsvps`: a DELIBERATE signed-out
 *    promo (`data-testid="my-lineups-signed-out"`, in-page sign-in overlay
 *    CTA). It is also where the "you're on a lineup" notice links, so a
 *    signed-out reader following it lands on a designed page.
 *  - `/saved` — no longer a page. It folded into `/my-tickets` on 2026-08-31
 *    and is now a `redirect()` stub, so a guest request 307s here and then
 *    307s again off the `/my-tickets` entry below. Adding it to this array
 *    would only change WHICH redirect they get first, and would lose the
 *    `redirect_url=/my-tickets` that the two-hop path produces.
 *  - Tokenised claim/handoff routes — `/claim-transfer`, `/invite/accept`,
 *    `/booking-requests/claim/**`, `/tickets/qr/**`, `/v/**`,
 *    `/payouts/acknowledge/**`, `/unsubscribe` — authorised by a token in
 *    the URL, by design reachable with no session.
 *  - Auth flow routes — `/sign-in`, `/sign-up`, `/forgot-password`,
 *    `/reset-password`, `/verify-email`, `/enroll-2fa`, `/auth/**`,
 *    `/api/auth/**`. Gating these bricks sign-in (and `/sign-in` would
 *    redirect to itself).
 *  - `/embed/**` and every public/marketing/discovery route.
 */
export const PRIVATE_ROUTE_PREFIXES = [
  // Account self-service: /account, /account/settings, /account/credits,
  // /account/notifications, /account/page. Every one renders a
  // "You're not signed in" dead-end card today.
  "/account",
  // Booking agreements, scoped to the parties on the agreement. Signed-out
  // visitors get a bare "sign in to view" fallback. The organiser's "the act
  // accepted" email links to /agreements/{id}
  // (notify-booking-request-responded.ts) and
  // those recipients always have real accounts, so the redirect-back
  // round-trip lands them exactly where the email pointed.
  "/agreements",
  // A payee's view of an event's deal and its changes since it froze
  // (freeze-the-deal FR-007). The deal-change notice email links to
  // /deals/{eventId}; only people on the deal can read it, and they all have
  // accounts, so the round-trip lands them where the email pointed.
  "/deals",
  // Resale seller dashboard (/sell → /sell/listings, /sell/payouts,
  // /sell/claims). Purely an authenticated dashboard: no signed-out state at
  // all, and nothing links into it from email.
  "/sell",
  // Buyer order/ticket views. This was deliberately EXCLUDED once, on the
  // reasoning that the ticket-issued email links guest buyers here and
  // bouncing them to /sign-in would "swap one dead-end for another".
  //
  // MEASURED 2026-08-25, and that premise is false: `/my-tickets/**` is
  // ALREADY auth-gated client-side. `AppChrome` wraps it in `AppAuthGate`
  // (apps/web/src/components/auth/AppAuthGate.tsx), an unconditional gate that
  // pushes `/sign-in?redirect=…` as soon as the session resolves to null. A
  // signed-out request for a real order id ends on the sign-in card with the
  // order-detail query never fired (observed: zero `getMyOrder` requests).
  //
  // So gating here removes nothing a guest could previously reach — it only
  // moves an identical bounce from "download ~114KB, hydrate, spin, redirect"
  // to a 307 off the edge.
  //
  // The guest problem is REAL but separate, and is NOT solved by leaving this
  // ungated: a guest-checkout buyer has a shadow `AuthUser` with no credential
  // account, so the sign-in they land on cannot be completed. That needs a
  // tokenised order view. When it lands, this gate must allow the token
  // through (bypass when the verified token param is present) rather than
  // being removed.
  "/my-tickets",
] as const;

/**
 * Base name of Better Auth's session cookie for THIS deployment.
 *
 * Derived, not guessed:
 *  - `better-auth`'s `createCookieGetter` (node_modules/better-auth/dist/
 *    cookies/index.mjs) builds the name as
 *    `${secureCookiePrefix}${advanced.cookiePrefix ?? "better-auth"}.${cookieName}`,
 *    with `cookieName = "session_token"`.
 *  - `apps/api/src/auth/better-auth.ts` uses the default `better-auth` prefix
 *    on prod (and local dev), but sets `advanced.cookiePrefix="better-auth-dev"`
 *    on DEPLOYED dev (via SESSION_COOKIE_PREFIX) so dev's cross-subdomain
 *    `.ithasfire.com` cookie never collides with prod's on the shared
 *    registrable domain — hence `better-auth-dev.session_token` is recognized
 *    too. See the cross-subdomain note below + infra dev.tfvars.
 *  - Confirmed live against the running dev API: signing in at
 *    `POST :3001/api/auth/sign-in/email` responds with
 *    `set-cookie: better-auth.session_token=…; Path=/; HttpOnly; SameSite=Lax`
 *    (host-only — cookies ignore ports, so the :3001 cookie is sent to the
 *    :3000 web origin in local dev).
 *
 * The `-` separated variant is included because Better Auth's own
 * `getSessionCookie` helper accepts both `${prefix}.${name}` and
 * `${prefix}-${name}`; matching both keeps us aligned with upstream if that
 * shape ever appears.
 */
const SESSION_COOKIE_BASE_NAMES = [
  "better-auth.session_token",
  "better-auth-session_token",
  // Deployed-dev cookiePrefix ("better-auth-dev"); prod is untouched.
  "better-auth-dev.session_token",
] as const;

/**
 * Cookie-name prefixes the browser/server may add. `__Secure-` is applied by
 * Better Auth whenever the auth `baseURL` is https — i.e. in production the
 * cookie arrives as `__Secure-better-auth.session_token`, while local dev
 * (http://localhost:3001) has no prefix. `__Host-` is not used by our config
 * today (it is incompatible with the `Domain=` attribute that
 * `crossSubDomainCookies` sets in prod) but is stripped anyway so a future
 * config change can't silently un-gate these routes.
 *
 * See the cross-subdomain note in `apps/api/src/auth/better-auth.ts` +
 * `cookie-domain.ts`: prod scopes the cookie to `.ithasfire.com` via
 * `SESSION_COOKIE_DOMAIN`, which changes the cookie's DOMAIN, not its NAME.
 */
const COOKIE_NAME_PREFIXES = ["__Secure-", "__Host-"] as const;

const stripCookieNamePrefix = (name: string): string => {
  for (const prefix of COOKIE_NAME_PREFIXES) {
    if (name.startsWith(prefix)) {
      return name.slice(prefix.length);
    }
  }
  return name;
};

/**
 * Whether the request carries something that LOOKS like a session cookie.
 *
 * Deliberately permissive (prefix-tolerant, both separator shapes, any
 * non-empty value): a false positive here just means the page renders and the
 * real server-side checks do their job, whereas a false negative would bounce
 * a signed-in user to `/sign-in`. Empty values are treated as absent because
 * that is how a cleared/expired cookie is expressed.
 */
export const hasSessionCookie = (request: NextRequest): boolean =>
  request.cookies
    .getAll()
    .some(
      (cookie) =>
        cookie.value.length > 0 &&
        (SESSION_COOKIE_BASE_NAMES as readonly string[]).includes(
          stripCookieNamePrefix(cookie.name),
        ),
    );

/**
 * Returns a redirect `NextResponse` when the request should be bounced to
 * sign-in, or `null` when it may proceed (either the path is outside every
 * private family, or a session cookie is present).
 *
 * The redirect carries `?redirect_url=<path+query>` — the same convention
 * `staff-route-gate.ts` uses via `appendRedirectParam`, and the one
 * `/sign-in` consumes via `readRedirectParam` (`apps/web/src/lib/redirect.ts`)
 * before `router.replace`-ing there once the session resolves. The query
 * string is preserved because these targets are query-driven — e.g.
 * `/account/settings?redirect_url=/admin/acme` renders a "return to" banner,
 * so dropping it would lose the user's actual destination. Round-tripping it
 * is safe: `readRedirectParam` re-sanitises to a same-origin relative path,
 * so a hostile `?redirect_url=https://evil.example` cannot survive the trip.
 */
export function applyPrivateRouteGate(
  request: NextRequest,
): NextResponse | null {
  const { pathname, search } = request.nextUrl;

  const isPrivate = PRIVATE_ROUTE_PREFIXES.some((prefix) =>
    isUnderPath(pathname, prefix),
  );
  if (!isPrivate) {
    return null;
  }

  if (hasSessionCookie(request)) {
    return null;
  }

  const signInUrl = new URL(
    appendRedirectParam(getSignInUrl(), `${pathname}${search}`),
    request.url,
  );
  return NextResponse.redirect(signInUrl);
}
