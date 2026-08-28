import { test as setup, expect } from "@playwright/test";

import { ensureBetterAuthTestUserExists } from "./helpers/better-auth-test-user";

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
    .addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);
  await page.goto("/sign-in?redirect=/account");

  // /sign-in is passkey-FIRST: the email+password form lives inside a
  // collapsed "Use password instead" disclosure (LoginCard.tsx — a
  // role="button" carrying aria-expanded, controlling #auth-sign-in-fallback,
  // whose collapsed state is `inert` with gridTemplateRows: 0fr). Until it is
  // expanded, `auth-sign-in-form` exists in the DOM but is not visible, so
  // waiting on it times out and takes the ENTIRE authenticated `chromium`
  // project down with it — every spec that depends on this setup.
  //
  // Expand it idempotently: only click when aria-expanded is not already true,
  // so this stays correct if the disclosure ever defaults to open (e.g. for an
  // account with no enrolled passkey — see the note at LoginCard.tsx:167).
  const passwordDisclosure = page.getByRole("button", {
    name: /use password instead/i,
  });
  // `waitFor`, NOT `isVisible()`. `isVisible()` is a point-in-time poll: on a
  // freshly-navigated page it returns false because the card has not painted
  // yet, which silently skips the expand and leaves the form inert — the fields
  // then accept no input and the submit stays aria-disabled. Auto-wait instead,
  // while still tolerating a page variant that has no disclosure at all (e.g.
  // an account with no passkey, where the password fields render directly).
  const hasDisclosure = await passwordDisclosure
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (
    hasDisclosure &&
    (await passwordDisclosure.getAttribute("aria-expanded")) !== "true"
  ) {
    await passwordDisclosure.click();
    await expect(passwordDisclosure).toHaveAttribute("aria-expanded", "true");
  }

  const form = page.getByTestId("auth-sign-in-form");
  await expect(form).toBeVisible();

  // Use the live accessible field labels on the dedicated sign-in page.
  const emailInput = form.getByLabel(/email or username/i);
  const passwordInput = form.getByLabel(/^password$/i);

  // `pressSequentially`, not `fill`, and `toBeEditable` before each.
  //
  // The submit button is gated on REACT state
  // (`canSubmit = Boolean(identifier.trim()) && password.length > 0`,
  // LoginCard.tsx:255). The disclosure we just opened animates
  // (gridTemplateRows 0fr→1fr) and is `inert` while collapsed, so a `fill()`
  // fired the moment `auth-sign-in-form` turns visible can set the DOM value
  // without React ever seeing the change — leaving `canSubmit` false and the
  // submit button aria-disabled forever. Real key events avoid that, and
  // `toBeEditable` waits out the inert window.
  await expect(emailInput).toBeEditable();
  await emailInput.pressSequentially(email, { delay: 10 });
  await expect(emailInput).toHaveValue(email);

  await expect(passwordInput).toBeEditable();
  await passwordInput.pressSequentially(password, { delay: 10 });
  await expect(passwordInput).toHaveValue(password);

  // Assert the button actually left its disabled state before clicking, so a
  // future regression in `canSubmit` fails HERE with a clear message instead of
  // as an opaque 15s click timeout.
  const submit = page.getByTestId("auth-sign-in-submit");
  await expect(submit).not.toHaveAttribute("aria-disabled", "true");
  await submit.click();

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
