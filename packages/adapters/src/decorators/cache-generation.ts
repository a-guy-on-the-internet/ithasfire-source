import { randomInt } from "node:crypto";

import type { LoggerPort } from "@th/ports/logger";
import type { CacheGenerationPort } from "@th/ports/read-through-cache";
import type { ReporterPort } from "@th/ports/reporter";

/**
 * Redis key (under the client's REDIS_NAMESPACE `keyPrefix`) of the shared
 * "public read models changed" generation. One key for the API and jobs.
 */
export const PUBLIC_READ_GENERATION_KEY = "cache:public-reads:generation";

/** Where the shared counter lives. */
export interface CacheGenerationStore {
  /** Current value. Never null: a missing key is seeded (see below). */
  read(): Promise<string>;
  /** Advance and return the new value. */
  bump(): Promise<string>;
}

/** The minimal ioredis surface the store needs (EVAL = one command). */
export interface RedisLikeForGeneration {
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

// Both scripts seed a MISSING key with a random base before touching it. A
// counter that restarted at 0 after an eviction or flush would walk back
// through values instances have already tagged entries with (ABA) and make a
// pre-flush entry look current again. A random 47-bit base makes a repeat
// vanishingly unlikely. Each script is a single command (Upstash counts EVAL
// as one), and atomic.
const READ_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if not v then
  redis.call('SET', KEYS[1], ARGV[1])
  v = ARGV[1]
end
return v`;
const BUMP_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], ARGV[1])
end
return redis.call('INCR', KEYS[1])`;

const randomBase = () => randomInt(1, 2 ** 47);

/** Redis-backed counter. The client's `keyPrefix` applies to `key`. */
export function createRedisCacheGenerationStore(
  redis: RedisLikeForGeneration,
  key: string = PUBLIC_READ_GENERATION_KEY,
): CacheGenerationStore {
  return {
    read: async () => String(await redis.eval(READ_SCRIPT, 1, key, randomBase())),
    bump: async () => String(await redis.eval(BUMP_SCRIPT, 1, key, randomBase())),
  };
}

export interface CacheGenerationOptions {
  store: CacheGenerationStore;
  /**
   * Store failures are reported here. Pass a THROTTLED reporter
   * (`createThrottledReporter`): during a Redis outage this fires on every
   * failed read/bump. Tags are low-cardinality (`area`, `op`).
   */
  reportError?: ReporterPort;
  logger?: LoggerPort;
  now?: () => number;
}

export interface CacheGenerationSource {
  /**
   * Advance the generation after a committed write. Moves every reader on
   * THIS instance synchronously (before the promise settles), then INCRs the
   * store. Never rejects: a store failure is reported, and this instance
   * stays fresh because its local epoch moved.
   *
   * Coalesced: at most one INCR in flight; bumps that arrive meanwhile share
   * ONE trailing INCR that starts after the in-flight one settles — i.e.
   * after their writes — so no write is ever covered only by an INCR that
   * began before it.
   */
  bump(reason: string): Promise<void>;
  /**
   * A memoized view for one cache. `memoMs` is that cache's cross-instance
   * staleness after a write AND its cap on store reads (one per `memoMs` per
   * instance, only when the cache is consulted — no timers).
   */
  reader(memoMs: number): CacheGenerationPort;
}

/**
 * The shared generation for one process.
 *
 * A reader's `current()` is `"<shared counter>#<local epoch>"`. The local
 * epoch moves on every `bump()` on this instance, so the writing instance
 * stops serving pre-write entries at once — even if the INCR then fails
 * (reported; other instances fall back to their TTL).
 *
 * A store read that fails resolves `null` ("unknown") for the rest of that
 * reader's memo window: the cache reads fresh and stores nothing.
 *
 * ## After an outage
 *
 * While the store is unreachable, another instance's write can land with its
 * INCR failing, so the shared counter comes back UNCHANGED. Every entry this
 * instance tagged before the outage would then match again. So any store
 * failure (read or INCR) marks the process, and the next SUCCESSFUL store
 * read advances the local epoch before tagging: everything cached before the
 * outage misses, on every reader, once. No timer.
 *
 * A failed INCR is also OWED: it is sent again with the next successful store
 * read on this instance (or superseded by the next bump), so instances that
 * saw no traffic during the outage — and therefore never saw a failure — still
 * learn of the write once the writer is consulted again. Residual: if the
 * writer is never consulted again after the store recovers and another
 * instance never saw the outage, that instance's bound is its cache TTL.
 */
export function createCacheGeneration(
  options: CacheGenerationOptions,
): CacheGenerationSource {
  const { store, reportError, logger } = options;
  const now = options.now ?? Date.now;

  let epoch = 0;
  /** Readers to update when an INCR lands. */
  const onBumped = new Set<(value: string) => void>();

  let incrInFlight: Promise<void> | null = null;
  let trailing: { promise: Promise<void>; reasons: Set<string> } | null = null;
  /** A store call failed since the last successful read (see header). */
  let storeFailedSinceRead = false;
  /** Reasons of INCRs that failed and have not been re-sent. */
  let owed: Set<string> | null = null;

  const report = (err: unknown, op: "read" | "bump", reason?: string) => {
    try {
      logger?.warn("cache_generation.store_failed", { op, reason, err });
      reportError?.(err, {
        tags: { area: "cache-generation", op },
        extra: reason ? { reason } : undefined,
      });
    } catch {
      // Best-effort reporting.
    }
  };

  const incr = (reasons: Set<string>): Promise<void> => {
    const run: Promise<void> = Promise.resolve()
      .then(() => store.bump())
      .then(
        (value) => {
          // Any successful INCR moves the shared counter, which is all an
          // owed one needed to do.
          owed = null;
          for (const update of onBumped) update(value);
        },
        (err: unknown) => {
          storeFailedSinceRead = true;
          owed = new Set([...(owed ?? []), ...reasons]);
          report(err, "bump", [...reasons].join(","));
        },
      )
      .finally(() => {
        if (incrInFlight === run) incrInFlight = null;
      });
    incrInFlight = run;
    return run;
  };

  /** Coalesced INCR (see `CacheGenerationSource.bump`), without the epoch. */
  const requestIncr = (reason: string): Promise<void> => {
    if (!incrInFlight) return incr(new Set([reason]));
    if (trailing) {
      trailing.reasons.add(reason);
      return trailing.promise;
    }
    const reasons = new Set([reason]);
    const promise = incrInFlight.then(() => {
      trailing = null;
      return incr(reasons);
    });
    trailing = { promise, reasons };
    return promise;
  };

  const bump = (reason: string): Promise<void> => {
    epoch += 1;
    return requestIncr(reason);
  };

  /** Called on every successful store read, before the value is tagged. */
  const onStoreReachable = () => {
    if (storeFailedSinceRead) {
      storeFailedSinceRead = false;
      // Entries tagged before the outage must not match again.
      epoch += 1;
    }
    if (owed) {
      const reasons = [...owed];
      owed = null;
      void requestIncr(`owed:${reasons.join(",")}`);
    }
  };

  const reader = (memoMs: number): CacheGenerationPort => {
    let memo: { value: string | null; at: number } | null = null;
    let inFlight: Promise<string | null> | null = null;
    /** Bumped when an INCR lands; a store read that spans one is discarded. */
    let landed = 0;

    // The local epoch in the tag is what makes a bump take effect here at
    // once; the shared value is what carries it to other instances.
    const tag = (value: string | null) =>
      value === null ? null : `${value}#${epoch}`;

    onBumped.add((value) => {
      memo = { value, at: now() };
      landed += 1;
      inFlight = null;
    });

    return {
      current(): Promise<string | null> {
        if (memo && now() - memo.at < memoMs) {
          return Promise.resolve(tag(memo.value));
        }
        if (inFlight) return inFlight;

        const startedIn = landed;
        const request: Promise<string | null> = Promise.resolve()
          .then(() => store.read())
          .then(
            (value) => {
              onStoreReachable();
              if (startedIn === landed) memo = { value, at: now() };
              return tag(value);
            },
            (err: unknown) => {
              storeFailedSinceRead = true;
              report(err, "read");
              if (startedIn === landed) memo = { value: null, at: now() };
              return null;
            },
          )
          .finally(() => {
            if (inFlight === request) inFlight = null;
          });
        inFlight = request;
        return request;
      },
      bump,
    };
  };

  return { bump, reader };
}
