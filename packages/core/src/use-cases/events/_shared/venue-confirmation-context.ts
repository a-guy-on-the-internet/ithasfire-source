import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import { fail } from "@th/errors";

import {
  hasActiveVenueConfirmationStamp,
  isVenueConfirmed,
  isVenueOwnedEvent,
} from "../../../lib/venue-confirmation";
import {
  requirePlaceBookingAuthority,
  type PlaceBookingAuthorityResult,
} from "../../booking-requests/_shared/place-access";
import type { VenueConfirmationIntentRecipient } from "./venue-confirmation-intents";

// ─────────────────────────────────────────────────────────────────────────────
// Shared load + authorize for `confirmVenueEvent` / `withdrawVenueConfirmation`
// (venue-confirmation-and-booking-intents spec, docs/specs/2026-08-27).
//
// Order: event (EVENT_NOT_FOUND) → it must sit at a place (an address-only
// event has nothing to confirm) → the place (PLACE_NOT_FOUND) → the place's
// STAFF gate: owner / edit-role member. A booking grantee is refused
// (holds-without-a-request FR-002): confirming or withdrawing someone else's
// event is the place's call, not a booker's. The event is loaded
// FIRST so the repo's P2025 on a vanished row is never the error a caller
// sees.
// ─────────────────────────────────────────────────────────────────────────────

export type VenueConfirmationContext = {
  event: EventRecord;
  place: PlaceRecord;
  authority: PlaceBookingAuthorityResult;
  /** Confirmed by construction — the place's owner owns the event. */
  venueOwned: boolean;
};

export async function loadVenueConfirmationContext(
  repos: Pick<Repos, "events" | "places" | "authz">,
  args: { eventId: string; actorHumanId: string },
): Promise<VenueConfirmationContext> {
  const event = await repos.events.getById(args.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (!event.placeId) {
    // Spec `precondition_failed: event_has_no_place` — the closed code set has
    // no precondition code; INVALID_STATUS is the house equivalent (see
    // `booking_request_closed` in the hold use cases).
    throw fail("INVALID_STATUS", {
      message: "event_has_no_place",
      meta: { eventId: event.id },
    });
  }
  const place = await repos.places.getById(event.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  const authority = await requirePlaceBookingAuthority(
    repos,
    place,
    args.actorHumanId,
  );
  return {
    event,
    place,
    authority,
    venueOwned: isVenueOwnedEvent(event, place),
  };
}

/**
 * Who is told about a confirmation transition: the event's owner pair. Null
 * for an ownerless COMMUNITY listing (nobody to tell — the venue confirming
 * a community event is recorded, not announced).
 */
export function venueConfirmationRecipientFor(
  event: Pick<EventRecord, "orgId" | "humanId">,
): VenueConfirmationIntentRecipient | null {
  if (event.orgId) return { type: "org", orgId: event.orgId };
  if (event.humanId) return { type: "human", humanId: event.humanId };
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output projection — what both use cases return about the event.
// ─────────────────────────────────────────────────────────────────────────────

export const venueConfirmationEventSchema = z
  .object({
    eventId: z.uuid(),
    placeId: z.uuid(),
    /** THE derivation (`lib/venue-confirmation`): stamp-and-not-withdrawn OR venue-owned. */
    venueConfirmed: z.boolean(),
    /** Confirmed by construction — the place's owner owns the event. */
    venueOwned: z.boolean(),
    /** The stamp half only (venue-owned events may be unstamped yet confirmed). */
    stamped: z.boolean(),
    venueConfirmedAt: z.date().nullable(),
    venueConfirmedByHumanId: z.uuid().nullable(),
    venueConfirmationRequestId: z.uuid().nullable(),
    venueConfirmationWithdrawnAt: z.date().nullable(),
    venueConfirmationWithdrawnReason: z.string().nullable(),
  })
  .strict();

export type VenueConfirmationEventOutput = z.infer<
  typeof venueConfirmationEventSchema
>;

export function toVenueConfirmationEventOutput(
  event: EventRecord,
  place: Pick<
    PlaceRecord,
    "id" | "orgIdsWithAccess" | "humanIdsWithAccess" | "acceptsCommunityListings"
  >,
): VenueConfirmationEventOutput {
  return venueConfirmationEventSchema.parse({
    eventId: event.id,
    placeId: event.placeId,
    venueConfirmed: isVenueConfirmed(event, place),
    venueOwned: isVenueOwnedEvent(event, place),
    stamped: hasActiveVenueConfirmationStamp(event),
    venueConfirmedAt: event.venueConfirmedAt ?? null,
    venueConfirmedByHumanId: event.venueConfirmedByHumanId ?? null,
    venueConfirmationRequestId: event.venueConfirmationRequestId ?? null,
    venueConfirmationWithdrawnAt: event.venueConfirmationWithdrawnAt ?? null,
    venueConfirmationWithdrawnReason:
      event.venueConfirmationWithdrawnReason ?? null,
  });
}
