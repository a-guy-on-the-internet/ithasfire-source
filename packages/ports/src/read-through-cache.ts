/**
 * In-process read-through cache for whole use-case results.
 *
 * A use case that accepts one of these as an optional dep wraps its own read
 * in `getOrLoad(key, load)`. The use case owns the KEY (it knows which inputs
 * change the answer) and decides which inputs are worth caching at all; the
 * composition root and transport decide WHETHER a request gets a cache — only
 * reads whose answer is a property of the resource, never of the caller,
 * should ever be handed one.
 *
 * Contract every implementation keeps:
 *
 * - A failed `load` is never stored. Callers either get the error or, if the
 *   implementation serves stale-on-error, the last good value (in which case
 *   the implementation reports the swallowed failure itself).
 * - Concurrent misses for one key share a single `load`.
 * - Values are shared between callers. Treat them as immutable.
 */
export interface ReadThroughCachePort {
  getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T>;
  /** Drop every entry on this instance. */
  clear(): void;
}

/**
 * Cross-process "has anything public changed?" signal for in-process caches.
 *
 * Writers call `bump()` after a committed write that can change a public read
 * model; caches tag each entry with `current()` at load time and treat a
 * different value as a miss. Every process shares one counter, so a write on
 * one instance (or process) reaches every instance's cache within the
 * implementation's memo window instead of at TTL expiry.
 */
export interface CacheGenerationPort {
  /**
   * The current generation, or `null` when it cannot be known (the shared
   * store is unreachable). Callers MUST treat `null` as "do not serve from
   * cache and do not store": read fresh.
   */
  current(): Promise<string | null>;
  /**
   * Advance the generation after a committed write. Takes effect on THIS
   * instance synchronously, before the returned promise settles. Never
   * rejects: a store failure is reported, and this instance stays fresh.
   */
  bump(reason: string): Promise<void>;
}
