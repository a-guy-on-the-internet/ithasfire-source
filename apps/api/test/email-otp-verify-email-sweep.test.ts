import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer, emailOTP } from "better-auth/plugins";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isOwnInboxVerification,
  resolveEmailProofTrigger,
  revokeUnprovenCredentials,
} from "../src/auth/account-security";
import { sessionUserIdOf } from "../src/auth/second-factor-bypass";
import {
  memoryEmailProofAuthUserId,
  memorySweepDeps,
} from "./helpers/memory-unproven-sweep";

/**
 * B2: `/email-otp/verify-email` flips `emailVerified` from `{ email, otp }`
 * alone, with no session. Before this, it skipped the unproven-account sweep
 * the email-code sign-in runs, so the real inbox owner verifying their
 * address left a squatter's password and sessions on a now-verified account
 * that holds every guest order attached to that address.
 *
 * A REAL `betterAuth()` (memory adapter, the emailOTP plugin, bearer for the
 * apps' `Authorization` sessions) driven through `auth.handler`, with the
 * production `user.update.before` email-proof branch (trigger detector,
 * `isOwnInboxVerification` with the production `sessionUserIdOf`, the
 * production `revokeUnprovenCredentials`); the Prisma writes are done against
 * the memory rows (`./helpers/memory-unproven-sweep`).
 */

const BASE_URL = "https://api.ithasfire.com";
const AUTH_BASE = `${BASE_URL}/api/auth`;
const PASSWORD = "correct-horse-battery-staple";
const EMAIL = "victim@example.com";

type Row = Record<string, unknown>;
type MemoryDb = Record<string, Row[]>;

let db: MemoryDb;
let mailedOtps: Map<string, string>;
/** Every sweep the hook ran: (authUserId, trigger). */
let revokeAll: ReturnType<typeof vi.fn>;
/** Set to make the sweep's writes fail. */
let sweepFailure: Error | null;

const buildAuth = () =>
  betterAuth({
    baseURL: BASE_URL,
    secret: "test-secret-test-secret-test-secret-32",
    database: memoryAdapter(db),
    trustedOrigins: [BASE_URL],
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    plugins: [
      bearer(),
      emailOTP({
        disableSignUp: true,
        sendVerificationOTP: async ({ email, otp, type }) => {
          mailedOtps.set(`${type}:${email}`, otp);
        },
      }),
    ],
    databaseHooks: {
      user: {
        update: {
          // The production hook's email-proof branch (better-auth.ts).
          before: async (data, ctx) => {
            const trigger = resolveEmailProofTrigger(
              (ctx as { path?: string } | null)?.path,
              data as Record<string, unknown>,
            );
            if (!trigger) return;
            const authUserId = await memoryEmailProofAuthUserId(
              () => db,
              ctx,
              trigger,
            );
            if (!authUserId) throw new Error("email proof: user unresolved");
            if (
              await isOwnInboxVerification(trigger, authUserId, () =>
                sessionUserIdOf(ctx),
              )
            ) {
              return;
            }
            const deps = memorySweepDeps(() => db);
            await revokeUnprovenCredentials(
              {
                ...deps,
                revokeAll: async (id, t) => {
                  revokeAll(id, t);
                  if (sweepFailure) throw sweepFailure;
                  return deps.revokeAll(id, t);
                },
              },
              { authUserId, trigger },
            );
          },
        },
      },
    },
  });

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
        origin: BASE_URL,
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );

const sessionCookieFrom = (response: Response): string => {
  const cookie = response.headers
    .getSetCookie()
    .map((h) => h.split(";")[0]!)
    .find((c) => /session_token=.+/.test(c));
  if (!cookie) throw new Error("no session cookie");
  return cookie;
};

const userRow = (): Row => {
  const row = db.user!.find((u) => u.email === EMAIL);
  if (!row) throw new Error("no user");
  return row;
};
const credentialRows = () =>
  db.account!.filter(
    (a) => a.userId === userRow().id && a.providerId === "credential",
  ).length;
const sessionRows = () =>
  db.session!.filter((s) => s.userId === userRow().id).length;

/** Someone signs up under EMAIL with a password and never verifies. */
const signUpUnverified = async () => {
  const res = await request("/sign-up/email", {
    body: { email: EMAIL, password: PASSWORD, name: "Someone" },
  });
  expect(res.status).toBe(200);
  expect(userRow().emailVerified).toBe(false);
  return {
    cookie: sessionCookieFrom(res),
    token: ((await res.json()) as { token: string }).token,
  };
};

/** Mail an email-verification code to EMAIL and post it to verify-email. */
const verifyEmail = async (auth: { cookie?: string; bearer?: string } = {}) => {
  const send = await request("/email-otp/send-verification-otp", {
    body: { email: EMAIL, type: "email-verification" },
  });
  expect(send.status).toBe(200);
  const otp = mailedOtps.get(`email-verification:${EMAIL}`);
  expect(otp).toBeTruthy();
  return request("/email-otp/verify-email", {
    body: { email: EMAIL, otp },
    ...auth,
  });
};

beforeEach(() => {
  db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
    passkey: [],
  };
  mailedOtps = new Map();
  revokeAll = vi.fn();
  sweepFailure = null;
  auth = buildAuth();
});

describe("/email-otp/verify-email runs the unproven-account sweep (B2)", () => {
  it("anonymous prover (the real inbox owner): the squatter's password and sessions go, once", async () => {
    await signUpUnverified();
    expect(credentialRows()).toBe(1);
    expect(sessionRows()).toBe(1);

    const res = await verifyEmail();

    expect(res.status).toBe(200);
    expect(userRow().emailVerified).toBe(true);
    expect(credentialRows()).toBe(0);
    expect(sessionRows()).toBe(0);
    expect(revokeAll).toHaveBeenCalledTimes(1);
    expect(revokeAll).toHaveBeenCalledWith(userRow().id, "email_otp_verify_email");
  });

  it("is idempotent: verifying an already-verified account sweeps nothing", async () => {
    await signUpUnverified();
    await verifyEmail();
    expect(revokeAll).toHaveBeenCalledTimes(1);

    const again = await verifyEmail();

    expect(again.status).toBe(200);
    expect(revokeAll).toHaveBeenCalledTimes(1);
  });

  it("a session for ANOTHER account does not count as the holder: sweeps", async () => {
    await signUpUnverified();
    const other = await request("/sign-up/email", {
      body: { email: "other@example.com", password: PASSWORD, name: "Other" },
    });
    const otherCookie = sessionCookieFrom(other);

    const res = await verifyEmail({ cookie: otherCookie });

    expect(res.status).toBe(200);
    expect(userRow().emailVerified).toBe(true);
    expect(credentialRows()).toBe(0);
    expect(revokeAll).toHaveBeenCalledTimes(1);
  });

  it("the account holder verifying after sign-up (cookie): verified, password and session kept", async () => {
    const { cookie } = await signUpUnverified();

    const res = await verifyEmail({ cookie });

    expect(res.status).toBe(200);
    expect(userRow().emailVerified).toBe(true);
    expect(credentialRows()).toBe(1);
    expect(sessionRows()).toBe(1);
    expect(revokeAll).not.toHaveBeenCalled();
  });

  it("the account holder on the mobile app (Authorization: Bearer): same", async () => {
    const { token } = await signUpUnverified();

    const res = await verifyEmail({ bearer: token });

    expect(res.status).toBe(200);
    expect(userRow().emailVerified).toBe(true);
    expect(credentialRows()).toBe(1);
    expect(sessionRows()).toBe(1);
    expect(revokeAll).not.toHaveBeenCalled();
  });

  it("a failing session read does not abort: it reads as no session, so the sweep runs", async () => {
    const { cookie } = await signUpUnverified();
    const ctx = await auth.$context;
    vi.spyOn(ctx.internalAdapter, "findSession").mockRejectedValue(
      new Error("session store down"),
    );

    const res = await verifyEmail({ cookie });

    expect(res.status).toBe(200);
    expect(userRow().emailVerified).toBe(true);
    expect(credentialRows()).toBe(0);
    expect(revokeAll).toHaveBeenCalledTimes(1);
  });

  it("a failing sweep aborts the flip (fails closed, the account stays unverified)", async () => {
    await signUpUnverified();
    sweepFailure = new Error("db down");

    const res = await verifyEmail();

    expect(res.ok).toBe(false);
    expect(revokeAll).toHaveBeenCalledTimes(1);
    expect(userRow().emailVerified).toBe(false);
    expect(credentialRows()).toBe(1);
  });
});
