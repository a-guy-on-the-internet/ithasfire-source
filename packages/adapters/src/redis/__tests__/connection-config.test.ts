import { describe, expect, it } from "vitest";

import {
  isLoopbackHost,
  normalizeKeyPrefix,
  resolveRedisConnection,
} from "../connection-config";

const REAL = "rediss://default:tok@us1-example.upstash.io:37000";

describe("resolveRedisConnection — missing url", () => {
  it("throws the historical message in production", () => {
    expect(() =>
      resolveRedisConnection({
        url: undefined,
        namespace: undefined,
        nodeEnv: "production",
      }),
    ).toThrow("REDIS_URL is required in production");
  });

  it("throws in production when the url is blank whitespace", () => {
    expect(() =>
      resolveRedisConnection({
        url: "   ",
        namespace: undefined,
        nodeEnv: "production",
      }),
    ).toThrow("REDIS_URL is required in production");
  });

  it("falls back to localhost outside production", () => {
    expect(
      resolveRedisConnection({
        url: undefined,
        namespace: undefined,
        nodeEnv: "development",
      }),
    ).toEqual({
      url: "redis://localhost:6379",
      keyPrefix: undefined,
      commandTimeout: 500,
      maxRetriesPerRequest: 2,
    });
  });

  it("falls back to localhost when NODE_ENV is unset", () => {
    expect(
      resolveRedisConnection({
        url: undefined,
        namespace: undefined,
        nodeEnv: undefined,
      }).url,
    ).toBe("redis://localhost:6379");
  });
});

describe("resolveRedisConnection — production loopback guard", () => {
  // The 2026-09-01 dev outage: `hf-dev-redis-url` held the literal string
  // `redis://127.0.0.1:6379`, REDIS_URL was *set*, the old presence-only
  // guard passed, and both Cloud Run services dialled their own loopback for
  // eleven days.
  const loopbackUrls = [
    "redis://localhost:6379",
    "redis://127.0.0.1:6379",
    "redis://127.1.2.3:6379",
    "redis://[::1]:6379",
    "redis://0.0.0.0:6379",
    "rediss://default:tok@localhost:6379",
    "redis://redis.localhost:6379",
  ];

  for (const url of loopbackUrls) {
    it(`throws in production for ${url}`, () => {
      expect(() =>
        resolveRedisConnection({
          url,
          namespace: "ithasfire:dev",
          nodeEnv: "production",
        }),
      ).toThrow(/loopback address/i);
    });
  }

  it("names the offending host and never leaks the password", () => {
    let message = "";
    try {
      resolveRedisConnection({
        url: "redis://default:sup3rsecret@127.0.0.1:6379",
        namespace: undefined,
        nodeEnv: "production",
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("127.0.0.1");
    expect(message).not.toContain("sup3rsecret");
  });

  it("allows a real host in production", () => {
    expect(
      resolveRedisConnection({
        url: REAL,
        namespace: "ithasfire:prod",
        nodeEnv: "production",
      }),
    ).toEqual({
      url: REAL,
      keyPrefix: "ithasfire:prod:",
      commandTimeout: 500,
      maxRetriesPerRequest: 2,
    });
  });

  it("leaves genuine local development alone", () => {
    for (const nodeEnv of [undefined, "development", "test"]) {
      expect(
        resolveRedisConnection({
          url: "redis://127.0.0.1:6379",
          namespace: undefined,
          nodeEnv,
        }).url,
      ).toBe("redis://127.0.0.1:6379");
    }
  });

  it("throws on an unparseable url in production", () => {
    expect(() =>
      resolveRedisConnection({
        url: "not a url",
        namespace: undefined,
        nodeEnv: "production",
      }),
    ).toThrow(/not a parseable URL/i);
  });

  it("throws in production on a url with no host", () => {
    // `new URL("localhost:6379")` parses, but as protocol `localhost:` with an
    // empty host — a missing-scheme typo we must not hand to ioredis.
    expect(() =>
      resolveRedisConnection({
        url: "localhost:6379",
        namespace: undefined,
        nodeEnv: "production",
      }),
    ).toThrow(/no host/i);
  });

  it("passes an unparseable url through outside production", () => {
    expect(
      resolveRedisConnection({
        url: "not a url",
        namespace: undefined,
        nodeEnv: "development",
      }).url,
    ).toBe("not a url");
  });
});

describe("normalizeKeyPrefix", () => {
  it("returns undefined for unset / empty / whitespace", () => {
    expect(normalizeKeyPrefix(undefined)).toBeUndefined();
    expect(normalizeKeyPrefix("")).toBeUndefined();
    expect(normalizeKeyPrefix("   ")).toBeUndefined();
  });

  it("adds exactly one trailing colon", () => {
    // Terraform emits the namespace with NO trailing colon.
    expect(normalizeKeyPrefix("ithasfire:dev")).toBe("ithasfire:dev:");
  });

  it("leaves an already-suffixed namespace alone", () => {
    expect(normalizeKeyPrefix("ithasfire:dev:")).toBe("ithasfire:dev:");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeKeyPrefix("  ithasfire:prod  ")).toBe("ithasfire:prod:");
  });

  it("is applied by resolveRedisConnection", () => {
    expect(
      resolveRedisConnection({
        url: REAL,
        namespace: "ithasfire:dev",
        nodeEnv: "production",
      }).keyPrefix,
    ).toBe("ithasfire:dev:");
    expect(
      resolveRedisConnection({
        url: REAL,
        namespace: "",
        nodeEnv: "production",
      }).keyPrefix,
    ).toBeUndefined();
  });
});

describe("isLoopbackHost — IPv4 shorthand and mapped IPv6", () => {
  // `redis:` is a NON-SPECIAL scheme, so `new URL()` does not normalise these
  // the way it would for `http:`. Hostnames below are exactly what
  // `new URL(...).hostname` yields (measured 2026-09-14), not what a human
  // typed — e.g. `[::ffff:127.0.0.1]` arrives as `::ffff:7f00:1`.
  it.each([
    "127.1",
    "127.0.1",
    "2130706433",
    "2130706434",
    "::ffff:7f00:1",
    "127.255.255.254",
  ])("treats %s as loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    "upstash.io",
    "gusc1-xyz-12345.upstash.io",
    "10.0.0.1",
    "192.168.1.5",
    "3232235777",
    "1270706433",
    "127",
    "::ffff:8.8.8.8",
  ])("does not treat %s as loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it.each([
    ["localhost", true],
    ["LOCALHOST", true],
    ["127.0.0.1", true],
    ["127.255.255.254", true],
    ["::1", true],
    ["[::1]", true],
    ["::", true],
    ["0.0.0.0", true],
    ["redis.localhost", true],
    ["", false],
    ["1.2.3.4", false],
    ["127.0.0.1.example.com", false],
    ["us1-example.upstash.io", false],
  ])("%s -> %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});
