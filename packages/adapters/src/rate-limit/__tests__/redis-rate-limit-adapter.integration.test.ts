import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { RedisMemoryServer } from "redis-memory-server";
import { RedisRateLimitAdapter } from "../redis-rate-limit-adapter";

/**
 * Integration coverage for the rate-limit adapter against a REAL Redis.
 *
 * The sibling unit test (`redis-rate-limit-adapter.test.ts`) drives the adapter
 * through a hand-written JS fake whose `eval` re-implements the Lua semantics.
 * That validates intent but can't catch a typo in the actual `CONSUME_SCRIPT`
 * string or a mis-wired `eval(script, numKeys, KEYS…, ARGV…)` call — the fake
 * ignores the script text entirely.
 *
 * Here a real `ioredis` client talks to a real `redis-server`, so every
 * `consume()` executes the literal Lua and the KEYS/ARGV wiring end-to-end.
 * Since this adapter is the only rate-limiting layer in front of the API, the
 * real script needs exercise.
 *
 * Which server:
 * - `TESTCONTAINERS_REUSE_REDIS_URL` set (CI: the `redis` service container on
 *   the job, see `.github/workflows/ci.yml` and `deploy-dev.yml`): connect to
 *   it. That server is SHARED with later steps in the same job (the apps/api
 *   concurrency suite), so this suite never flushes it, never shuts it down,
 *   and touches only keys under its own random per-run prefix.
 * - Otherwise: boot an in-memory `redis-server` binary via
 *   `redis-memory-server`. First run compiles/downloads it (slow); cached
 *   afterwards.
 *
 * Skipped only under `CI` with NO url: the runner may have no egress to fetch
 * the `redis-memory-server` binary, so `RedisMemoryServer.create()` hangs the
 * `beforeAll` to its 180s timeout and fails the whole gate. Every workflow that
 * runs this package's tests provides the url, so this skip is for any future
 * job that runs them without a Redis service.
 *
 * Deliberately reads the env var directly rather than calling
 * `@th/test-utils`' `startRedisContainer`: with no url that helper falls back
 * to Testcontainers (Docker), whereas this suite's local path is
 * `redis-memory-server`. The env var name is the same one that helper honours.
 */
const providedRedisUrl =
  process.env.TESTCONTAINERS_REUSE_REDIS_URL?.trim() || undefined;
// Same CI test as `resolveReusableHostRedis` in
// packages/test-utils/src/testcontainers/redis.ts ("true" or "1", any case),
// which isn't exported. Its `CI + REDIS_URL` fallback is deliberately NOT
// mirrored: locally `REDIS_URL` is the shared dev Redis, and this suite only
// uses an explicitly provided test server.
const ciFlag = process.env.CI?.toLowerCase();
const inCi = ciFlag === "true" || ciFlag === "1";

/**
 * Per-run namespace for every key this suite creates. The adapter is built
 * with it as its prefix, so nothing here can collide with real `rl:` counters
 * on a shared server, or with a concurrent run of this suite.
 */
const PREFIX = `rl-it-${randomBytes(6).toString("hex")}`;
const CUSTOM_PREFIX = `${PREFIX}-custom`;
/** The real Redis key the adapter writes for `raw`. */
const k = (raw: string) => `${PREFIX}:${raw}`;

describe.skipIf(inCi && !providedRedisUrl)("RedisRateLimitAdapter (integration, real Redis eval)", () => {
  /** Only set when this suite started the server; then it also stops it. */
  let server: RedisMemoryServer | undefined;
  let redis: Redis;
  let adapter: RedisRateLimitAdapter;

  // Give the very first run head-room to download + build the Redis binary.
  beforeAll(async () => {
    if (providedRedisUrl) {
      redis = new Redis(providedRedisUrl, { maxRetriesPerRequest: 1 });
    } else {
      server = await RedisMemoryServer.create();
      const host = await server.getHost();
      const port = await server.getPort();
      redis = new Redis({ host, port, lazyConnect: false, maxRetriesPerRequest: 1 });
    }
    adapter = new RedisRateLimitAdapter(redis, PREFIX);
  }, 180_000);

  /**
   * Delete only this run's keys (`PREFIX:*` and `PREFIX-custom:*`). Never
   * FLUSHALL/FLUSHDB: the server may be shared.
   */
  const deleteOwnKeys = async () => {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${PREFIX}*`, "COUNT", 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  };

  // Isolate every test — the counters and their TTLs are the whole point here.
  afterEach(async () => {
    await deleteOwnKeys();
  });

  afterAll(async () => {
    try {
      if (redis) await deleteOwnKeys();
    } finally {
      try {
        // Our client connection only. The server is stopped only if we started it.
        await redis?.quit();
      } finally {
        await server?.stop();
      }
    }
  });

  it("allows up to maxTokens, denies beyond, and reports a live Retry-After", async () => {
    // First two land inside the budget…
    const r1 = await adapter.consume("login:ip-1", 2, 60);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(1);

    const r2 = await adapter.consume("login:ip-1", 2, 60);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);

    // …the third trips the limit, and the TTL returned by the real Lua drives a
    // positive Retry-After (proves the `return {count, TTL}` table round-trips).
    const r3 = await adapter.consume("login:ip-1", 2, 60);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
    expect(r3.retryAfterSeconds).toBeGreaterThan(0);
    expect(r3.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("self-heals an orphaned key that lost its TTL (real `TTL < 0 -> EXPIRE` branch)", async () => {
    // Reproduce the live incident directly in Redis: a counter already over the
    // limit but with NO expiry (TTL -1). `SET` without EX leaves it persistent,
    // exactly the orphaned state the script is designed to rescue.
    const fullKey = k("notifications.countUnread:user-1");
    await redis.set(fullKey, "999");
    expect(await redis.ttl(fullKey)).toBe(-1);

    const result = await adapter.consume("notifications.countUnread:user-1", 100, 60);

    // Still denied — it's way over the limit…
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);

    // …but the real Lua's `TTL < 0 -> EXPIRE` branch must have fired, so the key
    // now carries a positive TTL and will reset instead of 429ing forever.
    const ttl = await redis.ttl(fullKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("leaves the real key with a positive TTL bounded by the window", async () => {
    // Exhaust a single-token window, then inspect the actual key in Redis.
    await adapter.consume("otp:phone-1", 1, 30);
    const denied = await adapter.consume("otp:phone-1", 1, 30);
    expect(denied.allowed).toBe(false);

    // The window is live: a positive TTL, never exceeding the configured window.
    const ttl = await redis.ttl(k("otp:phone-1"));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it("honours a custom prefix when addressing the real key", async () => {
    const customAdapter = new RedisRateLimitAdapter(redis, CUSTOM_PREFIX);

    await customAdapter.consume("test:key", 1, 60);

    // The counter lives under the custom namespace, not the suite's default one.
    expect(await redis.exists(`${CUSTOM_PREFIX}:test:key`)).toBe(1);
    expect(await redis.exists(k("test:key"))).toBe(0);
  });

  it("consumeMany runs the real N-key Lua: per-key counts, windows, and denials", async () => {
    const entries = [
      { key: "default:events.get:ip-1", maxTokens: 1, windowSeconds: 60 },
      { key: "global:ip-1", maxTokens: 3, windowSeconds: 30 },
    ];

    const first = await adapter.consumeMany(entries);
    expect(first).toEqual([
      { allowed: true, remaining: 0, retryAfterSeconds: 0 },
      { allowed: true, remaining: 2, retryAfterSeconds: 0 },
    ]);

    const second = await adapter.consumeMany(entries);
    expect(second[0]!.allowed).toBe(false);
    expect(second[0]!.retryAfterSeconds).toBeGreaterThan(0);
    expect(second[0]!.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(second[1]).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 });

    // Each key got ITS OWN window (ARGV[i] pairs with KEYS[i]).
    expect(await redis.get(k("default:events.get:ip-1"))).toBe("2");
    expect(await redis.get(k("global:ip-1"))).toBe("2");
    const perProcTtl = await redis.ttl(k("default:events.get:ip-1"));
    const globalTtl = await redis.ttl(k("global:ip-1"));
    expect(perProcTtl).toBeGreaterThan(30);
    expect(perProcTtl).toBeLessThanOrEqual(60);
    expect(globalTtl).toBeGreaterThan(0);
    expect(globalTtl).toBeLessThanOrEqual(30);
  });

  it("consumeMany heals an orphaned second key", async () => {
    await redis.set(k("global:user-1"), "999");
    expect(await redis.ttl(k("global:user-1"))).toBe(-1);

    const [, global] = await adapter.consumeMany([
      { key: "default:x:user-1", maxTokens: 240, windowSeconds: 60 },
      { key: "global:user-1", maxTokens: 600, windowSeconds: 60 },
    ]);

    expect(global!.allowed).toBe(false);
    expect(global!.retryAfterSeconds).toBeGreaterThan(0);
    expect(await redis.ttl(k("global:user-1"))).toBeGreaterThan(0);
  });

  it("peek reads real counts via MGET without creating or bumping keys", async () => {
    await adapter.consumeMany([
      { key: "pwfail:ip:e1:1.2.3.4", maxTokens: 3, windowSeconds: 900 },
      { key: "pwfail:event:e1", maxTokens: 100, windowSeconds: 3600 },
    ]);
    await adapter.consume("pwfail:ip:e1:1.2.3.4", 3, 900);

    await expect(
      adapter.peek(["pwfail:ip:e1:1.2.3.4", "pwfail:event:e1", "pwfail:none"]),
    ).resolves.toEqual([2, 1, 0]);

    // A read: the counter is unchanged and the absent key was not created.
    expect(await redis.get(k("pwfail:ip:e1:1.2.3.4"))).toBe("2");
    expect(await redis.exists(k("pwfail:none"))).toBe(0);
  });

  /**
   * Per-command counts of what THIS suite's scripts executed while `fn` runs:
   * every `EVAL` whose KEYS are all under `PREFIX`, and every command a script
   * ran (MONITOR source `lua`) whose key is under `PREFIX`. The inner commands
   * are the ones Upstash bills, so this pins the billing property.
   *
   * Why MONITOR and not `INFO commandstats`: commandstats are server-wide, so
   * they are exact only if nothing else talks to the server, and that does not
   * hold even in CI. On the self-hosted `hf-linux` runner, lima forwards the
   * job's `redis` service port to the Mac's `127.0.0.1:6379`, which is the dev
   * stack's `REDIS_URL`, so a running local API rate-limits (EVAL, INCR, TTL)
   * into the CI job's Redis. Filtering MONITOR by this run's random key prefix
   * is exact on any server, shared or not, and needs no `CONFIG RESETSTAT`.
   *
   * Ordering: MONITOR feeds commands in execution order over one connection,
   * so once the sentinel `EXISTS` (issued after `fn`) arrives, every command
   * `fn` caused has already been seen.
   */
  const scriptCallsDuring = async (
    fn: () => Promise<void>,
  ): Promise<Record<string, number>> => {
    const ownKey = (key: unknown) => String(key).startsWith(`${PREFIX}:`);
    const sentinel = k("monitor-sentinel");
    const calls: Record<string, number> = {};
    const bump = (name: string) => {
      calls[name] = (calls[name] ?? 0) + 1;
    };
    let sentinelSeen!: () => void;
    const sentinelArrived = new Promise<void>((resolve) => {
      sentinelSeen = resolve;
    });

    const monitor = await redis.monitor();
    monitor.on("monitor", (_time: string, args: unknown[], source: string) => {
      const name = String(args[0]).toLowerCase();
      if (name === "exists" && args[1] === sentinel) {
        sentinelSeen();
      } else if (name === "eval") {
        const keys = args.slice(3, 3 + Number(args[2]));
        if (keys.length > 0 && keys.every(ownKey)) bump("eval");
      } else if (source === "lua" && ownKey(args[1])) {
        bump(name);
      }
    });
    // Fail with a cause rather than hang to the test timeout if the sentinel
    // never shows up. 4s keeps it inside vitest's default 5s test timeout, so
    // this message (not "Test timed out") is what a local run reports.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await fn();
      await redis.exists(sentinel);
      await Promise.race([
        sentinelArrived,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("MONITOR sentinel not seen")),
            4_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      monitor.disconnect();
    }
    return calls;
  };

  it("the allowed path runs only INCR (plus EXPIRE on a new key): no TTL", async () => {
    const entries = [
      { key: "default:events.get:ip-9", maxTokens: 240, windowSeconds: 60 },
      { key: "global:ip-9", maxTokens: 600, windowSeconds: 60 },
    ];

    // 4 two-key calls, all allowed: the first creates both keys.
    const calls = await scriptCallsDuring(async () => {
      for (let i = 0; i < 4; i++) {
        const results = await adapter.consumeMany(entries);
        expect(results.every((r) => r.allowed)).toBe(true);
      }
    });

    expect(calls.eval).toBe(4);
    expect(calls.incr).toBe(8);
    expect(calls.expire).toBe(2);
    expect(calls.ttl ?? 0).toBe(0);
    // Steady state per two-key call: EVAL + 2 x INCR = 3 billed commands.
  });

  it("a new key gets the window as its expiry", async () => {
    const result = await adapter.consume("fresh:key", 5, 45);
    expect(result).toEqual({ allowed: true, remaining: 4, retryAfterSeconds: 0 });

    const ttl = await redis.ttl(k("fresh:key"));
    expect(ttl).toBeGreaterThan(40);
    expect(ttl).toBeLessThanOrEqual(45);
  });

  it("a deny reads the real TTL (one TTL call) and reports it as Retry-After", async () => {
    await adapter.consume("deny:key", 1, 60);
    // Shorten the live window so the reported TTL is distinguishable from the
    // window fallback.
    await redis.expire(k("deny:key"), 25);

    let denied!: Awaited<ReturnType<typeof adapter.consume>>;
    const calls = await scriptCallsDuring(async () => {
      denied = await adapter.consume("deny:key", 1, 60);
    });

    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(20);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(25);
    expect(calls.ttl).toBe(1);
    expect(calls.expire ?? 0).toBe(0);
  });

  it("an orphaned key UNDER max keeps counting, then heals on its first deny", async () => {
    const fullKey = k("orphan:under");
    await redis.set(fullKey, "3");
    expect(await redis.ttl(fullKey)).toBe(-1);

    const a = await adapter.consume("orphan:under", 5, 60);
    const b = await adapter.consume("orphan:under", 5, 60);
    expect(a).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    expect(b).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
    // The documented trade-off: no heal while allowed.
    expect(await redis.ttl(fullKey)).toBe(-1);

    const denied = await adapter.consume("orphan:under", 5, 60);
    expect(denied).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    const ttl = await redis.ttl(fullKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("consumeMany keeps input order with mixed max values (real Lua ARGV pairing)", async () => {
    const entries = [
      { key: "mix:two", maxTokens: 2, windowSeconds: 60 },
      { key: "mix:one", maxTokens: 1, windowSeconds: 30 },
      { key: "mix:three", maxTokens: 3, windowSeconds: 90 },
    ];

    await adapter.consumeMany(entries);
    const second = await adapter.consumeMany(entries);

    expect(second).toEqual([
      { allowed: true, remaining: 0, retryAfterSeconds: 0 },
      {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: expect.any(Number),
      },
      { allowed: true, remaining: 1, retryAfterSeconds: 0 },
    ]);
    expect(second[1]!.retryAfterSeconds).toBeGreaterThan(0);
    expect(second[1]!.retryAfterSeconds).toBeLessThanOrEqual(30);
    // Each key got its own window.
    expect(await redis.ttl(k("mix:three"))).toBeGreaterThan(60);
  });
});
