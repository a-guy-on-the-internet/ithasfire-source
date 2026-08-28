import { describe, expect, it } from "vitest";

import {
  HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES,
  hostOnlySessionCookiesToClear,
  hostOnlySessionCookiesToClearForResponse,
  responseSetsCookieNamed,
} from "../src/auth/host-only-session-cookie";

/**
 * Regression: prod shipped `SESSION_COOKIE_DOMAIN=.ithasfire.com`, but every
 * session minted before that deploy is carried by a HOST-ONLY cookie of the
 * same name. RFC 6265 keys cookies on (name, domain, path), so Better Auth's
 * sign-out — which re-serializes from the current config, i.e. WITH
 * `Domain=.ithasfire.com` — never touches the host-only entry. It survives,
 * stays visible to `api.ithasfire.com` and invisible to the apex, and wedges
 * the user on a blank `/sign-in`.
 */

const BASE = {
  sessionTokenName: "__Secure-better-auth.session_token",
  sessionDataName: "__Secure-better-auth.session_data",
  cookieCacheEnabled: false,
};

describe("hostOnlySessionCookiesToClear", () => {
  it("clears the session token when a cross-subdomain domain is configured", () => {
    expect(
      hostOnlySessionCookiesToClear({
        ...BASE,
        crossSubDomainCookieDomain: ".ithasfire.com",
      }),
    ).toEqual(["__Secure-better-auth.session_token"]);
  });

  it("emits nothing on a host-only deployment (dev/localhost)", () => {
    // Without SESSION_COOKIE_DOMAIN the cookie is ALREADY host-only, so Better
    // Auth's own clearing cookie hits the right entry — a duplicate would be
    // pure noise.
    expect(
      hostOnlySessionCookiesToClear({
        ...BASE,
        crossSubDomainCookieDomain: null,
      }),
    ).toEqual([]);
  });

  it("uses the runtime cookie name rather than a hardcoded prefix", () => {
    // The `__Secure-` prefix is env-dependent (http dev vs https prod), so the
    // name must come from `ctx.context.authCookies`, never a literal.
    expect(
      hostOnlySessionCookiesToClear({
        ...BASE,
        sessionTokenName: "better-auth.session_token",
        crossSubDomainCookieDomain: ".ithasfire.com",
      }),
    ).toEqual(["better-auth.session_token"]);
  });

  it("skips session_data while the cookie cache is disabled", () => {
    // `setCookieCache` early-returns when the cache is off, so the cookie is
    // never written and no host-only shadow of it can exist.
    expect(
      hostOnlySessionCookiesToClear({
        ...BASE,
        cookieCacheEnabled: false,
        crossSubDomainCookieDomain: ".ithasfire.com",
      }),
    ).not.toContain("__Secure-better-auth.session_data");
  });

  it("includes session_data once the cookie cache is enabled", () => {
    expect(
      hostOnlySessionCookiesToClear({
        ...BASE,
        cookieCacheEnabled: true,
        crossSubDomainCookieDomain: ".ithasfire.com",
      }),
    ).toEqual([
      "__Secure-better-auth.session_token",
      "__Secure-better-auth.session_data",
    ]);
  });

  it("drops empty cookie names rather than emitting a malformed header", () => {
    expect(
      hostOnlySessionCookiesToClear({
        ...BASE,
        sessionTokenName: "",
        crossSubDomainCookieDomain: ".ithasfire.com",
      }),
    ).toEqual([]);
  });
});

describe("HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES", () => {
  it("omits `domain` — that absence is what makes the cookie host-only", () => {
    expect(HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES).not.toHaveProperty("domain");
  });

  it("expires immediately and is scoped to the whole site", () => {
    expect(HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES.maxAge).toBe(0);
    expect(HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES.path).toBe("/");
  });

  it("keeps Secure set — `__Secure-` prefixed cookies are rejected without it", () => {
    expect(HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES.secure).toBe(true);
    expect(HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES.httpOnly).toBe(true);
    expect(HOST_ONLY_CLEAR_COOKIE_ATTRIBUTES.sameSite).toBe("lax");
  });
});

describe("responseSetsCookieNamed", () => {
  const headersWith = (...cookies: string[]) => {
    const headers = new Headers();
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return headers;
  };

  it("matches the session token among several Set-Cookie entries", () => {
    expect(
      responseSetsCookieNamed(
        headersWith(
          "csrf=abc; Path=/",
          `${BASE.sessionTokenName}=xyz; Domain=.ithasfire.com; Path=/`,
        ),
        BASE.sessionTokenName,
      ),
    ).toBe(true);
  });

  it("does not match a cookie whose name merely CONTAINS the target", () => {
    // `…session_token_v2` must not be read as `…session_token`, or we'd emit a
    // clear on responses that never touch the real session cookie.
    expect(
      responseSetsCookieNamed(
        headersWith(`${BASE.sessionTokenName}_v2=xyz; Path=/`),
        BASE.sessionTokenName,
      ),
    ).toBe(false);
  });

  it("is not fooled by commas inside an Expires attribute", () => {
    // The reason this reads `getSetCookie()` rather than splitting
    // `get("set-cookie")`: cookie dates contain ", ", which is also the header
    // join separator.
    expect(
      responseSetsCookieNamed(
        headersWith(
          "marketing=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
        ),
        BASE.sessionTokenName,
      ),
    ).toBe(false);
  });

  it("returns false for absent headers or an empty name", () => {
    expect(responseSetsCookieNamed(null, BASE.sessionTokenName)).toBe(false);
    expect(responseSetsCookieNamed(undefined, BASE.sessionTokenName)).toBe(
      false,
    );
    expect(responseSetsCookieNamed(headersWith("a=b"), "")).toBe(false);
  });
});

describe("hostOnlySessionCookiesToClearForResponse", () => {
  const PROD = {
    ...BASE,
    crossSubDomainCookieDomain: ".ithasfire.com",
  };

  const setCookie = (value: string) => new Headers({ "set-cookie": value });

  it("fires on any response that establishes a session", () => {
    // The regression this exists for: `/sign-in` is passkey-first, so a
    // `/sign-out`-only gate never ran for most users and the ghost cookie
    // survived their next sign-in.
    for (const path of [
      "/sign-in/email",
      "/passkey/verify-authentication",
      "/callback/google",
      "/magic-link/verify",
      "/two-factor/verify-totp",
    ]) {
      expect(
        hostOnlySessionCookiesToClearForResponse({
          ...PROD,
          path,
          responseHeaders: setCookie(
            `${BASE.sessionTokenName}=fresh; Domain=.ithasfire.com; Path=/`,
          ),
        }),
        path,
      ).toEqual([BASE.sessionTokenName]);
    }
  });

  it("fires on sign-out even when the response wrote no cookie", () => {
    // Sign-out's entire job is "leave this browser with no session", so it may
    // not depend on Better Auth having found a session to clear.
    expect(
      hostOnlySessionCookiesToClearForResponse({
        ...PROD,
        path: "/sign-out",
        responseHeaders: null,
      }),
    ).toEqual([BASE.sessionTokenName]);
  });

  it("stays silent on responses that never touch the session cookie", () => {
    expect(
      hostOnlySessionCookiesToClearForResponse({
        ...PROD,
        path: "/get-session",
        responseHeaders: setCookie("something-else=1; Path=/"),
      }),
    ).toEqual([]);
  });

  it("stays inert on a host-only deployment even when a session is set", () => {
    expect(
      hostOnlySessionCookiesToClearForResponse({
        ...BASE,
        crossSubDomainCookieDomain: null,
        path: "/sign-in/email",
        responseHeaders: setCookie(`${BASE.sessionTokenName}=fresh; Path=/`),
      }),
    ).toEqual([]);
  });
});

// NOT unit-tested here: the final `Set-Cookie` wire format. Serialization is
// better-call's `serializeCookie` (invoked by `ctx.setCookie`), and asserting
// it would mean either re-implementing that serializer in the test — a
// tautology that proves nothing — or importing an undeclared transitive
// dependency. The two properties that actually matter are pinned instead:
// `domain` is `never` at the type level (a `Domain=` can't be added by
// accident), and `serializeCookie` only appends `Domain=` when `opt.domain` is
// truthy.
//
// End-to-end header shape IS covered — see `host-only-session-cookie-wire.test.ts`,
// which drives a real `betterAuth()` over `auth.handler` and asserts
// `response.headers.getSetCookie()` carries both scopes.
