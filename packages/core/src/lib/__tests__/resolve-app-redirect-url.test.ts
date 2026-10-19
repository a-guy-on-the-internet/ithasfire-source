import { describe, expect, it } from "vitest";

import { resolveAppRedirectUrl } from "../resolve-app-redirect-url";

const APP = "https://ithasfire.com";

describe("resolveAppRedirectUrl", () => {
  it("accepts same-origin absolute URLs", () => {
    expect(resolveAppRedirectUrl("https://ithasfire.com/a?b=1", APP)).toBe(
      "https://ithasfire.com/a?b=1",
    );
  });

  it("resolves root-relative paths onto the app origin", () => {
    expect(resolveAppRedirectUrl("/admin/x/payments", APP)).toBe(
      "https://ithasfire.com/admin/x/payments",
    );
  });

  it.each([
    "https://evil.example/",
    "https://ithasfire.com.evil.example/",
    "https://ithasfire.com@evil.com/", // userinfo: host is evil.com
    "https://evil.com@ithasfire.com/", // same origin, but carries userinfo
    "https://evil.com\\@ithasfire.com/", // backslash-userinfo parser confusion
    "http://ithasfire.com/", // scheme differs → different origin
    "//evil.example/x",
    "/\\evil.example/x",
    "javascript:alert(1)",
    "relative/path",
    "/ok\nnext",
    "",
  ])("refuses %j", (raw) => {
    expect(() => resolveAppRedirectUrl(raw, APP)).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: "redirect_url_not_allowed",
      }),
    );
  });

  it("fails closed without a configured app URL", () => {
    expect(() => resolveAppRedirectUrl("/x", null)).toThrow(
      expect.objectContaining({ code: "SERVICE_UNAVAILABLE" }),
    );
  });
});
