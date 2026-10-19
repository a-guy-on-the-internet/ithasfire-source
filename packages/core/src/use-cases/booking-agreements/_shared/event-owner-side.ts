import { z } from "zod";

import type { BookingIntent } from "@th/ports/repos/booking-requests";
import { fail } from "@th/errors";

import {
  LEGACY_OWNER_SIDE,
  normalizeOwnerSide,
} from "../../../lib/legacy-place-values";

// ─────────────────────────────────────────────────────────────────────────────
// Who OWNS the event a booking produces (venue-confirmation-and-booking-
// intents spec, docs/specs/2026-08-27 "Who mints, who owns").
//
// The owner defaults by the request's intent: PERFORM → the venue hosts the
// act, so the venue owns the show (today's behaviour); RENT / USE → the
// requester is running their own night in the venue's room, so the DRAFT
// lands in the requester's admin. The venue side may override at confirm
// (`ownerOverride`). Mint AUTHORIZATION never moves — the venue confirms
// either way; only the owner assignment changes.
//
// This is the ONE derivation. The mint (`create-event-from-agreement`), the
// accept path's payout-terms seed (`accept-agreement`) and `confirmVenueEvent`
// all read it from here so they can never disagree about whose event it is.
// ─────────────────────────────────────────────────────────────────────────────

export const EVENT_OWNER_SIDES = ["place", "requester"] as const;

export type EventOwnerSide = (typeof EVENT_OWNER_SIDES)[number];

/**
 * An owner side at an input boundary (`ownerOverride`). Also takes the old
 * spelling, which a web build from before 2026-10-18 sends for the length of
 * a deploy, and reads it as `"place"` (`lib/legacy-place-values`).
 */
export const eventOwnerSideSchema = z
  .enum([...EVENT_OWNER_SIDES, LEGACY_OWNER_SIDE])
  .transform((side) => normalizeOwnerSide(side));

/**
 * The spec's default: PERFORM → place; RENT / USE → requester.
 *
 * Exhaustive on purpose. A bare `=== "PERFORM" ? "place" : "requester"`
 * fails OPEN — an unmapped or missing intent would silently become a
 * requester-owned booking, which is the direction that skips cloning the
 * venue's default PayoutTerms. The `never` arm makes a new intent a compile
 * error here, and a malformed row a loud throw rather than a quiet
 * mis-assignment.
 */
export function defaultEventOwnerSideForIntent(
  intent: BookingIntent,
): EventOwnerSide {
  switch (intent) {
    case "PERFORM":
      return "place";
    case "RENT":
    case "USE":
      return "requester";
    default: {
      // Unreachable unless storage / a mapper is corrupt — surface as
      // internal, never as a user-facing conflict.
      const never: never = intent;
      throw fail("INTERNAL", {
        message: "unknown_booking_intent",
        meta: { intent: String(never) },
      });
    }
  }
}

/** The default by intent, unless the venue side overrode it. */
export function resolveEventOwnerSide(
  request: { intent: BookingIntent },
  override: EventOwnerSide | null | undefined,
): EventOwnerSide {
  return override ?? defaultEventOwnerSideForIntent(request.intent);
}
