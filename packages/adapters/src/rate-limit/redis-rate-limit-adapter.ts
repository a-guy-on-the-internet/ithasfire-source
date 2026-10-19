import type {
  AllowanceEntry,
  AllowanceResult,
  RateLimitEntry,
  RateLimitPort,
  RateLimitResult,
} from "@th/ports/rate-limit";
import type { Redis } from "ioredis";

/**
 * Atomic fixed-window INCR + EXPIRE over N keys, evaluated server-side in one
 * round trip.
 *
 * History: this adapter once did `INCR` then a separate `EXPIRE` only when the
 * count came back as 1. That sequence is NOT atomic: if anything interrupts
 * between the two calls (process death, a dropped/failed EXPIRE, or a key that
 * somehow already exists without a TTL) the counter lives forever with TTL -1.
 * A fixed-window counter that never expires never resets, so once it crosses
 * `maxTokens` the caller is stuck getting denied on that key until Redis is
 * flushed by hand. Observed live as `rl:default:notifications.countUnread:*`
 * sitting at 930 / TTL -1, permanently 429ing a signed-in session's poll.
 *
 * Layout: `KEYS[i]` pairs with `ARGV[2i-1]` (its window in seconds) and
 * `ARGV[2i]` (its maxTokens). The reply is flat, `{count1, ttl1, count2, ttl2,
 * ...}` in key order. `consumeMany` sends all its buckets in one `EVAL`;
 * `consume` sends one.
 *
 * Per key:
 * - `count == 1` (new key): `EXPIRE key window`, reply ttl = window.
 * - `count > max` (deny): `TTL key`. If it is < 0 (an orphaned key with no
 *   expiry), `EXPIRE key window` and reply ttl = window, so the key heals on the
 *   deny path. Otherwise reply the live TTL, which drives Retry-After.
 * - otherwise (allow): reply ttl = 0, which is unused. No TTL call.
 *
 * Billing: Upstash bills the `EVAL` itself plus every `redis.call` inside it
 * (its own cost table lists a fixed-window hit as "3 | EVAL, INCR, PEXPIRE":
 * https://upstash.com/docs/redis/sdks/ratelimit-ts/costs). So the two-key
 * floor in the tRPC guard (`default:<path>:<actor>` + `global:<actor>`) costs:
 *
 * - this script, allowed path: EVAL + 2 x INCR = 3 billed commands;
 * - the previous script (INCR + TTL + TTL per key): EVAL + 2 x 3 = 7;
 * - one key before the global key existed: EVAL + 3 = 4.
 *
 * A brand-new key adds one EXPIRE; a denied key adds one TTL (plus one EXPIRE
 * if it was orphaned).
 *
 * Trade-off of skipping TTL on the allowed path: an orphaned key that is still
 * UNDER its max is no longer healed while it keeps allowing. It keeps counting
 * across what would have been window boundaries until it first exceeds max;
 * that deny heals it, and it then expires one window later. Worst case is one
 * early denial window, never a permanent one. The stuck-forever bug above was
 * a key OVER max, which this script heals on its next hit. An orphan that
 * stays under max and then stops getting traffic is never healed and never
 * expires: a slow memory leak in Redis, not a lockout.
 *
 * Multi-key EVAL and Redis Cluster: a cluster rejects a script whose KEYS span
 * more than one hash slot (CROSSSLOT), and the guard's `default:<path>:<actor>`
 * and `global:<actor>` keys hash to different slots. That is fine today: the
 * API and jobs build a single standalone `new Redis(url)` client (apps/api
 * `lib/dep.ts`, apps/jobs `lib/container.ts`), not an `ioredis` `Cluster`, and
 * Upstash serves a single endpoint. If this ever moves to a clustered Redis,
 * callers must hash-tag related keys (e.g. `{<actor>}`) so each `consumeMany`
 * call lands in one slot. ioredis applies its `keyPrefix` option to every one
 * of the `numKeys` keys, so namespacing works the same as the one-key form.
 *
 * Locking: Upstash runs EVAL under a global lock by default. A
 * `#!lua flags=allow-key-locking` shebang would let this script take per-key
 * locks instead (https://upstash.com/blog/redis-key-based-locking), but stock
 * Redis rejects unknown shebang flags, so setting it would break local Redis
 * and CI. Deliberately not set.
 *
 * Exported only so `__tests__/redis-rate-limit-adapter.script.test.ts` can
 * check the script TEXT (TTL only on the deny branch).
 */
export const CONSUME_SCRIPT = `
local out = {}
for i = 1, #KEYS do
  local key = KEYS[i]
  local window = tonumber(ARGV[2 * i - 1])
  local max = tonumber(ARGV[2 * i])
  local count = redis.call('INCR', key)
  local ttl = 0
  if count == 1 then
    redis.call('EXPIRE', key, window)
    ttl = window
  elseif count > max then
    ttl = redis.call('TTL', key)
    if ttl < 0 then
      redis.call('EXPIRE', key, window)
      ttl = window
    end
  end
  out[#out + 1] = count
  out[#out + 1] = ttl
end
return out
`;

/**
 * Rolling-window, all-or-nothing allowance (`RateLimitPort.consumeAllowance`).
 *
 * Each key is a HASH of sub-buckets: field = bucket index
 * (`floor(now / bucketSeconds)`), value = units charged in it. The window is
 * the current sub-bucket plus the `span = window / bucketSeconds` before
 * it, so a charge counts for at least the full window (24h to 25h, for a 24h
 * window with hourly sub-buckets) and usage rolls forward one sub-bucket at
 * a time instead of resetting all at once like the fixed-window counter
 * above.
 *
 * ARGV: amount, window, bucketSeconds, nowSeconds, then one limit per key.
 * Per key: drop sub-buckets older than the window (HDEL), sum the rest, note
 * the oldest live sub-bucket. Only if EVERY key has room for `amount` is
 * each charged (HINCRBY on the current sub-bucket + EXPIRE window+bucket,
 * so an idle key disappears on its own). Reply: `{ok, used1, oldest1,
 * used2, oldest2, …}` where oldest is -1 for an empty bucket.
 *
 * `now` comes from the caller, not Redis `TIME`: a script that writes after
 * a non-deterministic read is refused by script-replicating Redis versions,
 * and the adapter's clock is what the tests can drive. A few seconds of skew
 * between API instances shifts a sub-bucket boundary by those seconds.
 */
export const ALLOWANCE_SCRIPT = `
local amount = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local bucket = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local cur = math.floor(now / bucket)
local span = math.floor(window / bucket)
local oldest = cur - span
local used = {}
local first = {}
local ok = 1
for i = 1, #KEYS do
  local fields = redis.call('HGETALL', KEYS[i])
  local sum = 0
  local minb = -1
  for j = 1, #fields, 2 do
    local b = tonumber(fields[j])
    if b == nil or b < oldest then
      redis.call('HDEL', KEYS[i], fields[j])
    else
      sum = sum + tonumber(fields[j + 1])
      if minb < 0 or b < minb then minb = b end
    end
  end
  used[i] = sum
  first[i] = minb
  if sum + amount > tonumber(ARGV[4 + i]) then ok = 0 end
end
if ok == 1 and amount > 0 then
  for i = 1, #KEYS do
    redis.call('HINCRBY', KEYS[i], cur, amount)
    redis.call('EXPIRE', KEYS[i], window + bucket)
    used[i] = used[i] + amount
    if first[i] < 0 then first[i] = cur end
  end
end
local out = { ok }
for i = 1, #KEYS do
  out[#out + 1] = used[i]
  out[#out + 1] = first[i]
end
return out
`;

/**
 * Hand back units charged by ALLOWANCE_SCRIPT (`RateLimitPort.refundAllowance`).
 * ARGV: amount, bucketSeconds, nowSeconds. Per key: decrement the CURRENT
 * sub-bucket by `amount`, clamped at 0 (a field at 0 is deleted). Never
 * touches older sub-buckets and never goes negative, so a refund can't mint
 * capacity the key didn't spend this sub-bucket.
 */
export const REFUND_ALLOWANCE_SCRIPT = `
local amount = tonumber(ARGV[1])
local bucket = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cur = tostring(math.floor(now / bucket))
for i = 1, #KEYS do
  local v = tonumber(redis.call('HGET', KEYS[i], cur))
  if v ~= nil then
    local left = v - amount
    if left > 0 then
      redis.call('HSET', KEYS[i], cur, left)
    else
      redis.call('HDEL', KEYS[i], cur)
    end
  end
end
return 1
`;

/** Sub-bucket size for a rolling window: 1/24 of it, at least a second. */
export function allowanceBucketSeconds(windowSeconds: number): number {
  return Math.max(1, Math.floor(windowSeconds / 24));
}

/**
 * Fixed-window rate limiter backed by an atomic Redis Lua script.
 *
 * Each unique key gets a Redis counter that auto-expires after the window.
 * A new key's increment and expire happen in the same `EVAL`, and a key found
 * without a TTL is healed on its next denied hit (see `CONSUME_SCRIPT`).
 */
export class RedisRateLimitAdapter implements RateLimitPort {
  constructor(
    private readonly redis: Redis,
    /** Key prefix to namespace rate-limit counters (e.g. "rl"). */
    private readonly prefix = "rl",
    /** Wall clock in ms for `consumeAllowance` (tests drive it). */
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  private key(raw: string): string {
    return `${this.prefix}:${raw}`;
  }

  async consume(
    rawKey: string,
    maxTokens: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const [result] = await this.consumeMany([
      { key: rawKey, maxTokens, windowSeconds },
    ]);
    return result!;
  }

  async consumeMany(
    entries: ReadonlyArray<RateLimitEntry>,
  ): Promise<RateLimitResult[]> {
    if (entries.length === 0) return [];

    // One atomic round-trip for every bucket: bump each counter, set the
    // expiry on a new key, and read the TTL only for a denied key (healing it
    // if orphaned). ARGV is `window, max` per key, in key order.
    const reply = (await this.redis.eval(
      CONSUME_SCRIPT,
      entries.length,
      ...entries.map((entry) => this.key(entry.key)),
      ...entries.flatMap((entry) => [entry.windowSeconds, entry.maxTokens]),
    )) as number[];

    return entries.map((entry, i) =>
      toResult(
        Number(reply[i * 2]),
        Number(reply[i * 2 + 1]),
        entry.maxTokens,
        entry.windowSeconds,
      ),
    );
  }

  async consumeAllowance(input: {
    entries: ReadonlyArray<AllowanceEntry>;
    amount: number;
    windowSeconds: number;
  }): Promise<AllowanceResult> {
    const { entries, amount, windowSeconds } = input;
    if (entries.length === 0) return { allowed: true, results: [] };
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error("rate_limit_allowance_bad_amount");
    }
    const bucketSeconds = allowanceBucketSeconds(windowSeconds);
    const span = Math.floor(windowSeconds / bucketSeconds);
    const nowSeconds = Math.floor(this.nowMs() / 1000);

    const reply = (await this.redis.eval(
      ALLOWANCE_SCRIPT,
      entries.length,
      ...entries.map((entry) => this.key(entry.key)),
      amount,
      windowSeconds,
      bucketSeconds,
      nowSeconds,
      ...entries.map((entry) => entry.limit),
    )) as number[];

    const allowed = Number(reply[0]) === 1;
    return {
      allowed,
      results: entries.map((entry, i) => {
        const used = Number(reply[1 + i * 2]);
        const oldest = Number(reply[2 + i * 2]);
        const remaining = Math.max(0, entry.limit - used);
        const fits = used + (allowed ? 0 : amount) <= entry.limit;
        const retryAfterSeconds =
          fits || oldest < 0
            ? 0
            : // Sub-bucket `oldest` leaves once cur > oldest + span.
              Math.max(1, (oldest + span + 1) * bucketSeconds - nowSeconds);
        return { remaining, retryAfterSeconds };
      }),
    };
  }

  async refundAllowance(input: {
    entries: ReadonlyArray<Pick<AllowanceEntry, "key">>;
    amount: number;
    windowSeconds: number;
  }): Promise<void> {
    const { entries, amount, windowSeconds } = input;
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error("rate_limit_allowance_bad_amount");
    }
    if (entries.length === 0 || amount === 0) return;
    await this.redis.eval(
      REFUND_ALLOWANCE_SCRIPT,
      entries.length,
      ...entries.map((entry) => this.key(entry.key)),
      amount,
      allowanceBucketSeconds(windowSeconds),
      Math.floor(this.nowMs() / 1000),
    );
  }

  async peek(rawKeys: ReadonlyArray<string>): Promise<number[]> {
    if (rawKeys.length === 0) return [];

    // One MGET for every key: a read, so no Lua and no TTL repair. An absent
    // (never hit or expired) key comes back null and reads as 0.
    const reply = await this.redis.mget(
      ...rawKeys.map((raw) => this.key(raw)),
    );
    return rawKeys.map((_, i) => toCount(reply[i]));
  }
}

function toCount(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toResult(
  count: number,
  ttl: number,
  maxTokens: number,
  windowSeconds: number,
): RateLimitResult {
  if (count > maxTokens) {
    // Over the limit. Report the real TTL, falling back to the full window
    // when it is not positive. That does happen: Redis rounds TTL to the
    // nearest second, so a denied key with under ~500ms left replies 0 (an
    // orphan already comes back as the window).
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  }

  return {
    allowed: true,
    remaining: maxTokens - count,
    retryAfterSeconds: 0,
  };
}
