import { describe, expect, it } from "vitest";

import { hasSessionCookie } from "../session-cookie";

describe("hasSessionCookie", () => {
  it("returns false for a cookie header with only non-session cookies", () => {
    // The exact regression: anonymous viewers still carry cookies, and the old
    // `if (cookie)` guard treated them as signed in.
    expect(hasSessionCookie("th-theme=dark")).toBe(false);
    expect(
      hasSessionCookie("th-theme=dark; th_consent=1; th_eu_abc=sig"),
    ).toBe(false);
  });

  it("returns false for empty/absent cookie headers", () => {
    expect(hasSessionCookie("")).toBe(false);
    expect(hasSessionCookie(null)).toBe(false);
    expect(hasSessionCookie(undefined)).toBe(false);
  });

  it("returns true for the dev/local session cookie", () => {
    expect(hasSessionCookie("better-auth.session_token=abc123")).toBe(true);
    expect(
      hasSessionCookie("th-theme=dark; better-auth.session_token=abc123"),
    ).toBe(true);
  });

  it("returns true for the prod __Secure- prefixed session cookie", () => {
    expect(
      hasSessionCookie("__Secure-better-auth.session_token=abc123"),
    ).toBe(true);
    expect(
      hasSessionCookie(
        "th-theme=light; __Secure-better-auth.session_token=abc123; th_eu_abc=sig",
      ),
    ).toBe(true);
  });

  it("returns true for the deployed-dev prefixed session cookie", () => {
    // Deployed dev sets cookiePrefix="better-auth-dev" so its cross-subdomain
    // cookie doesn't collide with prod's on the shared .ithasfire.com domain.
    expect(hasSessionCookie("better-auth-dev.session_token=abc123")).toBe(true);
    expect(
      hasSessionCookie(
        "th-theme=dark; __Secure-better-auth-dev.session_token=abc123; th_eu_abc=sig",
      ),
    ).toBe(true);
  });

  it("does not match a sibling better-auth cookie or the token inside a value", () => {
    // Anchored to `.session_token`, so `better-auth.dont_remember` is ignored.
    expect(hasSessionCookie("better-auth.dont_remember=1")).toBe(false);
    // Parses names, not a raw substring: the marker inside an unrelated
    // cookie's VALUE must not read as a session.
    expect(hasSessionCookie("decoy=better-auth.session_token")).toBe(false);
  });
});
