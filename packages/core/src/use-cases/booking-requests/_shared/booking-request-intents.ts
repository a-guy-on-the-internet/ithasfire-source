import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Booking-request notification INTENTS (venue-confirmation-and-booking-intents
// spec, docs/specs/2026-08-27).
//
// Same posture as the hold and venue-confirmation intents: the use case sends
// nothing. It returns the notifications it OWES as data, computed inside its
// transaction from the rows it wrote, and `notify-booking-request-intents.ts`
// turns them into sends post-commit. Transport strips them from the wire.
//
// One kind:
//
//   · `request.received` — the CLAIMED venue's "new request" notice
//     (`notifyBookingRequestReceived`, FR-008) as an intent. The request-first
//     pitch fires that notifier itself post-commit; the EVENT-FIRST create
//     (`createBookingRequestFromEvent`) runs INSIDE the event save's
//     transaction and cannot, so it returns this and the dispatcher makes
//     the same call after the save committed.
//
// The venue claim invite and the unparked notice went with parking (amendment
// 2026-09-25: an unclaimed venue takes no requests).
// ─────────────────────────────────────────────────────────────────────────────

export const BOOKING_REQUEST_INTENT_KINDS = ["request.received"] as const;

export type BookingRequestIntentKind =
  (typeof BOOKING_REQUEST_INTENT_KINDS)[number];

export type RequestReceivedIntent = {
  kind: "request.received";
  bookingRequestId: string;
  placeId: string;
  /** The create instant — log context; the notifier keys on the request id. */
  at: Date;
};

export type BookingRequestNotificationIntent = RequestReceivedIntent;

export const bookingRequestNotificationIntentSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("request.received"),
        bookingRequestId: z.uuid(),
        placeId: z.uuid(),
        at: z.date(),
      })
      .strict(),
  ],
);
