import { describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";

import { createPhoneVerificationOptInHook } from "../src/auth/phone-verification-opt-in";

function makeLogger() {
  return {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(
      async (_name: string, fn: () => Promise<unknown>) => await fn(),
    ),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const PHONE = "+16155550100";

describe("phoneNumber.callbackOnVerification (SMS opt-in hook)", () => {
  it("records the opt-in with source phone_verification and reports nothing", async () => {
    const recordSmsOptIn = vi.fn(async () => ({ status: "OPTED_IN" }));
    const reportError = vi.fn();
    const hook = createPhoneVerificationOptInHook({
      recordSmsOptIn,
      logger: makeLogger() as unknown as LoggerPort,
      reportError,
    });

    await hook({ phoneNumber: PHONE });

    expect(recordSmsOptIn).toHaveBeenCalledWith({
      phoneNumber: PHONE,
      source: "phone_verification",
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a failed ledger write is reported once, tagged, without the number, and does not throw", async () => {
    // A Prisma validation error prints its call arguments, the number among them.
    const boom = new Error(
      'Invalid `smsConsent.upsert()` invocation: { phoneE164: "+16155550100" }',
    );
    const logger = makeLogger();
    const reportError = vi.fn();
    const hook = createPhoneVerificationOptInHook({
      recordSmsOptIn: vi.fn(async () => {
        throw boom;
      }),
      logger: logger as unknown as LoggerPort,
      reportError,
    });

    await expect(hook({ phoneNumber: PHONE })).resolves.toBeUndefined();

    expect(reportError).toHaveBeenCalledTimes(1);
    const reported = reportError.mock.calls[0]![0] as Error;
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toContain("smsConsent.upsert");
    expect(reported.message).not.toContain("5550100");
    expect(reported.stack ?? "").not.toContain("5550100");
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { hook: "phoneNumber.callbackOnVerification", swallowed: "true" },
      extra: { phoneNumberLast4: "0100" },
    });
    expect(JSON.stringify(reportError.mock.calls[0]![1])).not.toContain(
      "5550100",
    );
    // The log line is kept, also without the number.
    expect(logger.warn).toHaveBeenCalledWith(
      "phone_verification_sms_opt_in_failed",
      expect.anything(),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("5550100");
  });

  it("a throwing reporter changes nothing: still no throw", async () => {
    const hook = createPhoneVerificationOptInHook({
      recordSmsOptIn: vi.fn(async () => {
        throw new Error("db down");
      }),
      logger: makeLogger() as unknown as LoggerPort,
      reportError: () => {
        throw new Error("sentry down");
      },
    });

    await expect(hook({ phoneNumber: PHONE })).resolves.toBeUndefined();
  });
});
