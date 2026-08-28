import { useCallback, useEffect, useRef, useState } from "react";

import { trpc, type RouterOutputs } from "@/lib/trpc";
import { loadOrderTickets, saveOrderTickets } from "./ticket-cache";
import type { CachedOrderTickets } from "./ticket-cache-codec";
import {
  buildCacheFingerprint,
  resolveOrderTicketsState,
  toCacheableTickets,
  toIsoOrNull,
  type DisplayTicket,
  type OrderTicketsSource,
} from "./order-tickets-state";

export type { DisplayTicket, OrderTicketsSource };

/**
 * The wire ticket shape. Named explicitly because the router's inferred output
 * degrades to `any` here (a pre-existing cross-package inference cascade,
 * visible as the `src/lib/trpc.ts` overload error) — without the annotation the
 * `.map` callback below silently loses its type.
 */
type WireTicket =
  RouterOutputs["orders"]["listMyOrderTickets"]["tickets"][number];

export type UseOrderTicketsResult = {
  tickets: DisplayTicket[];
  /** Where the rendered tickets came from — drives the offline notice. */
  source: OrderTicketsSource;
  /** ISO write time when `source === "cache"`, else null. */
  cachedAt: string | null;
  /** True only while we have nothing to show yet, live or cached. */
  isLoading: boolean;
  /** Set when the live fetch failed AND no cache covered for it. */
  errorMessage: string | null;
  refetch: () => void;
};

/**
 * Ticket codes for one order, with a write-through offline cache.
 *
 * The cache read races the network deliberately: whichever lands first is shown
 * and live data supersedes it when it arrives. That keeps a warm cache instant
 * at the door instead of blocking on a request that may never resolve.
 *
 * Precedence rules live in `./order-tickets-state` (pure, and tested there).
 * This hook owns only the effects: reading the cache, writing through, and
 * exposing a stable `refetch`.
 */
export const useOrderTickets = (
  orderId: string,
  /**
   * Event start, when the caller has it. Only order detail does — the pass
   * screen loads tickets without the order — so it is optional. Passing it
   * lets the cache evict the entry once the show is over instead of falling
   * back to the long undated backstop.
   */
  eventStartsAt?: Date | string | null,
): UseOrderTicketsResult => {
  const query = trpc.orders.listMyOrderTickets.useQuery(
    { orderId },
    { staleTime: 30_000, retry: 1 },
  );

  const [cached, setCached] = useState<CachedOrderTickets | null>(null);
  const [cacheChecked, setCacheChecked] = useState(false);

  // Read the cache once per order id.
  useEffect(() => {
    let cancelled = false;
    setCached(null);
    setCacheChecked(false);

    void (async () => {
      const entry = await loadOrderTickets(orderId);
      if (cancelled) return;
      setCached(entry);
      setCacheChecked(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [orderId]);

  // Write through on every successful fetch. Keyed on the payload so a
  // refetch returning identical data doesn't churn the keychain.
  const lastWritten = useRef<string | null>(null);
  const liveTickets = query.data?.tickets as WireTicket[] | undefined;

  const eventStartsAtIso = toIsoOrNull(eventStartsAt);

  useEffect(() => {
    if (!liveTickets) return;

    const serializable = toCacheableTickets(liveTickets);
    const fingerprint = buildCacheFingerprint(
      orderId,
      serializable,
      eventStartsAtIso,
    );
    if (lastWritten.current === fingerprint) return;
    lastWritten.current = fingerprint;

    void saveOrderTickets(orderId, serializable, eventStartsAtIso);
  }, [liveTickets, orderId, eventStartsAtIso]);

  // Depend on the bound method, not the whole query object — the latter is a
  // fresh reference every render, which would defeat the memo and churn every
  // consumer that lists `refetch` in its own deps.
  const queryRefetch = query.refetch;
  const refetch = useCallback(() => {
    void queryRefetch();
  }, [queryRefetch]);

  const resolved = resolveOrderTicketsState({
    liveTickets,
    cached,
    cacheChecked,
    isQueryLoading: query.isLoading,
    isQueryError: query.isError,
    queryErrorMessage: query.error?.message ?? null,
  });

  return { ...resolved, refetch };
};
