import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { RedisMemoryServer } from "redis-memory-server";

import {
  allowanceBucketSeconds,
  RedisRateLimitAdapter,
} from "../redis-rate-limit-adapter";

/**
 * `consumeAllowance` against a REAL Redis, so the literal ALLOWANCE_SCRIPT
 * Lua and its KEYS/ARGV wiring run end to end: rolling sub-buckets, all or
 * nothing across keys, retry-after, expiry. Server selection and the CI skip
 * mirror `redis-rate-limit-adapter.integration.test.ts` (see there).
 */
const providedRedisUrl =
  process.env.TESTCONTAINERS_REUSE_REDIS_URL?.trim() || undefined;
const ciFlag = process.env.CI?.toLowerCase();
const inCi = ciFlag === "true" || ciFlag === "1";

const PREFIX = `rl-allow-${randomBytes(6).toString("hex")}`;
const DAY = 24 * 60 * 60;

describe.skipIf(inCi && !providedRedisUrl)(
  "RedisRateLimitAdapter.consumeAllowance (integration, real Redis eval)",
  () => {
    let server: RedisMemoryServer | undefined;
    let redis: Redis;
    // Test clock (ms). Starts on a sub-bucket boundary for exact arithmetic.
    let nowMs = Math.floor(Date.now() / 1000 / 3600) * 3600 * 1000;
    let adapter: RedisRateLimitAdapter;

    beforeAll(async () => {
      if (providedRedisUrl) {
        redis = new Redis(providedRedisUrl, { maxRetriesPerRequest: 1 });
      } else {
        server = await RedisMemoryServer.create();
        redis = new Redis({
          host: await server.getHost(),
          port: await server.getPort(),
          maxRetriesPerRequest: 1,
        });
      }
      adapter = new RedisRateLimitAdapter(redis, PREFIX, () => nowMs);
    }, 180_000);

    const deleteOwnKeys = async () => {
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", `${PREFIX}*`, "COUNT", 500);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== "0");
    };

    afterEach(async () => {
      await deleteOwnKeys();
    });

    afterAll(async () => {
      try {
        if (redis) await deleteOwnKeys();
      } finally {
        try {
          await redis?.quit();
        } finally {
          await server?.stop();
        }
      }
    });

    const charge = (amount: number, limits: [number, number] = [50, 50]) =>
      adapter.consumeAllowance({
        entries: [
          { key: "actor:a", limit: limits[0] },
          { key: "owner:o", limit: limits[1] },
        ],
        amount,
        windowSeconds: DAY,
      });

    it("charges every key by the amount and reports what remains", async () => {
      const r = await charge(30);
      expect(r).toEqual({
        allowed: true,
        results: [
          { remaining: 20, retryAfterSeconds: 0 },
          { remaining: 20, retryAfterSeconds: 0 },
        ],
      });
      // One hash per key, one field per hourly sub-bucket, with a TTL.
      expect(await redis.hgetall(`${PREFIX}:actor:a`)).toEqual({
        [String(Math.floor(nowMs / 1000 / allowanceBucketSeconds(DAY)))]: "30",
      });
      expect(await redis.ttl(`${PREFIX}:actor:a`)).toBeGreaterThan(DAY);
    });

    it("is all or nothing across keys: one key short → nothing charged anywhere", async () => {
      await charge(10, [50, 50]);
      // The owner key has room (40 left of 50), the actor key (limit 15) not.
      const denied = await charge(10, [15, 50]);
      expect(denied.allowed).toBe(false);
      expect(denied.results[0]).toMatchObject({ remaining: 5 });
      expect(denied.results[0]!.retryAfterSeconds).toBeGreaterThan(0);
      expect(denied.results[1]).toEqual({ remaining: 40, retryAfterSeconds: 0 });
      // Nothing moved.
      const read = await charge(0);
      expect(read.results.map((r) => r.remaining)).toEqual([40, 40]);
    });

    it("rolls hour by hour: a charge counts for a full 24h, then leaves", async () => {
      await charge(40); // hour 0
      nowMs += 12 * 3600 * 1000;
      await charge(10); // hour 12 → 50 used
      const full = await charge(1);
      expect(full.allowed).toBe(false);
      // The hour-0 sub-bucket leaves once hour 25 starts: 13h from now.
      expect(full.results[0]!.retryAfterSeconds).toBe(13 * 3600);

      // Hour 24, a true 24h after the first charge: still counted.
      nowMs += 12 * 3600 * 1000;
      expect(await charge(1)).toMatchObject({ allowed: false });

      nowMs += 3600 * 1000; // hour 25: hour-0 charge gone, hour-12 stays
      const after = await charge(40);
      expect(after.allowed).toBe(true);
      expect(after.results[0]!.remaining).toBe(0);
      expect(await charge(1)).toMatchObject({ allowed: false });
    });

    it("an amount-0 read drops sub-buckets that left the window", async () => {
      await charge(5); // hour 0
      nowMs += 25 * 3600 * 1000;
      const read = await charge(0);
      expect(read.results.map((r) => r.remaining)).toEqual([50, 50]);
      expect(await redis.hlen(`${PREFIX}:actor:a`)).toBe(0);
    });

    it("refundAllowance hands units back on the current sub-bucket, clamped at 0", async () => {
      const entries = [{ key: "actor:a" }, { key: "owner:o" }];
      await charge(10);
      await adapter.refundAllowance({ entries, amount: 4, windowSeconds: DAY });
      expect((await charge(0)).results.map((r) => r.remaining)).toEqual([44, 44]);
      // More than the sub-bucket holds: clamped, the field goes away.
      await adapter.refundAllowance({ entries, amount: 100, windowSeconds: DAY });
      expect((await charge(0)).results.map((r) => r.remaining)).toEqual([50, 50]);
      expect(await redis.hlen(`${PREFIX}:actor:a`)).toBe(0);

      // Never touches an OLDER sub-bucket, and never mints capacity.
      await charge(10);
      nowMs += 3600 * 1000;
      await adapter.refundAllowance({ entries, amount: 10, windowSeconds: DAY });
      expect((await charge(0)).results.map((r) => r.remaining)).toEqual([40, 40]);
      await expect(
        adapter.refundAllowance({ entries, amount: -1, windowSeconds: DAY }),
      ).rejects.toThrow("rate_limit_allowance_bad_amount");
    });

    it("an amount over the limit on an empty key is refused, with nothing charged", async () => {
      const r = await charge(51);
      expect(r.allowed).toBe(false);
      expect(r.results[0]).toEqual({ remaining: 50, retryAfterSeconds: 0 });
      expect(await redis.exists(`${PREFIX}:actor:a`)).toBe(0);
    });

    it("empty entries never touch Redis; a bad amount throws", async () => {
      await expect(
        adapter.consumeAllowance({ entries: [], amount: 5, windowSeconds: DAY }),
      ).resolves.toEqual({ allowed: true, results: [] });
      await expect(charge(-1)).rejects.toThrow("rate_limit_allowance_bad_amount");
      await expect(charge(1.5)).rejects.toThrow("rate_limit_allowance_bad_amount");
    });
  },
);
