import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { beforeAll, describe, expect, it } from "vitest";

import {
  HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES,
  hostOnlySessionCookiesToClearForResponse,
} from "../src/auth/host-only-session-cookie";

/**
 * The ONE test that can catch a silent regression here.
 *
 * `host-only-session-cookie.test.ts` covers name selection and explicitly
 * declines to assert the wire format. That leaves the actual guarantee
 * untested: that the response carries TWO `Set-Cookie` entries for the session
 * token — one with `Domain=.ithasfire.com` (Better Auth's own) and one with no
 * `Domain=` at all (ours, expiring the pre-deploy host-only shadow) — and that
 * appending ours does not clobber Better Auth's.
 *
 * That gap is dangerous specifically because the whole branch is INERT on dev
 * and in every other test: `crossSubDomainCookieDomain` is `null` without
 * `SESSION_COOKIE_DOMAIN`, so `hostOnlySessionCookiesToClear*` returns `[]` and
 * a hook that silently stopped emitting anything would look identical to a
 * healthy one. Nothing else in the suite would notice.
 *
 * So this builds a REAL `betterAuth()` (memory adapter, cross-subdomain cookies
 * on) and drives real HTTP requests through `auth.handler`, asserting on
 * `response.headers.getSetCookie()`. The hook body is the same exported
 * function `better-auth.ts` calls, so a change to the predicate — e.g.
 * narrowing it back to `ctx.path === "/sign-out"` — fails the
 * session-establishing cases below.
 */

const COOKIE_DOMAIN = ".ithasfire.com";
const BASE_URL = "https://api.ithasfire.com";
const SESSION_TOKEN = "__Secure-better-auth.session_token";
const EMAIL = "ghost@example.com";
const PASSWORD = "correct-horse-battery-staple";

type MemoryDb = Record<string, Record<string, unknown>[]>;

const buildAuth = () => {
  const db: MemoryDb = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };

  return betterAuth({
    baseURL: BASE_URL,
    secret: "test-secret-test-secret-test-secret-32",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    advanced: {
      crossSubDomainCookies: { enabled: true, domain: COOKIE_DOMAIN },
      defaultCookieAttributes: { sameSite: "lax", secure: true },
    },
    hooks: {
      // Byte-for-byte the production hook body (apps/api/src/auth/better-auth.ts).
      after: createAuthMiddleware(async (ctx) => {
        for (const name of hostOnlySessionCookiesToClearForResponse({
          path: ctx.path,
          responseHeaders: ctx.context.responseHeaders,
          crossSubDomainCookieDomain: COOKIE_DOMAIN,
          sessionTokenName: ctx.context.authCookies.sessionToken.name,
          sessionDataName: ctx.context.authCookies.sessionData?.name ?? "",
          cookieCacheEnabled: Boolean(
            ctx.context.options.session?.cookieCache?.enabled,
          ),
        })) {
          ctx.setCookie(name, "", HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES);
        }
      }),
    },
  });
};

let auth: ReturnType<typeof buildAuth>;

const post = (path: string, init: { body?: unknown; cookie?: string } = {}) =>
  auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Better Auth rejects cookie-bearing POSTs without an Origin
        // (MISSING_OR_NULL_ORIGIN); this is what a real browser sends.
        origin: BASE_URL,
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );

/** All `Set-Cookie` entries whose cookie NAME is `name`. */
const cookiesNamed = (response: Response, name: string): string[] =>
  response.headers
    .getSetCookie()
    .filter((c) => c.slice(0, c.indexOf("=")).trim() === name);

const hasDomainAttribute = (cookie: string): boolean =>
  /;\s*Domain=/i.test(cookie);

/**
 * The assertion that matters: for one cookie name, the response emits both a
 * domain-scoped entry AND a host-only one. Those are separate rows in the jar
 * (RFC 6265 §5.3 keys on (name, domain, path), host-only being part of the
 * domain key), which is why expiring one cannot disturb the other.
 */
const expectBothScopes = (response: Response) => {
  const entries = cookiesNamed(response, SESSION_TOKEN);
  const domainScoped = entries.filter(hasDomainAttribute);
  const hostOnly = entries.filter((c) => !hasDomainAttribute(c));

  expect(
    domainScoped,
    `expected a Domain=${COOKIE_DOMAIN} entry for ${SESSION_TOKEN}; got ${JSON.stringify(entries)}`,
  ).toHaveLength(1);
  expect(
    hostOnly,
    `expected a host-only (no Domain=) entry for ${SESSION_TOKEN}; got ${JSON.stringify(entries)}`,
  ).toHaveLength(1);

  expect(domainScoped[0]).toContain(`Domain=${COOKIE_DOMAIN}`);
  // The host-only entry must be an EXPIRY, never a live cookie.
  expect(hostOnly[0]).toMatch(/;\s*Max-Age=0\b/);
  expect(hostOnly[0]).toContain("Path=/");
  // `__Secure-` prefixed cookies are rejected outright without Secure.
  expect(hostOnly[0]).toContain("Secure");

  return { domainScoped: domainScoped[0]!, hostOnly: hostOnly[0]! };
};

describe("host-only session cookie — real Set-Cookie wire format", () => {
  beforeAll(() => {
    auth = buildAuth();
  });

  it("emits both scopes on a session-ESTABLISHING response (sign-up)", async () => {
    const response = await post("/sign-up/email", {
      body: { email: EMAIL, password: PASSWORD, name: "Ghost" },
    });
    expect(response.status).toBe(200);

    const { domainScoped } = expectBothScopes(response);
    // The freshly minted session must survive our clear: it is a different jar
    // entry, and it carries a real token, not an expiry.
    expect(domainScoped).not.toMatch(/;\s*Max-Age=0\b/);
    expect(domainScoped.split(";")[0]).not.toBe(`${SESSION_TOKEN}=`);
  });

  it("emits both scopes on sign-in — the passkey/OAuth-shaped case the path allowlist missed", async () => {
    // `/sign-in/email` stands in for every session-establishing endpoint
    // (passkey verify, OAuth callback, magic-link verify, 2FA verify): they all
    // reach this hook with the session-token cookie already on the response,
    // which is exactly what the predicate keys on. The old
    // `ctx.path === "/sign-out"` gate emitted NOTHING here.
    const response = await post("/sign-in/email", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(response.status).toBe(200);

    const { domainScoped, hostOnly } = expectBothScopes(response);
    expect(domainScoped).not.toMatch(/;\s*Max-Age=0\b/);
    expect(hostOnly).toMatch(/;\s*Max-Age=0\b/);
  });

  it("emits both scopes on sign-out", async () => {
    const signIn = await post("/sign-in/email", {
      body: { email: EMAIL, password: PASSWORD },
    });
    const token = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find(
        (c) =>
          c.startsWith(`${SESSION_TOKEN}=`) &&
          c.length > SESSION_TOKEN.length + 1,
      );
    expect(token).toBeTruthy();

    const response = await post("/sign-out", { cookie: token });
    expect(response.status).toBe(200);

    const { domainScoped, hostOnly } = expectBothScopes(response);
    // Both are expiries on this path.
    expect(domainScoped).toMatch(/;\s*Max-Age=0\b/);
    expect(hostOnly).toMatch(/;\s*Max-Age=0\b/);
  });

  it("does not emit a host-only clear on responses that never touch the session cookie", async () => {
    // A read that mints no cookie must not grow a spurious expiry header —
    // otherwise the hook would be indiscriminate rather than targeted.
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, {
        method: "GET",
        headers: { origin: BASE_URL },
      }),
    );

    expect(cookiesNamed(response, SESSION_TOKEN)).toEqual([]);
  });

  it("stays inert when no cross-subdomain domain is configured (dev)", async () => {
    // Same code path, `crossSubDomainCookieDomain: null`: the cookie is already
    // host-only, Better Auth clears exactly the right entry, and a duplicate
    // would be noise. Asserted here so the prod-only gating is not accidental.
    expect(
      hostOnlySessionCookiesToClearForResponse({
        path: "/sign-in/email",
        responseHeaders: new Headers({
          "set-cookie": `${SESSION_TOKEN}=abc; Path=/`,
        }),
        crossSubDomainCookieDomain: null,
        sessionTokenName: SESSION_TOKEN,
        sessionDataName: "__Secure-better-auth.session_data",
        cookieCacheEnabled: false,
      }),
    ).toEqual([]);
  });
});
