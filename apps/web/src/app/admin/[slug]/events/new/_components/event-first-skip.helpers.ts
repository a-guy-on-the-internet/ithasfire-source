/**
 * Pure helpers for the builder's "your request wasn't sent" notice
 * (venue-confirmation Phase 2, owner ruling 2026-09-08: surface the skip).
 *
 * The save's `bookingRequest` is a union on `outcome`. `created` / `existing`
 * feed the tie band (`EventProvenanceNote`); `skipped` — the venue refused
 * the ask at the server's gate walk, and the event saved address-only — is
 * NOT a request and has no band. It is a one-save fact about the ask the
 * cascade just made, which is why it lives with the cascade and why nothing
 * renders on reload (provenance has no request to report).
 *
 * Pure (no React) so the routing from wire codes to copy, and the "a fresh
 * attempt clears it" rule, are pinned by unit tests.
 */

import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "@th/trpc";

import type { BuilderPlacement } from "./builder-placement.helpers";

/** The `skipped` member of the save wire, as the router actually types it. */
export type SaveEventBookingSkip = Extract<
  NonNullable<
    inferRouterOutputs<AppRouter>["events"]["createEventForHuman"]["bookingRequest"]
  >,
  { outcome: "skipped" }
>;

type SaveBookingRequestResult =
  inferRouterOutputs<AppRouter>["events"]["createEventForHuman"]["bookingRequest"];

/** The skip, or `null` for every other outcome (created, existing, n/a). */
export function eventFirstSkipFromSave(
  bookingRequest: SaveBookingRequestResult | undefined,
): SaveEventBookingSkip | null {
  return bookingRequest?.outcome === "skipped" ? bookingRequest : null;
}

/**
 * Which sentence the notice reads. Four, in precedence order:
 *
 *  · `performer`  — `sender_not_eligible`: PERFORM asked without performer
 *                   mode. The fix is on the sender's side, so the venue is
 *                   not named.
 *  · `noHours`    — `PLACE_NOT_ACCEPTING_REQUESTS` with the machine message
 *                   `booking_requests_unconfigured`: the venue has never set
 *                   opening hours.
 *  · `date`       — `BOOKING_DATE_UNAVAILABLE`: a closed day or a past date.
 *  · `notTaking`  — everything else the server absorbs (paused requests,
 *                   unverified, calendar rejects the intent).
 *
 * `message` equals the `code` string when there is no sub-message (AppError
 * defaults message to code), so only the ONE sub-message this routes on is
 * compared; a bare code and a code-as-message land in the same variant.
 */
export type EventFirstSkipVariant = "performer" | "noHours" | "date" | "notTaking";

export function eventFirstSkipVariant(
  skip: Pick<SaveEventBookingSkip, "reason" | "code" | "message">,
): EventFirstSkipVariant {
  if (skip.reason === "sender_not_eligible") return "performer";
  if (
    skip.code === "PLACE_NOT_ACCEPTING_REQUESTS" &&
    skip.message === "booking_requests_unconfigured"
  ) {
    return "noHours";
  }
  if (skip.code === "BOOKING_DATE_UNAVAILABLE") return "date";
  return "notTaking";
}

/**
 * What the refused ask was made OF, captured at save time. The notice stays
 * while these still describe the builder's state and disappears the moment
 * any of them changes — a new venue, intent, calendar or start date is a
 * fresh attempt, and the old refusal would be a lie about it. Derived on
 * every render rather than cleared imperatively from four handlers, so a
 * new way of changing the ask cannot forget to clear it.
 *
 * `calendarId` is included because `calendar_rejects_intent` is per
 * calendar; the space is not — no gate reads it.
 */
export type EventFirstSkipSnapshot = {
  placeId: string;
  bookingIntent: BuilderPlacement["bookingIntent"];
  calendarId: string | null;
  /** The builder's `startsAt` field value, compared verbatim. */
  startsAt: string | null;
};

export function eventFirstSkipSnapshot(args: {
  placement: BuilderPlacement | null;
  startsAt: string | undefined;
  skip: SaveEventBookingSkip;
}): EventFirstSkipSnapshot {
  return {
    placeId: args.skip.placeId,
    bookingIntent: args.skip.intent,
    calendarId: args.placement?.calendarId ?? null,
    startsAt: args.startsAt ?? null,
  };
}

/** True while the builder still describes the ask the snapshot was taken of. */
export function eventFirstSkipIsCurrent(
  snapshot: EventFirstSkipSnapshot,
  current: { placement: BuilderPlacement | null; startsAt: string | undefined },
): boolean {
  const placement = current.placement;
  if (!placement) return false;
  return (
    placement.placeId === snapshot.placeId &&
    placement.bookingIntent === snapshot.bookingIntent &&
    placement.calendarId === snapshot.calendarId &&
    (current.startsAt ?? null) === snapshot.startsAt
  );
}
