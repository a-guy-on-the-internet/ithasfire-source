import { useCallback, useEffect, useRef, useState } from "react";

import { trpc, type RouterOutputs } from "@/lib/trpc";
import {
  isEmailVerificationRequired,
  retryUnlessVerificationRequired,
} from "@/features/auth/email-verification-required";
import { useEmailVerificationLatch } from "@/features/auth/use-email-verification-latch";
import {
  clearOrderTickets,
  loadOrderTickets,
  saveOrderTickets,
} from "./ticket-cache";
import type { CachedOrderTickets } from "./ticket-cache-codec";
import {
  applyCacheRead,
  buildCacheFingerprint,
  resolveOrderTicketsState,
  shouldWriteCache,
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
  /**
   * The server refused with `email_verification_required` (B2): show
   * `EmailVerificationPrompt`. Latched: it holds through a refetch and lets go
   * when the query answers with anything else.
   */
  verificationRequired: boolean;
  /** The live query is in flight (drives pull-to-refresh). */
  isFetching: boolean;
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
    { staleTime: 30_000, retry: retryUnlessVerificationRequired(1) },
  );
  const verificationRequired = useEmailVerificationLatch({
    gated: isEmailVerificationRequired(query.error),
    answered: query.isSuccess || query.isError,
  });
  // Read by the cache-load effect, which can settle after the gate arrived.
  const gatedRef = useRef(verificationRequired);
  gatedRef.current = verificationRequired;

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
      setCached(applyCacheRead(entry, gatedRef.current));
      setCacheChecked(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [orderId]);

  // Write through on every successful fetch. Keyed on the payload so a
  // refetch returning identical data doesn't churn the keychain.
  const lastWritten = useRef<string | null>(null);

  // The gate means the server answered and said no, so a cached copy must not
  // outlive it: drop it from state and from the keychain. Otherwise a later
  // offline open would show it.
  useEffect(() => {
    if (!verificationRequired) return;
    setCached(null);
    // After a verify the same payload must be written again.
    lastWritten.current = null;
    void clearOrderTickets(orderId);
  }, [verificationRequired, orderId]);

  const liveTickets = query.data?.tickets as WireTicket[] | undefined;

  const eventStartsAtIso = toIsoOrNull(eventStartsAt);

  // `verificationRequired` is a dependency so the write runs again once a
  // verify lets the latch go, even when the payload is unchanged.
  useEffect(() => {
    if (!liveTickets) return;

    const serializable = toCacheableTickets(liveTickets);
    const fingerprint = buildCacheFingerprint(
      orderId,
      serializable,
      eventStartsAtIso,
    );
    if (
      !shouldWriteCache({
        hasLiveTickets: true,
        gated: verificationRequired,
        fingerprint,
        lastWritten: lastWritten.current,
      })
    ) {
      return;
    }
    lastWritten.current = fingerprint;

    void saveOrderTickets(orderId, serializable, eventStartsAtIso);
  }, [liveTickets, orderId, eventStartsAtIso, verificationRequired]);

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
    isVerificationRequired: verificationRequired,
  });

  return { ...resolved, isFetching: query.isFetching, refetch };
};
