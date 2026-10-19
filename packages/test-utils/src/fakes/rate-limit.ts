import type {
  RateLimitEntry,
  RateLimitPort,
  RateLimitResult,
} from "@th/ports/rate-limit";

type Consume = RateLimitPort["consume"];

/**
 * A `consumeMany` built from a fake's `consume`: calls it once per entry, in
 * input order, and returns the results in the same order. Matches the port
 * contract (every bucket charged, no short-circuit), so `consume.mock.calls`
 * still records every key the guard charged, the same as before `consumeMany`
 * existed.
 *
 * Without it, a fake that only has `consume` makes `defaultRateLimit` throw a
 * TypeError, which the guard's fail-open path swallows. The request succeeds
 * and the default limits silently stop being tested.
 */
export function consumeManyVia(consume: Consume): RateLimitPort["consumeMany"] {
  return async (entries: ReadonlyArray<RateLimitEntry>) => {
    const results: RateLimitResult[] = [];
    for (const entry of entries) {
      results.push(
        await consume(entry.key, entry.maxTokens, entry.windowSeconds),
      );
    }
    return results;
  };
}

/**
 * A `peek` for a fake that does not track counts: every key reads as 0 (never
 * failed, never hit). Code that gates on a peeked count therefore behaves as it
 * did before `peek` existed, and a `{ consume }`-only fake does not throw a
 * TypeError into a fail-open path the test never meant to exercise. Use
 * `createInMemoryRateLimit` when the test needs real counts.
 */
export const peekZeros: RateLimitPort["peek"] = async (keys) =>
  keys.map(() => 0);

/**
 * Adds `peek` (reading every key as 0, see `peekZeros`) to a fake that lacks
 * one. Leaves an existing `peek` alone. Returns the same object.
 */
export function withPeek<T extends object>(
  fake: T,
): T & Pick<RateLimitPort, "peek"> {
  if (typeof (fake as { peek?: unknown }).peek === "function") {
    return fake as T & Pick<RateLimitPort, "peek">;
  }
  return Object.assign(fake, { peek: peekZeros });
}

/**
 * Adds `consumeMany` (via `consumeManyVia`) to a `{ consume }` fake, plus a
 * zero-reading `peek` if it has none (see `withPeek`). Returns the same object
 * so existing `fake.consume` references and spies keep working.
 */
export function withConsumeMany<T extends { consume: Consume }>(
  fake: T,
): T & Pick<RateLimitPort, "consumeMany" | "peek"> {
  return withPeek(
    Object.assign(fake, { consumeMany: consumeManyVia(fake.consume) }),
  );
}

/**
 * In-memory fixed-window `RateLimitPort` with real counting, for tests that
 * need limits to actually trip. A window starts at a key's first hit and
 * resets `windowSeconds` later, measured with the injected `now` (ms).
 */
export function createInMemoryRateLimit(opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const consume: Consume = async (key, maxTokens, windowSeconds) => {
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + windowSeconds * 1000 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maxTokens) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - t) / 1000)),
      };
    }
    return {
      allowed: true,
      remaining: maxTokens - bucket.count,
      retryAfterSeconds: 0,
    };
  };

  // Rolling allowance log per key: every charge with its time (ms). Exact
  // rolling window (the Redis adapter rounds to 1/24 of it).
  const charges = new Map<string, Array<{ at: number; amount: number }>>();
  const consumeAllowance: RateLimitPort["consumeAllowance"] = async ({
    entries,
    amount,
    windowSeconds,
  }) => {
    const t = now();
    const windowMs = windowSeconds * 1000;
    const live = entries.map((entry) => {
      const kept = (charges.get(entry.key) ?? []).filter(
        (c) => c.at > t - windowMs,
      );
      charges.set(entry.key, kept);
      return kept;
    });
    const used = live.map((kept) => kept.reduce((n, c) => n + c.amount, 0));
    const allowed = entries.every((entry, i) => used[i]! + amount <= entry.limit);
    if (allowed && amount > 0) {
      for (const kept of live) kept.push({ at: t, amount });
    }
    return {
      allowed,
      results: entries.map((entry, i) => {
        const after = used[i]! + (allowed ? amount : 0);
        const fits = used[i]! + amount <= entry.limit;
        const oldest = live[i]![0];
        return {
          remaining: Math.max(0, entry.limit - after),
          retryAfterSeconds:
            fits || !oldest
              ? 0
              : Math.max(1, Math.ceil((oldest.at + windowMs - t) / 1000)),
        };
      }),
    };
  };

  // Refund: take `amount` back from the newest charges, never below 0 (the
  // Redis adapter decrements the current sub-bucket, clamped at 0).
  const refundAllowance: RateLimitPort["refundAllowance"] = async ({
    entries,
    amount,
  }) => {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error("rate_limit_allowance_bad_amount");
    }
    for (const entry of entries) {
      const log = charges.get(entry.key) ?? [];
      let left = amount;
      for (let i = log.length - 1; i >= 0 && left > 0; i--) {
        const take = Math.min(left, log[i]!.amount);
        log[i]!.amount -= take;
        left -= take;
      }
      charges.set(
        entry.key,
        log.filter((c) => c.amount > 0),
      );
    }
  };

  /** Units charged to an allowance key within its last window. */
  const allowanceUsed = (key: string, windowSeconds: number): number =>
    (charges.get(key) ?? [])
      .filter((c) => c.at > now() - windowSeconds * 1000)
      .reduce((n, c) => n + c.amount, 0);

  const count = (key: string): number => {
    const bucket = buckets.get(key);
    return bucket && bucket.resetAt > now() ? bucket.count : 0;
  };

  return {
    consume,
    consumeMany: consumeManyVia(consume),
    consumeAllowance,
    refundAllowance,
    allowanceUsed,
    /** Current counts, without consuming (0 if never hit or expired). */
    peek: async (keys: ReadonlyArray<string>) => keys.map(count),
    /** Current count for a key (0 if never hit or expired). */
    count,
    /** Every key seen so far. */
    keys(): string[] {
      return [...buckets.keys()];
    },
  } satisfies RateLimitPort & Record<string, unknown>;
}
