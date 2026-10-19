import { z } from "zod";

import { BOOKING_REASON_MAX } from "../../booking-requests/messages/_shared/system-entries";

// ─────────────────────────────────────────────────────────────────────────────
// Venue-confirmation notification INTENTS (venue-confirmation-and-booking-
// intents spec, docs/specs/2026-08-27 "Confirmation lives on the Event").
//
// Same posture as the booking-hold intents: the use cases (`confirmVenueEvent`
// / `withdrawVenueConfirmation`) send nothing. Each returns the notification
// it OWES as data, computed inside the transaction from the row it wrote, and
// `notify-venue-confirmation-intents.ts` turns it into notify() calls
// post-commit with a durable idempotency key. Transport strips the intents
// from the wire (`*WireOutputSchema`).
//
// RECIPIENT, resolved by the use case: the EVENT's owner — a human directly,
// or an org (whose edit-role members the dispatcher expands). There is never
// a "staff" audience here: the venue is the actor, and a venue-owned event
// emits no intent at all (the venue telling itself is noise).
// ─────────────────────────────────────────────────────────────────────────────

// In memory only: an intent is returned by the use case and dispatched in the
// same request once it commits. The kind is never stored; it appears in the
// notification's idempotency key only in its pre-2026-10-18 spelling (see
// `buildVenueConfirmationIdempotencyKey`).
export const VENUE_CONFIRMATION_INTENT_KINDS = [
  /** The place vouched for the event: place name + link now render publicly. */
  "event.place_confirmed",
  /**
   * The venue withdrew (or declined) its confirmation, with a reason. The
   * event keeps its place, drops to address-only, and the owner may edit.
   */
  "event.place_confirmation_withdrawn",
] as const;

export type VenueConfirmationIntentKind =
  (typeof VENUE_CONFIRMATION_INTENT_KINDS)[number];

export type VenueConfirmationIntentRecipient =
  | { type: "human"; humanId: string }
  | { type: "org"; orgId: string };

export type VenueConfirmationNotificationIntent = {
  kind: VenueConfirmationIntentKind;
  eventId: string;
  placeId: string;
  /** The booking request the confirmation is linked to, when there is one. */
  bookingRequestId: string | null;
  /** The event's owner pair, read off the event row inside the tx. */
  recipient: VenueConfirmationIntentRecipient;
  /**
   * The stamp instant (`venueConfirmedAt` / `venueConfirmationWithdrawnAt`)
   * the transition wrote. Part of the idempotency key: a re-confirm after a
   * withdrawal, or a withdrawal with a NEW reason, is a new notification; a
   * retry of the same transition is not.
   */
  at: Date;
  /** `event.place_confirmation_withdrawn` ONLY: the place's reason. */
  reason?: string;
};

export const venueConfirmationIntentRecipientSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("human"), humanId: z.uuid() }).strict(),
    z.object({ type: z.literal("org"), orgId: z.uuid() }).strict(),
  ],
);

export const venueConfirmationNotificationIntentSchema = z
  .object({
    kind: z.enum(VENUE_CONFIRMATION_INTENT_KINDS),
    eventId: z.uuid(),
    placeId: z.uuid(),
    bookingRequestId: z.uuid().nullable(),
    recipient: venueConfirmationIntentRecipientSchema,
    at: z.date(),
    reason: z.string().min(1).max(BOOKING_REASON_MAX).optional(),
  })
  .strict();
