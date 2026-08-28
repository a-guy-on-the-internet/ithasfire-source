import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";

import { RedisRateLimitAdapter } from "@th/adapters/rate-limit/redis-rate-limit-adapter";
import {
  startRedisContainer,
  type RedisTestContainer,
} from "@th/test-utils/testcontainers";

import { createAtomicAuthRateLimiter } from "../src/auth/atomic-rate-limit";
import {
  AUTH_RATE_LIMIT_CUSTOM_RULES,
  resolveAccountCap,
} from "../src/auth/rate-limit-rules";

/**
 * INTEGRATION — real Redis. This is the whole point of the change.
 *
 * Better Auth's built-in limiter is a non-atomic read-modify-write
 * (`get(key)` → compute → `set(key, count + 1)`, with the arithmetic in
 * Better Auth core BETWEEN our storage hook's two calls), so all concurrent
 * requests read the same count and increments are lost. Measured on the live
 * dev API against `/sign-in/email` (cap 5/60s), one pinned
 * `cf-connecting-ip`: 12 sequential → exactly 5 allowed; 24 CONCURRENT → 24
 * allowed, zero 429s.
 *
 * A mocked `RateLimitPort` is atomic by construction and therefore CANNOT
 * prove the fix. These cases run the real `RedisRateLimitAdapter` (INCR +
 * self-healing EXPIRE in one Lua `EVAL`) against a real server, fire N > cap
 * requests concurrently, and assert exactly `cap` get through.
 *
 * The last case is the CONTROL: it reproduces Better Auth's algorithm
 * against the same Redis and shows it letting all N through — so a future
 * regression that quietly reintroduces read-modify-write fails here rather
 * than passing with a green mock.
 *
 * Infra: `@th/test-utils`' `startRedisContainer`, which uses
 * `TESTCONTAINERS_REUSE_REDIS_URL` (or `CI=true` + `REDIS_URL`) when set and
 * falls back to Testcontainers. Every key is namespaced with a fresh UUID per
 * run so a reused/shared server can't leak state between suites. If neither
 * a reusable URL nor Docker is available this suite FAILS — it does not
 * silently skip.
 */

const RULE = AUTH_RATE_LIMIT_CUSTOM_RULES["/sign-in/email"];
const IP_CAP = RULE.max; // 5
// Via resolveAccountCap, NOT `RULE.max * <multiplier>`: send endpoints use a
// tighter multiplier, so the resolver is the only honest source.
const ACCOUNT_CAP = resolveAccountCap("/sign-in/email")!.max; // 60
/**
 * Comfortably above BOTH caps so one number exercises the IP bucket (from a
 * single IP) and the account bucket (from distinct IPs).
 */
const CONCURRENCY = ACCOUNT_CAP + 12;

const noopLogger = { warn: () => {} };

describe("atomic auth rate limiter – real Redis concurrency", () => {
  let redisContainer: RedisTestContainer | undefined;
  let redis: Redis | undefined;
  let keyPrefix: string;

  beforeAll(async () => {
    redisContainer = await startRedisContainer();
    redis = new Redis(redisContainer.connectionUri, {
      maxRetriesPerRequest: 3,
    });
    await redis.ping();
  }, 180_000);

  afterAll(async () => {
    await redis?.quit().catch(() => {});
    await redisContainer?.stop();
  });

  const makeLimiter = () => {
    // Fresh namespace per case so buckets never bleed across tests (and so a
    // shared/reused Redis stays safe).
    keyPrefix = `test-authgate-${randomUUID()}`;
    return createAtomicAuthRateLimiter({
      rateLimit: new RedisRateLimitAdapter(redis!, keyPrefix),
      logger: noopLogger,
      identifierHashKey: "concurrency-test-identifier-key",
    });
  };

  it("allows exactly the IP cap when N > cap requests arrive CONCURRENTLY from one IP", async () => {
    const limiter = makeLimiter();

    const decisions = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        limiter({
          url: "/api/auth/sign-in/email",
          headers: { "cf-connecting-ip": "203.0.113.10" },
          body: { email: "victim@example.com", password: "wrong" },
        }),
      ),
    );

    const allowed = decisions.filter((d) => !d.limited).length;
    const limited = decisions.length - allowed;

    // The exact assertion Better Auth's limiter fails: N concurrent, cap 5.
    expect(allowed).toBe(IP_CAP);
    expect(limited).toBe(CONCURRENCY - IP_CAP);
  });

  /**
   * TARGETED-LOCKOUT GUARD, proven atomically rather than with a mock.
   *
   * The victim's account bucket must only be charged for requests the IP
   * bucket did NOT already refuse. If 429'd requests still burned it, a
   * single host could lock a known email out; with the short-circuit, one
   * host can only ever spend `IP_CAP` of the victim's tokens per window.
   */
  it("charges the victim's ACCOUNT bucket at most IP_CAP times from a single host", async () => {
    const limiter = makeLimiter();
    const victim = "lockout-victim@example.com";

    await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        limiter({
          url: "/api/auth/sign-in/email",
          headers: { "cf-connecting-ip": "203.0.113.90" },
          body: { email: victim, password: "wrong" },
        }),
      ),
    );

    const accountKeys = await redis!.keys(`${keyPrefix}:authgate:acct:*`);
    expect(accountKeys).toHaveLength(1);
    expect(Number(await redis!.get(accountKeys[0]!))).toBe(IP_CAP);

    // ...so the victim, arriving from their own (fresh) IP, still gets in.
    await expect(
      limiter({
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": "203.0.113.91" },
        body: { email: victim, password: "correct-horse" },
      }),
    ).resolves.toEqual({ limited: false });
  });

  it("matches SEQUENTIAL behaviour exactly (no over- or under-counting)", async () => {
    const limiter = makeLimiter();
    const results: boolean[] = [];

    for (let i = 0; i < 12; i += 1) {
      const decision = await limiter({
        // Alternate the RAW target between the plain form and a
        // dot-segment/backslash form that WHATWG normalization resolves to the
        // same endpoint. All 12 must share one bucket — if path normalization
        // ever diverges from the downstream router again, the counts split and
        // this fails.
        url:
          i % 3 === 0
            ? "/api/auth/sign-in/email"
            : i % 3 === 1
              ? "/api/auth/x/../sign-in/email"
              : "/api/auth/sign-in\\email",
        headers: { "cf-connecting-ip": "203.0.113.11" },
        body: { email: "victim@example.com", password: "wrong" },
      });
      results.push(!decision.limited);
    }

    expect(results).toEqual([
      ...Array(IP_CAP).fill(true),
      ...Array(12 - IP_CAP).fill(false),
    ]);
  });

  it("caps distributed credential stuffing on the ACCOUNT bucket (every request a fresh IP)", async () => {
    const limiter = makeLimiter();

    // Each request comes from a different IP, so the per-IP bucket never
    // trips — exactly the attack per-IP-only limiting misses entirely.
    const decisions = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_unused, index) =>
        limiter({
          url: "/api/auth/sign-in/email",
          headers: { "cf-connecting-ip": `198.51.100.${index + 1}` },
          body: { email: "victim@example.com", password: `guess-${index}` },
        }),
      ),
    );

    const allowed = decisions.filter((d) => !d.limited).length;
    expect(allowed).toBe(ACCOUNT_CAP);
  });

  it("keeps buckets independent per IP, per account and per path", async () => {
    const limiter = makeLimiter();

    // Burn the IP bucket for one (ip, path) pair.
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        limiter({
          url: "/api/auth/sign-in/email",
          headers: { "cf-connecting-ip": "203.0.113.20" },
          body: { email: "burned@example.com", password: "wrong" },
        }),
      ),
    );

    // A different IP + different account on the same path is unaffected.
    await expect(
      limiter({
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": "203.0.113.21" },
        body: { email: "bystander@example.com", password: "wrong" },
      }),
    ).resolves.toEqual({ limited: false });

    // The SAME IP on a different guess-space path is also unaffected.
    await expect(
      limiter({
        url: "/api/auth/two-factor/verify-totp",
        headers: { "cf-connecting-ip": "203.0.113.20" },
        body: { code: "000000" },
      }),
    ).resolves.toEqual({ limited: false });
  });

  it("sets a positive TTL on every bucket it creates (no permanently-stuck key)", async () => {
    const limiter = makeLimiter();

    await limiter({
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.30" },
      body: { email: "ttl@example.com", password: "wrong" },
    });

    const keys = await redis!.keys(`${keyPrefix}:authgate:*`);
    expect(keys).toHaveLength(2); // ip + account
    for (const key of keys) {
      expect(await redis!.ttl(key)).toBeGreaterThan(0);
    }

    // PII must never reach the keyspace. Assert the ACCOUNT key is the HMAC
    // specifically — NOT "no `@` appears anywhere", which is not a real
    // invariant: the IP component is raw, unvalidated header text, so a
    // forged `x-real-ip: a@b` would put an `@` in a key without any PII
    // having leaked.
    const accountKey = keys.find((k) => k.includes(":acct:"))!;
    expect(accountKey).not.toContain("ttl@example.com");
    expect(accountKey).toMatch(/:acct:\/sign-in\/email:[0-9a-f]{32}$/);
  });

  it("CONTROL: better-auth's read-modify-write algorithm lets all N through on the same Redis", async () => {
    // Faithful reproduction of better-auth/dist/api/rate-limiter/index.mjs:
    // onRequest does get(); onResponse does get() then set(count + 1). The
    // increment is NOT atomic, so concurrent callers all read the same count.
    const key = `test-bauth-${randomUUID()}`;
    const shouldRateLimit = (data: { count: number; lastRequest: number }) =>
      Date.now() - data.lastRequest < RULE.window * 1000 &&
      data.count >= RULE.max;

    const readModifyWrite = async (): Promise<boolean> => {
      const raw = await redis!.get(key);
      const data = raw
        ? (JSON.parse(raw) as { count: number; lastRequest: number })
        : null;
      const denied = data ? shouldRateLimit(data) : false;

      const now = Date.now();
      const next = data
        ? { count: data.count + 1, lastRequest: now }
        : { count: 1, lastRequest: now };
      await redis!.set(key, JSON.stringify(next), "EX", 120);
      return !denied;
    };

    const allowed = (
      await Promise.all(
        Array.from({ length: CONCURRENCY }, () => readModifyWrite()),
      )
    ).filter(Boolean).length;

    // This is the bug. If this assertion ever starts failing, the upstream
    // limiter became atomic and this whole layer can be re-evaluated.
    expect(allowed).toBeGreaterThan(IP_CAP);
  });
});
