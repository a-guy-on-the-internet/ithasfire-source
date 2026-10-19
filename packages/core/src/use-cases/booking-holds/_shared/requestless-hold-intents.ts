import { z } from "zod";

import type {
  BookingHoldHolder,
  BookingHoldReleaseReason,
} from "@th/ports/repos/booking-holds";

import { bookingHoldReleaseReasonSchema } from "./booking-hold-intents";

// ─────────────────────────────────────────────────────────────────────────────
// Notification INTENTS for request-less holds (holds-without-a-request
// FR-013, H7, H18). Same posture as booking-hold-intents.ts: a use case
// returns the notices it OWES as data, from the rows it wrote; the transport
// (plan step 9) turns them into notify() calls keyed
// `{holdId}:{transition}:{recipient}`. Nothing is sent from core.
//
// A request-less hold has no request, so these never ride the request
// intents (whose `bookingRequestId` is required) and never write a thread
// (H20): the use case writes an audit row beside each one.
//
// AUDIENCE, not recipient:
//   - `staff`: the place's staff (the transport routes: the placer, else the
//     place's edit-role members);
//   - `booker`: the BOOKER hold's holder — the grantee person, or the grantee
//     org's edit-role members (FR-013 "Booker");
//   - `named_party`: the person or org a PLACE hold names (H7).
// `party` is set exactly for `booker` and `named_party`.
//
// FR-013 rows covered by plan step 6:
//   booker places a hold            → staff, in-app             (`placed`)
//   place names a party on a hold   → named party, email+in-app (`named`)
//   hold challenged                 → owner email+in-app; staff in-app;
//                                     named party in-app        (`challenged`)
//   challenge answered (release)    → staff, in-app             (`answered`)
//   place releases a booker's hold  → booker, email+in-app      (`released`)
//   booker releases its own hold    → staff, in-app             (`released`)
//   named party passes              → staff, in-app             (`passed`)
// The challenger's own "answered / lapsed" notice needs the challenger,
// which no column records yet (step 9 follow-up; the audit row carries it).
// ─────────────────────────────────────────────────────────────────────────────

export const REQUESTLESS_HOLD_INTENT_KINDS = [
  /**
   * New request-less holds. ONE intent per placement call (a digest): `dates`
   * and `holdIds` carry every hold it covers (the idempotency key hashes the
   * id set). Booker placement → staff; a PLACE placement naming a party →
   * that party.
   */
  "requestless_hold.placed",
  "requestless_hold.named",
  /** The hold at 1st was challenged; `respondBy` is the answer deadline. */
  "requestless_hold.challenged",
  /** The owner answered a challenge by releasing (book is plan step 7's). */
  "requestless_hold.answered",
  /** The hold was released by hand; `by` says which side did it. */
  "requestless_hold.released",
  /** The named party took its name off; the hold stays, unassigned. */
  "requestless_hold.passed",
] as const;

export type RequestlessHoldIntentKind =
  (typeof REQUESTLESS_HOLD_INTENT_KINDS)[number];

export type RequestlessHoldIntentAudience = "staff" | "booker" | "named_party";

export type RequestlessHoldNotificationIntent = {
  kind: RequestlessHoldIntentKind;
  holdId: string;
  placeId: string;
  calendarId: string;
  /** ISO `YYYY-MM-DD`, place-local — the (first) hold's date. */
  date: string;
  /** The hold's 1-based position, when the copy names one. */
  position?: number;
  /** Digests only (`placed` / `named` for 2+ holds): every date covered. */
  dates?: Array<{ date: string; position: number }>;
  /** Digests only: the hold ids covered (the idempotency key's set). */
  holdIds?: string[];
  respondBy?: Date;
  reason?: BookingHoldReleaseReason;
  /** `released` only: who released it. */
  by?: "staff" | "booker";
  /**
   * The staff member to route a `staff` notice to first (FR-016's "placedBy"
   * step): the hold's placer when staff placed it, the grant's giver for a
   * BOOKER hold (its placer is the booker, never staff). Null when no staff
   * member is known (a place hold kept on a revoke was placed by the
   * booker): routing goes straight to the place's edit-role members.
   */
  staffHumanId: string | null;
} & (
  | { audience: "staff"; party?: never }
  | { audience: "booker" | "named_party"; party: BookingHoldHolder }
);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const bookingHoldHolderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org"), orgId: z.uuid() }).strict(),
  z.object({ kind: z.literal("person"), humanId: z.uuid() }).strict(),
]);

const intentBase = {
  kind: z.enum(REQUESTLESS_HOLD_INTENT_KINDS),
  holdId: z.uuid(),
  placeId: z.uuid(),
  calendarId: z.uuid(),
  date: isoDate,
  position: z.number().int().min(1).optional(),
  dates: z
    .array(z.object({ date: isoDate, position: z.number().int().min(1) }).strict())
    .min(1)
    .optional(),
  holdIds: z.array(z.uuid()).min(1).optional(),
  respondBy: z.date().optional(),
  reason: bookingHoldReleaseReasonSchema.optional(),
  by: z.enum(["staff", "booker"]).optional(),
  staffHumanId: z.uuid().nullable(),
};

export const requestlessHoldNotificationIntentSchema = z.union(
  [
    z.object({ ...intentBase, audience: z.literal("staff") }).strict(),
    z
      .object({
        ...intentBase,
        audience: z.enum(["booker", "named_party"]),
        party: bookingHoldHolderSchema,
      })
      .strict(),
  ],
);
