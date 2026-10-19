import { createHmac, hkdfSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BANNED_EMAIL_KEY_LABEL,
  createNetworkIdentityHasher,
  isUsableNetworkIdentitySecret,
  NETWORK_SIGHTING_KEY_LABEL,
  normalizeClientIp,
  normalizeCountryCode,
  userAgentFamily,
} from "../network-identity";

const SECRET = "s".repeat(40);
const OTHER_SECRET = "t".repeat(40);

describe("normalizeClientIp", () => {
  it("keeps an IPv4 address and derives its /24", () => {
    expect(normalizeClientIp(" 203.0.113.77 ")).toEqual({
      family: 4,
      address: "203.0.113.77",
      network: "203.0.113.0/24",
    });
  });

  it("expands IPv6 and derives its /48, ignoring case, zone and brackets", () => {
    const a = normalizeClientIp("2001:DB8:abcd:12::1");
    const b = normalizeClientIp("[2001:db8:ABCD:0012:0:0:0:1]");
    const c = normalizeClientIp("2001:db8:abcd:12::1%eth0");
    expect(a).toEqual({
      family: 6,
      address: "2001:0db8:abcd:0012:0000:0000:0000:0001",
      network: "2001:0db8:abcd::/48",
    });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("folds an IPv4-mapped IPv6 address into the IPv4 address", () => {
    expect(normalizeClientIp("::ffff:203.0.113.77")).toEqual(
      normalizeClientIp("203.0.113.77"),
    );
    expect(normalizeClientIp("::ffff:cb00:714d")).toEqual(
      normalizeClientIp("203.0.113.77"),
    );
  });

  it("rejects anything that is not an IP address", () => {
    for (const value of [
      null,
      undefined,
      "",
      "not-an-ip",
      "203.0.113",
      "<script>",
      "1.2.3.4, 5.6.7.8",
      "x".repeat(100),
    ]) {
      expect(normalizeClientIp(value)).toBeNull();
    }
  });
});

describe("createNetworkIdentityHasher", () => {
  it("is deterministic for the same secret and address", () => {
    const a = createNetworkIdentityHasher(SECRET).hashIp("203.0.113.77");
    const b = createNetworkIdentityHasher(SECRET).hashIp("203.0.113.77");
    expect(a).toEqual(b);
    expect(a?.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.networkHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives two hosts on one /24 the same networkHash and different ipHashes", () => {
    const hasher = createNetworkIdentityHasher(SECRET);
    const a = hasher.hashIp("203.0.113.77")!;
    const b = hasher.hashIp("203.0.113.200")!;
    const other = hasher.hashIp("203.0.114.77")!;
    expect(a.networkHash).toBe(b.networkHash);
    expect(a.ipHash).not.toBe(b.ipHash);
    expect(other.networkHash).not.toBe(a.networkHash);
  });

  it("groups IPv6 by /48", () => {
    const hasher = createNetworkIdentityHasher(SECRET);
    expect(hasher.hashIp("2001:db8:abcd:1::1")!.networkHash).toBe(
      hasher.hashIp("2001:db8:abcd:ffff::9")!.networkHash,
    );
    expect(hasher.hashIp("2001:db8:abce::1")!.networkHash).not.toBe(
      hasher.hashIp("2001:db8:abcd::1")!.networkHash,
    );
  });

  it("never outputs the address or the prefix", () => {
    const hashes = createNetworkIdentityHasher(SECRET).hashIp("203.0.113.77")!;
    const serialized = JSON.stringify(hashes);
    expect(serialized).not.toContain("203.0.113");
    expect(Object.keys(hashes).sort()).toEqual(["ipHash", "networkHash"]);
  });

  it("is keyed: a different secret gives unrelated hashes", () => {
    const a = createNetworkIdentityHasher(SECRET).hashIp("203.0.113.77")!;
    const b = createNetworkIdentityHasher(OTHER_SECRET).hashIp("203.0.113.77")!;
    expect(a.ipHash).not.toBe(b.ipHash);
    expect(a.networkHash).not.toBe(b.networkHash);
  });

  it("is domain-separated: not a plain HMAC under the root secret, and each purpose has its own derived key", () => {
    const hasher = createNetworkIdentityHasher(SECRET);
    const { ipHash } = hasher.hashIp("203.0.113.77")!;
    // Not the root secret used directly.
    expect(ipHash).not.toBe(
      createHmac("sha256", SECRET).update("ip\u001f203.0.113.77").digest("hex"),
    );
    // It IS the HKDF-derived network key, with the documented label.
    const networkKey = Buffer.from(
      hkdfSync(
        "sha256",
        SECRET,
        Buffer.alloc(0),
        NETWORK_SIGHTING_KEY_LABEL,
        32,
      ),
    );
    expect(ipHash).toBe(
      createHmac("sha256", networkKey)
        .update("ip\u001f203.0.113.77")
        .digest("hex"),
    );
    // The email key is a different derivation.
    const emailKey = Buffer.from(
      hkdfSync("sha256", SECRET, Buffer.alloc(0), BANNED_EMAIL_KEY_LABEL, 32),
    );
    expect(emailKey.equals(networkKey)).toBe(false);
    expect(hasher.hashEmail("jane@example.com")).toBe(
      createHmac("sha256", emailKey)
        .update("email\u001fjane@example.com")
        .digest("hex"),
    );
  });

  it("never lets an address hash collide with a prefix hash", () => {
    const hasher = createNetworkIdentityHasher(SECRET);
    const { ipHash, networkHash } = hasher.hashIp("203.0.113.0")!;
    expect(ipHash).not.toBe(networkHash);
  });

  it("hashes an email in its as-delivered form (case, +tag, Gmail dots, googlemail)", () => {
    const hasher = createNetworkIdentityHasher(SECRET);
    const canonical = hasher.hashEmail("bannedperson@gmail.com");
    for (const variant of [
      "BannedPerson@Gmail.com",
      " banned.person@gmail.com ",
      "banned.person+again@googlemail.com",
      "b.a.n.n.e.d.p.e.r.s.o.n+x@GMAIL.COM",
    ]) {
      expect(hasher.hashEmail(variant)).toBe(canonical);
    }
    // +tags fold for every domain; dots only for Gmail.
    expect(hasher.hashEmail("jane+x@example.com")).toBe(
      hasher.hashEmail("jane@example.com"),
    );
    expect(hasher.hashEmail("j.ane@example.com")).not.toBe(
      hasher.hashEmail("jane@example.com"),
    );
    expect(hasher.hashEmail("")).toBeNull();
    expect(hasher.hashEmail(null)).toBeNull();
  });
});

describe("isUsableNetworkIdentitySecret", () => {
  it("requires a secret of at least 32 characters", () => {
    expect(isUsableNetworkIdentitySecret(undefined)).toBe(false);
    expect(isUsableNetworkIdentitySecret(null)).toBe(false);
    expect(isUsableNetworkIdentitySecret("short")).toBe(false);
    expect(isUsableNetworkIdentitySecret("x".repeat(32))).toBe(true);
  });
});

describe("coarse request metadata", () => {
  it("keeps only a two-character country code", () => {
    expect(normalizeCountryCode("us")).toBe("US");
    expect(normalizeCountryCode("T1")).toBe("T1");
    expect(normalizeCountryCode("XX")).toBe("XX");
    expect(normalizeCountryCode("USA")).toBeNull();
    expect(normalizeCountryCode("<b>")).toBeNull();
    expect(normalizeCountryCode(null)).toBeNull();
  });

  it("reduces a user agent to a browser + OS family with no versions", () => {
    const chromeMac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.120 Safari/537.36";
    const safariIos =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    const firefoxWin =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0";
    const edge =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.67";
    expect(userAgentFamily(chromeMac)).toBe("Chrome on macOS");
    expect(userAgentFamily(safariIos)).toBe("Safari on iOS");
    expect(userAgentFamily(firefoxWin)).toBe("Firefox on Windows");
    expect(userAgentFamily(edge)).toBe("Edge on Windows");
    expect(userAgentFamily("curl/8.7.1")).toBe("Bot or script");
    expect(userAgentFamily("something-unknown")).toBe("Other");
    expect(userAgentFamily("")).toBeNull();
    expect(userAgentFamily(null)).toBeNull();
    for (const ua of [chromeMac, safariIos, firefoxWin, edge]) {
      expect(userAgentFamily(ua)).not.toMatch(/\d/);
    }
  });
});
