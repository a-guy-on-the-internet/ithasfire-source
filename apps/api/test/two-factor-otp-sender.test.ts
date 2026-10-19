import { describe, expect, it, vi } from "vitest";

import { sendTwoFactorOtp } from "@th/core/use-cases/auth/send-two-factor-otp";

import { APIError } from "better-auth/api";

import {
  createTwoFactorOtpSender,
  guardTwoFactorSendOtp,
  TWO_FACTOR_OTP_RATE_LIMITED_CODE,
} from "../src/auth/otp-senders";

/**
 * The `twoFactor` plugin's `sendOTP` wrapper swallows so Better Auth always
 * answers 200 — an OTP is retriable and not money-moving. Swallowed must not
 * mean silent, though: this exact branch hid a schema rejection for as long
 * as email 2FA existed. These pin both halves of that lesson.
 */
const productName = "Ithas Fire";
const logger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as never;

const okMailer = () => ({ send: vi.fn(async () => undefined) });

describe("sendTwoFactorOtp — the shape Better Auth actually hands over", () => {
  // The bug: an account with no phone carries `phoneNumber: null`, and the
  // schema said `.optional()` (undefined only). Every email-only 2FA user got
  // a 200 and no email.
  it("accepts `phoneNumber: null` and falls back to email", async () => {
    const mailer = okMailer();

    const result = await sendTwoFactorOtp(
      { mailer, logger },
      {
        userId: "u1",
        email: "jane@example.com",
        phoneNumber: null,
        phoneNumberVerified: false,
        otpCode: "739204",
        productName,
        preferSms: true,
      },
    );

    expect(result).toEqual({ ok: true, method: "email" });
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "jane@example.com" },
        template: expect.objectContaining({ key: "auth.2fa_otp" }),
      }),
    );
  });

  it("still accepts an absent phoneNumber", async () => {
    const mailer = okMailer();
    await expect(
      sendTwoFactorOtp(
        { mailer, logger },
        {
          userId: "u1",
          email: "jane@example.com",
          otpCode: "739204",
          productName,
        },
      ),
    ).resolves.toEqual({ ok: true, method: "email" });
  });
});

describe("createTwoFactorOtpSender — the swallow reports", () => {
  const user = { id: "u1", email: "jane@example.com" };

  it("reports a delivery failure once, tagged, and does not throw into Better Auth", async () => {
    const boom = new Error("smtp down");
    const mailer = { send: vi.fn(async () => { throw boom; }) };
    const reportError = vi.fn();
    const sender = createTwoFactorOtpSender({
      mailer,
      logger,
      productName,
      reportError,
    });

    await expect(sender({ user, otp: "739204" }, undefined)).resolves.toBeUndefined();

    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = reportError.mock.calls[0];
    // The use case wraps the mailer error in its own transient marker; what
    // matters is that SOMETHING reached the reporter for this user.
    expect(reported).toBeTruthy();
    expect(context).toEqual({
      tags: { useCase: "auth.sendTwoFactorOtp", swallowed: "true" },
      extra: { userId: "u1" },
    });
  });

  it("a throwing reporter changes nothing", async () => {
    const mailer = { send: vi.fn(async () => { throw new Error("smtp down"); }) };
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const sender = createTwoFactorOtpSender({
      mailer,
      logger,
      productName,
      reportError,
    });

    // This is the whole point of the swallow: Better Auth must get a resolved
    // promise no matter what. Caught a real gap when written — the bare
    // `reportError?.(...)` propagated the reporter's own error straight
    // through the catch and into the plugin.
    await expect(
      sender({ user, otp: "739204" }, undefined),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when delivery succeeds", async () => {
    const mailer = okMailer();
    const reportError = vi.fn();
    const sender = createTwoFactorOtpSender({
      mailer,
      logger,
      productName,
      reportError,
    });

    await sender({ user, otp: "739204" }, undefined);

    expect(reportError).not.toHaveBeenCalled();
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });
});

describe("createTwoFactorOtpSender — global passcode-text budget", () => {
  const smsUser = {
    id: "u1",
    email: "user@example.com",
    phoneNumber: "+12125551234",
    phoneNumberVerified: true,
  };
  const makeSms = () => ({
    send: vi.fn(async () => ({ result: { success: true } })),
  });

  it("over the cap, the code goes by email instead of text", async () => {
    const sms = makeSms();
    const mailer = okMailer();
    const smsBudget = vi.fn(async () => false);
    const sender = createTwoFactorOtpSender({
      sms: sms as never,
      mailer,
      logger,
      productName,
      smsBudget,
    });

    await sender({ user: smsUser, otp: "739204" }, undefined);

    expect(smsBudget).toHaveBeenCalledTimes(1);
    expect(sms.send).not.toHaveBeenCalled();
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });

  it("under the cap, the code goes by text", async () => {
    const sms = makeSms();
    const mailer = okMailer();
    const smsBudget = vi.fn(async () => true);
    const sender = createTwoFactorOtpSender({
      sms: sms as never,
      mailer,
      logger,
      productName,
      smsBudget,
    });

    await sender({ user: smsUser, otp: "739204" }, undefined);

    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("spends no budget on a send that would go by email anyway", async () => {
    const sms = makeSms();
    const mailer = okMailer();
    const smsBudget = vi.fn(async () => true);
    const sender = createTwoFactorOtpSender({
      sms: sms as never,
      mailer,
      logger,
      productName,
      smsBudget,
    });

    // Non-US number, then an unverified one.
    await sender(
      { user: { ...smsUser, phoneNumber: "+447700900123" }, otp: "739204" },
      undefined,
    );
    await sender(
      { user: { ...smsUser, phoneNumberVerified: false }, otp: "739204" },
      undefined,
    );

    expect(smsBudget).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
    expect(mailer.send).toHaveBeenCalledTimes(2);
  });

  it("a number that replied STOP gets the code by email and spends no budget", async () => {
    const sms = makeSms();
    const mailer = okMailer();
    const smsBudget = vi.fn(async () => true);
    const getByPhone = vi.fn(async () => ({ status: "OPTED_OUT" }) as never);
    const sender = createTwoFactorOtpSender({
      sms: sms as never,
      mailer,
      logger,
      productName,
      smsBudget,
      smsConsent: { getByPhone },
    });

    await sender({ user: smsUser, otp: "739204" }, undefined);

    expect(getByPhone).toHaveBeenCalledWith("+12125551234");
    expect(smsBudget).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });
});


describe("createTwoFactorOtpSender — per-account text cap", () => {
  const smsUser = {
    id: "u1",
    email: "user@example.com",
    phoneNumber: "+12125551234",
    phoneNumberVerified: true,
  };
  const makeSms = () => ({
    send: vi.fn(async () => ({ result: { success: true } })),
  });

  // Email here would let anyone with the password and the mailbox skip the
  // phone factor: over the account cap, nothing is sent at all.
  it("over the account's cap, sends nothing (no text, no email) and spends no pool", async () => {
    const sms = makeSms();
    const mailer = okMailer();
    const perUserSmsCap = vi.fn(async () => false);
    const smsBudget = vi.fn(async () => true);
    const reportError = vi.fn();
    const sender = createTwoFactorOtpSender({
      sms: sms as never,
      mailer,
      logger,
      productName,
      smsBudget,
      perUserSmsCap,
      reportError,
    });

    await sender({ user: smsUser, otp: "739204" }, undefined);

    expect(perUserSmsCap).toHaveBeenCalledWith("u1");
    expect(smsBudget).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
    // An expected refusal, not a failure.
    expect(reportError).not.toHaveBeenCalled();
  });

  it("over the shared pool (account under its cap), the code still goes by email", async () => {
    const sms = makeSms();
    const mailer = okMailer();
    const sender = createTwoFactorOtpSender({
      sms: sms as never,
      mailer,
      logger,
      productName,
      smsBudget: vi.fn(async () => false),
      perUserSmsCap: vi.fn(async () => true),
    });

    await sender({ user: smsUser, otp: "739204" }, undefined);

    expect(sms.send).not.toHaveBeenCalled();
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });

  it("under both caps, the account cap is charged first, then the pool, and the code is texted", async () => {
    const sms = makeSms();
    const mailer = okMailer();
    const order: string[] = [];
    const perUserSmsCap = vi.fn(async () => {
      order.push("user");
      return true;
    });
    const smsBudget = vi.fn(async () => {
      order.push("pool");
      return true;
    });
    const sender = createTwoFactorOtpSender({
      sms: sms as never,
      mailer,
      logger,
      productName,
      smsBudget,
      perUserSmsCap,
    });

    await sender({ user: smsUser, otp: "739204" }, undefined);

    expect(order).toEqual(["user", "pool"]);
    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("charges no account cap on a send that would go by email anyway", async () => {
    const perUserSmsCap = vi.fn(async () => true);
    const sender = createTwoFactorOtpSender({
      sms: makeSms() as never,
      mailer: okMailer(),
      logger,
      productName,
      perUserSmsCap,
    });

    await sender(
      { user: { ...smsUser, phoneNumberVerified: false }, otp: "739204" },
      undefined,
    );

    expect(perUserSmsCap).not.toHaveBeenCalled();
  });
});

describe("guardTwoFactorSendOtp — the 429 before a code is minted", () => {
  const guardLogger = () =>
    ({
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    }) as never;

  it("over the account's cap, refuses with a 429 TWO_FACTOR_OTP_RATE_LIMITED", async () => {
    const isUnderCap = vi.fn(async () => false);
    const err = await guardTwoFactorSendOtp({
      resolveUserId: async () => "u1",
      isUnderCap,
      logger: guardLogger(),
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isUnderCap).toHaveBeenCalledWith("u1");
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(429);
    expect((err as APIError).body).toMatchObject({
      code: TWO_FACTOR_OTP_RATE_LIMITED_CODE,
    });
  });

  it("under the cap, lets the request through", async () => {
    await expect(
      guardTwoFactorSendOtp({
        resolveUserId: async () => "u1",
        isUnderCap: async () => true,
        logger: guardLogger(),
      }),
    ).resolves.toBeUndefined();
  });

  it("with no account to resolve, leaves the refusal to Better Auth", async () => {
    const isUnderCap = vi.fn(async () => false);
    await expect(
      guardTwoFactorSendOtp({
        resolveUserId: async () => null,
        isUnderCap,
        logger: guardLogger(),
      }),
    ).resolves.toBeUndefined();
    expect(isUnderCap).not.toHaveBeenCalled();
  });

  it("a failed account lookup fails open, reported and redacted; a throwing reporter changes nothing", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(
      guardTwoFactorSendOtp({
        resolveUserId: async () => {
          throw new Error('lookup failed for "+16155550100"');
        },
        isUnderCap: async () => false,
        logger: guardLogger(),
        reportError,
      }),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    const reported = (reportError.mock.calls[0] as unknown[])[0] as Error;
    expect(reported.message).not.toContain("5550100");
  });
});
