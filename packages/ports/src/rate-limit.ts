/**
 * Fixed-window rate limiter port.
 *
 * Each call to `consume` decrements a token from the bucket identified by
 * `key`.  The bucket starts at `maxTokens` and resets after `windowSeconds`.
 *
 * Implementations are expected to be atomic (e.g., Redis INCR + EXPIRE).
 */
export interface RateLimitPort {
  /**
   * Try to consume one token from the bucket.
   *
   * @param key           Unique bucket identifier (e.g., `announce:send:<orgId>`).
   * @param maxTokens     Maximum requests allowed within the window.
   * @param windowSeconds Length of the rate-limit window in seconds.
   * @returns Whether the request is allowed and how many tokens remain.
   */
  consume(
    key: string,
    maxTokens: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;

  /**
   * Consume one token from EACH of several buckets in a single backend round
   * trip (for Redis: one `EVAL`, so it costs one billed command rather than N).
   *
   * Every entry has exactly the semantics of a standalone
   * `consume(entry.key, entry.maxTokens, entry.windowSeconds)`:
   *
   * - every bucket is incremented, including when an earlier entry is denied;
   *   there is no short-circuit and no rollback, so a denied request still
   *   spends a token from each bucket, the same as N separate `consume` calls;
   * - results come back in INPUT order, one per entry;
   * - keys are independent. Passing the same key twice increments it twice.
   *
   * Callers decide how to combine the results (e.g. deny if any entry is
   * denied). An empty `entries` array resolves to `[]` without touching the
   * backend.
   */
  consumeMany(
    entries: ReadonlyArray<RateLimitEntry>,
  ): Promise<RateLimitResult[]>;

  /**
   * Read each bucket's current count WITHOUT consuming a token, in ONE backend
   * round trip (for Redis: one `MGET`).
   *
   * - results come back in INPUT order, one number per key;
   * - a key that was never hit, or whose window has expired, reads as `0`;
   * - nothing is created, incremented, or re-expired.
   *
   * For "has this caller already failed N times?" checks that must not
   * themselves count as an attempt. An empty `keys` array resolves to `[]`
   * without touching the backend.
   */
  peek(keys: ReadonlyArray<string>): Promise<number[]>;

  /**
   * Charge `amount` units against EVERY bucket in `entries`, ALL OR NOTHING,
   * over a ROLLING window, in one atomic backend step. For allowances that
   * count things rather than calls (e.g. invite emails per 24h).
   *
   * - Each bucket's usage is the sum of what it was charged within the last
   *   `windowSeconds` (rolling, at a granularity of `windowSeconds / 24`).
   * - If `used + amount <= limit` holds for EVERY entry, every bucket is
   *   charged `amount` and `allowed` is true. Otherwise NOTHING is charged
   *   anywhere and `allowed` is false: no partial spend, unlike `consumeMany`.
   * - Results come back in INPUT order. `remaining` is `limit - used` after
   *   the call (so unchanged when denied). `retryAfterSeconds` is, for a
   *   bucket that cannot take `amount` now, the wait until its oldest charge
   *   leaves the window (it may take several such waits); 0 otherwise.
   * - `amount` 0 reads the buckets without charging. An empty `entries`
   *   resolves to `{ allowed: true, results: [] }` without touching the
   *   backend.
   */
  consumeAllowance(input: {
    entries: ReadonlyArray<AllowanceEntry>;
    amount: number;
    windowSeconds: number;
  }): Promise<AllowanceResult>;
  /**
   * Hand back `amount` units previously charged by `consumeAllowance` (the
   * work they paid for never happened). Decrements the CURRENT sub-bucket of
   * every key, clamped at 0, so a refund can never mint capacity beyond what
   * this sub-bucket holds. `windowSeconds` must match the charge (it sets
   * the sub-bucket size). Best effort: callers swallow and report failures.
   */
  refundAllowance(input: {
    entries: ReadonlyArray<Pick<AllowanceEntry, "key">>;
    amount: number;
    windowSeconds: number;
  }): Promise<void>;
}

/** One bucket for `RateLimitPort.consumeAllowance`. */
export type AllowanceEntry = {
  key: string;
  /** Units allowed within the rolling window. */
  limit: number;
};

export type AllowanceResult = {
  /** True when every bucket was charged; false when none was. */
  allowed: boolean;
  results: Array<{
    /** Units left in the window after this call. */
    remaining: number;
    /** Seconds until this bucket frees up some capacity (0 if it fit). */
    retryAfterSeconds: number;
  }>;
};

/** One bucket for `RateLimitPort.consumeMany`. Mirrors `consume`'s arguments. */
export type RateLimitEntry = {
  /** Unique bucket identifier (e.g., `global:<actor>`). */
  key: string;
  /** Maximum requests allowed within the window. */
  maxTokens: number;
  /** Length of the rate-limit window in seconds. */
  windowSeconds: number;
};

export type RateLimitResult = {
  /** Whether this request was allowed. */
  allowed: boolean;
  /** Tokens remaining in the current window (0 when denied). */
  remaining: number;
  /** Seconds until the window resets (useful for Retry-After headers). */
  retryAfterSeconds: number;
};
