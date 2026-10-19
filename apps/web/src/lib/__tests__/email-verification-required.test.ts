import { describe, expect, it } from "vitest";

import {
  anyEmailVerificationRequired,
  isEmailVerificationRequired,
  isVerifyCurrentEmailFirst,
} from "../email-verification-required";

/**
 * What the wire actually carries for the B2 gate: `requireVerifiedEmail`
 * throws `{ code: "forbidden", message: "email_verification_required" }`,
 * `toTrpcError` keeps the message, and the errorFormatter's `appCode` is the
 * generic `FORBIDDEN` (the message is not a registry code). So the message is
 * the signal, and `appCode` alone must not be.
 */
const gateClientError = {
  name: "TRPCClientError",
  message: "email_verification_required",
  data: { code: "FORBIDDEN", httpStatus: 403, appCode: "FORBIDDEN" },
};

describe("isEmailVerificationRequired", () => {
  it("recognises the tRPC client error the gated procedures throw", () => {
    expect(isEmailVerificationRequired(gateClientError)).toBe(true);
  });

  it("recognises the raw use-case shape and an Error carrying the code", () => {
    expect(
      isEmailVerificationRequired({
        code: "forbidden",
        message: "email_verification_required",
      }),
    ).toBe(true);
    expect(
      isEmailVerificationRequired(new Error("email_verification_required")),
    ).toBe(true);
  });

  it("accepts a structured appCode should the server ever send one", () => {
    expect(
      isEmailVerificationRequired({
        message: "Verify first",
        data: { appCode: "EMAIL_VERIFICATION_REQUIRED" },
      }),
    ).toBe(true);
  });

  it("is false for every other FORBIDDEN, and for non-errors", () => {
    expect(
      isEmailVerificationRequired({
        message: "forbidden",
        data: { code: "FORBIDDEN", appCode: "FORBIDDEN" },
      }),
    ).toBe(false);
    expect(
      isEmailVerificationRequired({ message: "not_coordinator" }),
    ).toBe(false);
    expect(isEmailVerificationRequired(null)).toBe(false);
    expect(isEmailVerificationRequired(undefined)).toBe(false);
    expect(isEmailVerificationRequired("email_verification_required")).toBe(
      false,
    );
  });

  it("anyEmailVerificationRequired finds the gate among several errors", () => {
    expect(anyEmailVerificationRequired(null, gateClientError)).toBe(true);
    expect(anyEmailVerificationRequired(null, undefined)).toBe(false);
  });
});

describe("isVerifyCurrentEmailFirst", () => {
  it("recognises the email-change route's refusal (code on the thrown Error)", () => {
    const err = Object.assign(
      new Error("Verify your current email address before changing it."),
      { code: "verify_current_email_first" },
    );
    expect(isVerifyCurrentEmailFirst(err)).toBe(true);
  });

  it("recognises Better Auth's change-email hook refusal", () => {
    expect(
      isVerifyCurrentEmailFirst({
        code: "VERIFY_CURRENT_EMAIL_FIRST",
        message: "Verify your current email address before changing it.",
      }),
    ).toBe(true);
  });

  it("is false for other email-change failures", () => {
    expect(
      isVerifyCurrentEmailFirst(new Error("Could not send verification code.")),
    ).toBe(false);
    expect(isVerifyCurrentEmailFirst({ code: "INVALID_OTP" })).toBe(false);
    expect(isVerifyCurrentEmailFirst(null)).toBe(false);
  });
});
