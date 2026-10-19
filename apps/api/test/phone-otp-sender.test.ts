import { describe, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";

import {
  createPhoneOtpSender,
  SMS_NUMBER_NOT_SUPPORTED_CODE,
  SMS_RATE_LIMITED_CODE,
  SMS_UNAVAILABLE_CODE,
} from "../src/auth/otp-senders";
import { isSmsConfigured, smsCredentials } from "../src/lib/sms-capability";

/**
 * Prod has no AWS keys, so the API has no SMS adapter. The phone OTP sender
 * used to log a warn and return, and Better Auth answered "code sent" for a
 * text that never went out. It now refuses with a 503 the client can read.
 */
const productName = "Ithas Fire";
const makeLogger = () =>
  ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  }) as never;
const mailer = { send: vi.fn(async () => undefined) };
const input = { phoneNumber: "+15555550123", code: "739204" };

describe("createPhoneOtpSender — no SMS adapter", () => {
  it("throws a 503 SMS_UNAVAILABLE APIError instead of claiming a code was sent", async () => {
    const reportError = vi.fn();
    const sender = createPhoneOtpSender({
      mailer,
      logger: makeLogger(),
      productName,
      reportError,
    });

    const err = await sender(input).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(APIError);
    const apiError = err as APIError;
    expect(apiError.statusCode).toBe(503);
    expect(apiError.status).toBe("SERVICE_UNAVAILABLE");
    expect(apiError.body).toMatchObject({
      code: SMS_UNAVAILABLE_CODE,
      message: "Text messages aren't available yet.",
    });
  });

  it("does not report the refusal: it is expected, not a failure", async () => {
    const reportError = vi.fn();
    const sender = createPhoneOtpSender({
      mailer,
      logger: makeLogger(),
      productName,
      reportError,
    });

    await expect(sender(input)).rejects.toBeInstanceOf(APIError);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("createPhoneOtpSender — SMS adapter present", () => {
  it("sends the text and resolves", async () => {
    const sms = { send: vi.fn(async () => ({ messageId: "m1" })) };
    const reportError = vi.fn();
    const sender = createPhoneOtpSender({
      sms: sms as never,
      mailer,
      logger: makeLogger(),
      productName,
      reportError,
    });

    await expect(sender(input)).resolves.toBeUndefined();
    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a provider failure is reported once, tagged, then answers 503 SMS_UNAVAILABLE (never a false 'code sent')", async () => {
    const sms = {
      send: vi.fn(async () => {
        throw new Error("sns throttled");
      }),
    };
    const reportError = vi.fn();
    const sender = createPhoneOtpSender({
      sms: sms as never,
      mailer,
      logger: makeLogger(),
      productName,
      reportError,
    });

    const err = await sender(input).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(APIError);
    const apiError = err as APIError;
    expect(apiError.statusCode).toBe(503);
    expect(apiError.body).toMatchObject({ code: SMS_UNAVAILABLE_CODE });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][1]).toEqual({
      tags: { useCase: "auth.sendPhoneOtp", swallowed: "true" },
    });
    // No full number and no code in the report.
    expect(JSON.stringify(reportError.mock.calls[0][1])).not.toContain(
      "5550123",
    );
    expect(JSON.stringify(reportError.mock.calls[0][1])).not.toContain(
      "739204",
    );
    // Email cannot prove control of a phone: no email fallback.
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("a throwing reporter changes nothing", async () => {
    const sms = {
      send: vi.fn(async () => {
        throw new Error("sns throttled");
      }),
    };
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const sender = createPhoneOtpSender({
      sms: sms as never,
      mailer,
      logger: makeLogger(),
      productName,
      reportError,
    });

    // Still the 503, not the reporter's error.
    await expect(sender(input)).rejects.toMatchObject({
      body: { code: SMS_UNAVAILABLE_CODE },
    });
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("createPhoneOtpSender — US numbers only, global budget", () => {
  const okSms = () => ({
    send: vi.fn(async () => ({ result: { success: true } })),
  });

  it.each([
    ["+447700900123"],
    ["+882123456789"],
    ["+19005551234"],
    ["+18765551234"],
  ])("refuses %s with a 400 and texts nothing", async (phoneNumber) => {
    const sms = okSms();
    const smsBudget = vi.fn(async () => true);
    const reportError = vi.fn();
    const sender = createPhoneOtpSender({
      sms: sms as never,
      mailer,
      logger: makeLogger(),
      productName,
      reportError,
      smsBudget,
    });

    const err = await sender({ phoneNumber, code: "739204" }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(400);
    expect((err as APIError).body).toMatchObject({
      code: SMS_NUMBER_NOT_SUPPORTED_CODE,
    });
    expect(sms.send).not.toHaveBeenCalled();
    // A refused number spends nothing from the global budget.
    expect(smsBudget).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("over the global cap answers 429 and texts nothing", async () => {
    const sms = okSms();
    const reportError = vi.fn();
    const sender = createPhoneOtpSender({
      sms: sms as never,
      mailer,
      logger: makeLogger(),
      productName,
      reportError,
      smsBudget: vi.fn(async () => false),
    });

    const err = await sender(input).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(429);
    expect((err as APIError).body).toMatchObject({
      code: SMS_RATE_LIMITED_CODE,
    });
    expect(sms.send).not.toHaveBeenCalled();
  });

  it("under the cap, charges once and sends", async () => {
    const sms = okSms();
    const smsBudget = vi.fn(async () => true);
    const sender = createPhoneOtpSender({
      sms: sms as never,
      mailer,
      logger: makeLogger(),
      productName,
      smsBudget,
    });

    await expect(sender(input)).resolves.toBeUndefined();
    expect(smsBudget).toHaveBeenCalledTimes(1);
    expect(sms.send).toHaveBeenCalledTimes(1);
  });
});

describe("sms capability predicate (shared by createAuthDeps and getFeatureGates)", () => {
  const keys = { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" };

  it("needs both AWS keys and at least one origination number", () => {
    expect(
      isSmsConfigured({ ...keys, AWS_SMS_ORIGINATION_OTP: "+18885550100" }),
    ).toBe(true);
    expect(
      isSmsConfigured({
        ...keys,
        AWS_SMS_ORIGINATION_NOTIFICATIONS: "+18885550100",
      }),
    ).toBe(true);
    // Keys alone: options would show while every US send failed.
    expect(isSmsConfigured(keys)).toBe(false);
    expect(
      isSmsConfigured({
        ...keys,
        AWS_SMS_ORIGINATION_OTP: "",
        AWS_SMS_ORIGINATION_NOTIFICATIONS: "",
      }),
    ).toBe(false);
    expect(
      isSmsConfigured({
        AWS_ACCESS_KEY_ID: "a",
        AWS_SMS_ORIGINATION_OTP: "+18885550100",
      }),
    ).toBe(false);
    expect(
      isSmsConfigured({
        AWS_ACCESS_KEY_ID: "",
        AWS_SECRET_ACCESS_KEY: "",
        AWS_SMS_ORIGINATION_OTP: "+18885550100",
      }),
    ).toBe(false);
    expect(isSmsConfigured({})).toBe(false);
  });

  it("hands the adapter the same credentials it judged by", () => {
    expect(
      smsCredentials({ ...keys, AWS_SMS_ORIGINATION_OTP: "+18885550100" }),
    ).toEqual({ accessKeyId: "a", secretAccessKey: "b" });
    expect(smsCredentials(keys)).toBeNull();
    expect(smsCredentials({})).toBeNull();
  });
});
