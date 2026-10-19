import { passkey } from "@better-auth/passkey";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { bearer, twoFactor } from "better-auth/plugins";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  refuseSecondFactorBypassSession,
  refuseTwoFactorWithoutPrimarySignIn,
  TWO_FACTOR_KEEPS_PASSKEY_ERROR,
  TWO_FACTOR_KEEPS_PASSWORD_ERROR,
  TWO_FACTOR_NEEDS_PRIMARY_SIGN_IN_ERROR,
  twoFactorPrerequisites,
} from "../src/auth/second-factor-bypass";

/**
 * A two-factor account always keeps a password or a passkey.
 *
 * Without one, a Google / Apple sign-in is the account's only way in, and
 * that sign-in cannot be asked for a second factor. These drive a REAL
 * `betterAuth()` (memory adapter) with `twoFactorPrerequisites` and
 * `bearer()` through `auth.handler`, as a browser (session cookie) and as a
 * native app (`Authorization: Bearer`).
 */

const WEB_URL = "https://ithasfire.com";
const BASE_URL = "https://api.ithasfire.com";
const AUTH_BASE = `${BASE_URL}/api/auth`;
const PASSWORD = "correct-horse-battery-staple";

type Row = Record<string, unknown>;
type MemoryDb = Record<string, Row[]>;

let db: MemoryDb;
let twoFactorOtps: Map<string, string>;
const reportError = vi.fn();
/** `Human.roles` by auth user id: what the production `staffRolesOf` reads. */
const staffRoles = new Map<string, string[]>();
const staffRolesOf = async (authUserId: string) =>
  staffRoles.get(authUserId) ?? [];

const buildAuth = (opts: {
  prerequisites: "after-bearer" | "before-bearer" | "none";
}) =>
  betterAuth({
    baseURL: BASE_URL,
    secret: "test-secret-test-secret-test-secret-32",
    database: memoryAdapter(db),
    trustedOrigins: [BASE_URL, WEB_URL],
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    account: { accountLinking: { enabled: true } },
    plugins: [
      ...(opts.prerequisites === "before-bearer"
        ? [twoFactorPrerequisites({ reportError })]
        : []),
      bearer(),
      ...(opts.prerequisites === "after-bearer"
        ? [twoFactorPrerequisites({ reportError })]
        : []),
      twoFactor({
        issuer: "Test",
        otpOptions: {
          sendOTP: async ({ user, otp }) => {
            twoFactorOtps.set(user.email, otp);
          },
        },
      }),
      passkey({ rpID: "ithasfire.com", rpName: "Test", origin: WEB_URL }),
    ],
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            await refuseSecondFactorBypassSession(ctx, session.userId, {
              authBaseURL: AUTH_BASE,
              webBaseURL: WEB_URL,
              reportError,
              staffRolesOf,
            });
          },
        },
      },
    },
  });

let auth: ReturnType<typeof buildAuth>;

/** A signed-in caller: the browser's cookie, or a native app's Bearer token. */
type Caller = { cookie: string; bearer: string };
type Credentials = { cookie?: string; bearer?: string };

const request = (
  path: string,
  init: { body?: unknown } & Credentials = {},
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

const cookiesFrom = (response: Response): string => {
  const jar = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0]!;
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value === "" || /max-age=0/i.test(header)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
};

const userRow = (email: string): Row => {
  const row = db.user!.find((u) => u.email === email);
  if (!row) throw new Error(`no user ${email}`);
  return row;
};

const providersOf = (email: string) =>
  db
    .account!.filter((a) => a.userId === userRow(email).id)
    .map((a) => a.providerId)
    .sort();

const passkeysOf = (email: string) =>
  db
    .passkey!.filter((p) => p.userId === userRow(email).id)
    .map((p) => p.id)
    .sort();

/**
 * A signed-in account with exactly the sign-ins asked for. Signs up with a
 * password (which is how the session is obtained), then sets the rows.
 */
const createAccount = async (
  email: string,
  has: {
    password: boolean;
    google?: boolean;
    passkeys?: string[];
    twoFactorEnabled?: boolean;
  },
): Promise<Caller> => {
  const res = await request("/sign-up/email", {
    body: { email, password: PASSWORD, name: email.split("@")[0] },
  });
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  const user = userRow(email);
  Object.assign(user, {
    emailVerified: true,
    twoFactorEnabled: has.twoFactorEnabled ?? false,
  });
  if (!has.password) {
    const rows = db.account!;
    rows.splice(0, rows.length, ...rows.filter((a) => a.userId !== user.id));
  }
  if (has.google) {
    db.account!.push({
      id: `google-${email}`,
      providerId: "google",
      accountId: `sub-${email}`,
      userId: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  for (const id of has.passkeys ?? []) {
    db.passkey!.push({
      id,
      name: id,
      userId: user.id,
      credentialID: `cred-${id}`,
      publicKey: "pk",
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      createdAt: new Date(),
    });
  }
  return { cookie: cookiesFrom(res), bearer: token };
};

const expectRefused = async (
  res: Response,
  error: { code: string; message: string },
) => {
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ ...error });
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
  twoFactorOtps = new Map();
  reportError.mockReset();
  staffRoles.clear();
  auth = buildAuth({ prerequisites: "after-bearer" });
});

describe("turning two-factor on needs a password or a passkey", () => {
  it.each([
    ["the browser's cookie", (c: Caller) => ({ cookie: c.cookie })],
    ["a native app's Bearer token", (c: Caller) => ({ bearer: c.bearer })],
  ])(
    "refuses the mailed-code route for a Google-only account (%s): no code is sent and the flag stays off",
    async (_label, as) => {
      const caller = await createAccount("staff@example.com", {
        password: false,
        google: true,
      });

      await expectRefused(
        await request("/two-factor/send-otp", as(caller)),
        TWO_FACTOR_NEEDS_PRIMARY_SIGN_IN_ERROR,
      );
      expect(twoFactorOtps.size).toBe(0);
      await expectRefused(
        await request("/two-factor/verify-otp", {
          ...as(caller),
          body: { code: "123456" },
        }),
        TWO_FACTOR_NEEDS_PRIMARY_SIGN_IN_ERROR,
      );
      expect(userRow("staff@example.com").twoFactorEnabled).toBe(false);
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it("sees a Bearer session wherever the plugin is listed (a before-hook never sees bearer()'s cookie)", async () => {
    auth = buildAuth({ prerequisites: "before-bearer" });
    const caller = await createAccount("staff@example.com", {
      password: false,
      google: true,
    });

    await expectRefused(
      await request("/two-factor/send-otp", { bearer: caller.bearer }),
      TWO_FACTOR_NEEDS_PRIMARY_SIGN_IN_ERROR,
    );
  });

  it.each([
    ["not a session token", "not-a-session-token"],
    ["a session token with a forged signature", "FORGED"],
  ])("a Bearer token that is %s is no session: the route answers for itself", async (_label, kind) => {
    const caller = await createAccount("staff@example.com", {
      password: false,
      google: true,
    });
    const token = kind === "FORGED" ? `${caller.bearer}.forged` : kind;

    const res = await request("/two-factor/send-otp", { bearer: token });

    // Not this check's refusal: without a session the plugin treats the
    // request as a sign-in challenge, and there is none.
    expect(res.status).not.toBe(200);
    expect(((await res.json()) as { code?: string }).code).not.toBe(
      TWO_FACTOR_NEEDS_PRIMARY_SIGN_IN_ERROR.code,
    );
    expect(twoFactorOtps.size).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("leaves the session refresh to the endpoint: same refresh and same cookies as without the check", async () => {
    const sendWithAgedSession = async (
      prerequisites: "after-bearer" | "none",
    ) => {
      db = {
        user: [],
        session: [],
        account: [],
        verification: [],
        twoFactor: [],
        passkey: [],
      };
      auth = buildAuth({ prerequisites });
      const caller = await createAccount("staff@example.com", {
        password: true,
      });
      const session = db.session!.find(
        (row) => row.userId === userRow("staff@example.com").id,
      )!;
      // Close enough to expiry that a session read refreshes it.
      const aged = new Date(Date.now() + 60 * 60 * 1000);
      Object.assign(session, { expiresAt: aged });
      const res = await request("/two-factor/send-otp", {
        cookie: caller.cookie,
      });
      return {
        status: res.status,
        refreshed: (session.expiresAt as Date).getTime() > aged.getTime(),
        cookiesSet: res.headers
          .getSetCookie()
          .map((header) => header.split("=")[0])
          .sort(),
      };
    };

    const withCheck = await sendWithAgedSession("after-bearer");
    const without = await sendWithAgedSession("none");

    expect(withCheck).toEqual(without);
    expect(withCheck).toMatchObject({ status: 200, refreshed: true });
  });

  it.each([
    ["a password", { password: true }],
    ["a passkey and no password", { password: false, passkeys: ["pk1"] }],
  ])("lets an account with %s turn it on by mailed code", async (_l, has) => {
    const caller = await createAccount("staff@example.com", has);

    const send = await request("/two-factor/send-otp", {
      cookie: caller.cookie,
    });
    expect(send.status).toBe(200);
    const verify = await request("/two-factor/verify-otp", {
      cookie: caller.cookie,
      body: { code: twoFactorOtps.get("staff@example.com") },
    });

    expect(verify.status).toBe(200);
    expect(userRow("staff@example.com").twoFactorEnabled).toBe(true);
  });

  const startTotpEnrolment = async (caller: Caller) => {
    const enable = await request("/two-factor/enable", {
      cookie: caller.cookie,
      body: { password: PASSWORD },
    });
    expect(enable.status).toBe(200);
    const { totpURI } = (await enable.json()) as { totpURI: string };
    const secret = new TextDecoder().decode(
      base32.decode(new URL(totpURI).searchParams.get("secret")!),
    );
    return () => createOTP(secret).totp();
  };

  it("lets an account with a password enrol an authenticator app", async () => {
    const caller = await createAccount("staff@example.com", { password: true });
    const currentCode = await startTotpEnrolment(caller);

    const verify = await request("/two-factor/verify-totp", {
      cookie: caller.cookie,
      body: { code: await currentCode() },
    });

    expect(verify.status).toBe(200);
    expect(userRow("staff@example.com").twoFactorEnabled).toBe(true);
  });

  it("refuses the first authenticator code when the password was removed after enrolment started", async () => {
    const caller = await createAccount("staff@example.com", {
      password: true,
      google: true,
    });
    const currentCode = await startTotpEnrolment(caller);
    const unlink = await request("/unlink-account", {
      cookie: caller.cookie,
      body: { providerId: "credential" },
    });
    expect(unlink.status).toBe(200);
    expect(providersOf("staff@example.com")).toEqual(["google"]);

    await expectRefused(
      await request("/two-factor/verify-totp", {
        cookie: caller.cookie,
        body: { code: await currentCode() },
      }),
      TWO_FACTOR_NEEDS_PRIMARY_SIGN_IN_ERROR,
    );
    expect(userRow("staff@example.com").twoFactorEnabled).toBe(false);
  });

  it("leaves the sign-in challenge alone: password, then the mailed code, with no session yet", async () => {
    await createAccount("staff@example.com", {
      password: true,
      twoFactorEnabled: true,
    });
    const challenge = await request("/sign-in/email", {
      body: { email: "staff@example.com", password: PASSWORD },
    });
    expect(
      ((await challenge.json()) as { twoFactorRedirect?: boolean })
        .twoFactorRedirect,
    ).toBe(true);
    const cookie = cookiesFrom(challenge);

    const send = await request("/two-factor/send-otp", { cookie });
    expect(send.status).toBe(200);
    const verify = await request("/two-factor/verify-otp", {
      cookie,
      body: { code: twoFactorOtps.get("staff@example.com") },
    });

    expect(verify.status).toBe(200);
    expect(cookiesFrom(verify)).toMatch(/session_token=.+/);
  });

  it("leaves an account that already has two-factor on alone (it is not enrolling)", async () => {
    // The pre-existing state: two-factor on, no password, no passkey.
    const caller = await createAccount("staff@example.com", {
      password: false,
      google: true,
      twoFactorEnabled: true,
    });

    const send = await request("/two-factor/send-otp", {
      cookie: caller.cookie,
    });

    expect(send.status).toBe(200);
  });
});

describe("a two-factor account cannot remove its password without a passkey", () => {
  it.each([
    ["the browser's cookie", (c: Caller) => ({ cookie: c.cookie })],
    ["a native app's Bearer token", (c: Caller) => ({ bearer: c.bearer })],
  ])("refuses /unlink-account for credential (%s)", async (_label, as) => {
    const caller = await createAccount("staff@example.com", {
      password: true,
      google: true,
      twoFactorEnabled: true,
    });

    await expectRefused(
      await request("/unlink-account", {
        ...as(caller),
        body: { providerId: "credential" },
      }),
      TWO_FACTOR_KEEPS_PASSWORD_ERROR,
    );
    expect(providersOf("staff@example.com")).toEqual(["credential", "google"]);
  });

  it("allows it when the account has a passkey", async () => {
    const caller = await createAccount("staff@example.com", {
      password: true,
      google: true,
      passkeys: ["pk1"],
      twoFactorEnabled: true,
    });

    const res = await request("/unlink-account", {
      cookie: caller.cookie,
      body: { providerId: "credential" },
    });

    expect(res.status).toBe(200);
    expect(providersOf("staff@example.com")).toEqual(["google"]);
  });

  it("allows it when two-factor is off", async () => {
    const caller = await createAccount("buyer@example.com", {
      password: true,
      google: true,
    });

    const res = await request("/unlink-account", {
      cookie: caller.cookie,
      body: { providerId: "credential" },
    });

    expect(res.status).toBe(200);
    expect(providersOf("buyer@example.com")).toEqual(["google"]);
  });

  it("leaves unlinking a provider alone", async () => {
    const caller = await createAccount("staff@example.com", {
      password: true,
      google: true,
      twoFactorEnabled: true,
    });

    const res = await request("/unlink-account", {
      cookie: caller.cookie,
      body: { providerId: "google" },
    });

    expect(res.status).toBe(200);
    expect(providersOf("staff@example.com")).toEqual(["credential"]);
  });
});

describe("a two-factor account cannot delete its last passkey without a password", () => {
  it.each([
    ["the browser's cookie", (c: Caller) => ({ cookie: c.cookie })],
    ["a native app's Bearer token", (c: Caller) => ({ bearer: c.bearer })],
  ])("refuses /passkey/delete-passkey for the only passkey (%s)", async (_label, as) => {
    const caller = await createAccount("staff@example.com", {
      password: false,
      google: true,
      passkeys: ["pk1"],
      twoFactorEnabled: true,
    });

    await expectRefused(
      await request("/passkey/delete-passkey", {
        ...as(caller),
        body: { id: "pk1" },
      }),
      TWO_FACTOR_KEEPS_PASSKEY_ERROR,
    );
    expect(passkeysOf("staff@example.com")).toEqual(["pk1"]);
  });

  it("allows deleting one of two, then refuses the last", async () => {
    const caller = await createAccount("staff@example.com", {
      password: false,
      google: true,
      passkeys: ["pk1", "pk2"],
      twoFactorEnabled: true,
    });

    const first = await request("/passkey/delete-passkey", {
      cookie: caller.cookie,
      body: { id: "pk1" },
    });
    expect(first.status).toBe(200);
    expect(passkeysOf("staff@example.com")).toEqual(["pk2"]);

    await expectRefused(
      await request("/passkey/delete-passkey", {
        cookie: caller.cookie,
        body: { id: "pk2" },
      }),
      TWO_FACTOR_KEEPS_PASSKEY_ERROR,
    );
    expect(passkeysOf("staff@example.com")).toEqual(["pk2"]);
  });

  it.each([
    ["the account has a password", { password: true, twoFactorEnabled: true }],
    ["two-factor is off", { password: false, twoFactorEnabled: false }],
  ])("allows deleting the only passkey when %s", async (_label, flags) => {
    const caller = await createAccount("staff@example.com", {
      ...flags,
      google: true,
      passkeys: ["pk1"],
    });

    const res = await request("/passkey/delete-passkey", {
      cookie: caller.cookie,
      body: { id: "pk1" },
    });

    expect(res.status).toBe(200);
    expect(passkeysOf("staff@example.com")).toEqual([]);
  });

  it("someone else's passkey id is the plugin's to refuse, and stays", async () => {
    await createAccount("other@example.com", {
      password: true,
      passkeys: ["theirs"],
    });
    const caller = await createAccount("staff@example.com", {
      password: false,
      google: true,
      passkeys: ["pk1"],
      twoFactorEnabled: true,
    });

    const res = await request("/passkey/delete-passkey", {
      cookie: caller.cookie,
      body: { id: "theirs" },
    });

    expect(res.status).not.toBe(200);
    expect(passkeysOf("other@example.com")).toEqual(["theirs"]);
    expect(passkeysOf("staff@example.com")).toEqual(["pk1"]);
  });
});

describe("refuseTwoFactorWithoutPrimarySignIn", () => {
  const contextFor = (
    user: unknown,
    extra: { accounts?: unknown[]; passkeys?: unknown[] } = {},
  ) => ({
    internalAdapter: {
      findUserById: vi.fn(async () => user),
      findAccounts: vi.fn(async () => extra.accounts ?? []),
    },
    adapter: {
      findMany: vi.fn(async () => extra.passkeys ?? []),
      findOne: vi.fn(async () => null),
    },
  });
  const signedIn = { sessionUserId: async () => "u1" };

  it("does not read the session on any other route", async () => {
    const sessionUserId = vi.fn(async () => "u1");
    await refuseTwoFactorWithoutPrimarySignIn(
      { path: "/sign-in/email", context: contextFor({}) },
      { sessionUserId },
    );
    await refuseTwoFactorWithoutPrimarySignIn(
      {
        path: "/unlink-account",
        body: { providerId: "google" },
        context: contextFor({}),
      },
      { sessionUserId },
    );
    expect(sessionUserId).not.toHaveBeenCalled();
  });

  it("does nothing without a session", async () => {
    const context = contextFor({ twoFactorEnabled: false });
    await refuseTwoFactorWithoutPrimarySignIn(
      { path: "/two-factor/verify-otp", context },
      { sessionUserId: async () => null },
    );
    expect(context.internalAdapter.findUserById).not.toHaveBeenCalled();
  });

  it("a credential row without a password does not count as one", async () => {
    const context = contextFor(
      { twoFactorEnabled: false },
      { accounts: [{ providerId: "credential", password: null }] },
    );
    await expect(
      refuseTwoFactorWithoutPrimarySignIn(
        { path: "/two-factor/send-otp", context },
        signedIn,
      ),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: { ...TWO_FACTOR_NEEDS_PRIMARY_SIGN_IN_ERROR },
    });
  });

  it.each([
    ["the session cannot be read", () => ({
      ctx: { path: "/two-factor/send-otp", context: contextFor({}) },
      opts: {
        sessionUserId: async () => {
          throw new Error("db down");
        },
      },
      authUserId: null,
    })],
    ["the user lookup fails", () => {
      const context = contextFor({ twoFactorEnabled: false });
      context.internalAdapter.findUserById.mockRejectedValue(
        new Error("db down"),
      );
      return {
        ctx: { path: "/two-factor/verify-otp", context },
        opts: signedIn,
        authUserId: "u1",
      };
    }],
    ["the account lookup fails", () => {
      const context = contextFor({ twoFactorEnabled: true });
      context.internalAdapter.findAccounts.mockRejectedValue(
        new Error("db down"),
      );
      return {
        ctx: {
          path: "/unlink-account",
          body: { providerId: "credential" },
          context,
        },
        opts: signedIn,
        authUserId: "u1",
      };
    }],
    ["the passkey lookup fails", () => {
      const context = contextFor({ twoFactorEnabled: true });
      context.adapter.findMany.mockRejectedValue(new Error("db down"));
      return {
        ctx: {
          path: "/passkey/delete-passkey",
          body: { id: "pk1" },
          context,
        },
        opts: signedIn,
        authUserId: "u1",
      };
    }],
    ["there is no database adapter on the context", () => ({
      ctx: { path: "/two-factor/send-otp" },
      opts: signedIn,
      authUserId: "u1",
    })],
  ])("fails closed and reports once when %s", async (_label, build) => {
    const report = vi.fn();
    const { ctx, opts, authUserId } = build();
    const thrown = await refuseTwoFactorWithoutPrimarySignIn(ctx, {
      ...opts,
      reportError: report,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(APIError);
    expect(thrown).toMatchObject({ status: "INTERNAL_SERVER_ERROR" });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.any(Error), {
      tags: { area: "auth", op: "two_factor_prerequisite_lookup" },
      extra: { authUserId, path: ctx.path },
    });
  });

  it("a throwing reporter does not change the outcome", async () => {
    await expect(
      refuseTwoFactorWithoutPrimarySignIn(
        { path: "/two-factor/send-otp" },
        {
          ...signedIn,
          reportError: () => {
            throw new Error("reporter down");
          },
        },
      ),
    ).rejects.toMatchObject({ status: "INTERNAL_SERVER_ERROR" });
  });
});
