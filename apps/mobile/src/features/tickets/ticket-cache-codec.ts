/**
 * Pure serialisation for the offline ticket cache.
 *
 * Deliberately free of any native import. `ticket-cache.ts` owns the
 * SecureStore IO and depends on this; keeping the codec separate means the
 * validation logic — the part with the actual edge cases — is unit-testable
 * without dragging `expo-secure-store` and the React Native runtime into the
 * test environment.
 */

/** Ticket shape we persist — deliberately a subset of the wire type. */
export type CachedTicket = {
  id: string;
  code: string;
  status: string;
  scannedAt: string | null;
};

export type CachedOrderTickets = {
  orderId: string;
  tickets: CachedTicket[];
  /** ISO timestamp of the write, surfaced to the user as cache staleness. */
  cachedAt: string;
  /**
   * ISO start time of the event these tickets admit to, when known.
   *
   * Drives eviction. `null` when the writer didn't have it — the pass screen
   * fetches tickets without the order, so it can only supply this when the
   * user came via order detail.
   */
  eventStartsAt?: string | null;
};

/**
 * SecureStore keys are restricted to `[A-Za-z0-9._-]`. Order ids are UUIDs so
 * they already comply, but this is called with whatever the router hands us —
 * validate rather than let a malformed id throw from inside the native module.
 */
export const VALID_ORDER_ID = /^[A-Za-z0-9._-]+$/;

export const isValidOrderId = (orderId: string): boolean =>
  VALID_ORDER_ID.test(orderId);

const KEY_PREFIX = "th.tickets.order.";
const KEY_SUFFIX = ".v1";

export const cacheKeyFor = (orderId: string): string =>
  `${KEY_PREFIX}${orderId}${KEY_SUFFIX}`;

/**
 * Index of every order id we have cached.
 *
 * SecureStore has no key enumeration, so without this we could never find the
 * entries again to delete them — and these are bearer credentials that MUST be
 * purgeable on sign-out. The index is the only thing that makes the cache
 * clearable at all.
 */
export const CACHE_INDEX_KEY = "th.tickets.index.v1";

export const serializeOrderIndex = (orderIds: readonly string[]): string =>
  JSON.stringify([...new Set(orderIds)].filter(isValidOrderId));

/** Malformed index → empty, so a corrupt entry can't wedge the purge path. */
export const parseOrderIndex = (raw: string | null): string[] => {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (id): id is string => typeof id === "string" && isValidOrderId(id),
  );
};

export const serializeCachedOrderTickets = (
  orderId: string,
  tickets: readonly CachedTicket[],
  cachedAt: string,
  eventStartsAt: string | null = null,
): string =>
  JSON.stringify({
    orderId,
    tickets: tickets.map((t) => ({
      id: t.id,
      code: t.code,
      status: t.status,
      scannedAt: t.scannedAt,
    })),
    cachedAt,
    eventStartsAt,
  } satisfies CachedOrderTickets);

/**
 * Parse and validate a cached blob.
 *
 * Anything that doesn't match the expected shape returns `null` rather than
 * throwing — a corrupt cache entry must degrade to "no cache", never crash the
 * pass screen the buyer is holding up at the door.
 *
 * The `expectedOrderId` check is not ceremony: it makes a key collision or a
 * stale rename fail closed instead of handing one order's codes to another.
 */
export const parseCachedOrderTickets = (
  raw: string,
  expectedOrderId: string,
): CachedOrderTickets | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<CachedOrderTickets>;

  if (candidate.orderId !== expectedOrderId) return null;
  if (typeof candidate.cachedAt !== "string") return null;
  if (!Array.isArray(candidate.tickets)) return null;

  const tickets: CachedTicket[] = [];
  for (const entry of candidate.tickets) {
    if (typeof entry !== "object" || entry === null) return null;
    const t = entry as Partial<CachedTicket>;
    if (typeof t.id !== "string" || typeof t.code !== "string") return null;
    if (typeof t.status !== "string") return null;
    if (typeof t.scannedAt !== "string" && t.scannedAt !== null) return null;
    tickets.push({
      id: t.id,
      code: t.code,
      status: t.status,
      scannedAt: t.scannedAt,
    });
  }

  // Absent on entries written before eviction existed — treated as unknown,
  // which falls back to the backstop age rule rather than being dropped.
  const eventStartsAt =
    typeof candidate.eventStartsAt === "string" ? candidate.eventStartsAt : null;

  return {
    orderId: candidate.orderId,
    tickets,
    cachedAt: candidate.cachedAt,
    eventStartsAt,
  };
};

/**
 * Grace period after an event before its cached codes are dropped.
 *
 * Generous on purpose: a late-running show, a phone that never regains signal
 * that night, and a support query the next morning all need the codes to still
 * be there. Three days covers a festival weekend.
 */
export const EVICT_AFTER_EVENT_DAYS = 3;

/**
 * Backstop for entries with no known event date.
 *
 * NOT a general TTL. Evicting on cache AGE would be actively wrong for this
 * feature: someone who buys sixty days out and doesn't reopen the app until
 * the night of the show would find their pass gone at exactly the moment the
 * offline cache exists to serve. So age only decides entries where we never
 * learned the event date, and the bound is long enough to outlive any
 * plausible on-sale-to-doors gap.
 */
export const EVICT_UNDATED_AFTER_DAYS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;

const parseTime = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * Whether a cached entry should be dropped.
 *
 * Unparseable timestamps evict: a corrupt date is not a reason to retain
 * bearer credentials forever.
 */
export const isExpiredCacheEntry = (
  entry: Pick<CachedOrderTickets, "cachedAt" | "eventStartsAt">,
  now: number,
): boolean => {
  const eventAt = parseTime(entry.eventStartsAt);
  if (eventAt !== null) {
    return now > eventAt + EVICT_AFTER_EVENT_DAYS * DAY_MS;
  }

  const cachedAt = parseTime(entry.cachedAt);
  if (cachedAt === null) return true;
  return now > cachedAt + EVICT_UNDATED_AFTER_DAYS * DAY_MS;
};
