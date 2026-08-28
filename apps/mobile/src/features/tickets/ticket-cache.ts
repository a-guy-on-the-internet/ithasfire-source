import * as SecureStore from "expo-secure-store";
import * as Sentry from "@sentry/react-native";

import {
  CACHE_INDEX_KEY,
  cacheKeyFor,
  isExpiredCacheEntry,
  isValidOrderId,
  parseCachedOrderTickets,
  parseOrderIndex,
  serializeCachedOrderTickets,
  serializeOrderIndex,
  type CachedOrderTickets,
  type CachedTicket,
} from "./ticket-cache-codec";

export type { CachedOrderTickets, CachedTicket };

/**
 * Offline cache for ticket codes.
 *
 * ## Why this exists
 *
 * The QR pass is the one screen that has to work with no network. Venues eat
 * signal — basements, metal rooms, 2,000 phones on one cell — and a ticket that
 * only renders online is not a ticket. So every successful fetch writes through
 * to disk, and the pass screen falls back to that copy when the query fails.
 *
 * ## Why SecureStore rather than a plain key-value store
 *
 * A ticket code IS the bearer credential — the scanner accepts whatever the QR
 * encodes. Anyone who can read the code can walk in. That puts these in the
 * same class as a session token, so they belong in the keychain/keystore, not
 * in AsyncStorage where any backup or file-level compromise lifts them out.
 *
 * `AFTER_FIRST_UNLOCK` is deliberate: the door is exactly when the phone has
 * been unlocked at least once, and the stricter `WHEN_UNLOCKED` would make the
 * cache unreadable to a background prefetch.
 *
 * Because they are credentials, the lifecycle has to match: `clearAllOrderTickets`
 * is called from sign-out (`use-auth-session.ts`). Leaving admittable codes on a
 * signed-out device would undo the point of storing them securely at all.
 *
 * Serialisation and validation live in `./ticket-cache-codec` so they can be
 * tested without the native module.
 */

/**
 * Android's SecureStore rejects values past ~2KB. A cached order is a handful
 * of short codes so this is generous, but an order with hundreds of tickets
 * would silently fail the write — we skip the cache and report instead, because
 * a missing cache degrades to "needs network", while a thrown error here would
 * take down an otherwise-working online render.
 */
const MAX_CACHE_BYTES = 1800;

/**
 * Report a swallowed cache failure.
 *
 * These branches all degrade rather than throw, which means without this they
 * are invisible in release builds — the buyer finds out at the door. The repo's
 * `ReporterPort` convention is written for core use cases with an injected
 * port; the client-side equivalent is a direct `captureException`, matching
 * `use-auth-session.ts`.
 *
 * NOTE: never pass ticket codes or the serialised payload here — they are
 * bearer credentials and Sentry is not an appropriate home for them.
 */
const reportCacheFailure = (message: string, error?: unknown): void => {
  if (__DEV__) {
    console.warn(`[ticket-cache] ${message}`, error);
  }
  Sentry.captureException(
    error instanceof Error ? error : new Error(`[ticket-cache] ${message}`),
    { tags: { area: "ticket-cache" }, extra: { message } },
  );
};

/**
 * Most recent orders to keep indexed.
 *
 * The index is the only handle we have on the cached entries, and it is itself
 * a SecureStore value subject to the same ~2KB advisory limit. One UUID plus
 * JSON quoting is ~39 bytes, so 40 stays comfortably inside it. Evicting the
 * oldest keeps the structure bounded; the evicted entry is deleted with it, so
 * capping never orphans a credential.
 */
const MAX_INDEXED_ORDERS = 40;

/**
 * Record an order in the purge index, evicting the oldest past the cap.
 *
 * Returns whether the id is now indexed. Callers write the entry only after
 * this succeeds — see `saveOrderTickets` for why the ordering matters.
 */
const addToIndex = async (orderId: string): Promise<boolean> => {
  try {
    const existing = parseOrderIndex(
      await SecureStore.getItemAsync(CACHE_INDEX_KEY),
    );
    if (existing.includes(orderId)) return true;

    const next = [...existing, orderId];
    const evicted = next.length > MAX_INDEXED_ORDERS
      ? next.splice(0, next.length - MAX_INDEXED_ORDERS)
      : [];

    await SecureStore.setItemAsync(CACHE_INDEX_KEY, serializeOrderIndex(next), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });

    // Drop the evicted entries' codes too — an entry we can no longer reach
    // from the index is a credential we could never purge.
    for (const id of evicted) {
      await clearOrderTickets(id);
    }

    return true;
  } catch (error) {
    reportCacheFailure(`failed to index order ${orderId}`, error);
    return false;
  }
};

export const saveOrderTickets = async (
  orderId: string,
  tickets: readonly CachedTicket[],
  /** Event start, when the caller knows it. Drives eviction — see the codec. */
  eventStartsAt: string | null = null,
): Promise<void> => {
  if (!isValidOrderId(orderId)) {
    reportCacheFailure(`refusing to cache under malformed order id`);
    return;
  }

  const serialized = serializeCachedOrderTickets(
    orderId,
    tickets,
    new Date().toISOString(),
    eventStartsAt,
  );

  if (serialized.length > MAX_CACHE_BYTES) {
    // Large group buys hit this — worth knowing about, since those buyers
    // silently lose offline access.
    reportCacheFailure(
      `order too large to cache (${serialized.length} bytes, ${tickets.length} tickets); skipping`,
    );
    return;
  }

  // Index FIRST, entry second. If the index write fails we simply don't cache:
  // an entry on disk with no index reference is an admittable ticket code that
  // sign-out could never find. The reverse failure — an index entry pointing at
  // nothing — is harmless, since the delete of a missing key is a no-op.
  const indexed = await addToIndex(orderId);
  if (!indexed) return;

  try {
    await SecureStore.setItemAsync(cacheKeyFor(orderId), serialized, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  } catch (error) {
    // A failed write costs offline access, never the current render.
    reportCacheFailure(`failed to cache order ${orderId}`, error);
  }
};

export const loadOrderTickets = async (
  orderId: string,
): Promise<CachedOrderTickets | null> => {
  if (!isValidOrderId(orderId)) return null;

  try {
    const raw = await SecureStore.getItemAsync(cacheKeyFor(orderId));
    if (!raw) return null;
    return parseCachedOrderTickets(raw, orderId);
  } catch (error) {
    reportCacheFailure(`failed to read cache for order ${orderId}`, error);
    return null;
  }
};

/** Returns whether the entry is now gone. */
export const clearOrderTickets = async (orderId: string): Promise<boolean> => {
  if (!isValidOrderId(orderId)) return false;
  try {
    await SecureStore.deleteItemAsync(cacheKeyFor(orderId));
    return true;
  } catch (error) {
    reportCacheFailure(`failed to clear cache for order ${orderId}`, error);
    return false;
  }
};

/**
 * Drop cached orders whose event is over (or which are implausibly old).
 *
 * Called when the tickets tab mounts — a natural, frequent-enough moment that
 * costs nothing, and the one place the user is demonstrably thinking about
 * tickets. Best-effort throughout: a failure here leaves stale entries, which
 * the sign-out purge still catches.
 *
 * The index is rewritten to exactly the surviving ids, so it shrinks with the
 * entries rather than growing forever.
 */
export const pruneExpiredOrderTickets = async (): Promise<void> => {
  try {
    const ids = parseOrderIndex(
      await SecureStore.getItemAsync(CACHE_INDEX_KEY),
    );
    if (ids.length === 0) return;

    const now = Date.now();
    const survivors: string[] = [];

    for (const id of ids) {
      const entry = await loadOrderTickets(id);
      // A missing/corrupt entry drops out of the index rather than being kept
      // as a dangling reference.
      if (!entry) continue;
      if (isExpiredCacheEntry(entry, now)) {
        await clearOrderTickets(id);
        continue;
      }
      survivors.push(id);
    }

    if (survivors.length === ids.length) return;

    if (survivors.length === 0) {
      await SecureStore.deleteItemAsync(CACHE_INDEX_KEY);
      return;
    }
    await SecureStore.setItemAsync(
      CACHE_INDEX_KEY,
      serializeOrderIndex(survivors),
      { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
    );
  } catch (error) {
    reportCacheFailure("failed to prune expired cached orders", error);
  }
};

/**
 * Purge every cached order. Called on sign-out.
 *
 * Survivors are retained in the index rather than the index being cleared
 * wholesale: a delete that fails transiently must stay findable, or its codes
 * are orphaned on disk permanently with nothing left pointing at them. The
 * index is only deleted when every entry is confirmed gone.
 */
export const clearAllOrderTickets = async (): Promise<void> => {
  try {
    const ids = parseOrderIndex(
      await SecureStore.getItemAsync(CACHE_INDEX_KEY),
    );

    const survivors: string[] = [];
    for (const id of ids) {
      const cleared = await clearOrderTickets(id);
      if (!cleared) survivors.push(id);
    }

    if (survivors.length === 0) {
      await SecureStore.deleteItemAsync(CACHE_INDEX_KEY);
      return;
    }

    await SecureStore.setItemAsync(
      CACHE_INDEX_KEY,
      serializeOrderIndex(survivors),
      { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
    );
    reportCacheFailure(
      `${survivors.length} cached order(s) survived the sign-out purge; retained in the index for retry`,
    );
  } catch (error) {
    reportCacheFailure("failed to clear the ticket cache on sign-out", error);
  }
};
