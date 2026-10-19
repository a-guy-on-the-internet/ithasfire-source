// Idempotency with replayable results and atomic claim.
//
// DURABLE-LEDGER USERS. Most keys here live seconds to days. The lineup
// notices (core `use-cases/event-humans/notify-lineup-notices.ts`) keep
// `lineup-notice:{owed,sent,invite}:*` for TEN YEARS and
// `lineup-notice:recent:*` for 7 days: they are the only record that a
// person was already told, so "exactly once per lineup row" depends on them
// surviving. Switching IDEMPOTENCY_BACKEND (postgres <-> redis), changing an
// adapter's namespace, purging the table, or running Redis with an eviction
// policy other than `noeviction` silently drops that ledger — rows owed a
// notice are then never told, and a republish cannot tell sent from unsent.
// Same for `resale-claim-refunded-notice:*` (core
// `use-cases/resale/notify-claim-refunded.ts`, ten years): the only record
// that a buyer was told their claim refund went through.
// Migrate those keys (or accept the loss) before doing any of that.

export interface IdempotencyPort {
  /**
   * Try to acquire the key for work. True = you own it for ttlSec.
   *
   * `ownerToken` (optional) tags the in-progress claim with an opaque,
   * per-acquire token so it can later be freed via {@link release} ONLY by
   * the holder that acquired it. Mutex-style callers (see core's
   * `refund-mutex.ts`) MUST pass one — without it, a holder that stalls past
   * its TTL can resume and free a NEWER holder's live claim. Plain dedupe
   * callers may omit it.
   */
  begin(key: string, ttlSec?: number, ownerToken?: string): Promise<boolean>;

  /**
   * Store a successful result and mark the key as succeeded.
   *
   * Deliberately last-write-wins, NOT owner-checked (unlike {@link release}):
   * a holder that completed its work must be able to record the result even
   * if its claim expired mid-flight — losing the result would be worse than
   * overwriting a newer claim, which the winner's own commit then replays.
   */
  commit<T = unknown>(key: string, result: T, keepSec?: number): Promise<void>;

  /** Mark the key as failed (optional short retention). */
  fail(key: string, error?: string, keepSec?: number): Promise<void>;

  /**
   * Owner-checked release (atomic compare-and-delete) for mutex-style claims.
   *
   * Frees the key IFF it still holds the live in-progress claim carrying
   * `ownerToken` (as passed to {@link begin}), making it immediately
   * re-acquirable. Returns true when released; false — with the record left
   * UNTOUCHED — when the token does not match: the claim expired and a new
   * holder re-acquired it, or commit/fail replaced it. A false return tells
   * the caller it LOST the lock mid-flight and its work may have raced.
   *
   * MUST be atomic per backend (single conditional DELETE / Lua
   * compare-and-del) and MUST never affect committed/failed records.
   */
  release(key: string, ownerToken: string): Promise<boolean>;

  /** Get cached successful result, or null if none. */
  get<T = unknown>(key: string): Promise<T | null>;

  /**
   * Read-only status of a live (unexpired) record, or null when there is
   * none. Unlike {@link get} it also reports an IN-PROGRESS claim, and unlike
   * {@link begin} it never claims — so a caller can ask "is this key held?"
   * without racing the holder. Optional so existing fakes keep compiling;
   * callers must handle its absence.
   */
  status?(key: string): Promise<"in_progress" | "succeeded" | "failed" | null>;

  /**
   * Convenience: run fn only if not already completed.
   * If another run already committed a result, returns that.
   */
  run<T>(
    key: string,
    ttlSec: number,
    fn: () => Promise<T>,
    keepSec?: number,
  ): Promise<{ fresh: boolean; result: T }>;

  /**
   * Delete records whose retention window has passed. Returns how many were
   * removed, so a caller can loop until a run comes back short.
   *
   * Exists because expiry is only self-managing on SOME backends. Redis expires
   * keys itself (`EX` on write), so its implementation is a no-op returning 0.
   * A relational backend has no such mechanism: reads already filter on
   * `expiresAt`, so correctness holds without a sweep, but the rows accumulate
   * forever — and `resultJson` caches full success payloads, so the table grows
   * by the size of every committed checkout result.
   *
   * That asymmetry is a live footgun: prod moved from the Redis adapter to the
   * Prisma one on 2026-07-30 to escape an Upstash quota, and silently inherited
   * unbounded growth in the process. Any future backend must answer this
   * question explicitly rather than by omission.
   *
   * @param limit maximum records to delete in one call (bounded so a large
   *   backlog can't produce a single enormous statement).
   */
  purgeExpired(limit?: number): Promise<number>;
}

/* Example usage:
const k = `stripe_evt:${evt.id}`;
if (!(await idem.begin(k, 120))) {
  const prior = await idem.get<{ orderId: string }>(k);
  if (prior?.status === "succeeded") return prior;
  throw new Error("idempotent-op-in-progress");
}

try {
  const result = await finalize(...);
  await idem.commit(k, result);
} catch (e) {
  await idem.fail(k, e);
  throw e;
}
*/
