import { expect, test } from "./fixtures";

import { resetE2eState } from "./helpers/e2e-reset";
import {
  createMailpitClient,
  extractOtpFromMailpitMessage,
} from "./helpers/mailpit";

const apiBaseUrl =
  process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3001";

function uniqueEmail(prefix = "playwright-verify-ui"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

test.describe("Email verification (UI-driven, OTP)", () => {
  test("sign up via UI -> OTP email sent -> type code -> verified", async ({
    page,
  }) => {
    const email = uniqueEmail();
    const password = "Test-Account-2026!";

    const mailpit = createMailpitClient({ request: page.request });

    // Clean slate.
    await resetE2eState(page.request, apiBaseUrl);
    await mailpit.ready();
    await mailpit.clear();

    // Open auth UI.
    await page.goto("/");
    const navbarAccount = page.getByTestId("navbar-account");
    await expect(navbarAccount).toBeVisible();
    await navbarAccount.click();

    // Switch to sign-up.
    const createAccount = page.getByTestId("auth-sign-in-create-account");
    await expect(createAccount).toBeVisible();
    await createAccount.click();

    const signUpForm = page.getByTestId("auth-sign-up-form");
    try {
      await expect(signUpForm).toBeVisible();
    } catch {
      // Occasionally the first click is swallowed during hydration/overlay animation.
      await createAccount.click();
      await expect(signUpForm).toBeVisible();
    }

    // Step 1 of 4 is email + password only; identity is asked on step 4.
    await signUpForm.getByTestId("auth-sign-up-email").fill(email);
    await signUpForm.getByTestId("auth-sign-up-password").fill(password);

    await signUpForm.getByTestId("auth-sign-up-submit").click();

    // 1) Verify-email card should appear with an OTP input.
    const otpInput = page.getByTestId("auth-verify-email-otp");
    await expect(otpInput).toBeVisible();

    // 2) Wait for the OTP email and read the code out of it.
    const message = await mailpit.waitForEmailTo(email);
    expect(message.Subject ?? "").toMatch(/verification|code/i);
    const otp = extractOtpFromMailpitMessage(message);
    expect(otp).toMatch(/^\d{6}$/);

    // 3) Type the code into the field. The card auto-submits on the
    // 6th digit so no explicit submit is required.
    await otpInput.fill(otp);

    // 4) The card flips to its verified-state panel before advancing.
    await expect(page.getByText(/email verified/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
