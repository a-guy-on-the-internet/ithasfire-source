"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "@bprogress/next/app";

import { trpc } from "@/trpc";

// ---------------------------------------------------------------------------
// useSurpriseMe — imperative "roll a random published event and go there".
//
// `events.getRandomEvent` is a tRPC *query*, but we want a button press to
// trigger it, so we roll imperatively via the tRPC utils `.fetch()` (TanStack
// Query) rather than mounting a reactive `useQuery`. On success we navigate to
// the public event page (`/events/{slug}`). We remember the last event id and
// pass it back as `excludeEventIds` so a re-roll always lands on a *different*
// event.
//
// Business rules stay server-side; this hook only orchestrates the call and
// the navigation, and always forces `publishedOnly` so users can never be sent
// to a draft.
// ---------------------------------------------------------------------------

/**
 * Friendly, user-facing filters. All optional. These map onto a subset of
 * `getRandomEventInput`; the dev-only inputs (seed, idempotencyKey, orgId,
 * placeId, raw lat/lng text) are intentionally not exposed here.
 */
export type SurpriseMeFilters = {
  /**
   * When set, restricts to events near these coordinates within `radiusKm`
   * (kilometres, 5–500; capped server-side at 500). Callers should drop `near`
   * entirely for an unconstrained ("worldwide") roll rather than sending a
   * radius the schema would reject.
   */
  near?: { lat: number; lng: number; radiusKm?: number };
  /** Keyword passed through to search (`q`). */
  q?: string;
  /** Date window. Open-ended on either side. */
  window?: { from?: Date; to?: Date };
};

export type SurpriseMeOutcome =
  | { status: "navigated"; eventId: string; slug: string }
  | { status: "no-event" }
  | { status: "error"; error: unknown };

export type UseSurpriseMeResult = {
  /**
   * Roll a random published event and navigate to it. Returns the outcome so
   * callers can decide how loudly to surface "no event found" (the homepage
   * affordance can stay quiet; the dedicated page shows an inline message).
   */
  roll: (filters?: SurpriseMeFilters) => Promise<SurpriseMeOutcome>;
  /** True while a roll is in flight. */
  isRolling: boolean;
  /** The last error thrown by a roll, or null. Cleared at the start of each roll. */
  error: unknown;
  /** Reset the remembered "last event" so the next roll can return anything. */
  resetHistory: () => void;
};

/** tRPC throws `NO_RANDOM_EVENT_AVAILABLE` (mapped to NOT_FOUND) when nothing matches. */
const isNoEventError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: { code?: string; appCode?: string } }).data;
  const message = (error as { message?: string }).message ?? "";
  return (
    data?.code === "NOT_FOUND" ||
    data?.appCode === "NO_RANDOM_EVENT_AVAILABLE" ||
    message.includes("NO_RANDOM_EVENT_AVAILABLE")
  );
};

export function useSurpriseMe(): UseSurpriseMeResult {
  const router = useRouter();
  const utils = trpc.useUtils();

  const [isRolling, setIsRolling] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Remember the last event we sent the user to, so a re-roll excludes it and
  // returns something fresh. Kept in a ref so it doesn't trigger re-renders.
  const lastEventIdRef = useRef<string | null>(null);

  const resetHistory = useCallback(() => {
    lastEventIdRef.current = null;
  }, []);

  const roll = useCallback(
    async (filters?: SurpriseMeFilters): Promise<SurpriseMeOutcome> => {
      setIsRolling(true);
      setError(null);

      const excludeEventIds = lastEventIdRef.current
        ? [lastEventIdRef.current]
        : undefined;

      // Build only the keys that are set — keep the payload minimal and never
      // send empty strings/objects. `publishedOnly: true` is non-negotiable.
      const input: Parameters<
        typeof utils.events.getRandomEvent.fetch
      >[0] = { publishedOnly: true };

      if (filters?.near) {
        input.near = {
          lat: filters.near.lat,
          lng: filters.near.lng,
          ...(filters.near.radiusKm
            ? { radiusKm: filters.near.radiusKm }
            : {}),
        };
      }
      const trimmedQuery = filters?.q?.trim();
      if (trimmedQuery) {
        input.q = trimmedQuery;
      }
      if (filters?.window?.from || filters?.window?.to) {
        input.window = {
          ...(filters.window.from ? { from: filters.window.from } : {}),
          ...(filters.window.to ? { to: filters.window.to } : {}),
        };
      }
      if (excludeEventIds) {
        input.excludeEventIds = excludeEventIds;
      }

      try {
        // Every roll must hit the server. The web QueryClient defaults to
        // `staleTime: 60_000`, and `.fetch()` proxies TanStack `fetchQuery`,
        // which would otherwise replay a cached event for a repeated query key
        // (e.g. after `resetHistory()` or across the shared home/lucky
        // surfaces). Force a fresh fetch and don't retain the result in cache.
        const event = await utils.events.getRandomEvent.fetch(input, {
          staleTime: 0,
          gcTime: 0,
        });

        // The server resolves to a published event; without a slug we can't
        // build the public URL, so treat it as "nothing usable found".
        if (!event?.slug) {
          return { status: "no-event" };
        }

        lastEventIdRef.current = event.id;
        router.push(`/events/${event.slug}`);
        return { status: "navigated", eventId: event.id, slug: event.slug };
      } catch (err) {
        if (isNoEventError(err)) {
          return { status: "no-event" };
        }
        setError(err);
        return { status: "error", error: err };
      } finally {
        setIsRolling(false);
      }
    },
    [router, utils],
  );

  return { roll, isRolling, error, resetHistory };
}
