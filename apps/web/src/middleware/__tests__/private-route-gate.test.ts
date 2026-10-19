// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import {
  applyPrivateRouteGate,
  hasSessionCookie,
  PRIVATE_ROUTE_PREFIXES,
} from "../private-route-gate";
import { config as middlewareConfig } from "../../middleware";

/**
 * The bug this gate closes: `/account/settings` returned a bare 200 to a
 * cookie-less request and let a `"use client"` page render a "You're not
 * signed in" card after hydration. These tests pin the redirect, the
 * cookie-name shapes the deployment can actually set (dev bare name, prod
 * `__Secure-` prefixed), and — most importantly — that public routes are
 * untouched. An over-broad matcher here would lock everyone out of the site.
 */

const makeRequest = (path: string, cookie?: string): NextRequest =>
  new NextRequest(`https://app.example.com${path}`, {
    headers: cookie ? { cookie } : undefined,
  });

const DEV_COOKIE = "better-auth.session_token=abc123";
const PROD_COOKIE = "__Secure-better-auth.session_token=abc123";

describe("applyPrivateRouteGate", () => {
  describe("private families redirect an anonymous request", () => {
    for (const prefix of PRIVATE_ROUTE_PREFIXES) {
      it(`redirects ${prefix} with a redirect-back param`, () => {
        const result = applyPrivateRouteGate(makeRequest(prefix));

        expect(result).not.toBeNull();
        expect(result?.status).toBe(307);
        expect(result?.headers.get("location")).toBe(
          `https://app.example.com/sign-in?redirect_url=${encodeURIComponent(prefix)}`,
        );
      });

      it(`redirects a nested path under ${prefix}`, () => {
        const result = applyPrivateRouteGate(makeRequest(`${prefix}/deep/leaf`));

        expect(result?.status).toBe(307);
        expect(result?.headers.get("location")).toBe(
          `https://app.example.com/sign-in?redirect_url=${encodeURIComponent(
            `${prefix}/deep/leaf`,
          )}`,
        );
      });
    }
  });

  it("gates the per-section settings routes, not just the index", () => {
    // `/account/settings` is a route FAMILY now (`/security`, `/roles`,
    // `/booking-requests`, …). The prefix match is segment-aware
    // (`isUnderPath`), so this is already covered — pinned explicitly because
    // an exact-match regression here would silently un-gate every section.
    for (const path of [
      "/account/settings/security",
      "/account/settings/booking-requests",
      "/account/settings/danger",
    ]) {
      const result = applyPrivateRouteGate(makeRequest(path));
      expect(result?.status).toBe(307);
      expect(result?.headers.get("location")).toBe(
        `https://app.example.com/sign-in?redirect_url=${encodeURIComponent(path)}`,
      );
    }
  });

  it("lets a signed-in request through to a settings sub-route", () => {
    expect(
      applyPrivateRouteGate(
        makeRequest("/account/settings/security", DEV_COOKIE),
      ),
    ).toBeNull();
  });

  it("preserves the query string in the redirect-back param", () => {
    // /account/settings is query-driven (it reads `redirect_url` itself to
    // render a "return to" banner), so dropping the search would lose the
    // user's actual destination.
    const result = applyPrivateRouteGate(
      makeRequest("/account/settings?redirect_url=%2Fadmin%2Facme"),
    );

    expect(result?.headers.get("location")).toBe(
      "https://app.example.com/sign-in?redirect_url=%2Faccount%2Fsettings%3Fredirect_url%3D%252Fadmin%252Facme",
    );
  });

  describe("public routes are never gated", () => {
    const publicPaths = [
      "/",
      "/events",
      "/events/some-slug",
      "/search",
      "/sign-in",
      "/sign-up",
      "/forgot-password",
      "/reset-password",
      "/verify-email",
      "/enroll-2fa",
      "/auth/complete",
      "/api/auth/get-session",
      "/embed/abc123",
      "/help",
      "/support",
      // NOTE: /my-tickets is GATED as of 2026-08-25 (it was never reachable
      // signed-out anyway — AppAuthGate bounced it client-side). Its redirect
      // is asserted with the other private prefixes above.
      // /saved is not gated HERE on purpose: since 2026-08-31 it is a
      // `redirect()` stub onto /my-tickets, which IS gated. The middleware
      // passing it through is what lets the page emit that redirect.
      "/saved",
      "/my-rsvps",
      "/my-lineups",
      "/claim-transfer",
      "/invite/accept",
      "/tickets/qr/tok_1",
      "/unsubscribe",
      "/payouts/acknowledge/line_1",
      "/booking-requests/claim/tok_1",
      // Prefix-adjacent traps: a naive `startsWith` would gate all of these.
      "/accounts",
      "/accounts-payable",
      "/account-recovery",
      "/agreements-policy",
      "/selling-guide",
    ];

    for (const path of publicPaths) {
      it(`lets ${path} through with no cookie`, () => {
        expect(applyPrivateRouteGate(makeRequest(path))).toBeNull();
      });
    }
  });

  describe("session cookie detection", () => {
    it("lets a private route through with the dev cookie name", () => {
      expect(
        applyPrivateRouteGate(makeRequest("/account/settings", DEV_COOKIE)),
      ).toBeNull();
    });

    it("lets a private route through with the prod __Secure- cookie name", () => {
      expect(
        applyPrivateRouteGate(makeRequest("/account/settings", PROD_COOKIE)),
      ).toBeNull();
    });

    it("lets a private route through with the `-` separated variant", () => {
      expect(
        applyPrivateRouteGate(
          makeRequest("/account/settings", "better-auth-session_token=abc"),
        ),
      ).toBeNull();
    });

    it("lets a private route through with the deployed-dev prefixed cookie", () => {
      // Deployed dev uses cookiePrefix="better-auth-dev" (bare + __Secure-).
      expect(
        applyPrivateRouteGate(
          makeRequest("/account/settings", "better-auth-dev.session_token=abc"),
        ),
      ).toBeNull();
      expect(
        applyPrivateRouteGate(
          makeRequest(
            "/account/settings",
            "__Secure-better-auth-dev.session_token=abc",
          ),
        ),
      ).toBeNull();
    });

    it("finds the session cookie alongside unrelated cookies", () => {
      expect(
        hasSessionCookie(
          makeRequest(
            "/account",
            `th-theme=stub; ${PROD_COOKIE}; th-locale=en`,
          ),
        ),
      ).toBe(true);
    });

    it("treats an empty cookie value as no session (cleared/expired cookie)", () => {
      const result = applyPrivateRouteGate(
        makeRequest("/account/settings", "better-auth.session_token="),
      );

      expect(result?.status).toBe(307);
    });

    it("ignores unrelated cookies", () => {
      expect(
        hasSessionCookie(
          makeRequest("/account", "th-theme=stub; better-auth.dont_remember=1"),
        ),
      ).toBe(false);
    });
  });
});

describe("middleware config matcher", () => {
  /**
   * Next.js statically analyses `export const config`, so the matcher entries
   * are hand-written literals rather than derived from
   * `PRIVATE_ROUTE_PREFIXES`. This is the guard against those two drifting:
   * add a family without a matcher entry and the belt-and-suspenders coverage
   * silently disappears if the catch-all pattern is ever narrowed.
   */
  it("has an explicit entry for every private route prefix", () => {
    for (const prefix of PRIVATE_ROUTE_PREFIXES) {
      expect(middlewareConfig.matcher).toContain(`${prefix}/:path*`);
    }
  });
});
