/**
 * What an emailed verification code is for: better-auth's emailOTP `type`.
 * The `auth.verification_code` email template (`@th/ui-email` registry) words
 * the code by it; absent = sign-in.
 *
 * It lives here, not in `@th/ui-email`, so apps/api can check better-auth's
 * own union against it at compile time (`purpose: type satisfies
 * VerificationCodePurpose` in apps/api/src/auth/better-auth.ts): the mailer's
 * template variables are untyped, so without that check a new better-auth
 * OTP type would reach the template and fail its schema at send time.
 */
export const VERIFICATION_CODE_PURPOSES = [
  "sign-in",
  "email-verification",
  "forget-password",
  "change-email",
] as const;
export type VerificationCodePurpose = (typeof VERIFICATION_CODE_PURPOSES)[number];
