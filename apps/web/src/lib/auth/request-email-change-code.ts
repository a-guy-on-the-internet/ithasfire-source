import { publicRuntimeEnv } from "@/config/env.public";

/**
 * Step 1 of the VERIFIED email change: the API mails a 6-digit code to the
 * NEW address (`POST /api/account/email-change/request`). Step 2 is
 * `authClient.emailOtp.changeEmail({ newEmail, otp })`, which moves the
 * account to the new address and marks it verified only once the code from
 * that inbox is entered.
 *
 * Better Auth's own `/change-email` (which rewrote an unverified account's
 * address with no proof at all) is refused server-side since the 2026-09-29
 * security review, so every client-side email change goes through here.
 * Same endpoint `EmailSection` (account settings) uses.
 */
export async function requestEmailChangeCode(newEmail: string): Promise<void> {
  const apiBaseUrl = publicRuntimeEnv.apiBaseUrl ?? "http://localhost:3001";
  const response = await fetch(
    `${apiBaseUrl.replace(/\/+$/, "")}/api/account/email-change/request`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newEmail }),
    },
  );

  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    message?: string;
  } | null;

  if (!response.ok || body?.ok === false) {
    // `code` carries the route's machine-readable refusal (e.g.
    // `verify_current_email_first`, see `isVerifyCurrentEmailFirst`) so a
    // caller can answer it with its own copy instead of the English sentence.
    throw Object.assign(
      new Error(body?.message ?? "Could not send verification code."),
      typeof body?.error === "string" ? { code: body.error } : {},
    );
  }
}
