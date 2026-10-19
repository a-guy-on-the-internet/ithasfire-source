import { expect, test } from "@playwright/test";

import { PRIVATE_ROUTE_PREFIXES } from "../src/middleware/private-route-gate";

// ─────────────────────────────────────────────────────────────────────────────
// The gate that private routes are actually gated.
//
// This exists because nothing caught the obvious: `GET /account/settings` with
// no cookies returned HTTP 200 and ~142KB of HTML. `/account/**` was not
// gated at ALL, while `/admin/**` and `/moderate/**` had been gated in
// middleware for months. Every existing guard was blind to it:
//   - the unit tests            → never asserted on a real HTTP status
//   - the Playwright specs      → all run authenticated (chromium project)
//   - code review               → the page "handles" signed-out, so it looked fine
// What none of them checked is the one thing that matters here: what a
// cookie-less HTTP request actually gets back. So that is what this asserts,
// at the transport level.
//
// It cuts both ways ON PURPOSE. A middleware matcher is a shotgun: the failure
// mode of getting it wrong is not "one page is ungated", it is "the entire
// site 307s to /sign-in". The public-route half of this spec is the louder
// half.
//
// Guest-safe in EITHER project: the `storageState` override below empties the
// browser context even under `chromium` (which injects auth via
// `playwright/.auth/user.json`), and the status-level assertions use a bare
// `fetch` that carries no cookies at all. Intended to run as
// `--project=guest`; it does not need a `testIgnore` entry to be correct.
//
// Read-only by construction — every request here is a GET, so this is safe
// against a live/shared dev database (E2E_USE_LIVE_STACK=1) and has nothing
// to clean up.
// ─────────────────────────────────────────────────────────────────────────────

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The private families, imported from the gate itself rather than re-listed —
 * a hand-copied list is exactly how a newly added family ends up untested.
 * `PRIVATE_ROUTE_PREFIXES` lives in
 * `apps/web/src/middleware/private-route-gate.ts` and carries the reasoning
 * for what is in it and (importantly) what is deliberately out of it.
 *
 * Re-exported so this file stays the single readable answer to "what is
 * private?" for anyone grepping the e2e suite.
 */
export const PRIVATE_ROUTES: string[] = [
  ...PRIVATE_ROUTE_PREFIXES,
  // A representative nested path per family: the matcher has to cover
  // descendants, not just the family root. `/account/settings` is the exact
  // route that regressed.
  "/account/settings",
  "/account/credits",
  "/account/notifications",
  "/agreements/agr_does_not_exist",
  "/sell/listings",
];

/**
 * Genuinely public routes. If an over-broad matcher ever gates these, this
 * half of the spec fails loudly — which is the point.
 *
 * `/sign-in` is non-negotiable: gating it would make the redirect target
 * itself redirect, i.e. an infinite loop that locks every user out of the
 * product entirely.
 */
export const PUBLIC_ROUTES: string[] = [
  "/",
  "/sign-in",
  "/about",
  "/help",
  "/search",
];

/**
 * Private-ish routes DELIBERATELY left ungated (see the exclusion notes on
 * `PRIVATE_ROUTE_PREFIXES`): `/my-rsvps` renders an intentional signed-out
 * promo rather than a dead-end card, so redirecting away would delete designed
 * UX. If you gate one of these on purpose, move it into the gate's array —
 * this list is here so it can't happen by accident.
 */
export const INTENTIONALLY_UNGATED_ROUTES: string[] = [
  // NOTE: /my-tickets moved OUT of this list on 2026-08-25 — it is gated now.
  // It was never actually reachable signed-out (AppAuthGate bounced it
  // client-side); the gate just makes that bounce a 307 instead of a 114KB
  // download. See private-route-gate.ts for the measurement.
  //
  // NOTE: /saved moved OUT on 2026-08-31 — the watchlist folded into
  // /my-tickets and /saved is now a `redirect()` stub, so it no longer returns
  // 200. Its own assertion is the `redirects /saved` test below.
  "/my-rsvps",
  // Same signed-out promo pattern as /my-rsvps (`my-lineups-signed-out`).
  "/my-lineups",
];

type RawResponse = {
  status: number;
  location: string | null;
  body: string;
};

/**
 * Fetches WITHOUT following redirects and without any cookie jar, so the
 * assertion is about the raw HTTP response and cannot be contaminated by
 * Playwright's storage state. `redirect: "manual"` is used instead of
 * Playwright's `maxRedirects: 0` because the latter's throw-vs-return
 * behaviour on an exceeded limit has changed across versions.
 */
const fetchRaw = async (baseURL: string, path: string): Promise<RawResponse> => {
  const res = await fetch(new URL(path, baseURL), {
    redirect: "manual",
    headers: { accept: "text/html" },
  });
  return {
    status: res.status,
    location: res.headers.get("location"),
    body: await res.text(),
  };
};

const requireBaseURL = (baseURL: string | undefined): string => {
  if (!baseURL) throw new Error("baseURL is not configured for this project");
  return baseURL;
};

test.describe("private route gate", () => {
  for (const route of PRIVATE_ROUTES) {
    test(`redirects an unauthenticated request for ${route} to /sign-in`, async ({
      baseURL,
    }) => {
      const res = await fetchRaw(requireBaseURL(baseURL), route);

      // The regression was a 200. Assert the absence of that specifically,
      // and that the response isn't a rendered document either way.
      expect(res.status, `${route} must not render for a guest`).not.toBe(200);
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      expect(res.body).not.toContain("<html");

      const location = new URL(
        res.location ?? "",
        requireBaseURL(baseURL),
      );
      expect(location.pathname).toBe("/sign-in");

      // And it must carry the redirect-back param, in the shape
      // `readRedirectParam` (apps/web/src/lib/redirect.ts) consumes.
      expect(location.searchParams.get("redirect_url")).toBe(route);
    });
  }

  for (const route of PUBLIC_ROUTES) {
    test(`leaves the public route ${route} reachable`, async ({ baseURL }) => {
      const res = await fetchRaw(requireBaseURL(baseURL), route);

      expect(res.status, `${route} must stay public`).toBe(200);
      expect(res.body).toContain("<html");
    });
  }

  for (const route of INTENTIONALLY_UNGATED_ROUTES) {
    test(`leaves ${route} ungated (deliberate — see spec notes)`, async ({
      baseURL,
    }) => {
      const res = await fetchRaw(requireBaseURL(baseURL), route);

      expect(res.status).toBe(200);
    });
  }

  test("redirects /saved to /my-tickets (the watchlist merged 2026-08-31)", async ({
    baseURL,
  }) => {
    // Bookmarks, the navbar heart, the home SavedStrip's "View all" and two
    // help-centre articles still point at /saved. It must never 404 or 200 —
    // it is a redirect stub onto the merged page.
    const res = await fetchRaw(requireBaseURL(baseURL), "/saved");

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);

    const location = new URL(res.location ?? "", requireBaseURL(baseURL));
    expect(location.pathname).toBe("/my-tickets");
  });

  test("a real browser navigation lands on /sign-in with the redirect-back param", async ({
    page,
    baseURL,
  }) => {
    // The transport-level checks above prove the 3xx. This proves the whole
    // round trip survives a browser: the redirect is followed, the sign-in
    // page renders, and the destination is still in the URL for the
    // post-sign-in `router.replace` to use.
    await page.goto("/account/settings");

    const url = new URL(page.url(), requireBaseURL(baseURL));
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("redirect_url")).toBe("/account/settings");
  });

  test("preserves the query string of the original destination", async ({
    baseURL,
  }) => {
    // /account/settings reads `redirect_url` itself to render its "return to"
    // banner, so a gate that dropped the search string would silently lose the
    // user's actual destination.
    const res = await fetchRaw(
      requireBaseURL(baseURL),
      "/account/settings?redirect_url=%2Fadmin%2Facme",
    );

    const location = new URL(res.location ?? "", requireBaseURL(baseURL));
    expect(location.searchParams.get("redirect_url")).toBe(
      "/account/settings?redirect_url=%2Fadmin%2Facme",
    );
  });
});
