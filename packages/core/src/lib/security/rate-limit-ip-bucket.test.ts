import { describe, expect, it } from "vitest";

import { rateLimitIpBucket } from "./rate-limit-ip-bucket";

describe("rateLimitIpBucket", () => {
  it("returns IPv4 byte-identical", () => {
    expect(rateLimitIpBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitIpBucket("10.0.0.1")).toBe("10.0.0.1");
  });

  it("returns null for missing / blank input", () => {
    expect(rateLimitIpBucket(null)).toBeNull();
    expect(rateLimitIpBucket(undefined)).toBeNull();
    expect(rateLimitIpBucket("")).toBeNull();
    expect(rateLimitIpBucket("   ")).toBeNull();
  });

  it("buckets IPv6 on its /64", () => {
    expect(rateLimitIpBucket("2001:db8:85a3:1:aaaa:bbbb:cccc:dddd")).toBe(
      "2001:0db8:85a3:0001::/64",
    );
  });

  it("puts every address in one /64 in the same bucket", () => {
    const a = rateLimitIpBucket("2001:db8:1:2::1");
    const b = rateLimitIpBucket("2001:db8:1:2:ffff:ffff:ffff:ffff");
    const c = rateLimitIpBucket("2001:0DB8:0001:0002:0:0:0:abcd");
    expect(a).toBe("2001:0db8:0001:0002::/64");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("separates neighbouring /64s", () => {
    expect(rateLimitIpBucket("2001:db8:1:2::1")).not.toBe(
      rateLimitIpBucket("2001:db8:1:3::1"),
    );
  });

  it("expands `::` in every position", () => {
    expect(rateLimitIpBucket("::1")).toBe("0000:0000:0000:0000::/64");
    expect(rateLimitIpBucket("::")).toBe("0000:0000:0000:0000::/64");
    expect(rateLimitIpBucket("fe80::")).toBe("fe80:0000:0000:0000::/64");
    expect(rateLimitIpBucket("2001:db8::7:0:0:1")).toBe(
      "2001:0db8:0000:0000::/64",
    );
    // `::` standing in for a single group.
    expect(rateLimitIpBucket("1:2:3::5:6:7:8")).toBe(
      "0001:0002:0003:0000::/64",
    );
  });

  it("drops a zone id", () => {
    expect(rateLimitIpBucket("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
  });

  it("maps IPv4-mapped IPv6 to the IPv4 (dotted and hex tails)", () => {
    expect(rateLimitIpBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitIpBucket("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(rateLimitIpBucket("0:0:0:0:0:ffff:1.2.3.4")).toBe("1.2.3.4");
  });

  it("does not treat other embedded-IPv4 forms as IPv4", () => {
    // NAT64 (64:ff9b::/96) is a real IPv6 prefix; it buckets as IPv6.
    expect(rateLimitIpBucket("64:ff9b::1.2.3.4")).toBe(
      "0064:ff9b:0000:0000::/64",
    );
  });

  it("passes a non-IP value through unchanged", () => {
    expect(rateLimitIpBucket("not-an-ip")).toBe("not-an-ip");
    expect(rateLimitIpBucket("[::1]:443")).toBe("[::1]:443");
  });
});
