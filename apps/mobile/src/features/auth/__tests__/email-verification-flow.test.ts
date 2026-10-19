import { describe, expect, it, vi } from "vitest";
import { formatAuthErrorMessage } from "@th/errors";

import {
  INITIAL_VERIFY_FLOW,
  RESEND_COOLDOWN_MS,
  confirmVerificationCode,
  resendSecondsLeft,
  sanitizeOtp,
  sendVerificationCode,
  shouldSubmitCode,
  verifiedElsewhere,
  verifyFlowReducer,
  type EmailVerificationClient,
  type VerifyFlowAction,
  type VerifyFlowState,
} from "../email-verification-flow";

const EMAIL = "buyer@example.com";

const fakeClient = (
  overrides: Partial<EmailVerificationClient> = {},
): EmailVerificationClient => ({
  sendCode: vi.fn(async () => ({ error: null })),
  verifyCode: vi.fn(async () => ({ error: null })),
  refreshSession: vi.fn(async () => ({})),
  ...overrides,
});

const run = (actions: VerifyFlowAction[], from = INITIAL_VERIFY_FLOW) =>
  actions.reduce<VerifyFlowState>(verifyFlowReducer, from);

describe("sanitizeOtp", () => {
  it("keeps the first six digits only", () => {
    expect(sanitizeOtp(" 12-34 56 78")).toBe("123456");
    expect(sanitizeOtp("abc")).toBe("");
  });
});

describe("sendVerificationCode", () => {
  it("asks for an email-verification code for the account's address", async () => {
    const client = fakeClient();
    await expect(sendVerificationCode(client, EMAIL)).resolves.toEqual({
      ok: true,
    });
    expect(client.sendCode).toHaveBeenCalledWith(EMAIL);
  });

  it("returns a message when the send fails or throws", async () => {
    const failed = await sendVerificationCode(
      fakeClient({
        sendCode: async () => ({
          error: { code: "TOO_MANY_REQUESTS", message: "Too many requests", status: 429 },
        }),
      }),
      EMAIL,
    );
    expect(failed.ok).toBe(false);

    const thrown = await sendVerificationCode(
      fakeClient({
        sendCode: async () => {
          throw new Error("Network request failed");
        },
      }),
      EMAIL,
    );
    expect(thrown.ok).toBe(false);
  });
});

describe("confirmVerificationCode", () => {
  it("on a good code refreshes the session and refetches every query", async () => {
    const client = fakeClient();
    const invalidate = vi.fn(async () => undefined);

    const outcome = await confirmVerificationCode(client, {
      email: EMAIL,
      otp: "123456",
      invalidate,
    });

    expect(outcome).toEqual({ ok: true });
    expect(client.verifyCode).toHaveBeenCalledWith(EMAIL, "123456");
    expect(client.refreshSession).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("still refetches when the session refresh fails", async () => {
    // The server reads emailVerified from the database, so the gated reads
    // answer without a fresh session.
    const invalidate = vi.fn();
    const outcome = await confirmVerificationCode(
      fakeClient({
        refreshSession: async () => {
          throw new Error("offline");
        },
      }),
      { email: EMAIL, otp: "123456", invalidate },
    );
    expect(outcome.ok).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("on a wrong code says so and refetches nothing", async () => {
    const invalidate = vi.fn();
    const client = fakeClient({
      verifyCode: async () => ({
        error: { code: "INVALID_OTP", message: "Invalid OTP", status: 400 },
      }),
    });

    const outcome = await confirmVerificationCode(client, {
      email: EMAIL,
      otp: "000000",
      invalidate,
    });

    expect(outcome).toEqual({
      ok: false,
      message: "That code didn't match. Check it and try again.",
    });
    expect(client.refreshSession).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("names an expired code", async () => {
    const outcome = await confirmVerificationCode(
      fakeClient({
        verifyCode: async () => ({
          error: { code: "OTP_EXPIRED", message: "OTP expired", status: 400 },
        }),
      }),
      { email: EMAIL, otp: "123456", invalidate: vi.fn() },
    );
    expect(outcome).toEqual({
      ok: false,
      message: "That code has expired. Send a new one.",
    });
  });
});

describe("error messages", () => {
  const failWith = (error: { code?: string; message?: string; status?: number }) =>
    confirmVerificationCode(
      fakeClient({ verifyCode: async () => ({ error }) }),
      { email: EMAIL, otp: "123456", invalidate: vi.fn() },
    );

  it("names too many tries", async () => {
    await expect(
      failWith({ code: "TOO_MANY_ATTEMPTS", message: "Too many attempts", status: 403 }),
    ).resolves.toEqual({
      ok: false,
      message: "Too many tries with that code. Send a new one.",
    });
  });

  it("falls back to formatAuthErrorMessage for any other code", async () => {
    const error = { code: "INTERNAL_SERVER_ERROR", message: "Boom", status: 500 };
    const outcome = await failWith(error);
    expect(outcome).toEqual({ ok: false, message: formatAuthErrorMessage(error) });
    expect(outcome.ok === false && outcome.message.length > 0).toBe(true);
  });

  it("falls back for a thrown error too", async () => {
    const err = new Error("Network request failed");
    const outcome = await confirmVerificationCode(
      fakeClient({
        verifyCode: async () => {
          throw err;
        },
      }),
      { email: EMAIL, otp: "123456", invalidate: vi.fn() },
    );
    expect(outcome).toEqual({ ok: false, message: formatAuthErrorMessage(err) });
  });
});

describe("verifiedElsewhere", () => {
  const codeStep = run([{ type: "send-ok", at: 0 }]);

  it("fires when the session turns verified without this prompt's verify", () => {
    expect(verifiedElsewhere(false, true, INITIAL_VERIFY_FLOW)).toBe(true);
    expect(verifiedElsewhere(false, true, codeStep)).toBe(true);
  });

  it("stays quiet for this prompt's own verify (it invalidates itself)", () => {
    const submitting = run([{ type: "submit-start" }], codeStep);
    expect(verifiedElsewhere(false, true, submitting)).toBe(false);
    expect(verifiedElsewhere(false, true, run([{ type: "submit-ok" }], submitting))).toBe(
      false,
    );
  });

  it("fires only on the false → true edge", () => {
    expect(verifiedElsewhere(true, true, codeStep)).toBe(false);
    expect(verifiedElsewhere(false, false, codeStep)).toBe(false);
  });
});

describe("verifyFlowReducer", () => {
  it("bumps errorSeq on every failure, so a repeated message is announced again", () => {
    const twice = run([
      { type: "send-ok", at: 0 },
      { type: "submit-start" },
      { type: "submit-fail", message: "nope" },
      { type: "submit-start" },
      { type: "submit-fail", message: "nope" },
    ]);
    expect(twice.errorSeq).toBe(2);
  });

  it("a pasted code with a space survives (no maxLength cut before sanitize)", () => {
    expect(run([{ type: "code-change", raw: "123 456" }]).code).toBe("123456");
  });

  it("send → code step → six digits → verified", () => {
    const sent = run([{ type: "send-start" }, { type: "send-ok", at: 1_000 }]);
    expect(sent.phase).toBe("code");
    expect(sent.sentAt).toBe(1_000);
    expect(shouldSubmitCode(sent)).toBe(false);

    const typed = run([{ type: "code-change", raw: "123456" }], sent);
    expect(shouldSubmitCode(typed)).toBe(true);

    const submitting = run([{ type: "submit-start" }], typed);
    expect(shouldSubmitCode(submitting)).toBe(false);

    expect(run([{ type: "submit-ok" }], submitting).phase).toBe("verified");
  });

  it("a wrong code clears the field, so auto-submit cannot loop", () => {
    const failed = run([
      { type: "send-ok", at: 0 },
      { type: "code-change", raw: "000000" },
      { type: "submit-start" },
      { type: "submit-fail", message: "nope" },
    ]);
    expect(failed.phase).toBe("code");
    expect(failed.code).toBe("");
    expect(failed.error).toBe("nope");
    expect(shouldSubmitCode(failed)).toBe(false);
  });

  it("a failed first send stays on the button with the message", () => {
    const failed = run([
      { type: "send-start" },
      { type: "send-fail", message: "Try later" },
    ]);
    expect(failed.phase).toBe("idle");
    expect(failed.sending).toBe(false);
    expect(failed.error).toBe("Try later");
  });

  it("a resend clears the old code", () => {
    const resent = run([
      { type: "send-ok", at: 0 },
      { type: "code-change", raw: "12" },
      { type: "send-start" },
      { type: "send-ok", at: RESEND_COOLDOWN_MS },
    ]);
    expect(resent.code).toBe("");
    expect(resent.sentAt).toBe(RESEND_COOLDOWN_MS);
  });
});

describe("resendSecondsLeft", () => {
  it("counts down the minute after a send", () => {
    expect(resendSecondsLeft(null, 5_000)).toBe(0);
    expect(resendSecondsLeft(0, 0)).toBe(60);
    expect(resendSecondsLeft(0, 59_001)).toBe(1);
    expect(resendSecondsLeft(0, RESEND_COOLDOWN_MS)).toBe(0);
    // A clock one tick behind the send never reads more than a minute.
    expect(resendSecondsLeft(5_000, 1_000)).toBe(60);
  });
});
