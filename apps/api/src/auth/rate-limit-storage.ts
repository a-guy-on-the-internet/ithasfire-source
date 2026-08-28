import Redis from "ioredis";
import type { RateLimit } from "better-auth";

import { createPinoLoggerAdapter } from "@th/adapters/infra/logger";
import type { ReporterPort } from "@th/ports/reporter";
import { createThrottledReporter } from "@th/core/lib/throttled-reporter";

import { env } from "../lib/env";

/**
 * Redis-backed storage for Better Auth's built-in rate limiter
 * (`rateLimit.customStorage`), so auth rate limits are enforced
 * **cross-instance** instead of per-process.
 *
 * Why `customStorage` and not `storage: "secondary-storage"`: the latter
 * requires a root-level `secondaryStorage` option, and Better Auth also uses
 * `secondaryStorage` for session caching when present — a side effect we do
 * not want. `customStorage` (supported and typed in better-auth 1.6.9; when
 * set, `rateLimit.storage` is ignored) hooks ONLY the rate limiter.
 *
 * Fail-open contract (mirrors `consumeRateLimitOrAllow` in
 * `packages/transport/trpc/src/guard.ts`): Redis must never be a single
 * point of total-API-outage. Better Auth does NOT catch storage errors —
 * a throw from `get`/`set` would propagate out of `onRequestRateLimit` /
 * `onResponseRateLimit` and fail every auth request. So every Redis call
 * here is wrapped: `get` errors return `null` (= no prior requests, allow)
 * and `set` errors are swallowed, both logged.
 */

/** Minimal slice of the ioredis client this storage needs (test seam). */
export type RateLimitRedisLike = {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    secondsToken: "EX",
    seconds: number,
  ): Promise<unknown>;
};

type RateLimitLogger = {
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
};

export type BetterAuthRateLimitStorage = {
  get: (key: string) => Promise<RateLimit | null>;
  set: (key: string, value: RateLimit, update?: boolean) => Promise<void>;
};

/**
 * Namespace prefix so Better Auth keys (`<ip>|<path>`) can't collide with
 * the tRPC rate limiter's keys on the shared Redis instance.
 */
const KEY_PREFIX = "bauth:rl:";

/**
 * Better Auth's `customStorage` hook does NOT receive the rule's window —
 * only the built-in wrappers get it — so this storage manages TTL itself.
 * The TTL only needs to be >= the largest configured window (60s across
 * `better-auth.ts` customRules and the global floor; built-in special rules
 * use 10s/60s) for limiting to be correct: `shouldRateLimit` compares
 * against `lastRequest`, so an entry that outlives its window is inert and
 * the counter resets on the next request. 2x margin keeps keys from
 * lingering while staying safely above every window.
 *
 * INVARIANT (referenced at the `customStorage:` wiring in `better-auth.ts`):
 * every rate-limit window — customRules, the global floor, and rules shipped
 * by Better Auth plugins/upgrades — must stay <= this value. A window longer
 * than the TTL silently under-limits: the Redis key expires mid-window and
 * the counter restarts from zero.
 */
export const DEFAULT_TTL_SECONDS = 120;

/**
 * Redis outage here disables auth rate limiting ENTIRELY (see the fail-open
 * contract note above) — the most severe fail-open path in the codebase.
 * Throttle Sentry reports to one per branch per window rather than either
 * spamming one event per auth request or going silent after the first (the
 * same class of gap behind the 2026-06 4-day silent search outage).
 */
const AUTH_RATE_LIMIT_REPORT_THROTTLE_MS = 15 * 60 * 1000;

function isRateLimitRecord(value: unknown): value is RateLimit {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    key?: unknown;
    count?: unknown;
    lastRequest?: unknown;
  };
  return (
    typeof record.key === "string" &&
    typeof record.count === "number" &&
    typeof record.lastRequest === "number"
  );
}

export function createRedisRateLimitStorage(opts: {
  redis: RateLimitRedisLike;
  logger?: RateLimitLogger;
  keyPrefix?: string;
  ttlSeconds?: number;
  /**
   * Optional best-effort error reporter (wired to `Sentry.captureException`
   * at the composition root — see `auth/deps.ts` / `lib/dep.ts`). Fired,
   * throttled, on every fail-open branch below so a Redis outage that
   * silently disables auth rate limiting stops being invisible in Sentry.
   */
  reportError?: ReporterPort;
}): BetterAuthRateLimitStorage {
  const logger = opts.logger ?? createPinoLoggerAdapter();
  const keyPrefix = opts.keyPrefix ?? KEY_PREFIX;
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const reportFailure = createThrottledReporter(
    opts.reportError,
    AUTH_RATE_LIMIT_REPORT_THROTTLE_MS,
  );

  return {
    get: async (key) => {
      try {
        const raw = await opts.redis.get(`${keyPrefix}${key}`);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!isRateLimitRecord(parsed)) {
          logger.warn("auth_rate_limit_storage_malformed_record", { key });
          try {
            reportFailure(
              new Error("auth_rate_limit_storage_malformed_record"),
              {
                tags: {
                  area: "auth_rate_limit_fail_open",
                  branch: "malformed_record",
                },
                extra: { key },
              },
            );
          } catch {
            // Reporting is best-effort — a throwing reporter must never
            // turn the fail-open allow into a thrown error.
          }
          return null;
        }
        return parsed;
      } catch (err) {
        // Fail open: no data = no prior requests = request allowed.
        logger.warn("auth_rate_limit_storage_get_failed", {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          reportFailure(err, {
            tags: { area: "auth_rate_limit_fail_open", branch: "get" },
            extra: {
              key,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        } catch {
          // Reporting is best-effort — a throwing reporter must never turn
          // the fail-open allow into a thrown error.
        }
        return null;
      }
    },
    set: async (key, value) => {
      try {
        await opts.redis.set(
          `${keyPrefix}${key}`,
          JSON.stringify(value),
          "EX",
          ttlSeconds,
        );
      } catch (err) {
        // Fail open: dropping the counter update just under-counts.
        logger.warn("auth_rate_limit_storage_set_failed", {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          reportFailure(err, {
            tags: { area: "auth_rate_limit_fail_open", branch: "set" },
            extra: {
              key,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        } catch {
          // Reporting is best-effort — a throwing reporter must never turn
          // the fail-open swallow into a thrown error.
        }
      }
    },
  };
}

/**
 * Lazily constructs a dedicated ioredis client for the auth rate limiter.
 *
 * Why not the `buildDeps()` client from `lib/dep.ts`: `auth` is created at
 * module import time (`export const auth = betterAuth({...})`), before —
 * and independently of — the async `buildDeps()` wiring, whose Redis client
 * lives and dies inside the returned `AppDeps`. Threading it in would mean
 * turning `auth` into a factory and rewiring every importer. One extra
 * connection per instance is trivial next to that refactor.
 *
 * `lazyConnect` means merely importing the auth module (e.g. in unit tests)
 * opens no socket; the connection is established on the first auth request.
 * If Redis is unreachable (or `REDIS_URL` is unset in some test context),
 * commands reject fast — bounded by `commandTimeout`/`maxRetriesPerRequest`,
 * same settings as the `dep.ts` client — and the storage wrapper above
 * fails open, so auth keeps working without rate limiting rather than
 * crashing. Production boot still hard-requires `REDIS_URL` via
 * `buildDeps()`; the localhost fallback here matches `dep.ts` dev behavior.
 */
let lazyClient: Redis | null = null;

function getAuthRateLimitRedis(): Redis {
  if (!lazyClient) {
    // Publish to `lazyClient` only after the error listener is attached: if
    // any construction step throws, the retry path must rebuild from scratch
    // rather than cache a listener-less client whose later 'error' events
    // would crash the process unhandled.
    const logger = createPinoLoggerAdapter();
    const redisUrl = env.REDIS_URL ?? "redis://localhost:6379";
    const client = new Redis(redisUrl, {
      commandTimeout: 500,
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });
    // Without a listener ioredis emits unhandled 'error' events when the
    // connection drops; the storage wrapper already logs per-command
    // failures, so this just needs to exist (log for connection-level
    // visibility, mirroring dep.ts).
    client.on("error", (err) => {
      logger.warn("auth_rate_limit_redis_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    lazyClient = client;
  }
  return lazyClient;
}

/**
 * Default storage instance wired into `better-auth.ts`. The Redis client is
 * created on first `get`/`set` (i.e. first auth request), not at import.
 *
 * The lazy-init path itself is inside the fail-open envelope: a synchronous
 * throw from the ioredis constructor (or logger construction) would
 * otherwise propagate into Better Auth's `onRequestRateLimit` — which has
 * no try/catch — and 500 every auth request. On init failure this degrades
 * to no-op storage (get → null, set → void), logs once (best-effort; the
 * log call itself is guarded), and retries init on the next call in case
 * the failure was transient.
 */
export function createBetterAuthRateLimitStorage(opts?: {
  /**
   * Optional best-effort error reporter (wired to `Sentry.captureException`
   * at the composition root — see `auth/deps.ts` / `lib/dep.ts`). Threaded
   * through to `createRedisRateLimitStorage` for the `get`/`set` branches,
   * and used directly here for the init-failure branch.
   */
  reportError?: ReporterPort;
}): BetterAuthRateLimitStorage {
  let storage: BetterAuthRateLimitStorage | null = null;
  let warnedInitFailure = false;
  const reportInitFailure = createThrottledReporter(
    opts?.reportError,
    AUTH_RATE_LIMIT_REPORT_THROTTLE_MS,
  );
  const resolve = (): BetterAuthRateLimitStorage | null => {
    if (storage) return storage;
    try {
      storage = createRedisRateLimitStorage({
        redis: getAuthRateLimitRedis(),
        reportError: opts?.reportError,
      });
      return storage;
    } catch (err) {
      if (!warnedInitFailure) {
        warnedInitFailure = true;
        try {
          createPinoLoggerAdapter().warn(
            "auth_rate_limit_storage_init_failed",
            { error: err instanceof Error ? err.message : String(err) },
          );
        } catch {
          // Nothing safe left to do — stay silent rather than throw into
          // the auth request path.
        }
      }
      try {
        reportInitFailure(err, {
          tags: { area: "auth_rate_limit_fail_open", branch: "init" },
          extra: { error: err instanceof Error ? err.message : String(err) },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never turn
        // the no-op storage fallback into a thrown error.
      }
      return null;
    }
  };
  return {
    get: async (key) => {
      const resolved = resolve();
      return resolved ? resolved.get(key) : null;
    },
    set: async (key, value, update) => {
      const resolved = resolve();
      if (resolved) await resolved.set(key, value, update);
    },
  };
}
