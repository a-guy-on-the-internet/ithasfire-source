"use client";

import { useMemo } from "react";

import { trpc } from "@/trpc";

import {
  bookingCtas,
  offeredIntents,
  type BookingCta,
  type BookingIntent,
  type BookingOptionCalendar,
} from "./request-to-play-form.helpers";
import type { BookingStandardsByIntent } from "./booking-standards.helpers";
import type { PlacePrivacyReadError } from "@/lib/places/venue-location-ceiling";

/**
 * The owner an event would be saved UNDER, for `viewer.authority`. The event
 * builder passes the org in org context; omitted = the acting human (the
 * place page never sends one).
 */
export type PlaceBookingOptionsOwner =
  | { kind: "human" }
  | { kind: "org"; orgId: string };

export type UsePlaceBookingOptionsArgs = {
  owner?: PlaceBookingOptionsOwner;
  /** Park the read (default true). */
  enabled?: boolean;
  /**
   * React Query retries (default false — the place page degrades on first
   * failure). A predicate lets a caller stop on a final answer, e.g. the event
   * builder's `shouldRetryPlacePrivacyRead` (a NOT_FOUND is final).
   */
  retry?:
    | number
    | boolean
    | ((failureCount: number, error: PlacePrivacyReadError) => boolean);
};

/**
 * The place page's one read for "what can I ask this venue for?"
 * (`places.getBookingOptions`, public). Shared by the two CTAs and the
 * dialog they open, so React Query serves all three from one cache entry.
 * The event builder's third-party venue cascade reads the same procedure
 * with an `owner`, so `viewer.authority` answers for the entity the event
 * will be saved under.
 *
 * `offered` is derived here once: the CTAs gate on it, the dialog defaults
 * and filters on it. `acceptsBookingRequests` is the CLAIMED venue's opt-out;
 * an unclaimed venue reports false and no calendars (it takes no requests).
 */
export function usePlaceBookingOptions(
  placeId: string,
  { owner, enabled = true, retry = false }: UsePlaceBookingOptionsArgs = {},
) {
  const query = trpc.places.getBookingOptions.useQuery(
    { placeId, ...(owner ? { owner } : {}) },
    { staleTime: 60_000, retry, meta: { silent: true }, enabled },
  );

  const calendars = useMemo<BookingOptionCalendar[]>(
    () => query.data?.calendars ?? [],
    [query.data],
  );
  const offered = useMemo<BookingIntent[]>(
    () => offeredIntents(calendars),
    [calendars],
  );

  // Typed, not cast: a wire shape that drifts from the client type fails here.
  const placeStandards: BookingStandardsByIntent | null =
    query.data?.placeStandards ?? null;

  return {
    query,
    calendars,
    offered,
    /**
     * FR-004: the place-wide effective standards per intent — what the create
     * gate holds an UNROUTED request to (a place with no calendars). Null
     * until the read settles, or from a double that predates it.
     */
    placeStandards,
    isClaimed: query.data?.isClaimed ?? true,
    acceptsBookingRequests: query.data?.acceptsBookingRequests ?? true,
    /**
     * Null until the read settles. `viewer` is required on the wire, but
     * optional-chained so a place-page test double that predates it (and
     * never reads authority) does not throw inside the hook.
     */
    authority: query.data?.viewer?.authority ?? null,
  };
}

/**
 * The place page's booking buttons (hero + `booking_info` block share it, so
 * the two surfaces can never disagree). Callers still apply today's outer
 * gate — VERIFIED + opted in — before mounting; this only decides which of
 * the two intents get a button.
 */
export function useBookingCtas(placeId: string): BookingCta[] {
  const options = usePlaceBookingOptions(placeId);
  return useMemo(
    () =>
      bookingCtas({
        offered: options.offered,
        acceptsBookingRequests: options.acceptsBookingRequests,
        settled: options.query.isSuccess,
        failed: options.query.isError,
      }),
    [
      options.offered,
      options.acceptsBookingRequests,
      options.query.isSuccess,
      options.query.isError,
    ],
  );
}
