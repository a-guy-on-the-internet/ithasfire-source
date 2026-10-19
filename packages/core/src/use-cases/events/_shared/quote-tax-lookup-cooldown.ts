/**
 * A short in-process NEGATIVE cache for the quote path's tax-rate lookups.
 *
 * The event page and checkout fee preview look a venue's rate up live when
 * nothing is cached (owner ruling 2026-10-06). During a provider outage (a
 * ZipTax 108 spell, a timeout run) every page view of a venue would otherwise
 * re-ask the provider, wait up to the adapter's timeout, and fail again. After
 * a FAILED lookup the venue cools down for {@link QUOTE_TAX_LOOKUP_COOLDOWN_MS}:
 * quotes for it skip the provider and come back `lookup_failed` at once (no
 * all-in figure, as on a real failure).
 *
 * QUOTES ONLY. Checkout never consults this: it has its own bounded retries
 * and refuses with `TAX_RATE_UNAVAILABLE`, and a quote's failure must not stop
 * a buyer from trying to pay once the provider is back.
 *
 * Bounded: at most {@link QUOTE_TAX_LOOKUP_COOLDOWN_MAX_ENTRIES} venues are
 * remembered; the oldest entry goes first. Per process, reset on restart — the
 * point is "not on every page view", not fleet-wide coordination.
 */
export type QuoteTaxLookupCooldown = {
  /** True = a lookup for this venue failed within the cooldown window. */
  isCoolingDown(key: string, nowMs: number): boolean;
  /** Record a FAILED lookup for this venue. */
  noteFailure(key: string, nowMs: number): void;
};

export const QUOTE_TAX_LOOKUP_COOLDOWN_MS = 60_000;
export const QUOTE_TAX_LOOKUP_COOLDOWN_MAX_ENTRIES = 1_000;

export function createQuoteTaxLookupCooldown(
  options: { ttlMs?: number; maxEntries?: number } = {},
): QuoteTaxLookupCooldown {
  const ttlMs = options.ttlMs ?? QUOTE_TAX_LOOKUP_COOLDOWN_MS;
  const maxEntries = Math.max(
    1,
    options.maxEntries ?? QUOTE_TAX_LOOKUP_COOLDOWN_MAX_ENTRIES,
  );
  /** venue key → when its last failure happened. Insertion order = age. */
  const failedAt = new Map<string, number>();

  return {
    isCoolingDown(key, nowMs) {
      const at = failedAt.get(key);
      if (at === undefined) return false;
      if (nowMs - at < ttlMs) return true;
      failedAt.delete(key);
      return false;
    },
    noteFailure(key, nowMs) {
      // Re-insert so a repeat failure moves to the young end.
      failedAt.delete(key);
      failedAt.set(key, nowMs);
      while (failedAt.size > maxEntries) {
        const oldest = failedAt.keys().next().value;
        if (oldest === undefined) break;
        failedAt.delete(oldest);
      }
    },
  };
}
