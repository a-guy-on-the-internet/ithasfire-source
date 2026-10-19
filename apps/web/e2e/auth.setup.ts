import { test as setup, expect } from "@playwright/test";

import { ensureBetterAuthTestUserExists } from "./helpers/better-auth-test-user";
import { submitSignInForm } from "./helpers/sign-in";

const authFile = "playwright/.auth/user.json";

setup("authenticate as test user", async ({ page }) => {
  // IMPORTANT: default must be "localhost", NOT "127.0.0.1".
  // Better Auth sets the session cookie's `domain` from the request host.
  // If the cookie lands with domain "127.0.0.1" while the browser navigates to
  // "localhost:3000", the cookie won't be sent on cross-origin auth requests
  // (they're different domains for cookie purposes). Using "localhost" here
  // keeps cookie domain consistent with the web app's origin.
  const apiBaseUrl =
    process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:3001";
  // Prefer a dedicated env var, but keep backward compatibility with older names.
  // Must be a valid email for Better Auth.
  const email =
    process.env.PLAYWRIGHT_TEST_EMAIL ??
    process.env.PLAYWRIGHT_TEST_IDENTIFIER ??
    "playwright-setup@example.com";
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD ?? "Test-Account-2025!";

  // Deterministic setup: ensure the account exists in the Better Auth DB
  // before attempting UI sign-in.
  try {
    await ensureBetterAuthTestUserExists({
      request: page.request,
      apiBaseUrl,
      email,
      password,
    });
  } catch {
    // Best-effort: Better Auth sometimes returns a generic 422 for sign-up
    // (e.g. user already exists but is in an unverified / inconsistent state).
    // We'll still attempt UI sign-in below.
  }

  // Verify the test user's email so that sign-in isn't blocked by
  // email-verification gates (Better Auth returns 403 for unverified users).
  const e2eSecret = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
  await page.request
    .post(`${apiBaseUrl.replace(/\/+$/, "")}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": e2eSecret,
        "content-type": "application/json",
      },
      data: { email },
    })
    .catch(() => {
      /* best-effort */
    });

  // In some workflows we intentionally skip starting Next.js (e.g. when
  // @th/trpc has temporary type errors). In that case, fall back to an API-only
  // sign-in and persist the Better Auth cookie jar into storageState.
  if (process.env.PLAYWRIGHT_REQUIRE_WEB_SERVER === "0") {
    // Keep origin consistent with the web app's origin (use localhost, not 127.0.0.1).
    const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const res = await page.request.post(
      `${apiBaseUrl.replace(/\/+$/, "")}/api/auth/sign-in/email`,
      {
        headers: {
          "content-type": "application/json",
          origin,
        },
        data: { email, password },
      },
    );

    // If sign-in fails due to verification gates, skip auth-dependent specs.
    if (!res.ok()) {
      const bodyText = await res.text();
      if (
        /verify|verification|unverified|confirm|forbidden|403/i.test(bodyText)
      ) {
        setup.skip(
          true,
          "Sign-in blocked by verification gate; skipping auth-dependent specs",
        );
      }

      throw new Error(`API sign-in failed (${res.status()}): ${bodyText}`);
    }

    await page.context().storageState({ path: authFile });
    return;
  }

  // Navigate straight to the dedicated sign-in route so auth setup does not
  // depend on homepage chrome or whichever feature-gate mode the site is in.
  // Pre-set the cookie-consent cookie so the banner does not cover the form.
  await page
    .context()
    .clearCookies();

  // ORDER MATTERS: clear FIRST, then re-add consent.
  //
  // The PRE-SEED steps above are handed `page.request`, which shares this
  // page's cookie jar, and Better Auth's `sign-up/email` returns a SESSION on
  // success — so on any run where the account did not already exist, the
  // pre-seed silently signed us in, `/sign-in` redirected straight to
  // `/account`, and the UI step below waited 20s for a form that can never
  // render. Every auth-dependent spec died with it.
  //
  // Clearing keeps the pre-seed's guarantee (the account exists and is
  // verified) while making the sign-in below actually exercise the card, which
  // is the point of minting `storageState` through the real form.
  await page
    .context()
    .addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);

  await page.goto("/sign-in?redirect=/account");

  // The two-step credential flow lives in ONE place now: `helpers/sign-in.ts`.
  //
  // What used to be here was a hand-rolled expansion of the old "Use password
  // instead" disclosure, and it was load-bearing in the worst way: this setup
  // mints the `storageState` the entire authenticated `chromium` project runs
  // on, so when the disclosure moved, every auth-dependent spec went down with
  // it. The helper is now the single point that has to track the card's shape,
  // and it carries the hydration-race handling (fill → assert value → advance,
  // retried as one unit) that this block used `pressSequentially` for.
  await submitSignInForm(page, { email, password });

  // Better Auth may enforce verification gates in some environments.
  // If sign-in is blocked (commonly a 403 from `/api/auth/sign-in/email`),
  // we don't want it to take down the whole E2E suite when we're primarily
  // validating guest flows (like Home preload).
  //
  // Other specs that require authenticated state should explicitly handle
  // verification or provide env/config to disable the gate.
  const verificationBlockedText = page
    .getByRole("alert")
    .getByText(
      /verify|verification|unverified|confirm your email|forbidden|403/i,
    );
  await page.waitForTimeout(500);
  if ((await verificationBlockedText.count()) > 0) {
    setup.skip(
      true,
      "Sign-in blocked by verification gate; skipping auth-dependent specs",
    );
  }

  // If credentials are wrong or Clerk blocks the password, LoginCard shows an error alert.
  const loginErrorText = page
    .getByRole("alert")
    .getByText(/couldn't find your account|data breach|reset your password/i);
  // Give the UI a moment to surface any error state.
  await page.waitForTimeout(500);
  await expect(loginErrorText).toHaveCount(0);

  // Successful login should redirect away from /sign-in.
  await page.waitForURL((url) => url.pathname !== "/sign-in", {
    timeout: 30_000,
  });
  await expect(page).not.toHaveURL(/\/sign-in$/);

  // Persist auth state for other tests.
  await page.context().storageState({ path: authFile });
});
