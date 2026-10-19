import { describe, expect, it, vi } from "vitest";

import type { RateLimitPort } from "@th/ports/rate-limit";

import {
  createOtpSmsBudget,
  createOtpSmsPerUserCap,
  createOtpSmsPerUserGate,
  OTP_SMS_BUDGET_KEYS,
  OTP_SMS_BUDGET_WINDOW_SECONDS,
  OTP_SMS_PER_USER_MAX,
  OTP_SMS_PER_USER_WINDOW_SECONDS,
  otpSmsPerUserKey,
} from "../src/auth/otp-sms-budget";

/** In-memory fixed-window counter with the `consume` contract. */
function fakeRateLimit(): Pick<RateLimitPort, "consume"> & {
  consume: ReturnType<typeof vi.fn>;
} {
  const counts = new Map<string, number>();
  return {
    consume: vi.fn(async (key: string, maxTokens: number) => {
      const used = (counts.get(key) ?? 0) + 1;
      counts.set(key, used);
      const allowed = used <= maxTokens;
      return {
        allowed,
        remaining: Math.max(0, maxTokens - used),
        retryAfterSeconds: allowed ? 0 : 60,
      };
    }),
  };
}

const logger = () => ({ warn: vi.fn() });

describe("createOtpSmsBudget — global passcode-text cap", () => {
  it("allows exactly maxPerHour texts across all callers, then refuses", async () => {
    const rateLimit = fakeRateLimit();
    const budget = createOtpSmsBudget({
      getRateLimit: () => rateLimit,
      pool: "phone",
      maxPerHour: 3,
      logger: logger(),
    });

    const answers = [];
    for (let i = 0; i < 5; i += 1) answers.push(await budget());

    expect(answers).toEqual([true, true, true, false, false]);
    // One global key, one hour window: not per IP, not per number.
    expect(rateLimit.consume).toHaveBeenCalledWith(
      OTP_SMS_BUDGET_KEYS.phone,
      3,
      OTP_SMS_BUDGET_WINDOW_SECONDS,
    );
    expect(OTP_SMS_BUDGET_WINDOW_SECONDS).toBe(3600);
  });

  it("reports the first denial (throttled), not every one", async () => {
    const reportError = vi.fn();
    const rateLimit = fakeRateLimit();
    const budget = createOtpSmsBudget({
      getRateLimit: () => rateLimit,
      pool: "phone",
      maxPerHour: 1,
      logger: logger(),
      reportError,
    });

    await budget(); // allowed
    await budget(); // denied → reported
    await budget(); // denied → throttled

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { area: "auth_otp_sms_budget", branch: "exhausted", pool: "phone" },
    });
  });

  it("fails open and reports when Redis errors", async () => {
    const reportError = vi.fn();
    const log = logger();
    const budget = createOtpSmsBudget({
      getRateLimit: () => ({
        consume: vi.fn(async () => {
          throw new Error("redis down");
        }),
      }),
      pool: "phone",
      maxPerHour: 1,
      logger: log,
      reportError,
    });

    await expect(budget()).resolves.toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      "auth_otp_sms_budget_unavailable",
      expect.objectContaining({ error: "redis down" }),
    );
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { area: "auth_otp_sms_budget", branch: "fail_open", pool: "phone" },
    });
  });

  it("fails open when the Redis client cannot even be built", async () => {
    const budget = createOtpSmsBudget({
      getRateLimit: () => {
        throw new Error("bad REDIS_URL");
      },
      pool: "phone",
      maxPerHour: 1,
      logger: logger(),
    });

    await expect(budget()).resolves.toBe(true);
  });

  it("a throwing reporter changes no answer", async () => {
    const rateLimit = fakeRateLimit();
    const budget = createOtpSmsBudget({
      getRateLimit: () => rateLimit,
      pool: "phone",
      maxPerHour: 1,
      logger: logger(),
      reportError: () => {
        throw new Error("sentry down");
      },
    });

    await expect(budget()).resolves.toBe(true);
    await expect(budget()).resolves.toBe(false);
  });

  it("2FA has its own pool: anonymous phone OTP traffic cannot spend it", async () => {
    const rateLimit = fakeRateLimit();
    const phone = createOtpSmsBudget({
      getRateLimit: () => rateLimit,
      pool: "phone",
      maxPerHour: 2,
      logger: logger(),
    });
    const twoFactor = createOtpSmsBudget({
      getRateLimit: () => rateLimit,
      pool: "2fa",
      maxPerHour: 2,
      logger: logger(),
    });

    // Anonymous traffic drains the phone pool...
    for (let i = 0; i < 5; i += 1) await phone();
    await expect(phone()).resolves.toBe(false);
    // ...and 2FA still texts.
    await expect(twoFactor()).resolves.toBe(true);
    expect(rateLimit.consume).toHaveBeenLastCalledWith(
      "authgate:global:otp-sms:2fa",
      2,
      OTP_SMS_BUDGET_WINDOW_SECONDS,
    );
    expect(OTP_SMS_BUDGET_KEYS).toEqual({
      phone: "authgate:global:otp-sms",
      "2fa": "authgate:global:otp-sms:2fa",
    });
  });

  it("an ongoing Redis outage does not hide a tripped cap: each branch has its own throttle", async () => {
    const reportError = vi.fn();
    let redisUp = false;
    const rateLimit = fakeRateLimit();
    const budget = createOtpSmsBudget({
      getRateLimit: () => {
        if (!redisUp) throw new Error("redis down");
        return rateLimit;
      },
      pool: "2fa",
      maxPerHour: 1,
      logger: logger(),
      reportError,
    });

    await budget(); // fail open → reported
    redisUp = true;
    await budget(); // allowed
    await budget(); // denied → reported despite the fail-open report just now

    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError.mock.calls.map((c) => (c[1] as { tags: { branch: string } }).tags.branch)).toEqual([
      "fail_open",
      "exhausted",
    ]);
  });
});

describe("createOtpSmsPerUserCap — one account's 2FA texts", () => {
  it("allows 5 per account per 15 minutes, then refuses, per account", async () => {
    const rateLimit = fakeRateLimit();
    const cap = createOtpSmsPerUserCap({
      getRateLimit: () => rateLimit,
      logger: logger(),
    });

    const answers = [];
    for (let i = 0; i < 7; i += 1) answers.push(await cap("u1"));

    expect(OTP_SMS_PER_USER_MAX).toBe(5);
    expect(OTP_SMS_PER_USER_WINDOW_SECONDS).toBe(15 * 60);
    expect(answers).toEqual([true, true, true, true, true, false, false]);
    expect(rateLimit.consume).toHaveBeenCalledWith(
      otpSmsPerUserKey("u1"),
      5,
      15 * 60,
    );
    // Another account has its own bucket.
    expect(await cap("u2")).toBe(true);
    // Not the global pool's key.
    expect(otpSmsPerUserKey("u1")).not.toBe(OTP_SMS_BUDGET_KEYS["2fa"]);
  });

  it("a denial is logged, not reported", async () => {
    const reportError = vi.fn();
    const log = logger();
    const cap = createOtpSmsPerUserCap({
      getRateLimit: () => ({
        consume: vi.fn(async () => ({
          allowed: false,
          remaining: 0,
          retryAfterSeconds: 60,
        })),
      }),
      logger: log,
      reportError,
    });

    expect(await cap("u1")).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      "auth_otp_sms_per_user_cap_reached",
      expect.anything(),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("fails open on a Redis error and reports it; a throwing reporter changes nothing", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const cap = createOtpSmsPerUserCap({
      getRateLimit: () => {
        throw new Error("bad REDIS_URL");
      },
      logger: logger(),
      reportError,
    });

    expect(await cap("u1")).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("createOtpSmsPerUserGate — read-only check for the 429", () => {
  it("is open below the cap and shut at it, reading the same key without charging", async () => {
    const peek = vi.fn(async (_keys: ReadonlyArray<string>) => [4]);
    const gate = createOtpSmsPerUserGate({
      getRateLimit: () => ({ peek }),
      logger: logger(),
    });

    expect(await gate("u1")).toBe(true);
    expect(peek).toHaveBeenCalledWith([otpSmsPerUserKey("u1")]);

    peek.mockResolvedValueOnce([5]);
    expect(await gate("u1")).toBe(false);
  });

  it("fails open on a Redis error and reports it", async () => {
    const reportError = vi.fn();
    const gate = createOtpSmsPerUserGate({
      getRateLimit: () => ({
        peek: vi.fn(async () => {
          throw new Error("redis down");
        }),
      }),
      logger: logger(),
      reportError,
    });

    expect(await gate("u1")).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("agrees with the charging cap: after 5 texts the gate shuts", async () => {
    const rateLimit = fakeRateLimit();
    const counts = new Map<string, number>();
    rateLimit.consume.mockImplementation(async (key: string, max: number) => {
      const used = (counts.get(key) ?? 0) + 1;
      counts.set(key, used);
      return { allowed: used <= max, remaining: 0, retryAfterSeconds: 0 };
    });
    const cap = createOtpSmsPerUserCap({
      getRateLimit: () => rateLimit,
      logger: logger(),
    });
    const gate = createOtpSmsPerUserGate({
      getRateLimit: () => ({
        peek: async (keys) => keys.map((k) => counts.get(k) ?? 0),
      }),
      logger: logger(),
    });

    for (let i = 0; i < 5; i += 1) {
      expect(await gate("u1")).toBe(true);
      expect(await cap("u1")).toBe(true);
    }
    expect(await gate("u1")).toBe(false);
  });
});
