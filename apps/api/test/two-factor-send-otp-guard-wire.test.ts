import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { bearer, twoFactor } from "better-auth/plugins";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTwoFactorSendOtpGuardHook,
  TWO_FACTOR_OTP_RATE_LIMITED_CODE,
} from "../src/auth/otp-senders";

/**
 * The per-account 2FA text cap answers 429 from a before-hook, because the
 * twoFactor plugin turns anything `sendOTP` throws into a 200. This drives a
 * REAL `betterAuth()` (memory adapter) through `auth.handler`, so the account
 * lookup (signed `two_factor` cookie, session cookie, Bearer token) and the
 * 429 are the plugin's real behaviour, not a model of it.
 */

const WEB_URL = "https://ithasfire.com";
const BASE_URL = "https://api.ithasfire.com";
const AUTH_BASE = `${BASE_URL}/api/auth`;
const PASSWORD = "correct-horse-battery-staple";

type Row = Record<string, unknown>;
let db: Record<string, Row[]>;
let sentTo: string[];
/** User ids the gate was asked about, in order. */
let asked: string[];
/** The cap under test: one text per account. */
const isUnderCap = vi.fn(async (userId: string) => {
  asked.push(userId);
  return sentTo.filter((id) => id === userId).length < 1;
});

const buildAuth = () => {
  const guard = createTwoFactorSendOtpGuardHook({
    isUnderCap,
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    } as never,
  });
  return betterAuth({
    baseURL: BASE_URL,
    secret: "test-secret-test-secret-test-secret-32",
    database: memoryAdapter(db),
    trustedOrigins: [BASE_URL, WEB_URL],
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    plugins: [
      bearer(),
      twoFactor({
        issuer: "Test",
        otpOptions: {
          sendOTP: async ({ user }) => {
            sentTo.push(user.id);
          },
        },
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        await guard(ctx);
      }),
    },
  });
};

let auth: ReturnType<typeof buildAuth>;

const request = (
  path: string,
  init: { body?: unknown; cookie?: string; bearer?: string } = {},
) =>
  auth.handler(
    new Request(`${AUTH_BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: WEB_URL,
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      body: JSON.stringify(init.body ?? {}),
    }),
  );

const cookiesFrom = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((h) => h.split(";")[0]!)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");

const signUp = async (email: string, twoFactorEnabled: boolean) => {
  const res = await request("/sign-up/email", {
    body: { email, password: PASSWORD, name: email.split("@")[0] },
  });
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  const user = db.user!.find((u) => u.email === email)!;
  Object.assign(user, { emailVerified: true, twoFactorEnabled });
  return { id: user.id as string, cookie: cookiesFrom(res), bearer: token };
};

beforeEach(() => {
  db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
  };
  sentTo = [];
  asked = [];
  isUnderCap.mockClear();
  auth = buildAuth();
});

describe("/two-factor/send-otp per-account cap (real Better Auth)", () => {
  it("mid sign-in (two_factor cookie): the first code is sent, the next answers 429 and sends nothing", async () => {
    const { id } = await signUp("u@example.com", true);
    const challenge = await request("/sign-in/email", {
      body: { email: "u@example.com", password: PASSWORD },
    });
    expect(
      ((await challenge.json()) as { twoFactorRedirect?: boolean })
        .twoFactorRedirect,
    ).toBe(true);
    const cookie = cookiesFrom(challenge);

    const first = await request("/two-factor/send-otp", { cookie });
    expect(first.status).toBe(200);
    expect(sentTo).toEqual([id]);

    const second = await request("/two-factor/send-otp", { cookie });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      code: TWO_FACTOR_OTP_RATE_LIMITED_CODE,
    });
    expect(sentTo).toEqual([id]);
    // The gate was asked about the account behind the cookie.
    expect(asked).toEqual([id, id]);
  });

  it.each([
    ["session cookie", (c: { cookie: string }) => ({ cookie: c.cookie })],
    ["Bearer token", (c: { bearer: string }) => ({ bearer: c.bearer })],
  ])("signed in (%s): the gate sees the session's account", async (_l, as) => {
    const caller = await signUp("s@example.com", false);

    const first = await request("/two-factor/send-otp", as(caller as never));
    expect(first.status).toBe(200);
    const second = await request("/two-factor/send-otp", as(caller as never));
    expect(second.status).toBe(429);
    expect(asked).toEqual([caller.id, caller.id]);
  });

  it("with no session and no two_factor cookie, leaves the refusal to Better Auth", async () => {
    const res = await request("/two-factor/send-otp");
    expect(res.status).toBe(401);
    expect(isUnderCap).not.toHaveBeenCalled();
  });

  it("does not touch other paths", async () => {
    await signUp("o@example.com", false);
    expect(isUnderCap).not.toHaveBeenCalled();
  });
});
