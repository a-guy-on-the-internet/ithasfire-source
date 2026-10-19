import type { LoggerPort } from "@th/ports/logger";
import type {
  CacheGenerationPort,
  ReadThroughCachePort,
} from "@th/ports/read-through-cache";
import type { ReporterPort } from "@th/ports/reporter";

/**
 * In-memory, per-instance implementation of `ReadThroughCachePort`.
 *
 * ## Why
 *
 * Production Neon bills per awake compute-hour and suspends after ~5 minutes
 * idle. The uptime check renders the home page roughly every 50 seconds, and
 * every render used to read `Event`, `SearchDocument`, `TicketType`, `Place`
 * and the moderation table, so the database never slept even with no real
 * traffic. The API instance itself stays warm (the same uptime check keeps it
 * up), so an in-process cache survives between those renders and lets the
 * database go idle.
 *
 * ## Semantics
 *
 * - **Fresh**: `age < ttlMs` AND (with a `generation`) the entry's generation
 *   equals `generation.current()`. Served from memory, no load.
 * - **Miss, expired or generation moved**: one `load` per key and generation,
 *   shared by every concurrent caller (single-flight). Success stores the
 *   value tagged with the generation read BEFORE the load, so a write that
 *   commits mid-load is caught on the next check.
 * - **Generation unknown** (`current()` → null, the shared store is down):
 *   read fresh, store nothing. Fail toward fresh, never toward a stale entry.
 * - **Load fails**: nothing is stored. If `staleIfErrorMs > 0` and an entry of
 *   the SAME generation is younger than `ttlMs + staleIfErrorMs`, it is served
 *   and the failure is reported through `reportError` (a deliberate swallow).
 *   Otherwise the error is rethrown and the caller behaves exactly as it did
 *   without a cache. An entry from an older generation is never served: a
 *   generation bump can mean "this was made more private".
 * - **Bounded**: at most `maxEntries` keys, least-recently-used evicted first.
 * - **`clear()`** drops every entry and detaches in-flight loads.
 */
export interface TtlReadThroughCacheOptions {
  /** Label for logs and Sentry tags, e.g. `"public-discovery"`. */
  name: string;
  /** How long an entry is served without reloading. */
  ttlMs: number;
  /**
   * Cross-instance invalidation. Absent → TTL is the only bound (tests,
   * single-process use).
   */
  generation?: CacheGenerationPort;
  /**
   * How long past `ttlMs` an entry may still be served when a reload fails.
   * Defaults to 0 (never serve stale).
   */
  staleIfErrorMs?: number;
  /** Maximum number of keys held. Defaults to 100. */
  maxEntries?: number;
  reportError?: ReporterPort;
  logger?: LoggerPort;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 100;
/** Generation used when no `generation` port is configured. */
const STATIC_GENERATION = "static";

type Entry = { value: unknown; storedAt: number; generation: string };

export function createTtlReadThroughCache(
  options: TtlReadThroughCacheOptions,
): ReadThroughCachePort {
  const { name, ttlMs, reportError, logger, generation } = options;
  const staleIfErrorMs = options.staleIfErrorMs ?? 0;
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = options.now ?? Date.now;

  // Map iteration order is insertion order, so re-inserting on every hit keeps
  // the least-recently-used key first.
  const entries = new Map<string, Entry>();
  /** Keyed by `key + generation` (or `key` + UNKNOWN for uncached reads). */
  const inFlight = new Map<string, Promise<unknown>>();
  // Bumped by `clear()`. A load compares the epoch it started under before
  // storing, so a pre-clear read cannot land after the clear.
  let clearEpoch = 0;

  const store = (key: string, value: unknown, gen: string) => {
    entries.delete(key);
    entries.set(key, { value, storedAt: now(), generation: gen });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  const serveStale = (key: string, gen: string, err: unknown): Entry | null => {
    if (staleIfErrorMs <= 0) return null;
    const entry = entries.get(key);
    if (!entry || entry.generation !== gen) return null;
    const ageMs = now() - entry.storedAt;
    if (ageMs >= ttlMs + staleIfErrorMs) return null;

    logger?.warn("read_through_cache.served_stale", {
      cache: name,
      key,
      ageMs,
      err,
    });
    try {
      reportError?.(err, {
        tags: { cache: name, fallback: "stale" },
        extra: { key, ageMs },
      });
    } catch {
      // Best-effort: a throwing reporter must not turn the stale fallback
      // into a failure.
    }
    return entry;
  };

  /** Single-flight `load`; stores the result under `gen` unless `gen` is null. */
  const run = <T>(
    key: string,
    gen: string | null,
    load: () => Promise<T>,
  ): Promise<T> => {
    const flightKey = `${key}\u0000${gen ?? "\u0000unknown"}`;
    const pending = inFlight.get(flightKey);
    if (pending) return pending as Promise<T>;

    const startedIn = clearEpoch;
    // `Promise.resolve().then(load)`: a loader that throws synchronously
    // becomes a rejection, and `finally` cannot run before `promise` exists.
    const promise: Promise<T> = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          if (gen !== null && startedIn === clearEpoch) store(key, value, gen);
          return value;
        },
        (err: unknown) => {
          const stale =
            gen !== null && startedIn === clearEpoch
              ? serveStale(key, gen, err)
              : null;
          if (stale) return stale.value as T;
          throw err;
        },
      )
      .finally(() => {
        if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey);
      });

    inFlight.set(flightKey, promise);
    return promise;
  };

  const lookup = <T>(key: string, gen: string, load: () => Promise<T>) => {
    const entry = entries.get(key);
    if (
      entry &&
      entry.generation === gen &&
      now() - entry.storedAt < ttlMs
    ) {
      entries.delete(key);
      entries.set(key, entry);
      return Promise.resolve(entry.value as T);
    }
    return run(key, gen, load);
  };

  return {
    getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
      if (!generation) return lookup(key, STATIC_GENERATION, load);
      return generation
        .current()
        // The port says `current()` never rejects; if an implementation
        // does, treat it as unknown — read fresh, store nothing — and report
        // it: this is a deliberate swallow (CLAUDE.md reporter rule).
        .catch((err: unknown) => {
          try {
            logger?.warn("read_through_cache.generation_failed", {
              cache: name,
              err,
            });
            reportError?.(err, { tags: { cache: name, fallback: "uncached" } });
          } catch {
            // Best-effort: reporting must not change the fallback.
          }
          return null;
        })
        .then((gen) =>
          gen === null ? run(key, null, load) : lookup(key, gen, load),
        );
    },

    clear(): void {
      entries.clear();
      inFlight.clear();
      clearEpoch += 1;
    },
  };
}
