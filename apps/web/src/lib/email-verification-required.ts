/**
 * The B2 own-orders gate (owner ruling 2026-10-16): an account whose email is
 * not verified sees and acts on none of the orders, tickets, listings, claims,
 * credits, reviews or coordinator seats attached to that address until it
 * proves the inbox. The server refuses with tRPC FORBIDDEN and the message
 * `email_verification_required` (`requireVerifiedEmail` in
 * packages/transport/trpc/src/verified-email.ts; `ensureEmailVerified` in
 * core). That is not a failure a retry can fix, so every page that calls a
 * gated procedure swaps its error state for `EmailVerificationRequired`.
 *
 * Detection lives here and only here.
 */

const EMAIL_VERIFICATION_REQUIRED = "email_verification_required";

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;

/**
 * True when `error` is the server's "verify your email first" refusal: a
 * `TRPCClientError` (message, or a future structured `data.appCode`), or the
 * raw `{ code, message }` shape a use case throws.
 */
export function isEmailVerificationRequired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    message?: unknown;
    data?: { appCode?: unknown } | null;
    shape?: { message?: unknown } | null;
  };
  return [e.message, e.data?.appCode, e.shape?.message].some(
    (candidate) => readString(candidate) === EMAIL_VERIFICATION_REQUIRED,
  );
}

/** Any of several query/mutation errors is the gate. */
export function anyEmailVerificationRequired(
  ...errors: readonly unknown[]
): boolean {
  return errors.some(isEmailVerificationRequired);
}

const VERIFY_CURRENT_EMAIL_FIRST = "verify_current_email_first";

/**
 * True when an email change was refused because the account must verify the
 * address it holds first. Two server paths say it:
 *  - `POST /api/account/email-change/request` answers 403
 *    `{ error: "verify_current_email_first" }` (surfaced by
 *    `requestEmailChangeCode` as `err.code`);
 *  - Better Auth's `/email-otp/change-email` hook answers
 *    `{ code: "VERIFY_CURRENT_EMAIL_FIRST" }` on `result.error`.
 */
export function isVerifyCurrentEmailFirst(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; error?: unknown; message?: unknown };
  return [e.code, e.error, e.message].some(
    (candidate) => readString(candidate) === VERIFY_CURRENT_EMAIL_FIRST,
  );
}
