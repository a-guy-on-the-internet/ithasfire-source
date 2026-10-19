import { z } from "zod";

import {
  plainTextOptional,
  plainTextRequired,
} from "../../../lib/sanitize-plain-text";
import { bookingRequestActRoleSchema } from "./bill-items";
import { optionalHttpUrl } from "./pitch-schema";

// ─────────────────────────────────────────────────────────────────────────────
// The bill on a booking request (lineup-booking-requests v2, FR-002 / FR-005,
// docs/specs/2026-09-25/completed/lineup-booking-requests-v2.spec.yaml).
//
// One definition of "an act on the bill" for every entrance: the signed-in
// create path (`createBookingRequest`), the anonymous embed inquiry
// (`createBookingInquiry`, EXTERNAL acts only) and — via the create path's
// base schema — the transport inputs derived from them.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Most rows one request's bill may hold, the sender's own act included. The
 * inbox reads a bill as one batched child read per page (NFR-003, "cap 12
 * per request"), so this is the TOTAL, not the count of `acts[]` alone.
 */
export const BOOKING_BILL_MAX_ROWS = 12;

/** Free-text act name bound (NFR-001) — the same 120 as `actName`. */
export const BOOKING_BILL_ACT_NAME_MAX_LENGTH = 120;

/**
 * Extra free-text acts an ANONYMOUS inquiry may add. The inquiry's own
 * `actName` is always row 0, so 11 extras keep it at the same total cap.
 */
export const BOOKING_BILL_ANONYMOUS_MAX_EXTRA_ACTS = BOOKING_BILL_MAX_ROWS - 1;

/** `BookingRequestAct.customRoleLabel` / EventHuman's own bound (v3 L13). */
export const BOOKING_BILL_CUSTOM_ROLE_LABEL_MAX_LENGTH = 60;

/**
 * Role + label on one signed-in act (v3 L13). `role` defaults to PERFORMER
 * in the use case. The label is sanitized BEFORE its length check (house
 * `plainTextOptional`); it only means something beside OTHER, and — like
 * `attachEventHuman` — the use case drops it for any other role instead of
 * refusing the request (the SQL CHECK would refuse the row).
 */
const bookingBillActRoleFields = {
  /** EventHuman's role vocabulary — what a lineup row carries (v3 L13). */
  role: bookingRequestActRoleSchema.optional(),
  customRoleLabel: plainTextOptional(
    BOOKING_BILL_CUSTOM_ROLE_LABEL_MAX_LENGTH,
  ).optional(),
};

/**
 * A platform act the sender tags (notified; joins or passes): a person
 * (`humanId`) or, since v3 L17, a group (`orgId`) — exactly one of the two.
 * `humanId` keeps its v2 key so every client that predates groups is
 * unchanged.
 */
export const bookingBillTaggedActSchema = z
  .object({
    kind: z.literal("tagged"),
    humanId: z.uuid().optional(),
    orgId: z.uuid().optional(),
    ...bookingBillActRoleFields,
  })
  .strict()
  .refine((act) => (act.humanId === undefined) !== (act.orgId === undefined), {
    message: "tagged_act_person_or_group",
    path: ["humanId"],
  });

/**
 * A free-text act. The name is sanitized BEFORE the length check (house
 * `plainTextRequired`); the URL is http(s)-only through the shared
 * `optionalHttpUrl` (NFR-001).
 */
export const bookingBillExternalActSchema = z
  .object({
    kind: z.literal("external"),
    name: plainTextRequired(BOOKING_BILL_ACT_NAME_MAX_LENGTH),
    url: optionalHttpUrl,
  })
  .strict();

/**
 * A free-text act on the SIGNED-IN bill: the shared external shape plus a
 * role (v3 L13). The anonymous embed keeps {@link bookingBillExternalActSchema}
 * as is — its rows stay PERFORMERs.
 */
export const bookingBillSignedInExternalActSchema =
  bookingBillExternalActSchema.extend(bookingBillActRoleFields);

export const bookingBillActSchema = z.discriminatedUnion("kind", [
  bookingBillTaggedActSchema,
  bookingBillSignedInExternalActSchema,
]);

/**
 * The signed-in bill (FR-002). `includeSelf` puts the SENDER's own act on it
 * (row 0 — the headliner by default); `acts` follow in the order given.
 *
 * Cross-row rules that need a typed error (a duplicate or self tag →
 * ACT_NOT_TAGGABLE) live in the use case, not here: a refine can only raise
 * `invalid_input`. The total-rows cap is pure shape, so it IS here. An empty
 * bill (`includeSelf: false`, no acts) is legal since v3 L12 — the request
 * names only the sender and the event is minted with an empty lineup.
 */
export const bookingBillSchema = z
  .object({
    includeSelf: z.boolean(),
    acts: z.array(bookingBillActSchema).max(BOOKING_BILL_MAX_ROWS),
  })
  .strict()
  .refine(
    (bill) =>
      (bill.includeSelf ? 1 : 0) + bill.acts.length <= BOOKING_BILL_MAX_ROWS,
    { message: "bill_too_long", path: ["acts"] },
  );

/**
 * The anonymous embed's bill (FR-005): EXTERNAL acts only. Strict all the
 * way down, so a `tagged` entry — or a stray `humanId` on an external one —
 * is a schema 400: an anonymous form must never become a way to probe which
 * humans exist.
 */
export const anonymousBookingBillSchema = z
  .object({
    acts: z
      .array(bookingBillExternalActSchema)
      .max(BOOKING_BILL_ANONYMOUS_MAX_EXTRA_ACTS),
  })
  .strict();

export type BookingBillInput = z.infer<typeof bookingBillSchema>;
export type BookingBillActInput = z.infer<typeof bookingBillActSchema>;
export type AnonymousBookingBillInput = z.infer<
  typeof anonymousBookingBillSchema
>;
