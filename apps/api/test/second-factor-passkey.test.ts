import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  refuseSecondFactorBypassSession,
  refuseUnverifiedPasskeyForTwoFactor,
} from "../src/auth/second-factor-bypass";

/**
 * A passkey stands in for a two-factor account's second factor only when it
 * verified the user (PIN or biometric).
 *
 * A REAL `betterAuth()` (memory adapter) with the passkey plugin configured
 * as production has it (`authentication.afterVerification` is
 * `refuseUnverifiedPasskeyForTwoFactor`), driven through `auth.handler`. The
 * authenticator is software: a P-256 key whose assertions are built and
 * signed here, so the plugin's own `verifyAuthenticationResponse` runs for
 * real and the only thing a test chooses is the UV flag.
 */

const WEB_URL = "https://ithasfire.com";
const BASE_URL = "https://api.ithasfire.com";
const AUTH_BASE = `${BASE_URL}/api/auth`;
const RP_ID = "ithasfire.com";
const PASSWORD = "correct-horse-battery-staple";

type Row = Record<string, unknown>;
type MemoryDb = Record<string, Row[]>;

let db: MemoryDb;
let hookPaths: Array<string | undefined>;
const reportError = vi.fn();
/** `Human.roles` by auth user id: what the production `staffRolesOf` reads. */
const staffRoles = new Map<string, string[]>();
const staffRolesOf = async (authUserId: string) =>
  staffRoles.get(authUserId) ?? [];

const buildAuth = (opts: { checkUserVerification: boolean }) =>
  betterAuth({
    baseURL: BASE_URL,
    secret: "test-secret-test-secret-test-secret-32",
    database: memoryAdapter(db),
    trustedOrigins: [BASE_URL, WEB_URL],
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    logger: { disabled: true },
    plugins: [
      twoFactor({ issuer: "Test" }),
      passkey({
        rpID: RP_ID,
        rpName: "Test",
        origin: WEB_URL,
        ...(opts.checkUserVerification
          ? {
              // The production option (apps/api/src/auth/better-auth.ts).
              authentication: {
                afterVerification: (verified) =>
                  refuseUnverifiedPasskeyForTwoFactor(verified, {
                    reportError,
                    staffRolesOf,
                  }),
              },
            }
          : {}),
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            hookPaths.push((ctx as { path?: string } | null)?.path);
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

const request = (
  method: "GET" | "POST",
  path: string,
  init: { body?: unknown; cookie?: string } = {},
) =>
  auth.handler(
    new Request(`${AUTH_BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: WEB_URL,
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
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

const sessionCookieFrom = (response: Response): string | undefined =>
  cookiesFrom(response)
    .split("; ")
    .find((c) => /session_token=.+/.test(c));

const userRow = (email: string): Row => {
  const row = db.user!.find((u) => u.email === email);
  if (!row) throw new Error(`no user ${email}`);
  return row;
};

const sessionsOf = (email: string) =>
  db.session!.filter((s) => s.userId === userRow(email).id).length;

const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest();

/** A software authenticator holding one P-256 credential. */
const softwareAuthenticator = (credentialId: string) => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" });
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}.
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(jwk.y!, "base64url"),
  ]);
  let counter = 0;
  return {
    credentialId,
    /** What the plugin stores as `passkey.publicKey`. */
    storedPublicKey: cose.toString("base64"),
    assert(challenge: string, flags: { userVerified: boolean }) {
      counter += 1;
      const counterBytes = Buffer.alloc(4);
      counterBytes.writeUInt32BE(counter);
      const authenticatorData = Buffer.concat([
        sha256(RP_ID),
        // UP (user present) always; UV (user verified) as asked.
        Buffer.from([0x01 | (flags.userVerified ? 0x04 : 0x00)]),
        counterBytes,
      ]);
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge,
          origin: WEB_URL,
          crossOrigin: false,
        }),
      );
      const signature = sign(
        "sha256",
        Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
        privateKey,
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientDataJSON.toString("base64url"),
          authenticatorData: authenticatorData.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      };
    },
  };
};

/** A password account with one registered passkey. */
const createAccountWithPasskey = async (
  email: string,
  flags: { twoFactorEnabled: boolean },
) => {
  const signUp = await request("POST", "/sign-up/email", {
    body: { email, password: PASSWORD, name: email.split("@")[0] },
  });
  expect(signUp.status).toBe(200);
  Object.assign(userRow(email), { ...flags, emailVerified: true });
  const authenticator = softwareAuthenticator(
    Buffer.from(`credential-${email}`).toString("base64url"),
  );
  db.passkey!.push({
    id: `pk-${email}`,
    name: "Test key",
    userId: userRow(email).id,
    credentialID: authenticator.credentialId,
    publicKey: authenticator.storedPublicKey,
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    transports: "usb",
    createdAt: new Date(),
  });
  return authenticator;
};

const signInWithPasskey = async (
  authenticator: ReturnType<typeof softwareAuthenticator>,
  flags: { userVerified: boolean },
) => {
  const options = await request("GET", "/passkey/generate-authenticate-options");
  expect(options.status).toBe(200);
  const { challenge, userVerification } = (await options.json()) as {
    challenge: string;
    userVerification: string;
  };
  // The plugin only prefers user verification; it does not require it.
  expect(userVerification).toBe("preferred");
  return request("POST", "/passkey/verify-authentication", {
    body: { response: authenticator.assert(challenge, flags) },
    cookie: cookiesFrom(options),
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
  hookPaths = [];
  reportError.mockReset();
  staffRoles.clear();
  auth = buildAuth({ checkUserVerification: true });
});

describe("passkey sign-in and user verification", () => {
  it("refuses a two-factor account whose passkey did not verify the user: no session, no cookie", async () => {
    const authenticator = await createAccountWithPasskey("staff@example.com", {
      twoFactorEnabled: true,
    });
    const before = sessionsOf("staff@example.com");
    hookPaths = [];

    const res = await signInWithPasskey(authenticator, { userVerified: false });

    // The plugin answers every failure inside its verification with this.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "AUTHENTICATION_FAILED",
    );
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect(sessionsOf("staff@example.com")).toBe(before);
    // Refused before `createSession`: the session hook never ran.
    expect(hookPaths).toEqual([]);
    // A refusal, not a failure: nothing to report.
    expect(reportError).not.toHaveBeenCalled();
  });

  it("signs in a two-factor account whose passkey verified the user", async () => {
    const authenticator = await createAccountWithPasskey("staff@example.com", {
      twoFactorEnabled: true,
    });
    const before = sessionsOf("staff@example.com");

    const res = await signInWithPasskey(authenticator, { userVerified: true });

    expect(res.status).toBe(200);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(sessionsOf("staff@example.com")).toBe(before + 1);
    expect(hookPaths.at(-1)).toBe("/passkey/verify-authentication");
  });

  it("signs in an account WITHOUT two-factor whose passkey did not verify the user", async () => {
    const authenticator = await createAccountWithPasskey("buyer@example.com", {
      twoFactorEnabled: false,
    });
    const before = sessionsOf("buyer@example.com");

    const res = await signInWithPasskey(authenticator, { userVerified: false });

    expect(res.status).toBe(200);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(sessionsOf("buyer@example.com")).toBe(before + 1);
  });

  it("refuses a STAFF account (no two-factor) whose passkey did not verify the user", async () => {
    const authenticator = await createAccountWithPasskey("staff@example.com", {
      twoFactorEnabled: false,
    });
    staffRoles.set(userRow("staff@example.com").id as string, ["ADMIN"]);
    const before = sessionsOf("staff@example.com");
    hookPaths = [];

    const res = await signInWithPasskey(authenticator, { userVerified: false });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "AUTHENTICATION_FAILED",
    );
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect(sessionsOf("staff@example.com")).toBe(before);
    expect(hookPaths).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("signs in a STAFF account (no two-factor) whose passkey verified the user: its one way in", async () => {
    const authenticator = await createAccountWithPasskey("staff@example.com", {
      twoFactorEnabled: false,
    });
    staffRoles.set(userRow("staff@example.com").id as string, ["ADMIN"]);
    const before = sessionsOf("staff@example.com");

    const res = await signInWithPasskey(authenticator, { userVerified: true });

    expect(res.status).toBe(200);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(sessionsOf("staff@example.com")).toBe(before + 1);
    expect(hookPaths.at(-1)).toBe("/passkey/verify-authentication");
    // ...and the same account's password is refused.
    const password = await request("POST", "/sign-in/email", {
      body: { email: "staff@example.com", password: PASSWORD },
    });
    expect(password.status).toBe(400);
    expect(((await password.json()) as { code?: string }).code).toBe(
      "STAFF_ACCOUNT_USE_PASSKEY",
    );
  });

  it("without the check, the plugin signs that two-factor account in with a touch (why the check exists)", async () => {
    auth = buildAuth({ checkUserVerification: false });
    const authenticator = await createAccountWithPasskey("staff@example.com", {
      twoFactorEnabled: true,
    });

    const res = await signInWithPasskey(authenticator, { userVerified: false });

    expect(res.status).toBe(200);
    expect(sessionCookieFrom(res)).toBeTruthy();
  });

  it("a forged assertion is still the plugin's to refuse", async () => {
    const authenticator = await createAccountWithPasskey("staff@example.com", {
      twoFactorEnabled: true,
    });
    const other = softwareAuthenticator(authenticator.credentialId);

    const res = await signInWithPasskey(other, { userVerified: true });

    expect(res.status).toBe(400);
    expect(sessionCookieFrom(res)).toBeUndefined();
  });
});

describe("refuseUnverifiedPasskeyForTwoFactor", () => {
  const contextFor = (passkeyRow: unknown, user: unknown) => ({
    internalAdapter: {
      findUserById: vi.fn(async () => user),
      findAccounts: vi.fn(async () => []),
    },
    adapter: {
      findMany: vi.fn(async () => []),
      findOne: vi.fn(async () => passkeyRow),
    },
  });
  const unverified = { authenticationInfo: { userVerified: false } };
  const noStaff = { staffRolesOf: async (): Promise<string[]> => [] };

  it("does not look anything up when the passkey verified the user", async () => {
    const context = contextFor({ userId: "u1" }, { twoFactorEnabled: true });
    await refuseUnverifiedPasskeyForTwoFactor({
      ctx: { context },
      verification: { authenticationInfo: { userVerified: true } },
      clientData: { id: "cred-1" },
    }, noStaff);
    expect(context.adapter.findOne).not.toHaveBeenCalled();
  });

  it("finds the user through the credential id", async () => {
    const context = contextFor({ userId: "u1" }, { twoFactorEnabled: true });
    await expect(
      refuseUnverifiedPasskeyForTwoFactor({
        ctx: { context },
        verification: unverified,
        clientData: { id: "cred-1" },
      }, noStaff),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    expect(context.adapter.findOne).toHaveBeenCalledWith({
      model: "passkey",
      where: [{ field: "credentialID", value: "cred-1" }],
    });
    expect(context.internalAdapter.findUserById).toHaveBeenCalledWith("u1");
  });

  it("treats a missing userVerified flag as not verified", async () => {
    const context = contextFor({ userId: "u1" }, { twoFactorEnabled: true });
    await expect(
      refuseUnverifiedPasskeyForTwoFactor({
        ctx: { context },
        verification: {},
        clientData: { id: "cred-1" },
      }, noStaff),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
  });

  it("lets an account without two-factor through", async () => {
    const context = contextFor({ userId: "u1" }, { twoFactorEnabled: false });
    await refuseUnverifiedPasskeyForTwoFactor({
      ctx: { context },
      verification: unverified,
      clientData: { id: "cred-1" },
    }, noStaff);
  });

  it("refuses a staff account without two-factor", async () => {
    const context = contextFor({ userId: "u1" }, { twoFactorEnabled: false });
    const staffRolesOf = vi.fn(async () => ["REVIEWER"]);
    await expect(
      refuseUnverifiedPasskeyForTwoFactor(
        { ctx: { context }, verification: unverified, clientData: { id: "cred-1" } },
        { staffRolesOf },
      ),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    expect(staffRolesOf).toHaveBeenCalledWith("u1");
  });

  it("lets a USER-role account without two-factor through", async () => {
    const context = contextFor({ userId: "u1" }, { twoFactorEnabled: false });
    await refuseUnverifiedPasskeyForTwoFactor(
      { ctx: { context }, verification: unverified, clientData: { id: "cred-1" } },
      { staffRolesOf: async () => ["USER"] },
    );
  });

  it("fails closed and reports once when the staff-role lookup fails", async () => {
    const report = vi.fn();
    const context = contextFor({ userId: "u1" }, { twoFactorEnabled: false });
    await expect(
      refuseUnverifiedPasskeyForTwoFactor(
        { ctx: { context }, verification: unverified, clientData: { id: "cred-1" } },
        {
          reportError: report,
          staffRolesOf: async () => {
            throw new Error("db down");
          },
        },
      ),
    ).rejects.toMatchObject({ status: "INTERNAL_SERVER_ERROR" });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the passkey lookup fails", () => {
      const context = contextFor({ userId: "u1" }, { twoFactorEnabled: true });
      context.adapter.findOne.mockRejectedValue(new Error("db down"));
      return { context };
    }],
    ["the user lookup fails", () => {
      const context = contextFor({ userId: "u1" }, { twoFactorEnabled: true });
      context.internalAdapter.findUserById.mockRejectedValue(
        new Error("db down"),
      );
      return { context };
    }],
    ["the passkey row is gone", () => ({
      context: contextFor(null, { twoFactorEnabled: true }),
    })],
    ["the user row is gone", () => ({
      context: contextFor({ userId: "u1" }, null),
    })],
    ["there is no endpoint context", () => ({})],
  ])("fails closed and reports once when %s", async (_label, build) => {
    const report = vi.fn();
    const thrown = await refuseUnverifiedPasskeyForTwoFactor(
      { ctx: build(), verification: unverified, clientData: { id: "cred-1" } },
      { reportError: report, staffRolesOf: noStaff.staffRolesOf },
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(APIError);
    expect(thrown).toMatchObject({ status: "INTERNAL_SERVER_ERROR" });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.any(Error), {
      tags: { area: "auth", op: "second_factor_passkey_lookup" },
      extra: { credentialId: "cred-1" },
    });
  });

  it("a throwing reporter does not change the outcome", async () => {
    await expect(
      refuseUnverifiedPasskeyForTwoFactor(
        { ctx: {}, verification: unverified, clientData: { id: "cred-1" } },
        {
          ...noStaff,
          reportError: () => {
            throw new Error("reporter down");
          },
        },
      ),
    ).rejects.toMatchObject({ status: "INTERNAL_SERVER_ERROR" });
  });
});
