import { passkey } from "@better-auth/passkey";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError, createAuthEndpoint } from "better-auth/api";
import {
  emailOTP,
  magicLink,
  phoneNumber,
  twoFactor,
  username,
} from "better-auth/plugins";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { SECOND_FACTOR_STAFF_ROLES } from "@th/ports/authz";

import {
  isOwnInboxVerification,
  resolveEmailProofTrigger,
  revokeUnprovenCredentials,
} from "../src/auth/account-security";
import {
  bypassesSecondFactor,
  refuseSecondFactorBypassSession,
  SECOND_FACTOR_SATISFIED_ROUTES,
  secondFactorRefusalRedirect,
  sessionUserIdOf,
  STAFF_PASSKEY_ROUTES,
  STAFF_USE_PASSKEY_ERROR,
  TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR,
} from "../src/auth/second-factor-bypass";
import {
  memoryEmailProofAuthUserId,
  memorySweepDeps,
} from "./helpers/memory-unproven-sweep";

/**
 * A two-factor account gets a session only on a route that passed its second
 * factor (or is a strong factor on its own).
 *
 * Better Auth's twoFactor plugin raises its challenge only for
 * `/sign-in/email|username|phone-number`; every other session-minting route
 * hands a `twoFactorEnabled` account a FULL session. These tests build a REAL
 * `betterAuth()` (memory adapter, the app's sign-in plugins) and drive real
 * requests through `auth.handler`, with the production
 * `refuseSecondFactorBypassSession` as the `session.create.before` hook. The
 * Google / Apple routes are in `second-factor-bypass-oauth.test.ts`, the
 * password-or-passkey prerequisites in
 * `second-factor-prerequisites.test.ts`, the passkey user-verification check
 * in `second-factor-passkey.test.ts`, and `second-factor-wiring.test.ts`
 * calls the hooks of the real `better-auth.ts` config.
 *
 * The squatter case also needs the production `user.update.before` sweep,
 * which clears an unverified account's two-factor enrolment before the
 * email-proof session is created. `user.update.before` here is that hook's
 * sweep: the production trigger detector (`resolveEmailProofTrigger`) and
 * the production `revokeUnprovenCredentials`, with the Prisma writes done
 * against the memory rows (`./helpers/memory-unproven-sweep`).
 */

const BASE_URL = "https://api.ithasfire.com";
const WEB_URL = "https://ithasfire.com";
const AUTH_BASE = `${BASE_URL}/api/auth`;
const PASSWORD = "correct-horse-battery-staple";

type Row = Record<string, unknown>;
type MemoryDb = Record<string, Row[]>;

let db: MemoryDb;
let mailedLinks: Map<string, string>;
let textedCodes: Map<string, string>;
let mailedOtps: Map<string, string>;
let twoFactorOtps: Map<string, string>;
/** `ctx.path` of every `session.create.before` call, in order. */
let hookPaths: Array<string | undefined>;
const reportError = vi.fn();
/** `Human.roles` by auth user id: what the production `staffRolesOf` reads. */
const staffRoles = new Map<string, string[]>();
const staffRolesOf = async (authUserId: string) =>
  staffRoles.get(authUserId) ?? [];

/**
 * A session-minting route nobody listed: what a plugin added later, or an
 * upgrade, would look like to the hook.
 */
const unlistedSessionRoute = {
  id: "unlisted-session-route",
  endpoints: {
    mintSession: createAuthEndpoint(
      "/later-plugin/sign-in",
      { method: "POST", body: z.object({ userId: z.string() }) },
      async (ctx) => {
        const session = await ctx.context.internalAdapter.createSession(
          ctx.body.userId,
        );
        return ctx.json({ token: session.token });
      },
    ),
  },
};

const buildAuth = () =>
  betterAuth({
    baseURL: BASE_URL,
    secret: "test-secret-test-secret-test-secret-32",
    database: memoryAdapter(db),
    trustedOrigins: [BASE_URL, "ithasfire-scanner://"],
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    plugins: [
      username(),
      twoFactor({
        issuer: "Test",
        otpOptions: {
          sendOTP: async ({ user, otp }) => {
            twoFactorOtps.set(user.email, otp);
          },
        },
      }),
      emailOTP({
        disableSignUp: true,
        sendVerificationOTP: async ({ email, otp }) => {
          mailedOtps.set(email, otp);
        },
      }),
      passkey({ rpID: "ithasfire.com", rpName: "Test", origin: WEB_URL }),
      magicLink({
        disableSignUp: true,
        sendMagicLink: async ({ email, url }) => {
          mailedLinks.set(email, url);
        },
      }),
      phoneNumber({
        sendOTP: async ({ phoneNumber: number, code }) => {
          textedCodes.set(number, code);
        },
      }),
      unlistedSessionRoute,
    ],
    databaseHooks: {
      session: {
        create: {
          // The production hook body (apps/api/src/auth/better-auth.ts).
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
      user: {
        update: {
          // The production hook's sweep (see header). Like production it
          // returns nothing: the sweep writes the row itself.
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
            await revokeUnprovenCredentials(memorySweepDeps(() => db), {
              authUserId,
              trigger,
            });
          },
        },
      },
    },
  });

let auth: ReturnType<typeof buildAuth>;

const request = (
  method: "GET" | "POST",
  pathOrUrl: string,
  init: { body?: unknown; cookie?: string } = {},
) =>
  auth.handler(
    new Request(
      pathOrUrl.startsWith("http") ? pathOrUrl : `${AUTH_BASE}${pathOrUrl}`,
      {
        method,
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
    ),
  );

/**
 * The cookies a browser holds after this response, as a Cookie header:
 * Set-Cookie headers applied in order, a later deletion winning. (A challenged
 * password sign-in sets the session cookie and then deletes it.)
 */
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

/** Sign up, then set the account's flags directly. Returns the sign-up cookie. */
const createAccount = async (
  email: string,
  flags: {
    twoFactorEnabled: boolean;
    emailVerified: boolean;
    phoneNumber?: string;
    username?: string;
  },
): Promise<string> => {
  const res = await request("POST", "/sign-up/email", {
    body: {
      email,
      password: PASSWORD,
      name: email.split("@")[0],
      ...(flags.username ? { username: flags.username } : {}),
    },
  });
  expect(res.status).toBe(200);
  const cookie = sessionCookieFrom(res);
  expect(cookie).toBeTruthy();
  Object.assign(userRow(email), {
    twoFactorEnabled: flags.twoFactorEnabled,
    emailVerified: flags.emailVerified,
    ...(flags.phoneNumber
      ? { phoneNumber: flags.phoneNumber, phoneNumberVerified: true }
      : {}),
  });
  return cookie!;
};

/**
 * Enrol a TOTP authenticator the way the web does: `/two-factor/enable` with
 * the password, then the first `/two-factor/verify-totp`. Returns a function
 * producing the current code, the backup codes, and the session cookie the
 * enrolment rotated to.
 */
const enrolTotp = async (email: string) => {
  const signUpCookie = await createAccount(email, {
    twoFactorEnabled: false,
    emailVerified: true,
  });
  const enable = await request("POST", "/two-factor/enable", {
    body: { password: PASSWORD },
    cookie: signUpCookie,
  });
  expect(enable.status).toBe(200);
  const { totpURI, backupCodes } = (await enable.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  const secret = new TextDecoder().decode(
    base32.decode(new URL(totpURI).searchParams.get("secret")!),
  );
  const currentCode = () => createOTP(secret).totp();
  const verify = await request("POST", "/two-factor/verify-totp", {
    body: { code: await currentCode() },
    cookie: signUpCookie,
  });
  expect(verify.status).toBe(200);
  expect(userRow(email).twoFactorEnabled).toBe(true);
  const cookie = sessionCookieFrom(verify);
  expect(cookie).toBeTruthy();
  return { currentCode, backupCodes, cookie: cookie! };
};

/** Password sign-in for a two-factor account: the challenge, and its cookie. */
const passwordChallenge = async (email: string, cookie?: string) => {
  const res = await request("POST", "/sign-in/email", {
    body: { email, password: PASSWORD },
    cookie,
  });
  expect(res.status).toBe(200);
  return {
    body: (await res.json()) as {
      twoFactorRedirect?: boolean;
      token?: string;
    },
    cookies: cookiesFrom(res),
    sessionCookie: sessionCookieFrom(res),
  };
};

const followMagicLink = async (
  email: string,
  callbacks: { callbackURL?: string; errorCallbackURL?: string } = {},
  opts: { stripCallbackURL?: boolean } = {},
) => {
  const send = await request("POST", "/sign-in/magic-link", {
    body: { email, ...callbacks },
  });
  expect(send.status).toBe(200);
  const url = new URL(mailedLinks.get(email)!);
  // The mailed link always carries `callbackURL` (the plugin defaults it to
  // "/"); a JSON caller (`authClient.magicLink.verify`) sends only the token.
  if (opts.stripCallbackURL) url.searchParams.delete("callbackURL");
  return request("GET", url.toString());
};

const signInByPhone = async (
  number: string,
  extra: Record<string, unknown> = {},
  cookie?: string,
) => {
  const send = await request("POST", "/phone-number/send-otp", {
    body: { phoneNumber: number },
  });
  expect(send.status).toBe(200);
  return request("POST", "/phone-number/verify", {
    body: { phoneNumber: number, code: textedCodes.get(number), ...extra },
    cookie,
  });
};

const expectRefusedJson = async (res: Response) => {
  expect(res.status).toBe(400);
  const body = (await res.json()) as { code?: string; message?: string };
  expect(body.code).toBe(TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR.code);
  expect(body.message).toBe(TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR.message);
  expect(sessionCookieFrom(res)).toBeUndefined();
};

/**
 * Someone registers an address they never proved, sets a password and turns
 * two-factor on with their own authenticator. Leaves their session open.
 */
const squatOn = async (email: string) => {
  await createAccount(email, { twoFactorEnabled: true, emailVerified: false });
  db.twoFactor!.push({
    id: `tf-${email}`,
    userId: userRow(email).id,
    secret: "squatter-secret",
    backupCodes: "squatter-codes",
    verified: true,
  });
  expect(sessionsOf(email)).toBe(1);
};

/** The inbox owner holds the account and nothing of the squatter's is left. */
const expectTakenOver = (email: string) => {
  const row = userRow(email);
  expect(row.emailVerified).toBe(true);
  expect(row.twoFactorEnabled).toBe(false);
  expect(db.twoFactor!.filter((t) => t.userId === row.id)).toEqual([]);
  // The squatter's password and session are gone; the one session left is
  // the owner's new one.
  expect(db.account!.filter((a) => a.userId === row.id)).toEqual([]);
  expect(sessionsOf(email)).toBe(1);
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
  mailedLinks = new Map();
  textedCodes = new Map();
  mailedOtps = new Map();
  twoFactorOtps = new Map();
  hookPaths = [];
  reportError.mockReset();
  staffRoles.clear();
  auth = buildAuth();
});

describe("magic-link verify for a two-factor account", () => {
  it("refuses a VERIFIED TOTP account (mailed link: redirect to errorCallbackURL with the code)", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    const before = sessionsOf("staff@example.com");

    const res = await followMagicLink("staff@example.com", {
      callbackURL: "ithasfire-scanner://auth-callback",
      errorCallbackURL: "ithasfire-scanner://auth-error",
    });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(`${location.protocol}//${location.host}`).toBe(
      "ithasfire-scanner://auth-error",
    );
    expect(location.searchParams.get("error")).toBe(
      TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR.code,
    );
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect(sessionsOf("staff@example.com")).toBe(before);
    // The hook saw the sign-in on the plugin's route template.
    expect(hookPaths.at(-1)).toBe("/magic-link/verify");
  });

  it("refuses a VERIFIED TOTP account (JSON caller: the 400 refusal body)", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    const before = sessionsOf("staff@example.com");

    const res = await followMagicLink(
      "staff@example.com",
      {},
      { stripCallbackURL: true },
    );

    await expectRefusedJson(res);
    expect(sessionsOf("staff@example.com")).toBe(before);
  });

  it("signs in an account without 2FA", async () => {
    await createAccount("buyer@example.com", {
      twoFactorEnabled: false,
      emailVerified: true,
    });
    const before = sessionsOf("buyer@example.com");

    const res = await followMagicLink("buyer@example.com", {
      callbackURL: "/done",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/done`);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(sessionsOf("buyer@example.com")).toBe(before + 1);
  });

  it("the inbox owner takes over an UNVERIFIED two-factor account someone else registered: the enrolment is swept, then the session is created", async () => {
    await squatOn("victim@example.com");

    const res = await followMagicLink("victim@example.com", {
      callbackURL: "/done",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/done`);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expectTakenOver("victim@example.com");
    expect(hookPaths.at(-1)).toBe("/magic-link/verify");
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("phone-number verify for a two-factor account", () => {
  it("refuses phone SIGN-IN for a verified TOTP account", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
      phoneNumber: "+15555550101",
    });
    const before = sessionsOf("staff@example.com");

    const res = await signInByPhone("+15555550101");

    await expectRefusedJson(res);
    expect(sessionsOf("staff@example.com")).toBe(before);
    expect(hookPaths.at(-1)).toBe("/phone-number/verify");
  });

  it("refuses phone SIGN-IN for a TOTP account even when its email is unverified (proving a SIM evicts nobody)", async () => {
    await createAccount("unverified@example.com", {
      twoFactorEnabled: true,
      emailVerified: false,
      phoneNumber: "+15555550102",
    });
    const before = sessionsOf("unverified@example.com");

    const res = await signInByPhone("+15555550102");

    await expectRefusedJson(res);
    expect(sessionsOf("unverified@example.com")).toBe(before);
  });

  it("signs in an account without 2FA by phone", async () => {
    await createAccount("buyer@example.com", {
      twoFactorEnabled: false,
      emailVerified: true,
      phoneNumber: "+15555550103",
    });
    const before = sessionsOf("buyer@example.com");

    const res = await signInByPhone("+15555550103");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: string }).token).toBeTruthy();
    expect(sessionsOf("buyer@example.com")).toBe(before + 1);
  });

  it("leaves a signed-in TOTP user's own number verification alone (updatePhoneNumber never reaches the hook)", async () => {
    const cookie = await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    const before = sessionsOf("staff@example.com");
    const hookCalls = hookPaths.length;

    const res = await signInByPhone(
      "+15555550104",
      { updatePhoneNumber: true },
      cookie,
    );

    expect(res.status).toBe(200);
    expect(userRow("staff@example.com").phoneNumber).toBe("+15555550104");
    expect(userRow("staff@example.com").phoneNumberVerified).toBe(true);
    expect(sessionsOf("staff@example.com")).toBe(before);
    expect(hookPaths.length).toBe(hookCalls);
  });

  it("leaves session-less verification alone (disableSession never reaches the hook)", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
      phoneNumber: "+15555550105",
    });
    const before = sessionsOf("staff@example.com");
    const hookCalls = hookPaths.length;

    const res = await signInByPhone("+15555550105", { disableSession: true });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: unknown }).token).toBeNull();
    expect(sessionsOf("staff@example.com")).toBe(before);
    expect(hookPaths.length).toBe(hookCalls);
  });
});

describe("email-code sign-in for a two-factor account", () => {
  const signInByEmailCode = async (email: string) => {
    const send = await request("POST", "/email-otp/send-verification-otp", {
      body: { email, type: "sign-in" },
    });
    expect(send.status).toBe(200);
    return request("POST", "/sign-in/email-otp", {
      body: { email, otp: mailedOtps.get(email) },
    });
  };

  it("refuses a verified TOTP account", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    await expectRefusedJson(await signInByEmailCode("staff@example.com"));
    expect(hookPaths.at(-1)).toBe("/sign-in/email-otp");
  });

  it("refuses only after the mailed code was proven (a wrong code learns nothing about the account)", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    await createAccount("buyer@example.com", {
      twoFactorEnabled: false,
      emailVerified: true,
    });
    const wrongCodeFor = async (email: string) => {
      await request("POST", "/email-otp/send-verification-otp", {
        body: { email, type: "sign-in" },
      });
      const res = await request("POST", "/sign-in/email-otp", {
        body: { email, otp: "000000" },
      });
      return { status: res.status, body: await res.json() };
    };
    hookPaths = [];

    const twoFactor = await wrongCodeFor("staff@example.com");
    const plain = await wrongCodeFor("buyer@example.com");

    expect(twoFactor).toEqual(plain);
    expect(twoFactor.status).toBe(400);
    expect(hookPaths).toEqual([]);
  });

  it("signs in an account without 2FA", async () => {
    await createAccount("buyer@example.com", {
      twoFactorEnabled: false,
      emailVerified: true,
    });
    const res = await signInByEmailCode("buyer@example.com");
    expect(res.status).toBe(200);
    expect(sessionCookieFrom(res)).toBeTruthy();
  });

  it("the inbox owner takes over an UNVERIFIED two-factor account someone else registered: the enrolment is swept, then the session is created", async () => {
    await squatOn("victim@example.com");

    const res = await signInByEmailCode("victim@example.com");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: string }).token).toBeTruthy();
    expect(sessionCookieFrom(res)).toBeTruthy();
    expectTakenOver("victim@example.com");
    expect(hookPaths.at(-1)).toBe("/sign-in/email-otp");
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("password sign-in: the plugin's challenge, not this refusal", () => {
  // The three first-factor routes on the allowlist are safe ONLY because the
  // twoFactor plugin deletes the session they mint. These pin that, per
  // route: an upgrade that drops one from the plugin's matcher fails here.
  it.each([
    [
      "/sign-in/email",
      { email: "staff@example.com", password: PASSWORD },
    ],
    ["/sign-in/username", { username: "staffer", password: PASSWORD }],
    [
      "/sign-in/phone-number",
      { phoneNumber: "+15555550110", password: PASSWORD },
    ],
  ] as const)(
    "%s answers the challenge and leaves no session behind",
    async (path, body) => {
      await createAccount("staff@example.com", {
        twoFactorEnabled: true,
        emailVerified: true,
        phoneNumber: "+15555550110",
        username: "staffer",
      });
      const before = sessionsOf("staff@example.com");

      const res = await request("POST", path, { body });

      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { twoFactorRedirect?: boolean })
          .twoFactorRedirect,
      ).toBe(true);
      expect(sessionCookieFrom(res)).toBeUndefined();
      expect(sessionsOf("staff@example.com")).toBe(before);
      expect(hookPaths.at(-1)).toBe(path);
    },
  );
});

describe("the legitimate two-factor flows still work", () => {
  it("password + TOTP: the session is minted on /two-factor/verify-totp", async () => {
    const { currentCode } = await enrolTotp("staff@example.com");
    // Enrolment rotated the session on the verify route.
    expect(hookPaths.at(-1)).toBe("/two-factor/verify-totp");
    const before = sessionsOf("staff@example.com");

    const challenge = await passwordChallenge("staff@example.com");
    expect(challenge.body.twoFactorRedirect).toBe(true);
    expect(sessionsOf("staff@example.com")).toBe(before);

    const res = await request("POST", "/two-factor/verify-totp", {
      body: { code: await currentCode() },
      cookie: challenge.cookies,
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: string }).token).toBeTruthy();
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(sessionsOf("staff@example.com")).toBe(before + 1);
    expect(hookPaths.at(-1)).toBe("/two-factor/verify-totp");
  });

  it("trusted device: after a passed challenge with trustDevice, password alone signs in on /sign-in/email", async () => {
    const { currentCode } = await enrolTotp("staff@example.com");
    const challenge = await passwordChallenge("staff@example.com");
    const verified = await request("POST", "/two-factor/verify-totp", {
      body: { code: await currentCode(), trustDevice: true },
      cookie: challenge.cookies,
    });
    expect(verified.status).toBe(200);
    const trustCookie = cookiesFrom(verified)
      .split("; ")
      .find((c) => c.includes("trust_device"));
    expect(trustCookie).toBeTruthy();
    const before = sessionsOf("staff@example.com");

    const again = await passwordChallenge("staff@example.com", trustCookie);

    expect(again.body.twoFactorRedirect).toBeUndefined();
    expect(again.body.token).toBeTruthy();
    expect(again.sessionCookie).toBeTruthy();
    expect(sessionsOf("staff@example.com")).toBe(before + 1);
    expect(hookPaths.at(-1)).toBe("/sign-in/email");
  });

  it("password + backup code: the session is minted on /two-factor/verify-backup-code", async () => {
    const { backupCodes } = await enrolTotp("staff@example.com");
    const challenge = await passwordChallenge("staff@example.com");
    const before = sessionsOf("staff@example.com");

    const res = await request("POST", "/two-factor/verify-backup-code", {
      body: { code: backupCodes[0] },
      cookie: challenge.cookies,
    });

    expect(res.status).toBe(200);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(sessionsOf("staff@example.com")).toBe(before + 1);
    expect(hookPaths.at(-1)).toBe("/two-factor/verify-backup-code");
  });

  it("password + texted/mailed 2FA code: the session is minted on /two-factor/verify-otp", async () => {
    await enrolTotp("staff@example.com");
    const challenge = await passwordChallenge("staff@example.com");
    const before = sessionsOf("staff@example.com");

    const send = await request("POST", "/two-factor/send-otp", {
      body: {},
      cookie: challenge.cookies,
    });
    expect(send.status).toBe(200);
    const res = await request("POST", "/two-factor/verify-otp", {
      body: { code: twoFactorOtps.get("staff@example.com") },
      cookie: challenge.cookies,
    });

    expect(res.status).toBe(200);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(sessionsOf("staff@example.com")).toBe(before + 1);
    expect(hookPaths.at(-1)).toBe("/two-factor/verify-otp");
  });

  it("change-password with revokeOtherSessions rotates a two-factor account's session", async () => {
    const { cookie } = await enrolTotp("staff@example.com");

    const res = await request("POST", "/change-password", {
      body: {
        currentPassword: PASSWORD,
        newPassword: `${PASSWORD}-2`,
        revokeOtherSessions: true,
      },
      cookie,
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: string }).token).toBeTruthy();
    expect(sessionsOf("staff@example.com")).toBe(1);
    expect(hookPaths.at(-1)).toBe("/change-password");
  });

  it("turning two-factor off rotates the session (the flag is already off at the hook)", async () => {
    const { cookie } = await enrolTotp("staff@example.com");

    const res = await request("POST", "/two-factor/disable", {
      body: { password: PASSWORD },
      cookie,
    });

    expect(res.status).toBe(200);
    expect(userRow("staff@example.com").twoFactorEnabled).toBe(false);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(hookPaths.at(-1)).toBe("/two-factor/disable");
  });
});

describe("deny by default: a session-minting route nobody listed", () => {
  it("refuses a two-factor account", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    const before = sessionsOf("staff@example.com");

    const res = await request("POST", "/later-plugin/sign-in", {
      body: { userId: userRow("staff@example.com").id },
    });

    await expectRefusedJson(res);
    expect(sessionsOf("staff@example.com")).toBe(before);
    expect(hookPaths.at(-1)).toBe("/later-plugin/sign-in");
  });

  it("refuses a two-factor account whose email is unverified too (nothing was proven, so nothing was swept)", async () => {
    await createAccount("unverified@example.com", {
      twoFactorEnabled: true,
      emailVerified: false,
    });

    const res = await request("POST", "/later-plugin/sign-in", {
      body: { userId: userRow("unverified@example.com").id },
    });

    await expectRefusedJson(res);
  });

  it("leaves an account without 2FA alone", async () => {
    await createAccount("buyer@example.com", {
      twoFactorEnabled: false,
      emailVerified: true,
    });

    const res = await request("POST", "/later-plugin/sign-in", {
      body: { userId: userRow("buyer@example.com").id },
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: string }).token).toBeTruthy();
  });
});

describe("a staff account with a passkey and no authenticator app signs in only with the passkey", () => {
  // Staff counts as enrolled with a passkey alone (`hasSecondFactorEnrolled`),
  // but the plugin challenges only `twoFactorEnabled` accounts: without this
  // rule the password (or the inbox) minted a session that passed every
  // staff check.
  const STAFF_EMAIL = "staff@example.com";

  /** A password account with a passkey row, two-factor OFF. */
  const passkeyAccount = async (
    email: string,
    roles: string[],
    extra: { phoneNumber?: string; username?: string } = {},
  ) => {
    const cookie = await createAccount(email, {
      twoFactorEnabled: false,
      emailVerified: true,
      ...extra,
    });
    const userId = userRow(email).id as string;
    db.passkey!.push({
      id: `pk-${email}`,
      name: "Test key",
      userId,
      credentialID: `cred-${email}`,
      publicKey: "unused",
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      transports: "usb",
      createdAt: new Date(),
    });
    staffRoles.set(userId, roles);
    return cookie;
  };

  const expectStaffRefusedJson = async (res: Response) => {
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe(STAFF_USE_PASSKEY_ERROR.code);
    expect(body.message).toBe(STAFF_USE_PASSKEY_ERROR.message);
    expect(sessionCookieFrom(res)).toBeUndefined();
  };

  it.each([
    ["/sign-in/email", { email: STAFF_EMAIL, password: PASSWORD }],
    ["/sign-in/username", { username: "staffer", password: PASSWORD }],
    [
      "/sign-in/phone-number",
      { phoneNumber: "+15555550110", password: PASSWORD },
    ],
  ] as const)("refuses the password on %s: no session", async (path, body) => {
    await passkeyAccount(STAFF_EMAIL, ["ADMIN"], {
      phoneNumber: "+15555550110",
      username: "staffer",
    });
    const before = sessionsOf(STAFF_EMAIL);

    const res = await request("POST", path, { body });

    await expectStaffRefusedJson(res);
    expect(sessionsOf(STAFF_EMAIL)).toBe(before);
    expect(hookPaths.at(-1)).toBe(path);
  });

  it.each(SECOND_FACTOR_STAFF_ROLES)(
    "refuses the password for a %s holder",
    async (role) => {
      await passkeyAccount(STAFF_EMAIL, [role]);
      await expectStaffRefusedJson(
        await request("POST", "/sign-in/email", {
          body: { email: STAFF_EMAIL, password: PASSWORD },
        }),
      );
    },
  );

  it("the staff roles are every HumanRole but USER (the list hasStaffRole uses)", () => {
    expect([...SECOND_FACTOR_STAFF_ROLES].sort()).toEqual(
      ["ADMIN", "COMMUNITY_MODERATOR", "DEVELOPER", "REVIEWER", "SUPPORT"].sort(),
    );
  });

  it("refuses the email code (/sign-in/email-otp)", async () => {
    await passkeyAccount(STAFF_EMAIL, ["SUPPORT"]);
    const send = await request("POST", "/email-otp/send-verification-otp", {
      body: { email: STAFF_EMAIL, type: "sign-in" },
    });
    expect(send.status).toBe(200);
    const before = sessionsOf(STAFF_EMAIL);

    const res = await request("POST", "/sign-in/email-otp", {
      body: { email: STAFF_EMAIL, otp: mailedOtps.get(STAFF_EMAIL) },
    });

    await expectStaffRefusedJson(res);
    expect(sessionsOf(STAFF_EMAIL)).toBe(before);
    expect(hookPaths.at(-1)).toBe("/sign-in/email-otp");
  });

  it("refuses the magic link, redirecting to errorCallbackURL with the staff code", async () => {
    await passkeyAccount(STAFF_EMAIL, ["REVIEWER"]);
    const before = sessionsOf(STAFF_EMAIL);

    const res = await followMagicLink(STAFF_EMAIL, {
      callbackURL: "ithasfire-scanner://auth-callback",
      errorCallbackURL: "ithasfire-scanner://auth-error",
    });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(`${location.protocol}//${location.host}`).toBe(
      "ithasfire-scanner://auth-error",
    );
    expect(location.searchParams.get("error")).toBe(
      STAFF_USE_PASSKEY_ERROR.code,
    );
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect(sessionsOf(STAFF_EMAIL)).toBe(before);
    expect(hookPaths.at(-1)).toBe("/magic-link/verify");
  });

  it("refuses the texted code (/phone-number/verify)", async () => {
    await passkeyAccount(STAFF_EMAIL, ["DEVELOPER"], {
      phoneNumber: "+15555550110",
    });
    await expectStaffRefusedJson(await signInByPhone("+15555550110"));
  });

  it("refuses a session-minting route nobody listed", async () => {
    await passkeyAccount(STAFF_EMAIL, ["COMMUNITY_MODERATOR"]);
    await expectStaffRefusedJson(
      await request("POST", "/later-plugin/sign-in", {
        body: { userId: userRow(STAFF_EMAIL).id },
      }),
    );
  });

  it("change-password still rotates a session the caller already holds", async () => {
    const cookie = await passkeyAccount(STAFF_EMAIL, ["ADMIN"]);

    const res = await request("POST", "/change-password", {
      body: {
        currentPassword: PASSWORD,
        newPassword: `${PASSWORD}-2`,
        revokeOtherSessions: true,
      },
      cookie,
    });

    expect(res.status).toBe(200);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(hookPaths.at(-1)).toBe("/change-password");
  });

  it("enrolling an authenticator app still works (the flag is on before the session rotates)", async () => {
    const cookie = await passkeyAccount(STAFF_EMAIL, ["ADMIN"]);
    const enable = await request("POST", "/two-factor/enable", {
      body: { password: PASSWORD },
      cookie,
    });
    expect(enable.status).toBe(200);
    const { totpURI } = (await enable.json()) as { totpURI: string };
    const secret = new TextDecoder().decode(
      base32.decode(new URL(totpURI).searchParams.get("secret")!),
    );

    const verify = await request("POST", "/two-factor/verify-totp", {
      body: { code: await createOTP(secret).totp() },
      cookie,
    });

    expect(verify.status).toBe(200);
    expect(sessionCookieFrom(verify)).toBeTruthy();
    expect(userRow(STAFF_EMAIL).twoFactorEnabled).toBe(true);
    expect(hookPaths.at(-1)).toBe("/two-factor/verify-totp");
  });

  it("turning the authenticator app off still rotates the session (the account is passkey-gated by then)", async () => {
    const { cookie } = await enrolTotp(STAFF_EMAIL);
    db.passkey!.push({
      id: "pk-staff",
      userId: userRow(STAFF_EMAIL).id,
      credentialID: "cred-staff",
      publicKey: "unused",
      counter: 0,
    });
    staffRoles.set(userRow(STAFF_EMAIL).id as string, ["ADMIN"]);

    const res = await request("POST", "/two-factor/disable", {
      body: { password: PASSWORD },
      cookie,
    });

    expect(res.status).toBe(200);
    expect(userRow(STAFF_EMAIL).twoFactorEnabled).toBe(false);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(hookPaths.at(-1)).toBe("/two-factor/disable");
    // And from then on the password alone is refused.
    await expectStaffRefusedJson(
      await request("POST", "/sign-in/email", {
        body: { email: STAFF_EMAIL, password: PASSWORD },
      }),
    );
  });

  it("a NON-staff account with a passkey still signs in with its password (no second-factor requirement)", async () => {
    await passkeyAccount("buyer@example.com", []);
    const before = sessionsOf("buyer@example.com");

    const res = await request("POST", "/sign-in/email", {
      body: { email: "buyer@example.com", password: PASSWORD },
    });

    expect(res.status).toBe(200);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(sessionsOf("buyer@example.com")).toBe(before + 1);
  });

  it("a USER-role account with a passkey still signs in with its password (USER is no staff grant)", async () => {
    await passkeyAccount("buyer@example.com", ["USER"]);
    const res = await request("POST", "/sign-in/email", {
      body: { email: "buyer@example.com", password: PASSWORD },
    });
    expect(res.status).toBe(200);
    expect(sessionCookieFrom(res)).toBeTruthy();
  });

  it("a NON-staff account with a passkey still signs in by magic link", async () => {
    await passkeyAccount("buyer@example.com", []);
    const res = await followMagicLink("buyer@example.com", {
      callbackURL: "/done",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/done`);
    expect(sessionCookieFrom(res)).toBeTruthy();
  });

  it("a staff account with NO factor still signs in with its password (its roles grant nothing until it enrols)", async () => {
    await createAccount(STAFF_EMAIL, {
      twoFactorEnabled: false,
      emailVerified: true,
    });
    staffRoles.set(userRow(STAFF_EMAIL).id as string, ["ADMIN"]);

    const res = await request("POST", "/sign-in/email", {
      body: { email: STAFF_EMAIL, password: PASSWORD },
    });

    expect(res.status).toBe(200);
    expect(sessionCookieFrom(res)).toBeTruthy();
  });

  it("a staff account WITH an authenticator app still gets the plugin's challenge on the password", async () => {
    await enrolTotp(STAFF_EMAIL);
    staffRoles.set(userRow(STAFF_EMAIL).id as string, ["ADMIN"]);
    db.passkey!.push({
      id: "pk-staff",
      userId: userRow(STAFF_EMAIL).id,
      credentialID: "cred-staff",
      publicKey: "unused",
      counter: 0,
    });

    const challenge = await passwordChallenge(STAFF_EMAIL);

    expect(challenge.body.twoFactorRedirect).toBe(true);
    expect(challenge.sessionCookie).toBeUndefined();
  });
});

describe("the allowlist names real routes", () => {
  // A typo, or a path an upgrade renamed, would silently refuse (or stop
  // covering) a real sign-in. Every listed path must be an endpoint of a
  // betterAuth() built with the app's sign-in plugins.
  it("every SECOND_FACTOR_SATISFIED_ROUTES path is a registered endpoint", () => {
    const registered = new Set(
      Object.values(auth.api as Record<string, { path?: string }>).map(
        (endpoint) => endpoint.path,
      ),
    );
    for (const path of Object.keys(SECOND_FACTOR_SATISFIED_ROUTES)) {
      expect(registered, `no endpoint ${path}`).toContain(path);
    }
    for (const path of [
      "/sign-in/email-otp",
      "/magic-link/verify",
      "/phone-number/verify",
      "/callback/:id",
      "/sign-in/social",
    ]) {
      expect(registered, `no endpoint ${path}`).toContain(path);
    }
  });

  it("is exactly the eight reviewed routes", () => {
    expect(Object.keys(SECOND_FACTOR_SATISFIED_ROUTES).sort()).toEqual(
      [
        "/change-password",
        "/passkey/verify-authentication",
        "/sign-in/email",
        "/sign-in/phone-number",
        "/sign-in/username",
        "/two-factor/verify-backup-code",
        "/two-factor/verify-otp",
        "/two-factor/verify-totp",
      ].sort(),
    );
  });
});

describe("refuseSecondFactorBypassSession", () => {
  const OPTS = {
    authBaseURL: AUTH_BASE,
    webBaseURL: WEB_URL,
    staffRolesOf: async (): Promise<string[]> => [],
  };
  const twoFactorUser = { twoFactorEnabled: true, emailVerified: true };
  const adaptersFor = (
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
  const expectLookupFailed = async (attempt: Promise<void>) => {
    const thrown = await attempt.then(
      () => null,
      (err: unknown) => err,
    );
    // An APIError 500, not the raw error: the cause is reported here, and
    // `onAPIError.onError` reports every non-APIError a hook throws.
    expect(thrown).toBeInstanceOf(APIError);
    expect(thrown).toMatchObject({
      status: "INTERNAL_SERVER_ERROR",
      body: { message: "Could not complete sign-in." },
    });
  };

  it("lets a passkey sign-in through without looking the user up", async () => {
    const context = adaptersFor(twoFactorUser);
    await refuseSecondFactorBypassSession(
      { path: "/passkey/verify-authentication", context },
      "u1",
      OPTS,
    );
    expect(context.internalAdapter.findUserById).not.toHaveBeenCalled();
  });

  it.each(Object.keys(SECOND_FACTOR_SATISFIED_ROUTES))(
    "lets %s through for a two-factor account",
    async (path) => {
      const context = adaptersFor(twoFactorUser);
      await refuseSecondFactorBypassSession({ path, context }, "u1", OPTS);
    },
  );

  it.each(["/passkey/verify-authentication", "/change-password"])(
    "lets %s through without a lookup (allowed in every state)",
    async (path) => {
      const context = adaptersFor(twoFactorUser);
      await refuseSecondFactorBypassSession({ path, context }, "u1", OPTS);
      expect(context.internalAdapter.findUserById).not.toHaveBeenCalled();
    },
  );

  it.each(["/oauth-proxy-callback", "/callback/:id"])(
    "refuses %s with a redirect to the web sign-in",
    async (path) => {
      const context = adaptersFor(twoFactorUser, {
        accounts: [{ providerId: "credential", password: "hash" }],
      });
      const refusal = await refuseSecondFactorBypassSession(
        { path, context },
        "u1",
        OPTS,
      ).catch((err: unknown) => err);
      expect(refusal).toMatchObject({
        status: "FOUND",
        headers: expect.anything(),
      });
      expect(
        new Headers((refusal as { headers: HeadersInit }).headers).get(
          "location",
        ),
      ).toBe(
        `${WEB_URL}/sign-in?error=${TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR.code}`,
      );
    },
  );

  it("refuses /sign-in/social (idToken) with the 400 body", async () => {
    const context = adaptersFor(twoFactorUser, {
      accounts: [{ providerId: "credential", password: "hash" }],
    });
    await expect(
      refuseSecondFactorBypassSession(
        { path: "/sign-in/social", context },
        "u1",
        OPTS,
      ),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: { ...TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR },
    });
  });

  it("refuses a provider sign-in for an account whose other factor is a passkey", async () => {
    const context = adaptersFor(twoFactorUser, {
      accounts: [{ providerId: "google" }],
      passkeys: [{ id: "pk1" }],
    });
    await expect(
      refuseSecondFactorBypassSession(
        { path: "/sign-in/social", context },
        "u1",
        OPTS,
      ),
    ).rejects.toMatchObject({ status: "BAD_REQUEST" });
    expect(context.adapter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "passkey",
        where: [{ field: "userId", value: "u1" }],
      }),
    );
  });

  it.each(["/oauth-proxy-callback", "/callback/:id", "/sign-in/social"])(
    "INTERIM: lets %s through, and reports it, when the provider is the account's only way in",
    async (path) => {
      const report = vi.fn();
      const context = adaptersFor(twoFactorUser, {
        // No password (a credential row without one counts as none), no passkey.
        accounts: [
          { providerId: "google" },
          { providerId: "credential", password: null },
        ],
      });
      await refuseSecondFactorBypassSession({ path, context }, "u1", {
        ...OPTS,
        reportError: report,
      });
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            op: "second_factor_provider_only_allowed",
          }),
          extra: { authUserId: "u1", path },
        }),
      );
    },
  );

  it.each(["/magic-link/verify", "/phone-number/verify", "/later/route"])(
    "the provider-only allowance does not reach %s",
    async (path) => {
      const context = adaptersFor(twoFactorUser, {
        accounts: [{ providerId: "google" }],
      });
      await expect(
        refuseSecondFactorBypassSession({ path, context }, "u1", OPTS),
      ).rejects.toMatchObject({ status: "BAD_REQUEST" });
      expect(context.internalAdapter.findAccounts).not.toHaveBeenCalled();
    },
  );

  it("a two-factor STAFF account with no password and no passkey is refused on a provider route, not reported as provider-only", async () => {
    const report = vi.fn();
    const context = adaptersFor(twoFactorUser, {
      accounts: [{ providerId: "google" }],
    });
    const refusal = await refuseSecondFactorBypassSession(
      { path: "/oauth-proxy-callback", context },
      "u1",
      { ...OPTS, reportError: report, staffRolesOf: async () => ["ADMIN"] },
    ).catch((err: unknown) => err);
    expect(refusal).toMatchObject({ status: "FOUND" });
    expect(
      new Headers((refusal as { headers: HeadersInit }).headers).get("location"),
    ).toBe(`${WEB_URL}/sign-in?error=${TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR.code}`);
    expect(report).not.toHaveBeenCalled();
  });

  it("a passkey-gated staff account is refused on /sign-in/email with the staff code", async () => {
    const context = adaptersFor(
      { twoFactorEnabled: false },
      { passkeys: [{ id: "pk1" }] },
    );
    await expect(
      refuseSecondFactorBypassSession(
        { path: "/sign-in/email", context },
        "u1",
        { ...OPTS, staffRolesOf: async () => ["DEVELOPER"] },
      ),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: { ...STAFF_USE_PASSKEY_ERROR },
    });
  });

  it("a staff account without two-factor and without a passkey is let through (nothing enrolled to protect)", async () => {
    const context = adaptersFor({ twoFactorEnabled: false });
    await refuseSecondFactorBypassSession(
      { path: "/sign-in/email", context },
      "u1",
      { ...OPTS, staffRolesOf: async () => ["ADMIN"] },
    );
    expect(context.adapter.findMany).toHaveBeenCalled();
  });

  it("reads no passkeys for a non-staff account without two-factor", async () => {
    const staffRolesOf = vi.fn(async () => [] as string[]);
    const context = adaptersFor({ twoFactorEnabled: false });
    await refuseSecondFactorBypassSession(
      { path: "/sign-in/email", context },
      "u1",
      { ...OPTS, staffRolesOf },
    );
    expect(staffRolesOf).toHaveBeenCalledWith("u1");
    expect(context.adapter.findMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the staff-role lookup fails",
      async () => {
        throw new Error("db down");
      },
    ],
    ["no staff-role lookup is wired", undefined],
  ])("fails closed and reports once when %s", async (_label, staffRolesOf) => {
    const report = vi.fn();
    const context = adaptersFor({ twoFactorEnabled: false });
    await expectLookupFailed(
      refuseSecondFactorBypassSession(
        { path: "/sign-in/email", context },
        "u1",
        {
          ...OPTS,
          reportError: report,
          staffRolesOf: staffRolesOf as never,
        },
      ),
    );
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ op: "second_factor_bypass_lookup" }),
      }),
    );
  });

  it("does not look for a password or passkey when the account has no 2FA", async () => {
    const context = adaptersFor({ twoFactorEnabled: false });
    await refuseSecondFactorBypassSession(
      { path: "/oauth-proxy-callback", context },
      "u1",
      OPTS,
    );
    expect(context.internalAdapter.findAccounts).not.toHaveBeenCalled();
    expect(context.adapter.findMany).not.toHaveBeenCalled();
  });

  it.each(["/sign-up/email", "/magic-link/verify", "/later/route"])(
    "a user row that cannot be read on %s is a lookup failure: refused and reported once",
    async (path) => {
      const report = vi.fn();
      const context = adaptersFor(null);
      await expectLookupFailed(
        refuseSecondFactorBypassSession({ path, context }, "u1", {
          ...OPTS,
          reportError: report,
        }),
      );
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "second-factor gate: no user row for the new session",
        }),
        expect.objectContaining({
          tags: expect.objectContaining({ op: "second_factor_bypass_lookup" }),
          extra: { authUserId: "u1", path },
        }),
      );
    },
  );

  it("a real sign-up reads its own user row: /sign-up/email reaches the hook and is not a lookup failure", async () => {
    hookPaths = [];
    const res = await request("POST", "/sign-up/email", {
      body: { email: "new@example.com", password: PASSWORD, name: "New" },
    });

    expect(res.status).toBe(200);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(hookPaths).toEqual(["/sign-up/email"]);
    expect(sessionsOf("new@example.com")).toBe(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports a user lookup failure once and answers 500 (fails closed)", async () => {
    const boom = new Error("db down");
    const report = vi.fn();
    await expectLookupFailed(
      refuseSecondFactorBypassSession(
        {
          path: "/magic-link/verify",
          context: {
            internalAdapter: {
              findUserById: () => Promise.reject(boom),
              findAccounts: async () => [],
            },
          },
        },
        "u1",
        { ...OPTS, reportError: report },
      ),
    );
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ op: "second_factor_bypass_lookup" }),
        extra: { authUserId: "u1", path: "/magic-link/verify" },
      }),
    );
  });

  it("reports a password/passkey lookup failure on a provider route once and answers 500 (fails closed)", async () => {
    const boom = new Error("db down");
    const report = vi.fn();
    const context = adaptersFor(twoFactorUser);
    context.adapter.findMany.mockRejectedValue(boom);
    await expectLookupFailed(
      refuseSecondFactorBypassSession(
        { path: "/oauth-proxy-callback", context },
        "u1",
        { ...OPTS, reportError: report },
      ),
    );
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ op: "second_factor_bypass_lookup" }),
      }),
    );
  });

  it("a throwing reporter does not change the outcome", async () => {
    await expectLookupFailed(
      refuseSecondFactorBypassSession(
        {
          path: "/phone-number/verify",
          context: {
            internalAdapter: {
              findUserById: () => Promise.reject(new Error("db down")),
              findAccounts: async () => [],
            },
          },
        },
        "u1",
        {
          ...OPTS,
          reportError: () => {
            throw new Error("reporter down");
          },
        },
      ),
    );
  });

  it.each([
    ["no context at all", null],
    ["a context without a path or adapter", {}],
    ["an unlisted path without an adapter", { path: "/later/route" }],
  ])(
    "fails closed and reports when a session is minted with %s",
    async (_label, ctx) => {
      const report = vi.fn();
      await expect(
        refuseSecondFactorBypassSession(ctx, "u1", {
          ...OPTS,
          reportError: report,
        }),
      ).rejects.toMatchObject({ status: "INTERNAL_SERVER_ERROR" });
      expect(report).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            op: "second_factor_bypass_no_context",
          }),
        }),
      );
    },
  );
});

describe("secondFactorRefusalRedirect", () => {
  const base = {
    query: undefined,
    authBaseURL: AUTH_BASE,
    webBaseURL: WEB_URL,
  };
  const refusedAt = (path: string | undefined, query?: Record<string, unknown>) =>
    secondFactorRefusalRedirect({ ...base, path, query });

  it.each(["/oauth-proxy-callback", "/callback/:id"])(
    "%s goes to the web sign-in with the error code",
    (path) => {
      expect(refusedAt(path)).toBe(
        `${WEB_URL}/sign-in?error=TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN`,
      );
    },
  );

  it("never follows a callbackURL on the provider routes", () => {
    expect(
      refusedAt("/oauth-proxy-callback", {
        callbackURL: "https://evil.example/landing",
      }),
    ).toBe(`${WEB_URL}/sign-in?error=TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN`);
  });

  it("magic link follows errorCallbackURL, then callbackURL, and is JSON without either", () => {
    expect(
      refusedAt("/magic-link/verify", {
        callbackURL: "/done",
        errorCallbackURL: "/oops",
      }),
    ).toBe(`${BASE_URL}/oops?error=TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN`);
    expect(refusedAt("/magic-link/verify", { callbackURL: "/done" })).toBe(
      `${BASE_URL}/done?error=TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN`,
    );
    expect(refusedAt("/magic-link/verify", {})).toBeNull();
  });

  it.each([
    "/sign-in/social",
    "/sign-in/email-otp",
    "/phone-number/verify",
    "/later/route",
    undefined,
  ])("%s answers JSON", (path) => {
    expect(refusedAt(path)).toBeNull();
  });

  it("a web origin that is not a URL: answers JSON and reports the misconfiguration", () => {
    const report = vi.fn();
    expect(
      secondFactorRefusalRedirect({
        ...base,
        path: "/callback/:id",
        webBaseURL: "not a url",
        reportError: report,
      }),
    ).toBeNull();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.any(TypeError),
      {
        tags: { area: "auth", op: "second_factor_refusal_redirect" },
        extra: { path: "/callback/:id", webBaseURL: "not a url" },
      },
    );
  });

  it("a web origin that is not a URL and a throwing reporter: still JSON", () => {
    expect(
      secondFactorRefusalRedirect({
        ...base,
        path: "/oauth-proxy-callback",
        webBaseURL: "not a url",
        reportError: () => {
          throw new Error("reporter down");
        },
      }),
    ).toBeNull();
  });

  it("reports nothing when the redirect resolves", () => {
    const report = vi.fn();
    secondFactorRefusalRedirect({
      ...base,
      path: "/callback/:id",
      reportError: report,
    });
    secondFactorRefusalRedirect({
      ...base,
      path: "/sign-in/social",
      reportError: report,
    });
    expect(report).not.toHaveBeenCalled();
  });
});

describe("a refused provider callback with a web origin that is not a URL", () => {
  it("is refused as JSON, and the session hook passes its reporter on", async () => {
    const report = vi.fn();
    await expect(
      refuseSecondFactorBypassSession(
        {
          path: "/callback/:id",
          context: {
            internalAdapter: {
              findUserById: async () => ({ twoFactorEnabled: true }),
              findAccounts: async () => [
                { providerId: "credential", password: "hash" },
              ],
            },
            adapter: { findMany: async () => [], findOne: async () => null },
          },
        },
        "u1",
        {
          authBaseURL: AUTH_BASE,
          webBaseURL: "not a url",
          reportError: report,
          staffRolesOf: async () => [],
        },
      ),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: { ...TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR },
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.any(TypeError),
      expect.objectContaining({
        tags: { area: "auth", op: "second_factor_refusal_redirect" },
      }),
    );
  });
});

describe("bypassesSecondFactor", () => {
  const ON = { twoFactorEnabled: true, emailVerified: true };
  const ON_UNVERIFIED = { twoFactorEnabled: true, emailVerified: false };
  const OFF = { twoFactorEnabled: false, emailVerified: true };
  const GATED = { twoFactorEnabled: false, staffPasskeyGated: true };

  it.each([
    // Allowed: the plugin challenges it, a factor was passed, or it is one.
    ["/sign-in/email", ON, false],
    ["/sign-in/username", ON, false],
    ["/sign-in/phone-number", ON, false],
    ["/two-factor/verify-totp", ON, false],
    ["/two-factor/verify-otp", ON, false],
    ["/two-factor/verify-backup-code", ON, false],
    ["/passkey/verify-authentication", ON, false],
    ["/change-password", ON, false],
    ["/sign-in/email", ON_UNVERIFIED, false],
    ["/passkey/verify-authentication", ON_UNVERIFIED, false],
    // Email proof: refused either way. An unverified account is not an
    // exception here: its first inbox proof turns two-factor off before
    // this is asked (the unproven-account sweep).
    ["/sign-in/email-otp", ON, true],
    ["/sign-in/email-otp", ON_UNVERIFIED, true],
    ["/magic-link/verify", ON, true],
    ["/magic-link/verify", ON_UNVERIFIED, true],
    // The SIM: refused either way.
    ["/phone-number/verify", ON, true],
    ["/phone-number/verify", ON_UNVERIFIED, true],
    // Google / Apple: refused either way.
    ["/oauth-proxy-callback", ON, true],
    ["/oauth-proxy-callback", ON_UNVERIFIED, true],
    ["/callback/:id", ON, true],
    ["/callback/:id", ON_UNVERIFIED, true],
    ["/sign-in/social", ON, true],
    ["/sign-in/social", ON_UNVERIFIED, true],
    // Session-minting routes this app's options leave unreachable.
    ["/verify-email", ON, true],
    ["/email-otp/verify-email", ON, true],
    ["/two-factor/enable", ON, true],
    // Routes this app does not install, and anything unknown.
    ["/one-tap/callback", ON, true],
    ["/oauth2/callback/:providerId", ON, true],
    ["/sign-in/anonymous", ON, true],
    ["/sign-up/email", ON, true],
    ["/later/route", ON, true],
    ["/later/route", ON_UNVERIFIED, true],
    [undefined, ON, true],
    // No two-factor: every route is left alone.
    ["/sign-in/email-otp", OFF, false],
    ["/magic-link/verify", OFF, false],
    ["/phone-number/verify", OFF, false],
    ["/oauth-proxy-callback", OFF, false],
    ["/callback/:id", OFF, false],
    ["/sign-in/social", OFF, false],
    ["/sign-up/email", OFF, false],
    ["/later/route", OFF, false],
    [undefined, OFF, false],
    // Passkey-gated staff (a staff role, a passkey, no TOTP): the passkey
    // and session rotation only.
    ["/passkey/verify-authentication", GATED, false],
    ["/change-password", GATED, false],
    ["/two-factor/disable", GATED, false],
    ["/sign-in/email", GATED, true],
    ["/sign-in/username", GATED, true],
    ["/sign-in/phone-number", GATED, true],
    ["/sign-in/email-otp", GATED, true],
    ["/magic-link/verify", GATED, true],
    ["/phone-number/verify", GATED, true],
    ["/oauth-proxy-callback", GATED, true],
    ["/callback/:id", GATED, true],
    ["/sign-in/social", GATED, true],
    ["/two-factor/verify-otp", GATED, true],
    ["/later/route", GATED, true],
    [undefined, GATED, true],
  ] as const)("%s %o -> %s", (path, user, expected) => {
    expect(bypassesSecondFactor(path, user)).toBe(expected);
  });

  it("is false for a missing user", () => {
    expect(bypassesSecondFactor("/magic-link/verify", null)).toBe(false);
    expect(bypassesSecondFactor("/later/route", undefined)).toBe(false);
  });

  it("does not match a prototype key as a listed route", () => {
    expect(bypassesSecondFactor("toString", ON)).toBe(true);
    expect(bypassesSecondFactor("constructor", ON)).toBe(true);
    expect(bypassesSecondFactor("toString", GATED)).toBe(true);
  });

  it("the passkey-gated list is exactly the three reviewed routes", () => {
    expect(Object.keys(STAFF_PASSKEY_ROUTES).sort()).toEqual(
      [
        "/change-password",
        "/passkey/verify-authentication",
        "/two-factor/disable",
      ].sort(),
    );
  });
});
