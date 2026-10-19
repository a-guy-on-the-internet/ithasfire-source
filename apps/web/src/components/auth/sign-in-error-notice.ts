import type { StandaloneAuthSessionNotice } from "./StandaloneAuthPageShell";

/**
 * Maps `/sign-in`'s `?error=` value to a notice. Only the codes the API sends
 * on a refused sign-in are known (`secondFactorRefusalRedirect` in
 * `apps/api/src/auth/second-factor-bypass.ts`, `accountNotActiveRedirect` in
 * `apps/api/src/auth/account-security.ts`); anything else, including a value
 * someone typed into the URL, shows nothing. The raw value is never rendered.
 */
export const signInErrorNotice = (
  error: string | null | undefined,
): StandaloneAuthSessionNotice => {
  switch (error) {
    case "TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN":
      return "twoFactorUsePrimary";
    case "STAFF_ACCOUNT_USE_PASSKEY":
      return "staffUsePasskey";
    case "account_not_active":
      return "accountNotActive";
    default:
      return "none";
  }
};

