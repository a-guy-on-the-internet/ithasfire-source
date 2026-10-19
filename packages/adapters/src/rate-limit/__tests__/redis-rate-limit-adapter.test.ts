import { describe, it, expect, vi } from "vitest";
import { RedisRateLimitAdapter } from "../redis-rate-limit-adapter";

/**
 * Lightweight fake Redis supporting incr, expire, ttl — plus `eval`, which
 * mimics the adapter's Lua script (atomic INCR + self-healing EXPIRE) against
 * the same in-memory store so the tests exercise real increment/expiry/TTL
 * semantics rather than a no-op.
 */
function makeFakeRedis() {
  const store = new Map<string, { count: number; expiresAt: number }>();
  const ops: string[] = [];

  const incr = (key: string) => {
    const now = Date.now();
    const entry = store.get(key);

    if (entry && entry.expiresAt > now) {
      entry.count += 1;
      return entry.count;
    }

    // Key either doesn't exist or has expired — start fresh at 1.
    store.set(key, { count: 1, expiresAt: Infinity });
    return 1;
  };

  const expire = (key: string, seconds: number) => {
    const entry = store.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + seconds * 1000;
    }
  };

  const ttl = (key: string) => {
    const entry = store.get(key);
    if (!entry) return -2;
    if (entry.expiresAt === Infinity) return -1;
    const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  };

  return {
    async incr(key: string) {
      return incr(key);
    },

    async expire(key: string, seconds: number) {
      expire(key, seconds);
    },

    async ttl(key: string) {
      return ttl(key);
    },

    /**
     * Mimics `redis.eval(CONSUME_SCRIPT, numKeys, ...keys, w1, m1, w2, m2, ...)`:
     * per key, INCR; EXPIRE + ttl=window on a new key; TTL (healing an orphan)
     * only when over max; ttl=0 otherwise. Returns the flat
     * `{count1, ttl1, count2, ttl2, ...}` reply. Also records each simulated
     * inner command in `ops` so tests can see which branch ran.
     */
    eval: vi.fn(
      async (_script: string, numKeys: number, ...args: Array<string | number>) => {
        const keys = args.slice(0, numKeys) as string[];
        const argv = args.slice(numKeys).map(Number);
        const out: number[] = [];
        keys.forEach((key, i) => {
          const window = argv[2 * i]!;
          const max = argv[2 * i + 1]!;
          const count = incr(key);
          ops.push(`INCR ${key}`);
          let reply = 0;
          if (count === 1) {
            expire(key, window);
            ops.push(`EXPIRE ${key}`);
            reply = window;
          } else if (count > max) {
            reply = ttl(key);
            ops.push(`TTL ${key}`);
            if (reply < 0) {
              expire(key, window);
              ops.push(`EXPIRE ${key}`);
              reply = window;
            }
          }
          out.push(count, reply);
        });
        return out;
      },
    ),

    /** Mimics `redis.mget(...keys)`: string counts, null for absent/expired keys. */
    mget: vi.fn(async (...keys: string[]) =>
      keys.map((key) => {
        const entry = store.get(key);
        if (!entry || entry.expiresAt <= Date.now()) return null;
        return String(entry.count);
      }),
    ),

    /** Test helper: forcibly expire a key. */
    _expire(key: string) {
      store.delete(key);
    },

    _store: store,
    /** Simulated inner commands, in order (see `eval`). */
    _ops: ops,
  };
}

describe("RedisRateLimitAdapter", () => {
  it("allows requests up to maxTokens", async () => {
    const redis = makeFakeRedis();
    const adapter = new RedisRateLimitAdapter(redis as any);

    const r1 = await adapter.consume("test:key", 3, 60);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await adapter.consume("test:key", 3, 60);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await adapter.consume("test:key", 3, 60);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("denies requests exceeding maxTokens", async () => {
    const redis = makeFakeRedis();
    const adapter = new RedisRateLimitAdapter(redis as any);

    // Exhaust the budget
    await adapter.consume("test:key", 2, 60);
    await adapter.consume("test:key", 2, 60);

    // Third request should be denied
    const r3 = await adapter.consume("test:key", 2, 60);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
    expect(r3.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets after the window expires", async () => {
    const redis = makeFakeRedis();
    const adapter = new RedisRateLimitAdapter(redis as any);

    await adapter.consume("test:key", 1, 60);

    // Simulate window expiry
    redis._expire("rl:test:key");

    const r2 = await adapter.consume("test:key", 1, 60);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);
  });

  it("tracks separate keys independently", async () => {
    const redis = makeFakeRedis();
    const adapter = new RedisRateLimitAdapter(redis as any);

    await adapter.consume("org:1", 1, 60);
    const denied = await adapter.consume("org:1", 1, 60);
    expect(denied.allowed).toBe(false);

    // Different key should still be allowed
    const r = await adapter.consume("org:2", 1, 60);
    expect(r.allowed).toBe(true);
  });

  it("uses the configured prefix", async () => {
    const redis = makeFakeRedis();
    const adapter = new RedisRateLimitAdapter(redis as any, "custom");

    await adapter.consume("test:key", 1, 60);

    expect(redis._store.has("custom:test:key")).toBe(true);
    expect(redis._store.has("rl:test:key")).toBe(false);
  });

  it("always leaves a positive TTL on the first request", async () => {
    const redis = makeFakeRedis();
    const adapter = new RedisRateLimitAdapter(redis as any);

    await adapter.consume("test:key", 5, 60);

    // A brand-new key must never be left without an expiry.
    expect(await redis.ttl("rl:test:key")).toBeGreaterThan(0);
  });

  it("self-heals an orphaned key stuck with no TTL (regression)", async () => {
    const redis = makeFakeRedis();
    const adapter = new RedisRateLimitAdapter(redis as any);

    // Reproduce the live bug: a counter already over the limit that somehow
    // lost its expiry (TTL -1, expiresAt Infinity). Under the old
    // INCR-then-EXPIRE code this key would stay TTL -1 forever and 429 the
    // caller until Redis was flushed by hand.
    redis._store.set("rl:notifications.countUnread:user-1", {
      count: 930,
      expiresAt: Infinity,
    });
    expect(await redis.ttl("rl:notifications.countUnread:user-1")).toBe(-1);

    const result = await adapter.consume(
      "notifications.countUnread:user-1",
      100,
      60,
    );

    // Still denied (it's over the limit)…
    expect(result.allowed).toBe(false);
    // …but Retry-After now reflects a real window instead of being stuck.
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    // …and crucially the key now carries a positive TTL, so it will reset.
    expect(
      await redis.ttl("rl:notifications.countUnread:user-1"),
    ).toBeGreaterThan(0);
  });

  describe("consumeMany", () => {
    it("charges every bucket in ONE eval round trip (numKeys = N, keys prefixed)", async () => {
      const redis = makeFakeRedis();
      const adapter = new RedisRateLimitAdapter(redis as any);

      await adapter.consumeMany([
        { key: "default:events.get:1.2.3.4", maxTokens: 240, windowSeconds: 60 },
        { key: "global:1.2.3.4", maxTokens: 600, windowSeconds: 30 },
      ]);

      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [script, numKeys, ...rest] = redis.eval.mock.calls[0]!;
      expect(typeof script).toBe("string");
      expect(numKeys).toBe(2);
      // KEYS first (both prefixed), then `window, max` per key as ARGV, in
      // key order.
      expect(rest).toEqual([
        "rl:default:events.get:1.2.3.4",
        "rl:global:1.2.3.4",
        60,
        240,
        30,
        600,
      ]);
    });

    it("returns one result per entry in input order, each with consume's semantics", async () => {
      const redis = makeFakeRedis();
      const adapter = new RedisRateLimitAdapter(redis as any);
      const entries = [
        { key: "tight", maxTokens: 1, windowSeconds: 60 },
        { key: "loose", maxTokens: 5, windowSeconds: 60 },
      ];

      const first = await adapter.consumeMany(entries);
      expect(first).toEqual([
        { allowed: true, remaining: 0, retryAfterSeconds: 0 },
        { allowed: true, remaining: 4, retryAfterSeconds: 0 },
      ]);

      // count 2 > max 1 on the tight bucket: denied with a TTL-based
      // Retry-After. The loose bucket is still charged and still allowed.
      const second = await adapter.consumeMany(entries);
      expect(second[0]!.allowed).toBe(false);
      expect(second[0]!.remaining).toBe(0);
      expect(second[0]!.retryAfterSeconds).toBeGreaterThan(0);
      expect(second[0]!.retryAfterSeconds).toBeLessThanOrEqual(60);
      expect(second[1]).toEqual({ allowed: true, remaining: 3, retryAfterSeconds: 0 });
    });

    it("falls back to the entry's window when the returned TTL is non-positive", async () => {
      const redis = makeFakeRedis();
      // Force a reply of count over max with TTL -1 for the second key only.
      redis.eval.mockResolvedValueOnce([1, 60, 9, -1]);
      const adapter = new RedisRateLimitAdapter(redis as any);

      const [a, b] = await adapter.consumeMany([
        { key: "a", maxTokens: 5, windowSeconds: 60 },
        { key: "b", maxTokens: 5, windowSeconds: 45 },
      ]);

      expect(a).toEqual({ allowed: true, remaining: 4, retryAfterSeconds: 0 });
      expect(b).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 45 });
    });

    it("self-heals an orphaned key in any position", async () => {
      const redis = makeFakeRedis();
      const adapter = new RedisRateLimitAdapter(redis as any);
      redis._store.set("rl:global:user-1", { count: 900, expiresAt: Infinity });

      const [, global] = await adapter.consumeMany([
        { key: "default:x:user-1", maxTokens: 240, windowSeconds: 60 },
        { key: "global:user-1", maxTokens: 600, windowSeconds: 60 },
      ]);

      expect(global!.allowed).toBe(false);
      expect(await redis.ttl("rl:global:user-1")).toBeGreaterThan(0);
    });

    it("returns [] for no entries without calling Redis", async () => {
      const redis = makeFakeRedis();
      const adapter = new RedisRateLimitAdapter(redis as any);

      await expect(adapter.consumeMany([])).resolves.toEqual([]);
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it("consume is still a single one-key eval", async () => {
      const redis = makeFakeRedis();
      const adapter = new RedisRateLimitAdapter(redis as any);

      await adapter.consume("test:key", 3, 60);

      expect(redis.eval).toHaveBeenCalledTimes(1);
      expect(redis.eval.mock.calls[0]!.slice(1)).toEqual([
        1,
        "rl:test:key",
        60,
        3,
      ]);
    });

    it("maps the reply: an allowed key's ttl (0) is ignored, a denied key's ttl is Retry-After", async () => {
      const redis = makeFakeRedis();
      // Key a: count 3 of max 5, ttl 0 (allowed path, no TTL read).
      // Key b: count 7 of max 6, ttl 42 (denied path, live TTL).
      // Key c: count 1 of max 2, ttl 30 (new key, ttl = window).
      redis.eval.mockResolvedValueOnce([3, 0, 7, 42, 1, 30]);
      const adapter = new RedisRateLimitAdapter(redis as any);

      const results = await adapter.consumeMany([
        { key: "a", maxTokens: 5, windowSeconds: 60 },
        { key: "b", maxTokens: 6, windowSeconds: 60 },
        { key: "c", maxTokens: 2, windowSeconds: 30 },
      ]);

      expect(results).toEqual([
        { allowed: true, remaining: 2, retryAfterSeconds: 0 },
        { allowed: false, remaining: 0, retryAfterSeconds: 42 },
        { allowed: true, remaining: 1, retryAfterSeconds: 0 },
      ]);
    });

    it("keeps input order with mixed max values", async () => {
      const redis = makeFakeRedis();
      const adapter = new RedisRateLimitAdapter(redis as any);
      const entries = [
        { key: "two", maxTokens: 2, windowSeconds: 60 },
        { key: "one", maxTokens: 1, windowSeconds: 60 },
        { key: "three", maxTokens: 3, windowSeconds: 60 },
      ];

      await adapter.consumeMany(entries);
      const second = await adapter.consumeMany(entries);

      expect(second.map((r) => r.allowed)).toEqual([true, false, true]);
      expect(second.map((r) => r.remaining)).toEqual([0, 0, 1]);
    });

    it("an orphaned key UNDER max keeps counting, then heals on its first deny", async () => {
      const redis = makeFakeRedis();
      const adapter = new RedisRateLimitAdapter(redis as any);
      redis._store.set("rl:orphan", { count: 3, expiresAt: Infinity });

      const a = await adapter.consume("orphan", 5, 60);
      const b = await adapter.consume("orphan", 5, 60);
      expect([a.allowed, b.allowed]).toEqual([true, true]);
      // Allowed path never reads or repairs the TTL.
      expect(await redis.ttl("rl:orphan")).toBe(-1);
      expect(redis._ops.some((op) => op.startsWith("TTL"))).toBe(false);

      const denied = await adapter.consume("orphan", 5, 60);
      expect(denied).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
      expect(await redis.ttl("rl:orphan")).toBeGreaterThan(0);
    });
  });

  describe("peek", () => {
    it("reads every key in ONE mget round trip, prefixed, in input order", async () => {
      const redis = makeFakeRedis();
      const adapter = new RedisRateLimitAdapter(redis as any, "custom");
      await adapter.consume("pwfail:ip:e1:1.2.3.4", 3, 900);
      await adapter.consume("pwfail:ip:e1:1.2.3.4", 3, 900);
      await adapter.consume("pwfail:event:e1", 100, 3600);
      redis.eval.mockClear();

      const counts = await adapter.peek([
        "pwfail:ip:e1:1.2.3.4",
        "pwfail:event:e1",
      ]);

      expect(counts).toEqual([2, 1]);
      expect(redis.mget).toHaveBeenCalledTimes(1);
      expect(redis.mget.mock.calls[0]).toEqual([
        "custom:pwfail:ip:e1:1.2.3.4",
        "custom:pwfail:event:e1",
      ]);
      // A read: no INCR/EXPIRE script ran.
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it("reads an absent key (null) as 0 and does not create it", async () => {
      const redis = makeFakeRedis();
      const adapter = new RedisRateLimitAdapter(redis as any);
      await adapter.consume("hit", 5, 60);

      await expect(adapter.peek(["never", "hit"])).resolves.toEqual([0, 1]);
      expect(redis._store.has("rl:never")).toBe(false);
    });

    it("does not consume: repeated peeks leave the count unchanged", async () => {
      const redis = makeFakeRedis();
      const adapter = new RedisRateLimitAdapter(redis as any);
      await adapter.consume("k", 5, 60);

      await adapter.peek(["k"]);
      await adapter.peek(["k"]);

      expect(redis._store.get("rl:k")!.count).toBe(1);
    });

    it("reads a non-numeric reply as 0 rather than NaN", async () => {
      const redis = makeFakeRedis();
      redis.mget.mockResolvedValueOnce(["garbage", "7"]);
      const adapter = new RedisRateLimitAdapter(redis as any);

      await expect(adapter.peek(["a", "b"])).resolves.toEqual([0, 7]);
    });

    it("returns [] for no keys without calling Redis", async () => {
      const redis = makeFakeRedis();
      const adapter = new RedisRateLimitAdapter(redis as any);

      await expect(adapter.peek([])).resolves.toEqual([]);
      expect(redis.mget).not.toHaveBeenCalled();
    });
  });
});
