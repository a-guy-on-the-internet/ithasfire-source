import { z } from "zod";

import type { PlaceBookingGrantee } from "@th/ports/repos/place-booking-grants";

// ─────────────────────────────────────────────────────────────────────────────
// Notification INTENTS for the booking grant lifecycle (holds-without-a-
// request FR-013, H18). Same posture as booking-hold-intents.ts: the use case
// returns the notices it OWES as data, computed from the rows it wrote, and
// the transport (plan step 9) turns them into notify() calls with the
// `{grantId}:{transition}:{recipient}` idempotency keys FR-013 names. Nothing
// is sent from core.
//
// AUDIENCE, not recipient:
//   - `grantee`: the booker. A person grant → the person; an org grant → the
//     org's edit-role members (FR-013 "Booker"). The transport resolves them.
//   - `granter`: the place staff member who gave the grant (FR-013 "grant
//     accepted / declined → place staff who gave it, in-app").
//
// FR-013 rows covered here:
//   grant given / revoked                 → grantee, email + in-app
//   grant accepted / declined             → granter, in-app
//   place releases a booker's hold        → grantee (folded into the revoke
//                                           notice: one digest, not one per hold)
//   kept hold becomes a place hold        → grantee (same digest; FR-003 "FR-005
//                                           notice to the booker")
// Move-ups of REQUEST holds ride the existing booking-hold intents
// (`hold.position_changed`), returned beside these.
// ─────────────────────────────────────────────────────────────────────────────

export const PLACE_BOOKING_GRANT_INTENT_KINDS = [
  /** A grant was given: the grantee may accept or decline it. */
  "grant.given",
  /** The grantee accepted: told to the staff member who gave it. */
  "grant.accepted",
  /** The grantee declined: told to the staff member who gave it. */
  "grant.declined",
  /**
   * The place revoked the grant. Carries the booker's holds the revoke
   * released (`releasedHolds`) and the ones it kept as place holds naming the
   * booker (`keptHolds`): the booker's own dates only.
   */
  "grant.revoked",
] as const;

export type PlaceBookingGrantIntentKind =
  (typeof PLACE_BOOKING_GRANT_INTENT_KINDS)[number];

export type PlaceBookingGrantIntentHold = { holdId: string; date: string };

export type PlaceBookingGrantNotificationIntent = {
  kind: PlaceBookingGrantIntentKind;
  grantId: string;
  placeId: string;
  /** Null = the whole place. */
  calendarId: string | null;
} & (
  | { audience: "grantee"; grantee: PlaceBookingGrantee }
  | { audience: "granter"; granterHumanId: string }
) & {
    /** `grant.revoked` only. */
    releasedHolds?: PlaceBookingGrantIntentHold[];
    /** `grant.revoked` only. */
    keptHolds?: PlaceBookingGrantIntentHold[];
  };

export const placeBookingGranteeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org"), orgId: z.uuid() }).strict(),
  z.object({ kind: z.literal("person"), humanId: z.uuid() }).strict(),
]);

const intentHoldSchema = z
  .object({
    holdId: z.uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

const intentBase = {
  kind: z.enum(PLACE_BOOKING_GRANT_INTENT_KINDS),
  grantId: z.uuid(),
  placeId: z.uuid(),
  calendarId: z.uuid().nullable(),
  releasedHolds: z.array(intentHoldSchema).optional(),
  keptHolds: z.array(intentHoldSchema).optional(),
};

export const placeBookingGrantNotificationIntentSchema = z.discriminatedUnion(
  "audience",
  [
    z
      .object({
        ...intentBase,
        audience: z.literal("grantee"),
        grantee: placeBookingGranteeSchema,
      })
      .strict(),
    z
      .object({
        ...intentBase,
        audience: z.literal("granter"),
        granterHumanId: z.uuid(),
      })
      .strict(),
  ],
);
