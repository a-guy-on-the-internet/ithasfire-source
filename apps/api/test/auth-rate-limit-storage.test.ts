import { describe, expect, it, vi } from "vitest";

import {
  createBetterAuthRateLimitStorage,
  createRedisRateLimitStorage,
  DEFAULT_TTL_SECONDS,
  type RateLimitRedisLike,
} from "../src/auth/rate-limit-storage";

// The lazy default wrapper (`createBetterAuthRateLimitStorage`) constructs
// its own ioredis client; make the constructor throw so the tests below can
// prove even the INIT path stays inside the fail-open envelope — a real
// constructor throw would otherwise propagate into Better Auth's
// onRequestRateLimit (no try/catch there) and 500 every auth request. The
// injected-client tests are unaffected: they never touch this import.
vi.mock("ioredis", () => ({
  default: class ThrowingRedis {
    constructor() {
      throw new Error("boom: redis constructor");
    }
  },
}));

const { initWarnSpy } = vi.hoisted(() => ({ initWarnSpy: vi.fn() }));
vi.mock("@th/adapters/infra/logger", () => ({
  createPinoLoggerAdapter: () => ({ warn: initWarnSpy }),
}));

function makeLogger() {
  return {
    warn: vi.fn(),
  };
}

function makeFakeRedis(): RateLimitRedisLike & {
  store: Map<string, string>;
  ttls: Map<string, number>;
} {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(
      async (key: string, value: string, _ex: "EX", seconds: number) => {
        store.set(key, value);
        ttls.set(key, seconds);
        return "OK";
      },
    ),
  };
}

const record = { key: "1.2.3.4|/sign-in/email", count: 3, lastRequest: 1000 };

describe("createRedisRateLimitStorage", () => {
  it("round-trips a rate limit record through Redis under a prefixed key", async () => {
    const redis = makeFakeRedis();
    const logger = makeLogger();
    const storage = createRedisRateLimitStorage({ redis, logger });

    await storage.set(record.key, record);
    const read = await storage.get(record.key);

    expect(read).toEqual(record);
    // Namespaced so Better Auth keys (`<ip>|<path>`) can't collide with the
    // tRPC rate limiter's keys on the shared Redis instance.
    expect(redis.store.has(`bauth:rl:${record.key}`)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sets a TTL covering the largest configured window (60s) with margin", async () => {
    const redis = makeFakeRedis();
    const storage = createRedisRateLimitStorage({
      redis,
      logger: makeLogger(),
    });

    await storage.set(record.key, record);

    const ttl = redis.ttls.get(`bauth:rl:${record.key}`);
    expect(ttl).toBe(DEFAULT_TTL_SECONDS);
    // INVARIANT: TTL must cover the largest window configured in
    // better-auth.ts (60s) — a shorter TTL silently under-limits.
    expect(ttl!).toBeGreaterThanOrEqual(60);
  });

  it("treats set(key, value, update=true) as a plain SET (update flag deliberately ignored)", async () => {
    // Better Auth passes `update: true` for existing counters so its
    // database storage can UPDATE instead of INSERT; for Redis a plain
    // SET-with-EX is the correct behavior for both cases (and refreshing
    // the TTL on every write is what keeps active keys alive).
    const redis = makeFakeRedis();
    const storage = createRedisRateLimitStorage({
      redis,
      logger: makeLogger(),
    });

    await storage.set(record.key, record, true);

    expect(redis.set).toHaveBeenCalledWith(
      `bauth:rl:${record.key}`,
      JSON.stringify(record),
      "EX",
      DEFAULT_TTL_SECONDS,
    );
  });

  it("respects ttlSeconds and keyPrefix overrides", async () => {
    const redis = makeFakeRedis();
    const storage = createRedisRateLimitStorage({
      redis,
      logger: makeLogger(),
      keyPrefix: "custom:",
      ttlSeconds: 45,
    });

    await storage.set(record.key, record);

    expect(redis.store.has(`custom:${record.key}`)).toBe(true);
    expect(redis.ttls.get(`custom:${record.key}`)).toBe(45);
  });

  it("returns null when no record exists", async () => {
    const storage = createRedisRateLimitStorage({
      redis: makeFakeRedis(),
      logger: makeLogger(),
    });

    await expect(storage.get("missing")).resolves.toBeNull();
  });

  it("fails open (returns null) when redis.get throws, and logs", async () => {
    const redis = makeFakeRedis();
    redis.get = vi.fn(async () => {
      throw new Error("Command timed out");
    });
    const logger = makeLogger();
    const storage = createRedisRateLimitStorage({ redis, logger });

    // A throw here would propagate out of Better Auth's onRequestRateLimit
    // and 500 every auth request — null means "no prior requests, allow".
    await expect(storage.get(record.key)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "auth_rate_limit_storage_get_failed",
      expect.objectContaining({ key: record.key }),
    );
  });

  it("fails open (no throw) when redis.set throws, and logs", async () => {
    const redis = makeFakeRedis();
    redis.set = vi.fn(async () => {
      throw new Error("Connection is closed");
    });
    const logger = makeLogger();
    const storage = createRedisRateLimitStorage({ redis, logger });

    await expect(storage.set(record.key, record)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "auth_rate_limit_storage_set_failed",
      expect.objectContaining({ key: record.key }),
    );
  });

  it("fails open (returns null) on malformed stored JSON", async () => {
    const redis = makeFakeRedis();
    redis.store.set(`bauth:rl:${record.key}`, "{not-json");
    const logger = makeLogger();
    const storage = createRedisRateLimitStorage({ redis, logger });

    await expect(storage.get(record.key)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "auth_rate_limit_storage_get_failed",
      expect.objectContaining({ key: record.key }),
    );
  });

  it("fails open (returns null) on a well-formed JSON value with the wrong shape", async () => {
    const redis = makeFakeRedis();
    redis.store.set(
      `bauth:rl:${record.key}`,
      JSON.stringify({ count: "three", lastRequest: null }),
    );
    const logger = makeLogger();
    const storage = createRedisRateLimitStorage({ redis, logger });

    await expect(storage.get(record.key)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "auth_rate_limit_storage_malformed_record",
      expect.objectContaining({ key: record.key }),
    );
  });

  it("rejects a record missing the key field (tightened shape guard)", async () => {
    const redis = makeFakeRedis();
    redis.store.set(
      `bauth:rl:${record.key}`,
      JSON.stringify({ count: 3, lastRequest: 1000 }),
    );
    const logger = makeLogger();
    const storage = createRedisRateLimitStorage({ redis, logger });

    await expect(storage.get(record.key)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "auth_rate_limit_storage_malformed_record",
      expect.objectContaining({ key: record.key }),
    );
  });

  describe("swallowed Redis failure reporting", () => {
    // The fail-open allow/no-op keeps auth requests flowing, so without the
    // reporter a sustained Redis outage would silently disable ALL auth rate
    // limiting and never show up in Sentry (the same class of gap behind the
    // 2026-06 4-day silent search outage).
    it("reports get() failures and still returns null (allow)", async () => {
      const redis = makeFakeRedis();
      redis.get = vi.fn(async () => {
        throw new Error("Command timed out");
      });
      const reportError = vi.fn();
      const storage = createRedisRateLimitStorage({
        redis,
        logger: makeLogger(),
        reportError,
      });

      await expect(storage.get(record.key)).resolves.toBeNull();

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tags: { area: "auth_rate_limit_fail_open", branch: "get" },
        extra: { key: record.key, error: "Command timed out" },
      });
    });

    it("reports set() failures and still resolves without throwing", async () => {
      const redis = makeFakeRedis();
      redis.set = vi.fn(async () => {
        throw new Error("Connection is closed");
      });
      const reportError = vi.fn();
      const storage = createRedisRateLimitStorage({
        redis,
        logger: makeLogger(),
        reportError,
      });

      await expect(storage.set(record.key, record)).resolves.toBeUndefined();

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tags: { area: "auth_rate_limit_fail_open", branch: "set" },
        extra: { key: record.key, error: "Connection is closed" },
      });
    });

    it("still fails open when reportError is not wired", async () => {
      const redis = makeFakeRedis();
      redis.get = vi.fn(async () => {
        throw new Error("Command timed out");
      });
      const storage = createRedisRateLimitStorage({
        redis,
        logger: makeLogger(),
      });

      await expect(storage.get(record.key)).resolves.toBeNull();
    });

    it("reports malformed-record failures (bad shape, no exception thrown) and still returns null (allow)", async () => {
      const redis = makeFakeRedis();
      redis.store.set(
        `bauth:rl:${record.key}`,
        JSON.stringify({ count: "three", lastRequest: null }),
      );
      const reportError = vi.fn();
      const storage = createRedisRateLimitStorage({
        redis,
        logger: makeLogger(),
        reportError,
      });

      await expect(storage.get(record.key)).resolves.toBeNull();

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tags: {
          area: "auth_rate_limit_fail_open",
          branch: "malformed_record",
        },
        extra: { key: record.key },
      });
    });

    it("a throwing reporter never breaks the fail-open malformed-record path", async () => {
      const redis = makeFakeRedis();
      redis.store.set(
        `bauth:rl:${record.key}`,
        JSON.stringify({ count: "three", lastRequest: null }),
      );
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const storage = createRedisRateLimitStorage({
        redis,
        logger: makeLogger(),
        reportError,
      });

      await expect(storage.get(record.key)).resolves.toBeNull();
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("throttles repeated malformed-record reports within the window", async () => {
      const redis = makeFakeRedis();
      redis.store.set(
        `bauth:rl:${record.key}`,
        JSON.stringify({ count: "three", lastRequest: null }),
      );
      const reportError = vi.fn();
      const storage = createRedisRateLimitStorage({
        redis,
        logger: makeLogger(),
        reportError,
      });

      await storage.get(record.key);
      await storage.get(record.key);
      await storage.get(record.key);

      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("throttles the malformed-record branch independently of get()/set() (distinct branch tag)", async () => {
      const redis = makeFakeRedis();
      redis.store.set(
        `bauth:rl:${record.key}`,
        JSON.stringify({ count: "three", lastRequest: null }),
      );
      redis.set = vi.fn(async () => {
        throw new Error("set boom");
      });
      const reportError = vi.fn();
      const storage = createRedisRateLimitStorage({
        redis,
        logger: makeLogger(),
        reportError,
      });

      // Malformed-record branch on get(), thrown-exception branch on set() —
      // distinct `branch` tags mean each gets its own throttle window rather
      // than one silencing the other.
      await storage.get(record.key);
      await storage.set(record.key, record);

      expect(reportError).toHaveBeenCalledTimes(2);
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: {
            area: "auth_rate_limit_fail_open",
            branch: "malformed_record",
          },
        }),
      );
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { area: "auth_rate_limit_fail_open", branch: "set" },
        }),
      );
    });

    it("a throwing reporter never breaks the fail-open get()/set() paths", async () => {
      const redis = makeFakeRedis();
      redis.get = vi.fn(async () => {
        throw new Error("Command timed out");
      });
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const storage = createRedisRateLimitStorage({
        redis,
        logger: makeLogger(),
        reportError,
      });

      await expect(storage.get(record.key)).resolves.toBeNull();
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not call reportError on the success path", async () => {
      const redis = makeFakeRedis();
      const reportError = vi.fn();
      const storage = createRedisRateLimitStorage({
        redis,
        logger: makeLogger(),
        reportError,
      });

      await storage.set(record.key, record);
      await storage.get(record.key);

      expect(reportError).not.toHaveBeenCalled();
    });

    it("throttles repeated get() failure reports within the window", async () => {
      const redis = makeFakeRedis();
      redis.get = vi.fn(async () => {
        throw new Error("Command timed out");
      });
      const reportError = vi.fn();
      const storage = createRedisRateLimitStorage({
        redis,
        logger: makeLogger(),
        reportError,
      });

      await storage.get(record.key);
      await storage.get(record.key);
      await storage.get(record.key);

      // Same reportError instance + same tags across all three calls →
      // throttled to a single report, not one per request.
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("throttles get() and set() failures independently of each other (distinct branch tags)", async () => {
      const redis = makeFakeRedis();
      redis.get = vi.fn(async () => {
        throw new Error("get boom");
      });
      redis.set = vi.fn(async () => {
        throw new Error("set boom");
      });
      const reportError = vi.fn();
      const storage = createRedisRateLimitStorage({
        redis,
        logger: makeLogger(),
        reportError,
      });

      await storage.get(record.key);
      await storage.set(record.key, record);

      expect(reportError).toHaveBeenCalledTimes(2);
    });
  });
});

describe("createBetterAuthRateLimitStorage (lazy default wrapper)", () => {
  it("fails open when the Redis constructor throws: get → null, set → no throw, logged once", async () => {
    initWarnSpy.mockClear();
    const storage = createBetterAuthRateLimitStorage();

    await expect(storage.get(record.key)).resolves.toBeNull();
    await expect(
      storage.set(record.key, record),
    ).resolves.toBeUndefined();
    await expect(storage.get(record.key)).resolves.toBeNull();

    // Logged once per storage instance, not once per request.
    expect(initWarnSpy).toHaveBeenCalledTimes(1);
    expect(initWarnSpy).toHaveBeenCalledWith(
      "auth_rate_limit_storage_init_failed",
      expect.objectContaining({
        error: expect.stringContaining("boom: redis constructor"),
      }),
    );
  });

  it("stays fail-open even when the init-failure logger itself throws", async () => {
    initWarnSpy.mockClear();
    initWarnSpy.mockImplementationOnce(() => {
      throw new Error("logger boom");
    });
    const storage = createBetterAuthRateLimitStorage();

    await expect(storage.get(record.key)).resolves.toBeNull();
    await expect(
      storage.set(record.key, record),
    ).resolves.toBeUndefined();
  });

  describe("swallowed init failure reporting", () => {
    // Redis constructor failure here disables ALL auth rate limiting for the
    // life of the process (retried per-call, per resolve()) — the most
    // severe fail-open path in the codebase — so it must not go unreported.
    it("reports the init failure and still resolves get()/set() as no-op", async () => {
      initWarnSpy.mockClear();
      const reportError = vi.fn();
      const storage = createBetterAuthRateLimitStorage({ reportError });

      await expect(storage.get(record.key)).resolves.toBeNull();
      await expect(
        storage.set(record.key, record),
      ).resolves.toBeUndefined();

      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tags: { area: "auth_rate_limit_fail_open", branch: "init" },
        extra: { error: expect.stringContaining("boom: redis constructor") },
      });
    });

    it("still fails open when reportError is not wired", async () => {
      const storage = createBetterAuthRateLimitStorage();

      await expect(storage.get(record.key)).resolves.toBeNull();
    });

    it("a throwing reporter never breaks the fail-open no-op storage", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const storage = createBetterAuthRateLimitStorage({ reportError });

      await expect(storage.get(record.key)).resolves.toBeNull();
      expect(reportError).toHaveBeenCalled();
    });

    it("throttles repeated init-failure reports across retried resolve() calls", async () => {
      const reportError = vi.fn();
      const storage = createBetterAuthRateLimitStorage({ reportError });

      // Every get()/set() re-attempts resolve() since init never succeeds
      // (the throwing ioredis mock applies for the whole test file) — the
      // throttle must still cap this to one report per window.
      await storage.get(record.key);
      await storage.get(record.key);
      await storage.set(record.key, record);

      expect(reportError).toHaveBeenCalledTimes(1);
    });
  });
});
