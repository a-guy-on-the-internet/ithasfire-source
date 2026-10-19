import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";

import { createThrottledReporter } from "@th/core/lib/throttled-reporter";

import { getTrpcHttpUrl } from "@/config/trpc";
import { hasSessionCookie } from "@/lib/auth/session-cookie";
import { getSignInUrl } from "@/lib/auth/urls";
import { appendRedirectParam } from "@/lib/redirect";
import { isUnderPath } from "@/middleware/path-match";
// The marker-free core, not `@/server/client-ip-forward` (server-only).
import {
  signedClientIpHeaders,
  type IncomingHeaderReader,
} from "@/server/client-ip-forward-core";

/**
 * Middleware-level auth gate for `/admin/**`, `/moderate/**` and
 * `/platform/**`.
 *
 * WHY THIS EXISTS (and duplicates the Server Component checks in
 * `admin/[slug]/layout.tsx`, `admin/page.tsx`, `moderate/layout.tsx`):
 * a `redirect()` thrown from a Server Component did not reliably produce a
 * real HTTP 3xx for a full-document (non-JS) request — verified against an
 * actual `next build && node server.js` production standalone bundle, where
 * anonymous `curl -i` against `/admin`, `/admin/<slug>`, and
 * `/moderate/suggestions` (and even the pre-existing, unrelated
 * `redirect("/platform/overview")` in `app/platform/page.tsx`) all returned a
 * bare `200` with no `Location` header. This is NOT a Turbopack-dev-only
 * artifact — it reproduced in the production build.
 *
 * That was originally attributed to the root layout wrapping every page in
 * React's experimental `<ViewTransition>` boundary. That boundary is now scoped
 * to the PUBLIC surface only — `<PageTransition>`
 * (`apps/web/src/app/_components/PageTransition.tsx`) sets `default="none"` for
 * `/admin`, `/platform` and `/moderate`, so these routes no longer animate.
 *
 * DO NOT read that as "the cause is gone, delete this gate". Two reasons:
 * the original symptom already covered a redirect that was NOT under a
 * relevant boundary (`app/platform/page.tsx`), so the transition was probably
 * never the sole cause; and `default="none"` disables the ANIMATION, while the
 * component still renders here — the RSC/streaming shape is not necessarily
 * identical to having no boundary at all. The 200-instead-of-3xx behaviour has
 * NOT been re-verified since any of this changed.
 *
 * Re-run the anonymous `curl -i` check against a production standalone bundle
 * before touching this. Until then it is the layer that actually stops an
 * anonymous request cold: middleware runs before any React rendering, so
 * `NextResponse.redirect()` here is a genuine 3xx regardless of RSC streaming
 * behaviour. The Server Component-level checks stay in place as defense in
 * depth (and because middleware can't easily resolve org-scoped role data).
 *
 * `next/headers`' `cookies()`/`headers()` are unavailable in middleware —
 * this reads `request.headers`/`request.cookies` directly instead, and hits
 * the same Better Auth / tRPC endpoints the Server Component helpers use
 * (`get-server-session.ts`, `moderator-access.ts`) via plain `fetch`, since a
 * tRPC proxy client built on `next/headers` can't run here either.
 *
 * WHAT EACH PREFIX GETS:
 *  - `/admin/**` — session check ONLY. Admin authorization is org-scoped
 *    (which org? which role in it?) and that can't be resolved from the
 *    pathname alone up here, so the role check stays in
 *    `admin/[slug]/layout.tsx` + the tRPC procedures. Do not "upgrade" this
 *    branch without solving the org-resolution problem first.
 *  - `/moderate/**` — session + `community.checkModeratorAccess`
 *    (COMMUNITY_MODERATOR or platform ADMIN) + the step-up 2FA gate.
 *  - `/platform/**` — session + `platform.checkStaffAccess` + the step-up 2FA
 *    gate. Before this existed, the staff console's only boundaries were the
 *    tRPC procedures and a CLIENT-side check in `PlatformShell.tsx`; this
 *    mirrors that client gate's behaviour at the edge so an anonymous or
 *    non-staff full-document request is stopped before any RSC render.
 *
 * THIS GATE IS DELIBERATELY COARSE — DO NOT "IMPROVE" IT INTO AN RBAC LAYER.
 * It answers exactly one question per prefix: "is this actor staff at all?"
 * (for `/platform`, whatever `platform.checkStaffAccess` says — which includes
 * REVIEWER and every other staff role). Per-section authorization — e.g.
 * `/platform/reports` requiring ADMIN/SUPPORT/DEVELOPER via
 * `requirePlatformStaff` in the use cases — stays at the tRPC procedures,
 * where the data to decide it actually lives and where it is testable. Encoding
 * per-section role rules here would create a second, silently-drifting copy of
 * the authorization matrix keyed off URL shape.
 */

type ServerSessionShape = {
  user: { id: string } & Record<string, unknown>;
  session: Record<string, unknown>;
};

const isServerSession = (value: unknown): value is ServerSessionShape => {
  if (!value || typeof value !== "object") return false;
  const user = (value as { user?: unknown }).user;
  return (
    !!user &&
    typeof user === "object" &&
    typeof (user as { id?: unknown }).id === "string"
  );
};

/**
 * DELIBERATELY `getTrpcHttpUrl()` (public / Cloudflare-proxied), NOT
 * `getServerTrpcHttpUrl()` — do not "optimize" this to the internal origin.
 *
 * `config/trpc.ts` actively advises server-side callers to prefer
 * `getServerTrpcHttpUrl()`, which resolves `WEB_API_BASE_URL` → the API's
 * internal `*.run.app` origin, so SSR traffic stays inside Google's network.
 * That advice does not apply here: requests to the internal origin never
 * transit Cloudflare, so Cloudflare's Transform Rule never injects
 * `x-origin-secret` — and unlike `server/trpc-client.ts`, this gate sends no
 * `originSecretHeaders()` of its own (`server/origin-secret.ts` is
 * `import "server-only"`, which middleware is not). Switching to the internal
 * URL would therefore hit the API's origin-guard with no secret and 403 EVERY
 * request the moment `ENFORCE_ORIGIN_SECRET=true` — i.e. fail closed, staff
 * wide, in production only. The hairpin through Cloudflare is the price of
 * that safety.
 */
const getApiBaseUrl = (): string => getTrpcHttpUrl().replace(/\/trpc$/, "");

/**
 * Sentry `area` tag for everything this gate reports. Was `admin-auth-gate`
 * back when the gate only covered `/admin` + `/moderate`; renamed alongside
 * the module so the tag names what it actually guards. The Server Component
 * helpers (`lib/auth/get-server-session.ts`, `server/moderator-access.ts`) are
 * a DIFFERENT code path and report under `ssr-auth-gate` — don't assume one
 * tag covers both layers.
 */
const SENTRY_AREA = "staff-route-gate";

/**
 * A sustained upstream outage must produce PERIODIC breadcrumbs, not one event
 * per request and not silence after the first.
 *
 * Un-throttled, this gate is a firehose: `/admin/**` is the busiest gated
 * surface AND the one prefix that calls `hasSession` on literally every
 * request, so a four-minute `get-session` 503 at 5rps is ~1,200 events. Those
 * events then compete for the client-side quota with the signals that actually
 * matter here — a mint `429` (staff-wide lockout) and a staff-probe `500` are
 * both LOW volume by nature, and would be exactly what gets dropped.
 *
 * Same window and same trade-off as the two existing solutions to this in this
 * subsystem — `guard.ts`'s `RATE_LIMIT_REPORT_THROTTLE_MS` and
 * `rate-limit-storage.ts`'s `AUTH_RATE_LIMIT_REPORT_THROTTLE_MS`.
 */
const GATE_REPORT_THROTTLE_MS = 15 * 60 * 1000;

/**
 * `createThrottledReporter` keys its window on the call's `tags`, which is
 * precisely the property needed here: every report below carries a distinct
 * `check` (and `outcome`), so a `get-session` flood CANNOT swallow the mint
 * `429` or the staff-probe `500` — each gets its own independent window.
 * `extra` (status, procedurePath) is deliberately NOT part of the key, so a
 * flapping upstream cycling through statuses can't defeat the throttle.
 *
 * Module-level, so the window survives across requests within a server
 * instance (a per-request wrapper would never throttle anything — the exact
 * bug `guard.ts`'s memoizing WeakMap exists to avoid). In-memory only: it
 * resets on restart and is per-instance, which is fine — the contract is
 * "don't spam one event per request", not "exactly once across the fleet".
 */
const reportFailure = createThrottledReporter((error, context) => {
  Sentry.captureException(error, context);
}, GATE_REPORT_THROTTLE_MS);

/**
 * Reports an INFRASTRUCTURE denial — a non-2xx from an upstream this gate
 * depends on.
 *
 * The distinction this exists to draw: a `200` carrying `allowed: false` is an
 * EXPECTED denial (a normal person hitting a staff URL) and must stay silent,
 * or the signal drowns. A non-2xx is the API being broken or rate-limiting us,
 * which fails the gate closed and bounces REAL staff to `/access-denied` with
 * no other trace — exactly the swallow-and-fallback-unreported pattern
 * CLAUDE.md's error convention exists to prevent (Jun 2026 silent-search
 * outage). `logger.warn` would not be captured; only an exception is.
 *
 * NEVER put the cookie or the minted token in `extra` — status and (where
 * relevant) the procedure path only.
 */
function reportUpstreamFailure(
  check: string,
  status: number,
  extra?: Record<string, unknown>,
): void {
  reportFailure(
    new Error(`staff-route-gate ${check} upstream returned ${status}`),
    {
      tags: { area: SENTRY_AREA, check, outcome: "upstream-non-2xx" },
      extra: { status, ...extra },
    },
  );
}

/**
 * Reports a THROWN failure (network error, malformed body). Same throttle as
 * `reportUpstreamFailure`, but a distinct `outcome` tag so the two failure
 * modes for one `check` neither share a window nor blur together in Sentry —
 * "the API is 503ing" and "we can't reach the API at all" want different
 * responses.
 */
function reportThrown(
  check: string,
  error: unknown,
  extra?: Record<string, unknown>,
): void {
  reportFailure(error, {
    tags: { area: SENTRY_AREA, check, outcome: "threw" },
    ...(extra ? { extra } : {}),
  });
}

/**
 * Path prefixes this gate covers. Exported so the middleware matcher test can
 * assert `config.matcher` has a belt-and-suspenders entry for each (same drift
 * guard `PRIVATE_ROUTE_PREFIXES` has).
 *
 * `applyStaffRouteGate` ITERATES these keys rather than reading `.admin` /
 * `.moderate` / `.platform` by hand, and each key's post-session policy lives
 * in the total `PREFIX_ACCESS_POLICY` record below. That combination is what
 * makes adding a 4th prefix safe: the matcher test demands an entry for it,
 * and the policy record makes it a COMPILE ERROR to add one without saying
 * whether it needs a staff probe. Read by hand, a 4th key would have picked up
 * a matcher entry and been silently ungated.
 */
export const STAFF_GATED_PREFIXES = {
  admin: "/admin",
  moderate: "/moderate",
  platform: "/platform",
} as const;

type StaffGatedPrefixKey = keyof typeof STAFF_GATED_PREFIXES;

/**
 * Fails CLOSED (see module doc): any network error, non-2xx response, or
 * malformed body resolves to `false` ("no session") rather than throwing.
 *
 * A `200` with no session in the body is the EXPECTED anonymous answer and is
 * not reported; a non-2xx is an upstream failure that bounces a possibly
 * signed-in user to `/sign-in`, so it is.
 */
async function hasSession(
  cookie: string,
  incoming: IncomingHeaderReader,
): Promise<boolean> {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/auth/get-session`, {
      method: "GET",
      headers: { cookie, ...signedClientIpHeaders(incoming) },
      cache: "no-store",
    });
    if (!res.ok) {
      reportUpstreamFailure("session", res.status);
      return false;
    }
    const json: unknown = await res.json();
    return isServerSession(json);
  } catch (err) {
    reportThrown("session", err);
    return false;
  }
}

/**
 * Mints the short-lived Bearer JWT the staff probe is authenticated with.
 *
 * The non-2xx report here is the highest-value one in this file. This endpoint
 * is rate-limited by Better Auth keyed on client IP, and every call from this
 * gate is server-to-server, so the whole fleet's mints collapse onto the web
 * service's egress IP — a `429` here is a staff-WIDE lockout, not one user's
 * problem, and it is otherwise indistinguishable from "not staff". See the
 * `"/token"` rule in `apps/api/src/auth/better-auth.ts` for the cap that keeps
 * this off the global floor.
 *
 * Mitigated by the signed visitor IP (x-th-client-ip*): when the web has
 * ORIGIN_SHARED_SECRET and the inbound request has a valid
 * `cf-connecting-ip`, the API keys this call on the staff member's IP instead
 * (apps/api/src/plugins/verified-client-ip.ts). Without a forward it is still
 * the shared-egress bucket described above.
 */
async function mintToken(
  cookie: string,
  incoming: IncomingHeaderReader,
): Promise<string | null> {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/auth/token`, {
      method: "GET",
      headers: { cookie, ...signedClientIpHeaders(incoming) },
      cache: "no-store",
    });
    if (!res.ok) {
      reportUpstreamFailure("mint-token", res.status);
      return null;
    }
    const json = (await res.json()) as {
      token?: unknown;
      data?: { token?: unknown };
    };
    const token = json.token ?? json.data?.token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch (err) {
    reportThrown("mint-token", err);
    return null;
  }
}

type StaffAccessCheck = {
  allowed: boolean;
  /** Enrolled passkey or TOTP (step-up 2FA gate). `false` when `!allowed`. */
  secondFactorEnrolled: boolean;
};

const DENIED_STAFF_ACCESS: StaffAccessCheck = {
  allowed: false,
  secondFactorEnrolled: false,
};

/**
 * tRPC procedures this gate probes. Both return the SAME
 * `{ allowed, secondFactorEnrolled, … }` shape, which is what makes the single
 * `checkStaffAccessViaTrpc` helper below possible — if either output ever
 * diverges, split the helper rather than widening its parsing.
 */
const ACCESS_PROCEDURES = {
  /**
   * Mirrors `checkModeratorAccessServer` — COMMUNITY_MODERATOR or platform
   * ADMIN. Gates `/moderate/**`.
   */
  moderator: "community.checkModeratorAccess",
  /**
   * Mirrors the client gate in `app/platform/_components/PlatformShell.tsx` —
   * any PLATFORM_STAFF_ROLES member (ADMIN, REVIEWER, SUPPORT, DEVELOPER).
   * Gates `/platform/**`. Deliberately excluded from `requireStaffSecondFactor`'s
   * gated-path allowlist server-side (see the procedure's doc in
   * `packages/transport/trpc/src/routers/platform.ts`), so it keeps answering
   * for staff who haven't enrolled a 2nd factor — which is exactly what lets
   * this gate send them to `/enroll-2fa` instead of `/access-denied`.
   */
  platformStaff: "platform.checkStaffAccess",
} as const;

type AccessProcedure =
  (typeof ACCESS_PROCEDURES)[keyof typeof ACCESS_PROCEDURES];

/**
 * What each gated prefix requires AFTER the shared session check.
 * `null` = session check only.
 *
 * Total over `STAFF_GATED_PREFIXES`'s keys ON PURPOSE: a new prefix added
 * there fails to compile until its policy is stated here, so "gated by the
 * matcher but ungated by the code" is not a reachable state.
 */
const PREFIX_ACCESS_POLICY: Record<
  StaffGatedPrefixKey,
  AccessProcedure | null
> = {
  // Admin authorization is org-scoped and can't be resolved from the
  // pathname — see "WHAT EACH PREFIX GETS" in the module doc.
  admin: null,
  moderate: ACCESS_PROCEDURES.moderator,
  platform: ACCESS_PROCEDURES.platformStaff,
};

/**
 * Shared probe for "does this actor have staff access?", used for BOTH gated
 * staff prefixes so the two can't drift. Calls `procedurePath` as a plain,
 * non-batched GET (neither procedure takes input, so no `input=` query param
 * is needed) authenticated with a short-lived Bearer JWT minted from the
 * forwarded session cookie, same as `mintTokenFromCookie` in
 * `server/trpc-client.ts`.
 *
 * Fails CLOSED: a failed mint, a network error, a non-2xx response, a
 * malformed body, or anything thrown all resolve to denied.
 *
 * Also surfaces `secondFactorEnrolled` (step-up 2FA gate for platform /
 * moderation staff) so the caller can redirect staff missing a 2nd factor to
 * `/enroll-2fa` instead of letting the full shell load.
 */
async function checkStaffAccessViaTrpc(
  cookie: string,
  procedurePath: AccessProcedure,
  incoming: IncomingHeaderReader,
): Promise<StaffAccessCheck> {
  try {
    const token = await mintToken(cookie, incoming);
    if (!token) return DENIED_STAFF_ACCESS;

    const res = await fetch(`${getApiBaseUrl()}/trpc/${procedurePath}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...signedClientIpHeaders(incoming),
      },
      cache: "no-store",
    });
    if (!res.ok) {
      // NOT reported when the body says `allowed: false` on a 200 — that is a
      // normal person on a staff URL. A non-2xx means the probe itself failed
      // and real staff are being denied. See `reportUpstreamFailure`.
      reportUpstreamFailure("staff-access", res.status, { procedurePath });
      return DENIED_STAFF_ACCESS;
    }

    const json = (await res.json()) as {
      result?: {
        data?: {
          json?: { allowed?: unknown; secondFactorEnrolled?: unknown };
        };
      };
    };
    if (json.result?.data?.json?.allowed !== true) {
      return DENIED_STAFF_ACCESS;
    }
    return {
      allowed: true,
      secondFactorEnrolled:
        json.result?.data?.json?.secondFactorEnrolled === true,
    };
  } catch (err) {
    reportThrown("staff-access", err, { procedurePath });
    return DENIED_STAFF_ACCESS;
  }
}

/**
 * Returns a redirect `NextResponse` when the request must be bounced, or
 * `null` when the request may proceed (either it's outside every prefix in
 * `STAFF_GATED_PREFIXES`, or the gate passed).
 */
export async function applyStaffRouteGate(
  request: NextRequest,
): Promise<NextResponse | null> {
  const { pathname } = request.nextUrl;

  // Prefixes are disjoint, so match order is irrelevant.
  const matchedPrefix = (
    Object.keys(STAFF_GATED_PREFIXES) as StaffGatedPrefixKey[]
  ).find((key) => isUnderPath(pathname, STAFF_GATED_PREFIXES[key]));
  if (!matchedPrefix) {
    return null;
  }

  // REJECTED OPTIMIZATION — do not add it back: skipping the staff probe when
  // the request carries `next-router-prefetch: 1` would cut the fetch volume
  // from PlatformShell's ~25 prefetched sidebar links, but that header is
  // CLIENT-CONTROLLED. Any `curl -H 'next-router-prefetch: 1'` would then walk
  // straight past this gate — a one-command auth bypass of the whole thing.
  // If prefetch volume ever needs addressing, do it with a short-TTL cache of
  // the probe RESULT keyed on the session, never by trusting a request header.

  // Shared across all gated prefixes: no valid session → sign-in. Keeping this
  // in one place is why an anonymous `/platform` request needs no branch of
  // its own. None of `/sign-in`, `/access-denied` or `/enroll-2fa` is under a
  // gated prefix, so no redirect target can loop back into this gate.
  //
  // The cookie-PRESENCE pre-filter matters for more than speed: without it,
  // any request bearing any junk cookie buys an unauthenticated caller a full
  // outbound API round trip from our edge — a request-amplification primitive,
  // and this change would have put it on a third prefix. `hasSessionCookie`
  // (`lib/auth/session-cookie.ts`, the `cookie: string` overload — NOT the
  // same-named `NextRequest` one in `private-route-gate.ts`, which is kept
  // separate because that gate needs `request.cookies` parsing) is the
  // repo's designated filter for exactly this: "any server path that pays an
  // internal round trip only signed-in viewers can benefit from must gate on
  // this".
  //
  // TRADE-OFF, stated plainly: this is presence-only and name-based, so if the
  // deployed Better Auth `cookiePrefix` ever changes without updating that
  // helper, signed-in staff false-negative straight to `/sign-in` — annoying,
  // but it fails CLOSED, which is the correct direction here. It is also why
  // `private-route-gate.ts` keeps its own matcher deliberately permissive.
  //
  // Short-circuits left to right, which IS the policy: no cookie header → no
  // fetch; cookies but no session cookie → no fetch; otherwise verify for
  // real. It also narrows `cookie` to `string` for the probe below.
  const cookie = request.headers.get("cookie");
  if (
    cookie === null ||
    !hasSessionCookie(cookie) ||
    !(await hasSession(cookie, request.headers))
  ) {
    const signInUrl = new URL(
      appendRedirectParam(getSignInUrl(), pathname),
      request.url,
    );
    return NextResponse.redirect(signInUrl);
  }

  // `/admin` maps to `null` here — session check only. See "WHAT EACH PREFIX
  // GETS" in the module doc.
  const staffProcedure = PREFIX_ACCESS_POLICY[matchedPrefix];

  if (staffProcedure) {
    // `cookie` is narrowed to `string` by the early return above — no cast.
    const access = await checkStaffAccessViaTrpc(
      cookie,
      staffProcedure,
      request.headers,
    );
    if (!access.allowed) {
      return NextResponse.redirect(new URL("/access-denied", request.url));
    }
    if (!access.secondFactorEnrolled) {
      const enrollUrl = new URL(
        appendRedirectParam("/enroll-2fa", pathname),
        request.url,
      );
      return NextResponse.redirect(enrollUrl);
    }
  }

  return null;
}
