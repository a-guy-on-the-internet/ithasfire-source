import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { applyPrivateRouteGate } from "@/middleware/private-route-gate";
import { applyStaffRouteGate } from "@/middleware/staff-route-gate";
import { ROUTE_CONTEXT_HEADER, routeContextForPath } from "@/lib/route-context";

/**
 * IMPORTANT — file location is load-bearing, not cosmetic:
 * this Next.js 16.2.4 + Turbopack combination silently drops the middleware/
 * proxy entirely (empty middleware-manifest.json, no build error, no
 * deprecation warning, no `x-origin-secret`/redirect ever applied at
 * runtime) unless the file lives at `src/middleware.ts` — matching this
 * repo's `src/app` router layout. Root-level `middleware.ts`, root-level
 * `proxy.ts`, and `src/proxy.ts` were all tried and all produced the same
 * silent no-op in a real `next build --turbopack` + standalone
 * `node server.js` run; only `src/middleware.ts` (this exact path, the
 * pre-16 naming convention, under `src/`) actually executes — verified via
 * live `curl` against the standalone bundle (307 redirects on /admin and
 * /moderate, 403 on a bad x-origin-secret). Matches a known, unresolved
 * upstream bug (vercel/next.js#93326) for the `proxy.ts` rename specifically;
 * the `src/` placement requirement for THIS repo's layout was found by direct
 * experimentation, not documented upstream. Do not rename or relocate this
 * file without re-verifying against a real production standalone build.
 *
 * CORRECTION (2026-08-19) — do NOT diagnose that drop from the manifest:
 * `.next/server/middleware-manifest.json` is `{"middleware":{}, "sortedMiddleware":[],
 * "functions":{}}` in a CURRENT, WORKING `next build --turbopack` of this app,
 * while the middleware demonstrably executes (verified same build: anonymous
 * `curl` against the standalone `node server.js` returned 307 to /sign-in on
 * /admin, /moderate AND /platform). Turbopack emits a runtime-stub
 * `.next/server/middleware.js` that loads the real code from chunks, and the
 * manifest is no longer the registration record. The "empty manifest" wording
 * above is preserved as the historical symptom of the ORIGINAL misplacement
 * bug, but it is NOT a usable tell today — an empty manifest proves nothing
 * either way. The ONLY reliable check is behavioural: build, run the standalone
 * bundle, and `curl -i` an anonymous request at a gated prefix.
 *
 * This file contains the origin-secret guard below, plus a server-side auth
 * gate for `/admin/**`, `/moderate/**` and `/platform/**` (see
 * `staff-route-gate.ts` for why that gate has to live here rather than solely
 * in those routes' Server Components — and, for `/platform`, rather than
 * solely in the client-side `PlatformShell` check it mirrors), plus a
 * cookie-presence UX redirect for the remaining private
 * route families (see `private-route-gate.ts` — that one is explicitly NOT an
 * authorization boundary).
 *
 * Auth is otherwise enforced at the API layer (tRPC) and via client-side
 * guards. This file exists beyond that for route-level protection needs
 * (e.g., geo-gating, maintenance-mode redirect, A/B bucketing) plus the
 * concerns above.
 *
 * `runtime = "nodejs"` (below) is set explicitly so `node:crypto` /
 * `timingSafeEqual` are guaranteed available — see the origin-secret-guard
 * comment for why.
 */
export const runtime = "nodejs";

const HEADER_NAME = "x-origin-secret";

/**
 * Paths exempt from the origin-secret guard. Cloud Run's startup probe for
 * the web service (`startup_probe_path` in infra/terraform/main.tf) hits the
 * *.run.app origin directly, so it never carries the Cloudflare-injected
 * header. Mirrors EXEMPT_PATHS in apps/api/src/plugins/origin-guard.ts.
 * Matched against `nextUrl.pathname` (no query string), exact match only.
 */
const EXEMPT_PATHS = ["/api/health"];

/**
 * Origin-secret guard — web-app half of the mitigation documented in
 * apps/api/src/app.ts (`trustProxy` note) and apps/api/src/plugins/origin-guard.ts.
 * Cloud Run has public ingress and no GCLB in front of it, so requests can
 * bypass Cloudflare's edge (WAF, rate limiting) entirely by hitting the
 * *.run.app origin directly. A Cloudflare Transform Rule
 * (infra/terraform/modules/cloudflare) sets `x-origin-secret` on every
 * request that transits the edge; this compares it against
 * ORIGIN_SHARED_SECRET.
 *
 * Skipped entirely outside production (no Cloudflare edge in front of
 * local/preview). When ENFORCE_ORIGIN_SECRET is not "true", mismatches are
 * only logged (rollout/log-only mode) — this must default to off so a bad
 * rollout can't brick prod.
 */
export function checkOriginSecret(request: NextRequest): NextResponse | null {
  if (process.env.NODE_ENV !== "production") {
    return null;
  }

  if (EXEMPT_PATHS.includes(request.nextUrl.pathname)) {
    return null;
  }

  // Trimmed because Cloudflare stamps the TRIMMED secret
  // (`origin_secret_trimmed` in the Terraform module); a stored secret with a
  // trailing newline would otherwise mismatch every request. The provided
  // header is not trimmed: HTTP parsing already strips surrounding OWS, and the
  // edge sends the trimmed value. An all-whitespace secret counts as unset.
  const expected = process.env.ORIGIN_SHARED_SECRET?.trim();
  if (!expected) {
    // Nothing to compare against — treat as unconfigured, not as a mismatch
    // to enforce against. The api-side guard requires this in prod schema
    // validation; the web side degrades gracefully if it's ever missing.
    return null;
  }

  const provided = request.headers.get(HEADER_NAME);
  const matches =
    typeof provided === "string" &&
    Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  if (matches) {
    return null;
  }

  // Never log the secret value itself — only that a mismatch occurred.
  console.warn("origin_secret_mismatch", {
    path: request.nextUrl.pathname,
    method: request.method,
  });

  if (process.env.ENFORCE_ORIGIN_SECRET === "true") {
    return new NextResponse(
      JSON.stringify({ error: "origin_secret_mismatch" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  return null;
}

export default async function middleware(request: NextRequest) {
  const blocked = checkOriginSecret(request);
  if (blocked) {
    return blocked;
  }

  const gated = await applyStaffRouteGate(request);
  if (gated) {
    return gated;
  }

  // Disjoint from the admin/moderate/platform prefixes above, so ordering
  // between the two gates is arbitrary; this one runs second because it is
  // synchronous and cheap (no network call).
  const privateGated = applyPrivateRouteGate(request);
  if (privateGated) {
    return privateGated;
  }

  return withRouteContext(request);
}

/**
 * Hand the root layout the route's context (see `lib/route-context.ts`):
 * `/embed/*` → "embed", which pins the appearance to light and marks `<body>`
 * for the embed rules; a public page → `public:<locale>`, the language its URL
 * fixes (`/es/...` → es, the English R1 and twinless event/place/org pages →
 * en), which the layout renders instead of the cookie / Accept-Language pick.
 * App pages get no context. The root layout cannot see the pathname, so
 * the context rides a request header. A client-supplied copy of the header is
 * always stripped first, so the only value the layout ever reads is the one
 * derived here from the path.
 */
export function withRouteContext(request: NextRequest): NextResponse {
  const context = routeContextForPath(request.nextUrl.pathname);
  if (!context && !request.headers.has(ROUTE_CONTEXT_HEADER)) {
    return NextResponse.next();
  }
  const headers = new Headers(request.headers);
  headers.delete(ROUTE_CONTEXT_HEADER);
  if (context) {
    headers.set(ROUTE_CONTEXT_HEADER, context);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    // Skip Next.js internals, static files, and the Sentry tunnel route (/monitoring).
    // The extension group is ANCHORED (`$`) to the end of the path: unanchored,
    // any page path with a dotted segment (`/events/next.js-meetup`) skipped
    // middleware entirely — its auth gates AND the route-context header strip,
    // which let a client-sent `x-th-route-context` reach the root layout.
    // Pinned by `__tests__/route-context.test.ts` (matcher cases).
    "/((?!monitoring|_next|[^?]*\\.(?:html?|css|js|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)$).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
    // Explicit belt-and-suspenders entries for the staff-route auth gate
    // (staff-route-gate.ts) — already covered by the catch-all pattern
    // above, but listed explicitly so a future narrowing of that pattern
    // can't silently stop running the gate. Like the private-route entries
    // below these MUST be literal strings (Next.js statically analyses
    // `config`); a unit test
    // (`src/middleware/__tests__/staff-route-gate.test.ts`) asserts this list
    // stays in sync with `STAFF_GATED_PREFIXES`.
    "/admin/:path*",
    "/moderate/:path*",
    "/platform/:path*",
    // Same belt-and-suspenders treatment for the private-route gate
    // (private-route-gate.ts). These MUST be literal strings: Next.js
    // statically analyses `config` at build time, so they cannot be derived
    // from `PRIVATE_ROUTE_PREFIXES` with a `.map()`. A unit test
    // (`src/middleware/__tests__/private-route-gate.test.ts`) asserts this
    // list stays in sync with that array so the two can't drift.
    "/account/:path*",
    "/agreements/:path*",
    "/deals/:path*",
    "/sell/:path*",
    "/my-tickets/:path*",
  ],
};
