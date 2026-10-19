import { describe, expect, it } from "vitest";

import {
  RESET_SWEEP_OPTIONS,
  sweepAuthUserPatch,
} from "../src/auth/account-security";

// What `sweepUnprovenAccountInDb` writes to the AuthUser row. The first-sign-in
// stamp goes ONLY when the sweep also deletes the sessions.
describe("sweepAuthUserPatch", () => {
  it("password reset (RESET_SWEEP_OPTIONS, keeps sessions) keeps the first-sign-in stamp", () => {
    const patch = sweepAuthUserPatch(RESET_SWEEP_OPTIONS);
    expect(patch).toEqual({
      phoneNumber: null,
      phoneNumberVerified: false,
      twoFactorEnabled: false,
    });
    expect("firstSignedInAt" in patch).toBe(false);
  });

  it("email-code / OAuth proof (sessions deleted) clears the first-sign-in stamp", () => {
    // The `revokeAll` call in better-auth.ts (unproven credential sweep).
    const patch = sweepAuthUserPatch({
      keepCredentialAndSessions: false,
      markEmailVerified: false,
    });
    expect(patch).toEqual({
      phoneNumber: null,
      phoneNumberVerified: false,
      twoFactorEnabled: false,
      firstSignedInAt: null,
    });
  });

  it("an inbox proof that also marks the email verified clears the stamp and verifies", () => {
    expect(
      sweepAuthUserPatch({
        keepCredentialAndSessions: false,
        markEmailVerified: true,
      }),
    ).toEqual({
      phoneNumber: null,
      phoneNumberVerified: false,
      twoFactorEnabled: false,
      firstSignedInAt: null,
      emailVerified: true,
    });
  });

  it("keeping sessions never clears the stamp, even when verifying", () => {
    const patch = sweepAuthUserPatch({
      keepCredentialAndSessions: true,
      markEmailVerified: true,
    });
    expect("firstSignedInAt" in patch).toBe(false);
    expect(patch.emailVerified).toBe(true);
  });

  it("keeps the payload's key order (byte-for-byte with the pre-extraction inline object)", () => {
    expect(
      Object.keys(
        sweepAuthUserPatch({
          keepCredentialAndSessions: false,
          markEmailVerified: true,
        }),
      ),
    ).toEqual([
      "phoneNumber",
      "phoneNumberVerified",
      "twoFactorEnabled",
      "firstSignedInAt",
      "emailVerified",
    ]);
  });
});
