import { describe, expect, it } from "vitest";

import { resolveCookieDomain } from "../src/auth/cookie-domain";

const PROD_API = "https://api.ithasfire.com";

describe("resolveCookieDomain", () => {
  describe("accepts a valid, host-bound leading-dot domain", () => {
    it("prod: .ithasfire.com bound to api.ithasfire.com → .ithasfire.com", () => {
      expect(resolveCookieDomain(".ithasfire.com", PROD_API)).toBe(
        ".ithasfire.com",
      );
    });

    it("api host may be the apex itself", () => {
      expect(
        resolveCookieDomain(".ithasfire.com", "https://ithasfire.com"),
      ).toBe(".ithasfire.com");
    });

    it("accepts a deeper (3-label) shared parent", () => {
      expect(
        resolveCookieDomain(
          ".staging.ithasfire.com",
          "https://api.staging.ithasfire.com",
        ),
      ).toBe(".staging.ithasfire.com");
    });

    it("normalizes casing and whitespace", () => {
      expect(
        resolveCookieDomain("  .ITHASFIRE.com  ", "https://API.ithasfire.com"),
      ).toBe(".ithasfire.com");
    });

    it("ignores api url port and path when binding to host", () => {
      expect(
        resolveCookieDomain(
          ".ithasfire.com",
          "https://api.ithasfire.com:443/api/auth",
        ),
      ).toBe(".ithasfire.com");
    });
  });

  describe("returns null (omit crossSubDomainCookies)", () => {
    it("unset / empty / whitespace", () => {
      expect(resolveCookieDomain(undefined, PROD_API)).toBeNull();
      expect(resolveCookieDomain("", PROD_API)).toBeNull();
      expect(resolveCookieDomain("   ", PROD_API)).toBeNull();
    });

    it("no leading dot", () => {
      expect(resolveCookieDomain("ithasfire.com", PROD_API)).toBeNull();
    });

    it("bare TLD (.com) — only one label after the dot", () => {
      expect(resolveCookieDomain(".com", "https://api.com")).toBeNull();
    });

    it("denylisted Cloud Run suffix (.run.app)", () => {
      expect(
        resolveCookieDomain(".run.app", "https://api-abc.run.app"),
      ).toBeNull();
    });

    it("denylisted Cloudflare Pages suffix (.pages.dev)", () => {
      expect(
        resolveCookieDomain(".pages.dev", "https://app.pages.dev"),
      ).toBeNull();
    });

    it("denylisted GCP hosting suffixes", () => {
      expect(
        resolveCookieDomain(".appspot.com", "https://app.appspot.com"),
      ).toBeNull();
      expect(
        resolveCookieDomain(".web.app", "https://app.web.app"),
      ).toBeNull();
      expect(
        resolveCookieDomain(".firebaseapp.com", "https://app.firebaseapp.com"),
      ).toBeNull();
      expect(
        resolveCookieDomain(".github.io", "https://user.github.io"),
      ).toBeNull();
    });

    it("two-label ccTLD shapes (.co.uk / .com.au)", () => {
      expect(resolveCookieDomain(".co.uk", "https://api.co.uk")).toBeNull();
      expect(resolveCookieDomain(".com.au", "https://api.com.au")).toBeNull();
    });

    it("domain is not a suffix of the api host", () => {
      expect(resolveCookieDomain(".example.com", PROD_API)).toBeNull();
    });

    it("missing api url (cannot host-bind)", () => {
      expect(resolveCookieDomain(".ithasfire.com", undefined)).toBeNull();
    });

    it("unparseable api url", () => {
      expect(
        resolveCookieDomain(".ithasfire.com", "not a url"),
      ).toBeNull();
    });

    it("empty labels (malformed dotted domain)", () => {
      expect(
        resolveCookieDomain(".ithasfire..com", PROD_API),
      ).toBeNull();
      expect(resolveCookieDomain("..com", "https://api..com")).toBeNull();
    });

    it("registrable-domain match must be label-aligned, not substring", () => {
      // `notithasfire.com` must NOT match `.ithasfire.com` (would be a substring
      // hit without the leading-dot boundary check).
      expect(
        resolveCookieDomain(".ithasfire.com", "https://api.notithasfire.com"),
      ).toBeNull();
    });
  });
});
