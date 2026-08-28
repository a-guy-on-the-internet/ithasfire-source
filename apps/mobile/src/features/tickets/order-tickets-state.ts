import type { CachedOrderTickets } from "./ticket-cache-codec";

/**
 * Pure precedence logic for the offline ticket cache.
 *
 * Split out of `use-order-tickets.ts` because this is the part that decides
 * whether a buyer sees their pass at a door with no signal — the highest-risk
 * behaviour in the feature — and it is worth testing directly rather than
 * through a mocked React Query + SecureStore stack.
 */

export type DisplayTicket = {
  id: string;
  code: string;
  status: string;
  scannedAt: Date | string | null;
};

export type OrderTicketsSource = "live" | "cache" | "none";

export type OrderTicketsQueryState = {
  liveTickets: DisplayTicket[] | undefined;
  cached: CachedOrderTickets | null;
  /** False until the cache read has settled, however it settled. */
  cacheChecked: boolean;
  isQueryLoading: boolean;
  isQueryError: boolean;
  queryErrorMessage: string | null;
};

export type ResolvedOrderTickets = {
  tickets: DisplayTicket[];
  source: OrderTicketsSource;
  cachedAt: string | null;
  isLoading: boolean;
  errorMessage: string | null;
};

const GENERIC_ERROR = "Couldn't load your tickets.";

// ── Write-through helpers ───────────────────────────────────────────────────
//
// Pure so the cache-write path is testable without a renderer. These are the
// parts of `useOrderTickets`'s effect that can actually be wrong.

/** A ticket as it arrives from the router, before the cache narrows it. */
export type WireLikeTicket = {
  id: string;
  code: string;
  status: string;
  scannedAt: Date | string | null | undefined;
};

export const toIsoOrNull = (
  value: Date | string | null | undefined,
): string | null => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return value;
};

/**
 * Narrow wire tickets to exactly the fields we persist.
 *
 * The explicit field list is the point: it stops a future widening of the wire
 * type from silently writing extra PII into the keychain alongside the codes.
 */
export const toCacheableTickets = (
  tickets: readonly WireLikeTicket[],
): { id: string; code: string; status: string; scannedAt: string | null }[] =>
  tickets.map((t) => ({
    id: t.id,
    code: t.code,
    status: t.status,
    scannedAt: toIsoOrNull(t.scannedAt),
  }));

/**
 * Key for "have we already written exactly this?".
 *
 * Includes the order id because two orders can legitimately hold an identical
 * ticket-list shape, and includes the event date because learning it later is
 * a change worth persisting — without it, an entry first cached from the pass
 * screen (no date) would never be upgraded to a datable one, and so would
 * never become evictable.
 */
export const buildCacheFingerprint = (
  orderId: string,
  tickets: readonly { id: string; code: string; status: string; scannedAt: string | null }[],
  eventStartsAt: string | null,
): string => `${orderId}|${eventStartsAt ?? ""}|${JSON.stringify(tickets)}`;

/**
 * Resolve what the screen should render.
 *
 * Order of precedence, and why:
 *
 *   1. **Live data wins**, even alongside an error — a background refetch can
 *      fail while `data` is still populated, and yanking the buyer's tickets
 *      away to show an error card would be strictly worse than stale data.
 *   2. **A non-empty cache is shown** rather than a spinner or an error. This
 *      is the entire point of the feature; a cached pass must never sit behind
 *      a loading state waiting on a request that will never resolve.
 *   3. **An error surfaces only once the cache has been checked** and had
 *      nothing to offer. Reporting failure while the cache read is still
 *      outstanding would flash an error at someone whose pass is about to
 *      appear.
 */
export const resolveOrderTicketsState = (
  state: OrderTicketsQueryState,
): ResolvedOrderTickets => {
  if (state.liveTickets) {
    return {
      tickets: state.liveTickets,
      source: "live",
      cachedAt: null,
      isLoading: false,
      errorMessage: null,
    };
  }

  if (state.cached && state.cached.tickets.length > 0) {
    return {
      tickets: state.cached.tickets,
      source: "cache",
      cachedAt: state.cached.cachedAt,
      isLoading: false,
      errorMessage: null,
    };
  }

  if (state.isQueryError && state.cacheChecked) {
    return {
      tickets: [],
      source: "none",
      cachedAt: null,
      isLoading: false,
      errorMessage: state.queryErrorMessage || GENERIC_ERROR,
    };
  }

  return {
    tickets: [],
    source: "none",
    cachedAt: null,
    isLoading: state.isQueryLoading || !state.cacheChecked,
    errorMessage: null,
  };
};
