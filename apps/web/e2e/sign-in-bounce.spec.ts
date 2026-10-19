import { expect, test } from "./fixtures";

/**
 * Regression: `/sign-in` wedged on a permanently blank page with no way out.
 *
 * The production shape, precisely — it matters, because the previous version of
 * this spec asserted behaviour the fix deliberately does NOT have:
 *
 *  1. Prod set `SESSION_COOKIE_DOMAIN=.ithasfire.com`, so the API now issues
 *     `Domain=.ithasfire.com` session cookies.
 *  2. Anyone who signed in BEFORE that deploy still holds a HOST-ONLY cookie of
 *     the same name, bound to `api.ithasfire.com`. RFC 6265 keys the jar on
 *     (name, domain, path) with host-only part of the domain key, so it is a
 *     distinct entry: sent to the api host, never to the apex.
 *  3. Middleware reads the APEX cookie header, sees no session, fails closed →
 *     a real `307 → /sign-in`.
 *  4. The page's `authClient.useSession()` is a BROWSER call to the api host,
 *     which DOES get the ghost cookie → valid session → it redirects →
 *     middleware bounces → same route segment, state preserved, `redirecting`
 *     latched, render `null`. Forever.
 *
 * So the client sees a session and the server does not, at the same instant.
 * This spec recreates exactly that without touching cookie state: `/get-session`
 * is stubbed to succeed (browser → api host works) while the gated route is
 * stubbed to 307 back (server → apex fails). Fully hermetic — neither the
 * database nor the API is involved.
 *
 * What is asserted is what the fix actually guarantees:
 *   - the page recovers into a USABLE form instead of staying blank,
 *   - the URL is still `/sign-in` (i.e. we really are in the bounce, not a
 *     successful navigation),
 *   - the user gets an EXPLANATION, and specifically the "couldn't verify"
 *     one rather than "expired" — the re-check confirms this session, because
 *     it is the same browser → same host call that succeeded a moment ago,
 *   - and NOTHING was signed out.
 *
 * That last one is the assertion worth having. `signOut()` was in this
 * component twice and was wrong both times; the second time is not fixable
 * from the client, because `customSession(...)` swallows internal failures into
 * `200 + null`, byte-identical to a genuine sign-out. The invariant is now
 * structural — "no path in this component may destroy a session" — and this is
 * its end-to-end guard.
 *
 * Run against an already-running dev stack with:
 *   E2E_USE_LIVE_STACK=1 pnpm exec playwright test e2e/sign-in-bounce.spec.ts \
 *     --project=guest --reporter=list
 */

const DESTINATION = "/admin/@bounce-probe";
const SIGN_IN_URL = `/sign-in?redirect_url=${encodeURIComponent(DESTINATION)}`;

// The page waits BOUNCE_DETECT_MS (9s) before it stops believing the
// navigation is in flight. Deliberately generous rather than tight: the
// timeout is a UX bound, not a correctness one, and pinning the test to the
// exact constant would make a future adjustment read as a regression.
const RECOVERY_TIMEOUT_MS = 20_000;

const CORS = (origin: string) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-credentials": "true",
});

test("recovers from a sign-in redirect that bounces back", async ({ page }) => {
  const origin = "http://localhost:3000";
  const signOutCalls: string[] = [];
  const gatedRouteHits: string[] = [];

  // ── The client CAN see a session ──────────────────────────────────────
  // This stub stands in for the ghost cookie: browser → api host, so it is
  // sent, and the session resolves. Note it also serves the page's post-bounce
  // re-check, which is correct — that re-check is the same call to the same
  // host and in production it succeeds too. That is precisely why the notice
  // shown here must be the "couldn't verify" one.
  await page.route("**/api/auth/get-session**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", ...CORS(origin) },
      body: JSON.stringify({
        session: {
          id: "ghost-session",
          userId: "ghost-user",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        user: {
          id: "ghost-user",
          email: "ghost@example.com",
          name: "Ghost",
          emailVerified: true,
        },
      }),
    });
  });

  // The client tRPC link mints a short-lived JWT per batch from Better Auth's
  // `GET /api/auth/token` (see `src/trpc.ts`). Because the session above is
  // stubbed, the REAL api has no matching session record and answers 401 —
  // which surfaces as a console error and trips the `fixtures.ts` gate. That
  // 401 is an artifact of stubbing, not the behaviour under test: in the
  // production wedge the ghost cookie IS valid at the api host, so this mint
  // succeeds. Stub it so the fake session is internally consistent and the
  // console-error gate stays honest for everything else.
  await page.route("**/api/auth/token**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", ...CORS(origin) },
      body: JSON.stringify({ token: "e2e-stub-token" }),
    });
  });

  // Recorded, never expected. Fulfilled rather than aborted so that a
  // regression fails on the COUNT assertion below with a clear message,
  // instead of on some downstream network error that buries the cause.
  await page.route("**/api/auth/sign-out**", async (route) => {
    signOutCalls.push(route.request().url());
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", ...CORS(origin) },
      body: JSON.stringify({ success: true }),
    });
  });

  // ── The server CANNOT ─────────────────────────────────────────────────
  // Every hit on the gated route 307s back to /sign-in, standing in for
  // `staff-route-gate` failing closed on an apex request with no session
  // cookie.
  await page.route("**/admin/**", async (route) => {
    gatedRouteHits.push(route.request().url());
    await route.fulfill({
      status: 307,
      headers: { location: SIGN_IN_URL },
      body: "",
    });
  });

  await page.goto(SIGN_IN_URL);

  // Phase 1 — the page believes the redirect is in flight, so it renders
  // nothing. This is the state that used to be terminal.
  await expect(page.getByLabel(/email|password/i).first()).toBeHidden({
    timeout: 1_500,
  });

  // Phase 2 — the bounce really happened: the destination was requested and
  // sent us straight back. Without this, phase 3 could pass on a page that
  // simply never navigated.
  await expect
    .poll(() => gatedRouteHits.length, { timeout: RECOVERY_TIMEOUT_MS })
    .toBeGreaterThan(0);

  // Phase 3 — recovery. A usable form, not a blank page.
  //
  // `/sign-in` now opens on step 1 (`ACCESS · 01`): the identifier field is
  // visible immediately, with `CONTINUE` as the card's one accent fill and
  // passkey / Google / Apple as peers under an `OR` rule. There is no
  // disclosure to expand — the collapsed "Use password instead" expander this
  // block used to open is gone, and with it the class of failure where a
  // `fill()` on an inert field silently no-ops and reads back "".
  //
  // The password field is NOT on this step, so "the form came back" is
  // asserted on step 1's own controls.
  const emailField = page.getByTestId("auth-sign-in-email");
  await expect(emailField).toBeVisible({ timeout: RECOVERY_TIMEOUT_MS });
  await expect(page.getByTestId("auth-sign-in-continue")).toBeVisible();

  // Passkey survives the demotion from the page's accent CTA to an ink-outline
  // peer, so it is still asserted — it is the fastest path for anyone enrolled.
  // By test id, not by name: the label is now just "Passkey".
  await expect(page.getByTestId("auth-sign-in-passkey")).toBeVisible({
    timeout: RECOVERY_TIMEOUT_MS,
  });

  // …and an explanation. The re-check confirms the session (same browser,
  // same host), so this is the `sessionConfirmed` branch: "couldn't verify",
  // NOT "expired". Nothing expired — the session simply isn't usable at the
  // destination.
  await expect(
    page.getByText(/couldn.t verify your session for this page/i),
  ).toBeVisible({ timeout: RECOVERY_TIMEOUT_MS });
  await expect(page.getByText(/previous session has expired/i)).toBeHidden();

  // Phase 4 — we are still on /sign-in, i.e. genuinely bounced.
  expect(new URL(page.url()).pathname).toBe("/sign-in");

  // Phase 5 — THE INVARIANT. The page may not destroy a session on any path.
  // `authClient.signOut()` was removed deliberately and must stay removed:
  // reaching this state requires `useSession()` to have just succeeded, so a
  // sign-out here is overwhelmingly a false positive on a working login.
  expect(
    signOutCalls,
    "the sign-in page must never sign anybody out — see the INVARIANT block in page.tsx",
  ).toHaveLength(0);

  // The form has to actually work, not merely be present.
  await emailField.fill("someone@example.com");
  await expect(emailField).toHaveValue("someone@example.com");

  // Zero console errors is enforced automatically by the `test` fixture
  // (e2e/fixtures.ts) — including any hydration failure on this route.
});
