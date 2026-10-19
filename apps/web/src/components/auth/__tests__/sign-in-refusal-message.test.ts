import { describe, expect, it } from "vitest";

import { signInRefusalMessage } from "../sign-in-refusal-message";

const t = (key: string) => `t:${key}`;

describe("signInRefusalMessage", () => {
  it.each([
    [{ code: "STAFF_ACCOUNT_USE_PASSKEY" }, "t:auth.staffUsePasskeySignIn"],
    [
      { code: "TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN" },
      "t:auth.twoFactorUsePrimarySignIn",
    ],
    // A thrown APIError-shaped value carries the code on its body.
    [{ body: { code: "STAFF_ACCOUNT_USE_PASSKEY" } }, "t:auth.staffUsePasskeySignIn"],
  ])("%o -> %s", (error, expected) => {
    expect(signInRefusalMessage(error, t)).toBe(expected);
  });

  it.each([
    [{ code: "INVALID_EMAIL_OR_PASSWORD" }],
    [{ code: "toString" }],
    [{ code: 42 }],
    ["STAFF_ACCOUNT_USE_PASSKEY"],
    [null],
    [undefined],
  ])("is null for %o", (error) => {
    expect(signInRefusalMessage(error, t)).toBeNull();
  });
});
