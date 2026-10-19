import { describe, expect, it } from "vitest";

import {
  CLIENT_IP_HEADER_PRECEDENCE,
  describeClientIp,
  MAX_FORWARDED_FOR_LENGTH,
  resolveClientIp,
} from "./client-ip";

describe("resolveClientIp", () => {
  it("prefers cf-connecting-ip even against a spoofed multi-entry x-forwarded-for", () => {
    const ip = resolveClientIp(
      {
        // Attacker-supplied XFF chain must not win over the CF-set header.
        "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12",
        "true-client-ip": "40.40.40.40",
        "x-real-ip": "50.50.50.50",
        "cf-connecting-ip": "203.0.113.7",
      },
      "198.51.100.44",
    );

    expect(ip).toBe("203.0.113.7");
  });

  it("falls through true-client-ip → x-real-ip → x-forwarded-for(leftmost) → socket", () => {
    expect(
      resolveClientIp(
        {
          "true-client-ip": "40.40.40.40",
          "x-real-ip": "50.50.50.50",
          "x-forwarded-for": "60.60.60.60, 70.70.70.70",
        },
        "198.51.100.44",
      ),
    ).toBe("40.40.40.40");

    expect(
      resolveClientIp(
        {
          "x-real-ip": "50.50.50.50",
          "x-forwarded-for": "60.60.60.60, 70.70.70.70",
        },
        "198.51.100.44",
      ),
    ).toBe("50.50.50.50");

    expect(
      resolveClientIp(
        { "x-forwarded-for": "60.60.60.60, 70.70.70.70" },
        "198.51.100.44",
      ),
    ).toBe("60.60.60.60");

    expect(resolveClientIp({}, "198.51.100.44")).toBe("198.51.100.44");
  });

  it("returns the socket address when no forwarding headers are present", () => {
    expect(resolveClientIp(null, "198.51.100.44")).toBe("198.51.100.44");
    expect(resolveClientIp(undefined, "198.51.100.44")).toBe("198.51.100.44");
    expect(resolveClientIp({}, "198.51.100.44")).toBe("198.51.100.44");
  });

  it("returns null when there are neither headers nor a socket address", () => {
    expect(resolveClientIp({})).toBeNull();
    expect(resolveClientIp(null, null)).toBeNull();
    expect(resolveClientIp({ "x-forwarded-for": "   " }, undefined)).toBeNull();
  });

  it("normalizes casing, whitespace, and array-valued headers", () => {
    // Mixed-case header key.
    expect(
      resolveClientIp({ "CF-Connecting-IP": "203.0.113.7" }),
    ).toBe("203.0.113.7");

    // Whitespace around the value and inside the XFF chain is trimmed.
    expect(
      resolveClientIp({ "x-forwarded-for": "  60.60.60.60 , 70.70.70.70 " }),
    ).toBe("60.60.60.60");

    // Array-valued header (e.g. a repeated x-forwarded-for) collapses to its
    // first non-empty entry, then to the leftmost hop.
    expect(
      resolveClientIp({
        "x-forwarded-for": ["60.60.60.60, 70.70.70.70", "80.80.80.80"],
      }),
    ).toBe("60.60.60.60");

    // Array-valued cf-connecting-ip.
    expect(
      resolveClientIp({ "cf-connecting-ip": ["203.0.113.7"] }),
    ).toBe("203.0.113.7");
  });

  it("skips an empty x-forwarded-for and continues to the socket fallback", () => {
    expect(
      resolveClientIp({ "x-forwarded-for": " , " }, "198.51.100.44"),
    ).toBe("198.51.100.44");
  });

  it("exposes the canonical precedence, socket-agnostic (socket lives at the call site)", () => {
    expect(CLIENT_IP_HEADER_PRECEDENCE).toEqual([
      "cf-connecting-ip",
      "true-client-ip",
      "x-real-ip",
      "x-forwarded-for",
    ]);
  });
});

describe("describeClientIp", () => {
  it("returns the limiter key, the raw CF header and the FULL x-forwarded-for chain", () => {
    expect(
      describeClientIp(
        {
          "CF-Connecting-IP": "203.0.113.7",
          "x-forwarded-for": "1.2.3.4, 172.70.1.1, 35.191.0.1",
        },
        "169.254.1.1",
      ),
    ).toEqual({
      clientIp: "203.0.113.7",
      cfConnectingIp: "203.0.113.7",
      // Rightmost hops are the proxy-appended ones — never truncated.
      forwardedFor: "1.2.3.4, 172.70.1.1, 35.191.0.1",
    });
  });

  it("without cf-connecting-ip falls back to the XFF first hop and reports the CF header as null", () => {
    expect(
      describeClientIp({ "x-forwarded-for": "198.51.100.9, 35.191.0.1" }),
    ).toEqual({
      clientIp: "198.51.100.9",
      cfConnectingIp: null,
      forwardedFor: "198.51.100.9, 35.191.0.1",
    });
  });

  it("joins an array-valued x-forwarded-for instead of keeping only the first entry", () => {
    expect(
      describeClientIp({ "x-forwarded-for": ["1.1.1.1", "2.2.2.2"] })
        .forwardedFor,
    ).toBe("1.1.1.1, 2.2.2.2");
  });

  it("handles missing headers", () => {
    expect(describeClientIp(undefined, "127.0.0.1")).toEqual({
      clientIp: "127.0.0.1",
      cfConnectingIp: null,
      forwardedFor: null,
    });
  });
});

describe("describeClientIp — forwardedFor length cap", () => {
  it("caps a padded header at MAX_FORWARDED_FOR_LENGTH, keeping the honest rightmost hops", () => {
    const padding = Array.from({ length: 400 }, (_, i) => `10.0.${i % 250}.1`).join(", ");
    const xff = `${padding}, 203.0.113.9, 34.96.0.1`;

    const { forwardedFor } = describeClientIp({ "x-forwarded-for": xff });

    expect(forwardedFor!.length).toBe(MAX_FORWARDED_FOR_LENGTH);
    expect(forwardedFor!.startsWith("…")).toBe(true);
    expect(forwardedFor!.endsWith("203.0.113.9, 34.96.0.1")).toBe(true);
  });

  it("leaves a normal header untouched", () => {
    const { forwardedFor } = describeClientIp({
      "x-forwarded-for": "198.51.100.7, 34.96.0.1",
    });
    expect(forwardedFor).toBe("198.51.100.7, 34.96.0.1");
  });
});

describe("describeClientIp — logged IPs must be IPs", () => {
  it("drops a non-IP cf-connecting-ip from the log fields but leaves the limiter key alone", () => {
    const headers = { "cf-connecting-ip": "<script>alert(1)</script>" };

    const logged = describeClientIp(headers);

    expect(logged.cfConnectingIp).toBeNull();
    expect(logged.clientIp).toBeNull();
    // resolveClientIp is what the rate limiters key on — unchanged.
    expect(resolveClientIp(headers)).toBe("<script>alert(1)</script>");
  });

  it("drops an over-long value", () => {
    const long = "1".repeat(65);
    expect(describeClientIp({ "cf-connecting-ip": long }).cfConnectingIp).toBeNull();
  });

  it("keeps real IPv4 and IPv6 addresses", () => {
    expect(
      describeClientIp({ "cf-connecting-ip": "203.0.113.9" }),
    ).toMatchObject({ clientIp: "203.0.113.9", cfConnectingIp: "203.0.113.9" });
    expect(
      describeClientIp({ "cf-connecting-ip": "2001:db8::1" }).cfConnectingIp,
    ).toBe("2001:db8::1");
  });
});
