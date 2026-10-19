import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The auth rate limiter builds its OWN ioredis client, lazily, outside
 * `buildDeps()` (see the comment on `getAuthRateLimitRedis`). That makes it
 * the one client that can silently miss `REDIS_NAMESPACE` — and its keys
 * (`bauth:rl:*`) gate sign-in, so an unprefixed dev instance sharing the
 * Upstash database with prod would rate-limit real users.
 *
 * `auth-rate-limit-storage.test.ts` mocks ioredis with a THROWING constructor
 * for its whole file, so the constructor arguments can't be inspected there.
 * This file mocks a recording constructor instead.
 */
const { constructed } = vi.hoisted(() => ({
  constructed: [] as Array<{ url: string; options: Record<string, unknown> }>,
}));

vi.mock("ioredis", () => ({
  default: class RecordingRedis {
    constructor(url: string, options: Record<string, unknown>) {
      constructed.push({ url, options });
    }
    on() {
      return this;
    }
  },
}));

vi.mock("@th/adapters/infra/logger", () => ({
  createPinoLoggerAdapter: () => ({ warn: vi.fn(), error: vi.fn() }),
}));

// The real env module parses the whole schema at import, and under
// NODE_ENV=production it requires every prod secret. The storage reads only
// REDIS_URL and REDIS_NAMESPACE from it, so read those live from process.env.
vi.mock("../src/lib/env", () => ({
  env: {
    get REDIS_URL() {
      return process.env.REDIS_URL;
    },
    get REDIS_NAMESPACE() {
      return process.env.REDIS_NAMESPACE;
    },
  },
}));

const ORIGINAL = {
  REDIS_URL: process.env.REDIS_URL,
  REDIS_NAMESPACE: process.env.REDIS_NAMESPACE,
  NODE_ENV: process.env.NODE_ENV,
};

async function loadStorage() {
  vi.resetModules();
  constructed.length = 0;
  return import("../src/auth/rate-limit-storage");
}

function restore(key: keyof typeof ORIGINAL) {
  const value = ORIGINAL[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  constructed.length = 0;
});

afterEach(() => {
  restore("REDIS_URL");
  restore("REDIS_NAMESPACE");
  restore("NODE_ENV");
});

describe("auth rate-limit redis client", () => {
  it("applies REDIS_NAMESPACE as the ioredis keyPrefix", async () => {
    process.env.REDIS_URL = "rediss://default:tok@us1-example.upstash.io:37000";
    process.env.REDIS_NAMESPACE = "ithasfire:dev";

    const { createBetterAuthRateLimitStorage } = await loadStorage();
    const storage = createBetterAuthRateLimitStorage();
    await storage.get("1.2.3.4|/sign-in/email");

    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.url).toBe(process.env.REDIS_URL);
    expect(constructed[0]!.options).toMatchObject({
      keyPrefix: "ithasfire:dev:",
      commandTimeout: 500,
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });
  });

  it("omits keyPrefix entirely when REDIS_NAMESPACE is unset", async () => {
    process.env.REDIS_URL = "rediss://default:tok@us1-example.upstash.io:37000";
    delete process.env.REDIS_NAMESPACE;

    const { createBetterAuthRateLimitStorage } = await loadStorage();
    await createBetterAuthRateLimitStorage().get("1.2.3.4|/sign-in/email");

    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.options).not.toHaveProperty("keyPrefix");
  });

  it("keeps the loopback guard inside the fail-open envelope", async () => {
    // A production loopback URL must NOT escape into Better Auth's
    // onRequestRateLimit (no try/catch there — it would 500 every auth
    // request). `buildDeps()` runs the same resolver and hard-fails boot, so
    // that is where the loud signal lives; here we degrade + report.
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.REDIS_NAMESPACE = "ithasfire:dev";
    process.env.NODE_ENV = "production";

    const { createBetterAuthRateLimitStorage } = await loadStorage();
    const reportError = vi.fn();
    const storage = createBetterAuthRateLimitStorage({ reportError });

    await expect(
      storage.get("1.2.3.4|/sign-in/email"),
    ).resolves.toBeNull();
    await expect(
      storage.set("1.2.3.4|/sign-in/email", {
        key: "1.2.3.4|/sign-in/email",
        count: 1,
        lastRequest: Date.now(),
      }),
    ).resolves.toBeUndefined();

    // No client was ever constructed — the resolver threw first.
    expect(constructed).toHaveLength(0);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0]![0])).toMatch(/loopback address/i);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { area: "auth_rate_limit_fail_open", branch: "init" },
    });
  });
});
