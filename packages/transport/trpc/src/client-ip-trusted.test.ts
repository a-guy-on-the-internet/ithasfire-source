import { describe, expect, it } from "vitest";

import {
  CLIENT_IP_HEADER_PRECEDENCE,
  TRUSTED_CLIENT_IP_HEADER_PRECEDENCE,
  VERIFIED_CLIENT_IP_HEADER,
  resolveClientIp,
  resolveTrustedClientIp,
} from "./client-ip";

/**
 * `resolveTrustedClientIp` / `TRUSTED_CLIENT_IP_HEADER_PRECEDENCE`: the
 * API-internal resolvers that honour the `x-th-verified-client-ip` header
 * stamped by apps/api's verified-client-ip plugin. The strip-then-stamp half
 * of the contract is tested in apps/api/test/verified-client-ip.test.ts.
 */
describe("resolveTrustedClientIp", () => {
  it("prefers the stamped verified IP over every forwarding header", () => {
    expect(
      resolveTrustedClientIp(
        {
          [VERIFIED_CLIENT_IP_HEADER]: "198.51.100.23",
          "cf-connecting-ip": "203.0.113.1",
          "x-forwarded-for": "192.0.2.9, 10.0.0.1",
        },
        "127.0.0.1",
      ),
    ).toBe("198.51.100.23");
  });

  it("reads the header case-insensitively", () => {
    expect(
      resolveTrustedClientIp({ "X-TH-Verified-Client-IP": "2001:db8::1" }),
    ).toBe("2001:db8::1");
  });

  it("is exactly resolveClientIp when no verified IP is stamped", () => {
    const headers = {
      "cf-connecting-ip": "203.0.113.1",
      "x-forwarded-for": "192.0.2.9",
    };
    expect(resolveTrustedClientIp(headers, "127.0.0.1")).toBe(
      resolveClientIp(headers, "127.0.0.1"),
    );
    expect(resolveTrustedClientIp({}, "10.1.2.3")).toBe("10.1.2.3");
    expect(resolveTrustedClientIp(null)).toBeNull();
  });

  it("ignores a stamped value that is not an IP and falls through", () => {
    for (const junk of ["not-an-ip", "203.0.113.1, 198.51.100.2", "", "x".repeat(80)]) {
      expect(
        resolveTrustedClientIp({
          [VERIFIED_CLIENT_IP_HEADER]: junk,
          "cf-connecting-ip": "203.0.113.1",
        }),
      ).toBe("203.0.113.1");
    }
  });
});

describe("header precedence lists", () => {
  it("puts the verified header first in the trusted list", () => {
    expect(TRUSTED_CLIENT_IP_HEADER_PRECEDENCE).toEqual([
      VERIFIED_CLIENT_IP_HEADER,
      ...CLIENT_IP_HEADER_PRECEDENCE,
    ]);
  });

  it("keeps the verified header OUT of the shared list (geo reuses it)", () => {
    expect(CLIENT_IP_HEADER_PRECEDENCE).not.toContain(VERIFIED_CLIENT_IP_HEADER);
    expect(
      resolveClientIp({ [VERIFIED_CLIENT_IP_HEADER]: "198.51.100.23" }),
    ).toBeNull();
  });
});
