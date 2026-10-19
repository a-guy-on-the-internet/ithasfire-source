import { expect, test } from "./fixtures";

import { resetE2eState } from "./helpers/e2e-reset";
import {
  createMailpitClient,
  extractOtpFromMailpitMessage,
} from "./helpers/mailpit";

const apiBaseUrl =
  process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3001";

function uniqueEmail(prefix = "playwright-verify"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

test.describe("Email verification (API-driven, OTP)", () => {
  test("sign up via API -> OTP email sent -> POST verify -> verified", async ({
    page,
  }) => {
    const email = uniqueEmail();
    const password = "Test-Account-2026!";

    const mailpit = createMailpitClient({ request: page.request });

    // Make the environment deterministic.
    await resetE2eState(page.request, apiBaseUrl);
    await mailpit.ready();
    await mailpit.clear();

    // 1) Sign up via Better Auth API.
    // Better Auth rejects requests that don't provide a trusted Origin.
    const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
    const apiOrigin = apiBaseUrl.replace(/\/+$/, "");
    const signUpRes = await page.request.post(
      `${apiOrigin}/api/auth/sign-up/email`,
      {
        headers: { "content-type": "application/json", origin },
        data: { name: "Playwright Verify", email, password },
      },
    );
    expect(signUpRes.ok(), await signUpRes.text()).toBeTruthy();

    // 2) Assert an OTP email was delivered.
    const message = await mailpit.waitForEmailTo(email);
    expect(message.Subject ?? "").toMatch(/verification|code/i);

    // 3) Extract the 6-digit OTP from the email body and POST it to the
    // emailOTP verify endpoint. This replaces the old click-the-link flow.
    const otp = extractOtpFromMailpitMessage(message);
    expect(otp).toMatch(/^\d{6}$/);

    const verifyRes = await page.request.post(
      `${apiOrigin}/api/auth/email-otp/verify-email`,
      {
        headers: { "content-type": "application/json", origin },
        data: { email, otp },
      },
    );
    expect(verifyRes.ok(), await verifyRes.text()).toBeTruthy();
  });
});
