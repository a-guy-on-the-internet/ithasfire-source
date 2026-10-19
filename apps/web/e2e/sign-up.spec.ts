import { expect, test } from "./fixtures";

test.describe("Sign up", () => {
  test("new user can sign up and establish a session", async ({ page }) => {
    test.skip(
      test.info().project.name !== "guest",
      "run this spec in the guest (unauthenticated) project",
    );

    // Debug guardrail: track if the UI double-submits sign-up.
    const signUpRequests: Array<{
      url: string;
      method: string;
      postData?: string | null;
    }> = [];
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      if (!req.url().includes("/api/auth/sign-up/email")) return;
      signUpRequests.push({
        url: req.url(),
        method: req.method(),
        postData: req.postData(),
      });
    });

    // This email is intentionally stable. Our E2E environment must be truly clean
    // between runs; using unique emails would mask DB reset/migration issues.
    // Must not collide with the Playwright auth setup user (playwright-test@example.com)
    // which is created in the [setup] project.
    const email = "playwright-signup-ui@example.com";
    const password =
      process.env.PLAYWRIGHT_TEST_PASSWORD ?? "Test-Account-2025!";

    // Start from home and open the account overlay.
    await page.goto("/");
    await page.getByTestId("navbar-account").click();

    // Switch to sign up.
    await page.getByTestId("auth-sign-in-create-account").click();

    const form = page.getByTestId("auth-sign-up-form");
    await expect(form).toBeVisible();

    // Step 1 of 4 is email + password only — display name and username moved
    // to the profile step, confirm-password was dropped. Fill by test id:
    // placeholders come from the i18n catalogs and are ordinal.
    await form.getByTestId("auth-sign-up-email").fill(email);
    await form.getByTestId("auth-sign-up-password").fill(password);

    await form.getByTestId("auth-sign-up-submit").click();

    // Wait until we see at least one sign-up POST.
    await expect
      .poll(() => signUpRequests.length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(1);

    // Next.js injects a hidden route announcer with role=alert.
    // Scope to the auth card and assert on the *error alert* we render.
    const card = page.getByTestId("auth-sign-up-card");
    const alert = card.getByRole("alert");
    try {
      // If an auth error is shown, this alert will have readable content.
      await expect(alert).toHaveCount(0);
    } catch (error) {
      const alertText =
        (await alert
          .first()
          .innerText()
          .catch(() => null)) ?? "";
      const alertHtml =
        (await alert
          .first()
          .evaluate((el) => el.outerHTML)
          .catch(() => null)) ?? "";

      await page.screenshot({
        path: "test-results/sign-up-alert-debug.png",
        fullPage: true,
      });

      console.error("[e2e] sign-up UI error alert text:", alertText.trim());
      console.error("[e2e] sign-up UI error alert html:", alertHtml);
      console.error(
        "[e2e] captured sign-up requests:",
        JSON.stringify(signUpRequests, null, 2),
      );
      throw error;
    }

    // Stronger invariant: the UI should only submit sign-up once.
    // If this fails, inspect signUpRequests[*].postData for duplicate emails.
    expect(signUpRequests.length).toBe(1);

    // Should land on a signed-in state eventually.
    await page.waitForLoadState("domcontentloaded");
    await expect(page).not.toHaveURL(/\/(sign-up|sign-in)$/);

    // Prove the session is real by navigating to a gated route.
    await page.goto("/admin/acme/events/new");
    await expect(page).not.toHaveURL(/\/(login|sign-in)$/);
  });
});
