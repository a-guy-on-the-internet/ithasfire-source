import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { oAuthProxy, twoFactor } from "better-auth/plugins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isInboxProvingProvider,
  revokeUnprovenCredentials,
} from "../src/auth/account-security";
import {
  refuseSecondFactorBypassSession,
  skipsProviderLinkForTwoFactor,
  STAFF_USE_PASSKEY_ERROR,
  TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR,
} from "../src/auth/second-factor-bypass";
import { memorySweepDeps } from "./helpers/memory-unproven-sweep";

/**
 * Google / Apple sign-in must not hand a two-factor account a session.
 *
 * A REAL `betterAuth()` (memory adapter) with a Google provider, account
 * linking and `oAuthProxy` configured as production has them (web and API on
 * different origins), driven through `auth.handler`. The only thing faked is
 * Google itself: the token endpoint is a stubbed `fetch`, and the id token is
 * an unsigned JWT (the provider decodes it; the app's own `verifyIdToken`
 * override is stood in for by `() => true`). The production
 * `refuseSecondFactorBypassSession` is the `session.create.before` hook.
 *
 * `account.create.before` is the production hook body: the production
 * `revokeUnprovenCredentials` (its Prisma writes done against the memory
 * rows, `./helpers/memory-unproven-sweep`), then
 * `skipsProviderLinkForTwoFactor`, which keeps a refused sign-in from leaving
 * a link row behind.
 */

const WEB_URL = "https://ithasfire.com";
const BASE_URL = "https://api.ithasfire.com";
const AUTH_BASE = `${BASE_URL}/api/auth`;
const PASSWORD = "correct-horse-battery-staple";
const REFUSED_AT_WEB = `${WEB_URL}/sign-in?error=${TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR.code}`;
const STAFF_REFUSED_AT_WEB = `${WEB_URL}/sign-in?error=${STAFF_USE_PASSKEY_ERROR.code}`;

type Row = Record<string, unknown>;
type MemoryDb = Record<string, Row[]>;

let db: MemoryDb;
let hookPaths: Array<string | undefined>;
let twoFactorOtps: Map<string, string>;
let resetTokens: Map<string, string>;
/** What "Google" says about whoever is signing in. */
let googleProfile: { sub: string; email: string; email_verified: boolean };
const reportError = vi.fn();
/** `Human.roles` by auth user id: what the production `staffRolesOf` reads. */
const staffRoles = new Map<string, string[]>();
const staffRolesOf = async (authUserId: string) =>
  staffRoles.get(authUserId) ?? [];

const b64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const googleIdToken = () =>
  `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
    ...googleProfile,
    name: "Provider Name",
    iss: "https://accounts.google.com",
    aud: "test-client",
  })}.unsigned`;

const buildAuth = (opts: { proxied: boolean }) =>
  betterAuth({
    baseURL: BASE_URL,
    secret: "test-secret-test-secret-test-secret-32",
    database: memoryAdapter(db),
    trustedOrigins: [BASE_URL, WEB_URL],
    rateLimit: { enabled: false },
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, token }) => {
        resetTokens.set(user.email, token);
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google", "apple"],
      },
    },
    socialProviders: {
      google: {
        clientId: "test-client",
        clientSecret: "test-secret",
        redirectURI: `${AUTH_BASE}/callback/google`,
        verifyIdToken: async () => true,
      },
    },
    plugins: [
      twoFactor({
        issuer: "Test",
        otpOptions: {
          sendOTP: async ({ user, otp }) => {
            twoFactorOtps.set(user.email, otp);
          },
        },
      }),
      passkey({ rpID: "ithasfire.com", rpName: "Test", origin: WEB_URL }),
      ...(opts.proxied
        ? [oAuthProxy({ productionURL: WEB_URL, currentURL: BASE_URL })]
        : []),
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
      account: {
        create: {
          // The production hook body (apps/api/src/auth/better-auth.ts).
          before: async (account, ctx) => {
            const { userId, providerId } = account;
            if (!isInboxProvingProvider(providerId)) return;
            await revokeUnprovenCredentials(memorySweepDeps(() => db), {
              authUserId: userId,
              trigger: "oauth_link",
            });
            const skipLink = await skipsProviderLinkForTwoFactor(
              ctx,
              { userId, providerId },
              { reportError, staffRolesOf },
            );
            if (skipLink) return false;
          },
        },
      },
    },
  });

let auth: ReturnType<typeof buildAuth>;

const request = (
  method: "GET" | "POST",
  pathOrUrl: string,
  init: { body?: unknown; cookie?: string; origin?: string } = {},
) =>
  auth.handler(
    new Request(
      pathOrUrl.startsWith("http") ? pathOrUrl : `${AUTH_BASE}${pathOrUrl}`,
      {
        method,
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          origin: init.origin ?? WEB_URL,
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
    ),
  );

/** The cookies a browser holds after this response (later deletions win). */
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

const providersOf = (email: string) =>
  db
    .account!.filter((a) => a.userId === userRow(email).id)
    .map((a) => a.providerId)
    .sort();

/** A password account with its flags set directly. Returns its cookie. */
const createAccount = async (
  email: string,
  flags: { twoFactorEnabled: boolean; emailVerified: boolean },
): Promise<string> => {
  const res = await request("POST", "/sign-up/email", {
    body: { email, password: PASSWORD, name: email.split("@")[0] },
  });
  expect(res.status).toBe(200);
  Object.assign(userRow(email), flags);
  return sessionCookieFrom(res)!;
};

const linkGoogle = (email: string, sub: string) => {
  db.account!.push({
    id: `acc-${sub}`,
    providerId: "google",
    accountId: sub,
    userId: userRow(email).id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
};

const dropPassword = (email: string) => {
  const id = userRow(email).id;
  const rows = db.account!;
  rows.splice(
    0,
    rows.length,
    ...rows.filter((a) => !(a.userId === id && a.providerId === "credential")),
  );
};

/**
 * "Continue with Google" as a browser does it: start the flow, come back from
 * Google on `/callback/google`, and follow every redirect that stays on the
 * API. Returns the last API response (the one whose Location leaves for the
 * web app) and every API path visited.
 */
const continueWithGoogle = async (callbackURL = `${WEB_URL}/my-tickets`) => {
  const start = await request("POST", "/sign-in/social", {
    body: { provider: "google", callbackURL },
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  let cookie = cookiesFrom(start);
  let next = `${AUTH_BASE}/callback/google?code=auth-code&state=${encodeURIComponent(state)}`;
  const visited: string[] = [];
  let res: Response;
  for (;;) {
    visited.push(new URL(next).pathname.replace("/api/auth", ""));
    res = await request("GET", next, { cookie });
    const location = res.headers.get("location");
    if (res.status !== 302 || !location?.startsWith(AUTH_BASE)) break;
    cookie = [cookie, cookiesFrom(res)].filter(Boolean).join("; ");
    next = location;
    if (visited.length > 5) throw new Error("redirect loop");
  }
  return { res, visited };
};

const signInWithGoogleIdToken = () =>
  request("POST", "/sign-in/social", {
    body: { provider: "google", idToken: { token: googleIdToken() } },
  });

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
  twoFactorOtps = new Map();
  resetTokens = new Map();
  googleProfile = {
    sub: "google-sub-1",
    email: "staff@example.com",
    email_verified: true,
  };
  reportError.mockReset();
  staffRoles.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: "google-access-token",
            id_token: googleIdToken(),
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected network call in test: ${url}`);
    }),
  );
  auth = buildAuth({ proxied: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Continue with Google in the browser (oAuthProxy across two origins, as in production)", () => {
  it("mints its session on /oauth-proxy-callback, not on /callback/:id", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: false,
      emailVerified: true,
    });
    hookPaths = [];

    const { res, visited } = await continueWithGoogle();

    expect(visited).toEqual(["/callback/google", "/oauth-proxy-callback"]);
    expect(hookPaths).toEqual(["/oauth-proxy-callback"]);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${WEB_URL}/my-tickets`);
    expect(sessionCookieFrom(res)).toBeTruthy();
  });

  it("refuses a verified two-factor account that has never linked Google: redirect to the web sign-in, no session", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    const before = sessionsOf("staff@example.com");

    const { res } = await continueWithGoogle();

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(REFUSED_AT_WEB);
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect(sessionsOf("staff@example.com")).toBe(before);
    expect(userRow("staff@example.com").twoFactorEnabled).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("the refused sign-in leaves no Google link and no provider tokens on the account", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });

    const { res } = await continueWithGoogle();

    // Better Auth links the provider account before it creates the session;
    // the link is skipped, and the refusal is still the session hook's.
    expect(res.headers.get("location")).toBe(REFUSED_AT_WEB);
    expect(providersOf("staff@example.com")).toEqual(["credential"]);
    expect(JSON.stringify(db.account)).not.toContain("google-access-token");
    expect(db.account!.find((a) => a.providerId === "credential")!.password)
      .toBeTruthy();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("refuses a verified two-factor account with Google already linked", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    linkGoogle("staff@example.com", googleProfile.sub);
    const before = sessionsOf("staff@example.com");

    const { res } = await continueWithGoogle();

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(REFUSED_AT_WEB);
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect(sessionsOf("staff@example.com")).toBe(before);
  });

  it("signs in an account without two-factor", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: false,
      emailVerified: true,
    });
    const before = sessionsOf("staff@example.com");

    const { res } = await continueWithGoogle();

    expect(res.headers.get("location")).toBe(`${WEB_URL}/my-tickets`);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(sessionsOf("staff@example.com")).toBe(before + 1);
  });

  it("signs up a brand-new Google user", async () => {
    googleProfile = {
      sub: "google-sub-new",
      email: "new@example.com",
      email_verified: true,
    };

    const { res } = await continueWithGoogle();

    expect(res.headers.get("location")).toBe(`${WEB_URL}/my-tickets`);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(providersOf("new@example.com")).toEqual(["google"]);
  });
});

describe("the inbox owner evicting a squatter with Google", () => {
  it("first Google sign-in onto an UNVERIFIED two-factor account: the squatter's enrolment is swept and the owner is signed in", async () => {
    // The squatter registered the victim's address, set a password and
    // turned two-factor on, without ever proving the inbox.
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: false,
    });
    db.twoFactor!.push({
      id: "tf1",
      userId: userRow("staff@example.com").id,
      secret: "squatter-secret",
      backupCodes: "x",
      verified: true,
    });

    const { res } = await continueWithGoogle();

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${WEB_URL}/my-tickets`);
    expect(sessionCookieFrom(res)).toBeTruthy();
    const row = userRow("staff@example.com");
    expect(row.twoFactorEnabled).toBe(false);
    expect(row.emailVerified).toBe(true);
    expect(db.twoFactor).toEqual([]);
    // The squatter's password and sessions are gone; only the owner's new
    // session and Google link remain.
    expect(providersOf("staff@example.com")).toEqual(["google"]);
    expect(sessionsOf("staff@example.com")).toBe(1);
  });

  it("an UNVERIFIED two-factor account with Google ALREADY linked is refused: nothing is swept, so the enrolment is not skipped", async () => {
    // Google reports the address unverified, so the account stays unverified
    // and no link is created: nothing runs the sweep.
    googleProfile = { ...googleProfile, email_verified: false };
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: false,
    });
    linkGoogle("staff@example.com", googleProfile.sub);
    const before = sessionsOf("staff@example.com");

    const { res } = await continueWithGoogle();

    expect(res.headers.get("location")).toBe(REFUSED_AT_WEB);
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect(sessionsOf("staff@example.com")).toBe(before);
    expect(userRow("staff@example.com").twoFactorEnabled).toBe(true);
  });
});

describe("/sign-in/social with an idToken (native Google / Apple)", () => {
  it("refuses a verified two-factor account with the 400 body", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    linkGoogle("staff@example.com", googleProfile.sub);
    const before = sessionsOf("staff@example.com");

    const res = await signInWithGoogleIdToken();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ...TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR });
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect(sessionsOf("staff@example.com")).toBe(before);
    expect(hookPaths.at(-1)).toBe("/sign-in/social");
  });

  it("refuses a verified two-factor account that never linked Google, and links nothing", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });

    const res = await signInWithGoogleIdToken();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ...TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR });
    expect(providersOf("staff@example.com")).toEqual(["credential"]);
  });

  it("signs in an account without two-factor, and links Google", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: false,
      emailVerified: true,
    });

    const res = await signInWithGoogleIdToken();

    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: string }).token).toBeTruthy();
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(providersOf("staff@example.com")).toEqual(["credential", "google"]);
  });
});

describe("/callback/:id without the proxy (same-origin deployments, x-skip-oauth-proxy)", () => {
  beforeEach(() => {
    auth = buildAuth({ proxied: false });
  });

  it("refuses a verified two-factor account with a redirect to the web sign-in, and links nothing", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    const before = sessionsOf("staff@example.com");

    const { res, visited } = await continueWithGoogle();

    expect(visited).toEqual(["/callback/google"]);
    expect(hookPaths.at(-1)).toBe("/callback/:id");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(REFUSED_AT_WEB);
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect(sessionsOf("staff@example.com")).toBe(before);
    expect(providersOf("staff@example.com")).toEqual(["credential"]);
  });

  it("signs in an account without two-factor", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: false,
      emailVerified: true,
    });

    const { res } = await continueWithGoogle();

    expect(res.headers.get("location")).toBe(`${WEB_URL}/my-tickets`);
    expect(sessionCookieFrom(res)).toBeTruthy();
  });
});

describe("lockout: a two-factor account whose only way in is the provider", () => {
  it("two-factor CAN be turned on with no password: any session + a mailed code (/two-factor/verify-otp)", async () => {
    // A Google-only account: no credential row at all.
    const signUp = await signInWithGoogleIdToken();
    expect(signUp.status).toBe(200);
    const cookie = sessionCookieFrom(signUp)!;
    expect(providersOf("staff@example.com")).toEqual(["google"]);

    const send = await request("POST", "/two-factor/send-otp", {
      body: {},
      cookie,
    });
    expect(send.status).toBe(200);
    const verify = await request("POST", "/two-factor/verify-otp", {
      body: { code: twoFactorOtps.get("staff@example.com") },
      cookie,
    });

    expect(verify.status).toBe(200);
    expect(userRow("staff@example.com").twoFactorEnabled).toBe(true);
    expect(providersOf("staff@example.com")).toEqual(["google"]);
    expect(db.twoFactor).toEqual([]);
  });

  it("INTERIM: that account still signs in with Google, and the sign-in is reported", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    linkGoogle("staff@example.com", googleProfile.sub);
    dropPassword("staff@example.com");
    const before = sessionsOf("staff@example.com");

    const { res } = await continueWithGoogle();

    expect(res.headers.get("location")).toBe(`${WEB_URL}/my-tickets`);
    expect(sessionCookieFrom(res)).toBeTruthy();
    expect(sessionsOf("staff@example.com")).toBe(before + 1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          op: "second_factor_provider_only_allowed",
        }),
        extra: {
          authUserId: userRow("staff@example.com").id,
          path: "/oauth-proxy-callback",
        },
      }),
    );
  });

  it("a passkey is a way in: Google is refused for a two-factor account with a passkey and no password", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    linkGoogle("staff@example.com", googleProfile.sub);
    dropPassword("staff@example.com");
    db.passkey!.push({
      id: "pk1",
      userId: userRow("staff@example.com").id,
      credentialID: "cred-1",
      publicKey: "pk",
      counter: 0,
    });

    const { res } = await continueWithGoogle();

    expect(res.headers.get("location")).toBe(REFUSED_AT_WEB);
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("once that account sets a password by reset, Google is refused and password + mailed 2FA code signs in", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    linkGoogle("staff@example.com", googleProfile.sub);
    dropPassword("staff@example.com");

    // "Forgot password" works for an account with no password: the reset
    // creates the credential account.
    const requested = await request("POST", "/request-password-reset", {
      body: { email: "staff@example.com", redirectTo: `${WEB_URL}/reset` },
    });
    expect(requested.status).toBe(200);
    const reset = await request("POST", "/reset-password", {
      body: {
        newPassword: PASSWORD,
        token: resetTokens.get("staff@example.com"),
      },
    });
    expect(reset.status).toBe(200);
    expect(providersOf("staff@example.com")).toEqual(["credential", "google"]);

    const { res: google } = await continueWithGoogle();
    expect(google.headers.get("location")).toBe(REFUSED_AT_WEB);

    const challenge = await request("POST", "/sign-in/email", {
      body: { email: "staff@example.com", password: PASSWORD },
    });
    expect(
      ((await challenge.json()) as { twoFactorRedirect?: boolean })
        .twoFactorRedirect,
    ).toBe(true);
    const challengeCookies = cookiesFrom(challenge);
    await request("POST", "/two-factor/send-otp", {
      body: {},
      cookie: challengeCookies,
    });
    const verified = await request("POST", "/two-factor/verify-otp", {
      body: { code: twoFactorOtps.get("staff@example.com") },
      cookie: challengeCookies,
    });

    expect(verified.status).toBe(200);
    expect(sessionCookieFrom(verified)).toBeTruthy();
    expect(hookPaths.at(-1)).toBe("/two-factor/verify-otp");
  });
});

describe("staff accounts on Google / Apple", () => {
  const addPasskey = (email: string) => {
    db.passkey!.push({
      id: `pk-${email}`,
      userId: userRow(email).id,
      credentialID: `cred-${email}`,
      publicKey: "pk",
      counter: 0,
    });
  };
  const makeStaff = (email: string) =>
    staffRoles.set(userRow(email).id as string, ["ADMIN"]);

  describe("a staff account with a passkey and no authenticator app", () => {
    beforeEach(async () => {
      await createAccount("staff@example.com", {
        twoFactorEnabled: false,
        emailVerified: true,
      });
      addPasskey("staff@example.com");
      makeStaff("staff@example.com");
    });

    it("is refused on /oauth-proxy-callback: redirect with the staff code, no session, no link", async () => {
      const before = sessionsOf("staff@example.com");

      const { res } = await continueWithGoogle();

      expect(hookPaths.at(-1)).toBe("/oauth-proxy-callback");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(STAFF_REFUSED_AT_WEB);
      expect(sessionCookieFrom(res)).toBeUndefined();
      expect(sessionsOf("staff@example.com")).toBe(before);
      expect(providersOf("staff@example.com")).toEqual(["credential"]);
      expect(reportError).not.toHaveBeenCalled();
    });

    it("is refused on /callback/:id (no proxy), and nothing is linked", async () => {
      auth = buildAuth({ proxied: false });
      const before = sessionsOf("staff@example.com");

      const { res, visited } = await continueWithGoogle();

      expect(visited).toEqual(["/callback/google"]);
      expect(hookPaths.at(-1)).toBe("/callback/:id");
      expect(res.headers.get("location")).toBe(STAFF_REFUSED_AT_WEB);
      expect(sessionsOf("staff@example.com")).toBe(before);
      expect(providersOf("staff@example.com")).toEqual(["credential"]);
    });

    it("is refused on /sign-in/social with an idToken: the 400 body, nothing linked", async () => {
      const res = await signInWithGoogleIdToken();

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ...STAFF_USE_PASSKEY_ERROR });
      expect(sessionCookieFrom(res)).toBeUndefined();
      expect(hookPaths.at(-1)).toBe("/sign-in/social");
      expect(providersOf("staff@example.com")).toEqual(["credential"]);
    });
  });

  it("a NON-staff account with a passkey still signs in with Google", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: false,
      emailVerified: true,
    });
    addPasskey("staff@example.com");

    const { res } = await continueWithGoogle();

    expect(res.headers.get("location")).toBe(`${WEB_URL}/my-tickets`);
    expect(sessionCookieFrom(res)).toBeTruthy();
  });

  it("a two-factor STAFF account whose only way in is Google is refused, not let through (no provider-only allowance for staff)", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    linkGoogle("staff@example.com", googleProfile.sub);
    dropPassword("staff@example.com");
    makeStaff("staff@example.com");
    const before = sessionsOf("staff@example.com");

    const { res } = await continueWithGoogle();

    expect(res.headers.get("location")).toBe(REFUSED_AT_WEB);
    expect(sessionCookieFrom(res)).toBeUndefined();
    expect(sessionsOf("staff@example.com")).toBe(before);
    // A refusal, not the reported provider-only allowance.
    expect(reportError).not.toHaveBeenCalled();
  });

  it("the same two-factor staff account is refused on /sign-in/social with an idToken", async () => {
    await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    linkGoogle("staff@example.com", googleProfile.sub);
    dropPassword("staff@example.com");
    makeStaff("staff@example.com");

    const res = await signInWithGoogleIdToken();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ...TWO_FACTOR_USE_PRIMARY_SIGN_IN_ERROR });
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("linking Google from account settings is not a sign-in", () => {
  /**
   * `/link-social` as the browser does it: the signed-in user starts the
   * flow, comes back from Google on `/callback/google`. Better Auth carries
   * `link.userId` in the OAuth state and creates the account without a new
   * session.
   */
  const linkFromSettings = async (cookie: string) => {
    const start = await request("POST", "/link-social", {
      body: { provider: "google", callbackURL: `${WEB_URL}/settings` },
      cookie,
    });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get("state")!;
    return request(
      "GET",
      `${AUTH_BASE}/callback/google?code=auth-code&state=${encodeURIComponent(state)}`,
      { cookie: [cookie, cookiesFrom(start)].filter(Boolean).join("; ") },
    );
  };

  it.each([
    ["with the proxy, as in production", true],
    ["without the proxy", false],
  ])(
    "a signed-in two-factor user links Google (%s): the link is written and no session is minted",
    async (_label, proxied) => {
      auth = buildAuth({ proxied });
      const cookie = await createAccount("staff@example.com", {
        twoFactorEnabled: true,
        emailVerified: true,
      });
      const before = sessionsOf("staff@example.com");
      hookPaths = [];

      const res = await linkFromSettings(cookie);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${WEB_URL}/settings`);
      expect(providersOf("staff@example.com")).toEqual([
        "credential",
        "google",
      ]);
      // Not a sign-in: the session hook never ran.
      expect(hookPaths).toEqual([]);
      expect(sessionsOf("staff@example.com")).toBe(before);
      expect(userRow("staff@example.com").twoFactorEnabled).toBe(true);
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it("a signed-in two-factor user links Google with an idToken (/link-social): the link is written", async () => {
    const cookie = await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    const before = sessionsOf("staff@example.com");

    const res = await request("POST", "/link-social", {
      body: { provider: "google", idToken: { token: googleIdToken() } },
      cookie,
    });

    expect(res.status).toBe(200);
    expect(providersOf("staff@example.com")).toEqual(["credential", "google"]);
    expect(sessionsOf("staff@example.com")).toBe(before);
  });

  it("after linking from settings, Google still does not sign that two-factor account in", async () => {
    const cookie = await createAccount("staff@example.com", {
      twoFactorEnabled: true,
      emailVerified: true,
    });
    await linkFromSettings(cookie);
    const before = sessionsOf("staff@example.com");

    const { res } = await continueWithGoogle();

    expect(res.headers.get("location")).toBe(REFUSED_AT_WEB);
    expect(sessionsOf("staff@example.com")).toBe(before);
  });
});

describe("skipsProviderLinkForTwoFactor", () => {
  const google = { userId: "u1", providerId: "google" };
  const contextFor = (
    user: unknown,
    extra: { accounts?: unknown[]; passkeys?: unknown[] } = {},
  ) => ({
    internalAdapter: {
      findUserById: vi.fn(async () => user),
      findAccounts: vi.fn(
        async () =>
          extra.accounts ?? [{ providerId: "credential", password: "hash" }],
      ),
    },
    adapter: {
      findMany: vi.fn(async () => extra.passkeys ?? []),
      findOne: vi.fn(async () => null),
    },
  });
  const noLink = {
    oauthLinkUserId: async () => undefined,
    staffRolesOf: async (): Promise<string[]> => [],
  };

  it.each(["/oauth-proxy-callback", "/callback/:id", "/sign-in/social"])(
    "skips the link on %s for a two-factor account that has a password",
    async (path) => {
      const context = contextFor({ twoFactorEnabled: true });
      expect(
        await skipsProviderLinkForTwoFactor({ path, context }, google, noLink),
      ).toBe(true);
    },
  );

  it("skips the link on a route nobody listed (the session there is refused too)", async () => {
    const context = contextFor({ twoFactorEnabled: true });
    expect(
      await skipsProviderLinkForTwoFactor(
        { path: "/later/route", context },
        google,
        noLink,
      ),
    ).toBe(true);
  });

  it("keeps the link for an account without two-factor", async () => {
    const context = contextFor({ twoFactorEnabled: false });
    expect(
      await skipsProviderLinkForTwoFactor(
        { path: "/oauth-proxy-callback", context },
        google,
        noLink,
      ),
    ).toBe(false);
    expect(context.internalAdapter.findAccounts).not.toHaveBeenCalled();
  });

  it("keeps the link when the provider is the account's only way in (the session hook lets that sign-in through)", async () => {
    const context = contextFor(
      { twoFactorEnabled: true },
      { accounts: [{ providerId: "apple" }] },
    );
    expect(
      await skipsProviderLinkForTwoFactor(
        { path: "/oauth-proxy-callback", context },
        google,
        noLink,
      ),
    ).toBe(false);
  });

  it("skips the link for a passkey-gated staff account (no two-factor, a passkey, a staff role)", async () => {
    const context = contextFor(
      { twoFactorEnabled: false },
      { passkeys: [{ id: "pk1" }] },
    );
    expect(
      await skipsProviderLinkForTwoFactor(
        { path: "/oauth-proxy-callback", context },
        google,
        { ...noLink, staffRolesOf: async () => ["ADMIN"] },
      ),
    ).toBe(true);
  });

  it("skips the link for a two-factor STAFF account whose only way in is the provider", async () => {
    const context = contextFor(
      { twoFactorEnabled: true },
      { accounts: [{ providerId: "apple" }] },
    );
    expect(
      await skipsProviderLinkForTwoFactor(
        { path: "/oauth-proxy-callback", context },
        google,
        { ...noLink, staffRolesOf: async () => ["SUPPORT"] },
      ),
    ).toBe(true);
  });

  it("never touches the password row", async () => {
    const context = contextFor({ twoFactorEnabled: true });
    expect(
      await skipsProviderLinkForTwoFactor(
        { path: "/reset-password", context },
        { userId: "u1", providerId: "credential" },
        noLink,
      ),
    ).toBe(false);
    expect(context.internalAdapter.findUserById).not.toHaveBeenCalled();
  });

  it("keeps a link made on /link-social", async () => {
    const context = contextFor({ twoFactorEnabled: true });
    expect(
      await skipsProviderLinkForTwoFactor(
        { path: "/link-social", context },
        google,
        noLink,
      ),
    ).toBe(false);
    expect(context.internalAdapter.findUserById).not.toHaveBeenCalled();
  });

  it("keeps a link on /callback/:id whose OAuth state names this user as the linker", async () => {
    const context = contextFor({ twoFactorEnabled: true });
    expect(
      await skipsProviderLinkForTwoFactor(
        { path: "/callback/:id", context },
        google,
        { ...noLink, oauthLinkUserId: async () => "u1" },
      ),
    ).toBe(false);
  });

  it("skips a link on /callback/:id whose OAuth state names a DIFFERENT user", async () => {
    const context = contextFor({ twoFactorEnabled: true });
    expect(
      await skipsProviderLinkForTwoFactor(
        { path: "/callback/:id", context },
        google,
        { ...noLink, oauthLinkUserId: async () => "someone-else" },
      ),
    ).toBe(true);
  });

  it("does not read the OAuth state on the proxy's callback (a link never ends there)", async () => {
    const oauthLinkUserId = vi.fn(async () => "u1");
    const context = contextFor({ twoFactorEnabled: true });
    expect(
      await skipsProviderLinkForTwoFactor(
        { path: "/oauth-proxy-callback", context },
        google,
        { ...noLink, oauthLinkUserId },
      ),
    ).toBe(true);
    expect(oauthLinkUserId).not.toHaveBeenCalled();
  });

  it("keeps the link when the user row cannot be read yet (a provider sign-up)", async () => {
    const context = contextFor(null);
    expect(
      await skipsProviderLinkForTwoFactor(
        { path: "/oauth-proxy-callback", context },
        google,
        noLink,
      ),
    ).toBe(false);
  });

  it.each([
    [
      "the user lookup fails",
      () => {
        const context = contextFor({ twoFactorEnabled: true });
        context.internalAdapter.findUserById.mockRejectedValue(
          new Error("db down"),
        );
        return { ctx: { path: "/oauth-proxy-callback", context }, opts: noLink };
      },
    ],
    [
      "the passkey lookup fails",
      () => {
        const context = contextFor({ twoFactorEnabled: true });
        context.adapter.findMany.mockRejectedValue(new Error("db down"));
        return { ctx: { path: "/oauth-proxy-callback", context }, opts: noLink };
      },
    ],
    [
      "the OAuth state cannot be read",
      () => ({
        ctx: {
          path: "/callback/:id",
          context: contextFor({ twoFactorEnabled: true }),
        },
        opts: {
          ...noLink,
          oauthLinkUserId: async () => {
            throw new Error("db down");
          },
        },
      }),
    ],
    [
      "there is no endpoint context",
      () => ({ ctx: { path: "/oauth-proxy-callback" }, opts: noLink }),
    ],
  ])("fails closed and reports once when %s", async (_label, build) => {
    const report = vi.fn();
    const { ctx, opts } = build();
    await expect(
      skipsProviderLinkForTwoFactor(ctx, google, {
        ...opts,
        reportError: report,
      }),
    ).rejects.toMatchObject({ status: "INTERNAL_SERVER_ERROR" });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      {
        tags: { area: "auth", op: "second_factor_provider_link_lookup" },
        extra: {
          authUserId: "u1",
          providerId: "google",
          path: ctx.path,
        },
      },
    );
  });

  it("a throwing reporter does not change the outcome", async () => {
    await expect(
      skipsProviderLinkForTwoFactor({ path: "/oauth-proxy-callback" }, google, {
        ...noLink,
        reportError: () => {
          throw new Error("reporter down");
        },
      }),
    ).rejects.toMatchObject({ status: "INTERNAL_SERVER_ERROR" });
  });
});
