import { expect, type APIRequestContext } from "@playwright/test";

import { createMailpitClient, extractOtpFromMailpitMessage } from "./mailpit";

/**
 * Run the post-signup email-verification dance via the OTP endpoint.
 *
 * Replaces the older "click the verification link in Mailpit" pattern. Specs
 * that previously did:
 *
 *   const verificationEmail = await mailpit.waitForEmailTo(email);
 *   const verificationUrl = extractFirstUrlFromMailpitMessage(verificationEmail);
 *   await page.goto(verificationUrl);
 *
 * should now do:
 *
 *   await verifySignUpOtp({ request, apiBaseUrl, email });
 *
 * Returns the OTP that was verified, useful for assertions if a spec wants
 * to double-check it was a 6-digit code.
 */
export async function verifySignUpOtp({
  request,
  apiBaseUrl,
  email,
  webOrigin,
}: {
  request: APIRequestContext;
  apiBaseUrl: string;
  email: string;
  /** Trusted origin for Better Auth's CSRF check; defaults to PLAYWRIGHT_BASE_URL. */
  webOrigin?: string;
}): Promise<{ otp: string }> {
  const mailpit = createMailpitClient({ request });
  const message = await mailpit.waitForEmailTo(email);
  const otp = extractOtpFromMailpitMessage(message);
  expect(otp, "expected 6-digit verification OTP in email").toMatch(/^\d{6}$/);

  const apiOrigin = apiBaseUrl.replace(/\/+$/, "");
  const origin =
    webOrigin ?? process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
  const res = await request.post(
    `${apiOrigin}/api/auth/email-otp/verify-email`,
    {
      headers: { "content-type": "application/json", origin },
      data: { email, otp },
    },
  );
  expect(
    res.ok(),
    `email-otp verify-email failed: ${await res.text()}`,
  ).toBeTruthy();

  return { otp };
}
