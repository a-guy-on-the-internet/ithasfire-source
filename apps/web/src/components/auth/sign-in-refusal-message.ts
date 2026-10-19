/**
 * The translated copy for a sign-in the API refused for want of a second
 * factor, answered as JSON on the password and email-code forms
 * (`apps/api/src/auth/second-factor-bypass.ts`). Null for any other error, so
 * the caller falls back to its usual formatting. The redirect routes carry
 * the same codes in `?error=` (`sign-in-error-notice.ts`).
 */
const REFUSAL_KEYS: Readonly<Record<string, string>> = {
  STAFF_ACCOUNT_USE_PASSKEY: "auth.staffUsePasskeySignIn",
  TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN: "auth.twoFactorUsePrimarySignIn",
};

const codeOf = (error: unknown): unknown => {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { code?: unknown; body?: { code?: unknown } | null };
  return e.code ?? e.body?.code;
};

export const signInRefusalMessage = (
  error: unknown,
  t: (key: string) => string,
): string | null => {
  const code = codeOf(error);
  if (typeof code !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(REFUSAL_KEYS, code)) return null;
  return t(REFUSAL_KEYS[code]!);
};
