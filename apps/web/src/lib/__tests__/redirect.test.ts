import { describe, expect, it } from "vitest";
import type { ReadonlyURLSearchParams } from "next/navigation";

import {
  appendRedirectParam,
  readRedirectParam,
  sanitizeRedirectPath,
} from "../redirect";

const asSearchParams = (value: string): ReadonlyURLSearchParams =>
  new URLSearchParams(value) as unknown as ReadonlyURLSearchParams;

describe("sanitizeRedirectPath", () => {
  it("returns null for falsy values", () => {
    expect(sanitizeRedirectPath(null)).toBeNull();
    expect(sanitizeRedirectPath("" as unknown as string)).toBeNull();
  });

  it("rejects absolute URLs and protocol-relative paths", () => {
    expect(sanitizeRedirectPath("https://example.com")).toBeNull();
    expect(sanitizeRedirectPath("//example.com")).toBeNull();
  });

  it("rejects backslash / control-char protocol-relative bypass vectors", () => {
    // Browsers normalize "\" -> "/" and strip tab/newline/CR, so each of these
    // resolves to https://evil.com and must be rejected. Regression guard for
    // the confirmed open-redirect bypass.
    expect(sanitizeRedirectPath("/\\evil.com")).toBeNull();
    expect(sanitizeRedirectPath("/\t//evil.com")).toBeNull();
    expect(sanitizeRedirectPath("/\n/evil.com")).toBeNull();
    expect(sanitizeRedirectPath("/\r//evil.com")).toBeNull();
    expect(sanitizeRedirectPath("javascript:alert(1)")).toBeNull();
  });

  it("rejects destinations that point back at the sign-in surface", () => {
    // Not a security issue — the sentinel-origin check already handles the
    // hostile cases. This is a wedge guard: `?redirect_url=%2Fsign-in` makes a
    // signed-in user `router.replace("/sign-in")` onto the SAME route segment,
    // which doesn't unmount the page, so `redirecting` stays latched and they
    // get ~9s of blank screen followed by a sign-in form they don't need.
    expect(sanitizeRedirectPath("/sign-in")).toBeNull();
    expect(sanitizeRedirectPath("/sign-in?foo=bar")).toBeNull();
    // `/sign-in` is a catch-all route ([[...index]]), so sub-paths wedge too.
    expect(sanitizeRedirectPath("/sign-in/callback")).toBeNull();
    // …but a merely similar prefix is a real destination and must survive.
    expect(sanitizeRedirectPath("/sign-in-help")).toBe("/sign-in-help");
    expect(sanitizeRedirectPath("/sign-up")).toBe("/sign-up");
  });

  it("falls back through the alias keys when the destination is the sign-in page", () => {
    const params = asSearchParams("redirect_url=%2Fsign-in&redirect=%2Fevents");
    expect(readRedirectParam(params)).toBe("/events");
  });

  it("returns normalized same-origin paths", () => {
    expect(sanitizeRedirectPath("/dashboard")).toBe("/dashboard");
    expect(sanitizeRedirectPath("/events/foo?x=1#y")).toBe("/events/foo?x=1#y");
    // The URL parser normalizes a bare relative to a same-origin path; safe.
    expect(sanitizeRedirectPath("account" as unknown as string)).toBe(
      "/account",
    );
  });
});

describe("readRedirectParam", () => {
  it("returns the first matching key when present", () => {
    const params = asSearchParams("redirect_url=%2Fevents%2F123&foo=bar");
    expect(readRedirectParam(params)).toBe("/events/123");
  });

  it("preserves encoded nested query values during append/read round-trips", () => {
    const destination =
      "/claim-transfer?token=a%2Bb%3D%3D&email=test%2Balias%40example.com";
    const targetUrl = appendRedirectParam("/sign-in", destination);
    const query = targetUrl.split("?")[1] ?? "";

    expect(readRedirectParam(asSearchParams(query))).toBe(destination);
  });

  it("falls back to camelCase parameters", () => {
    const params = asSearchParams("redirectUrl=%2Fsettings");
    expect(readRedirectParam(params)).toBe("/settings");
  });

  it("supports the legacy redirect key", () => {
    const params = asSearchParams("redirect=%2Faccount%2Fbilling");
    expect(readRedirectParam(params)).toBe("/account/billing");
  });

  it("skips unsafe values and continues checking supported aliases", () => {
    const params = asSearchParams(
      "redirect_url=%2F%2Fevil.example&redirect=%2Fsafe-destination",
    );
    expect(readRedirectParam(params)).toBe("/safe-destination");
  });

  it("rejects the %5C backslash bypass decoded by URLSearchParams", () => {
    // URLSearchParams.get decodes %5C -> "\", surfacing the "/\evil.com"
    // bypass to the guard. This exercises the real source -> guard path.
    const params = asSearchParams("redirect=%2F%5Cevil.com");
    expect(readRedirectParam(params)).toBeNull();
  });

  it("returns null when nothing valid is present", () => {
    const params = asSearchParams("redirect=https%3A%2F%2Fevil.example");
    expect(readRedirectParam(params)).toBeNull();
  });
});

describe("appendRedirectParam", () => {
  it("returns the original URL when no destination is provided", () => {
    expect(appendRedirectParam("/auth/sync", null)).toBe("/auth/sync");
  });

  it("appends a query string when one does not exist", () => {
    expect(appendRedirectParam("/auth/sync", "/events")).toBe(
      "/auth/sync?redirect_url=%2Fevents",
    );
  });

  it("appends using an ampersand when the URL already has params", () => {
    expect(appendRedirectParam("/auth/sync?foo=bar", "/events")).toBe(
      "/auth/sync?foo=bar&redirect_url=%2Fevents",
    );
  });
});
