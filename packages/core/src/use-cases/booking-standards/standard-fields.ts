import type { BookingIntent } from "@th/types/repos/booking-requests";
import type { BookingStandardField } from "@th/types/repos/booking-standards";

// ─────────────────────────────────────────────────────────────────────────────
// The booking-standard field catalogue + the ONE "is this field satisfied?"
// predicate table (venue-booking-standards spec, docs/specs/2026-09-25,
// FR-001 / FR-006, risk "client and server disagree on satisfied").
//
// Leaf module with an EMPTY runtime import graph (type imports only — no zod,
// no sanitize-html, nothing Node-only). The public request form imports this
// table into a client bundle so its live ticks and inline errors use the
// same rule the server's STANDARDS_UNMET gate uses. Keep it dependency-free,
// same posture as `../booking-requests/constants.ts`.
//
// Field names are the create payload's own keys:
//   - PERFORM fields: `bookingPitchFieldsSchema`
//     (../booking-requests/_shared/pitch-schema.ts), shared by the signed-in
//     create path and the anonymous embed inquiry, plus `bill`
//     (../booking-requests/_shared/bill-schema.ts).
//   - RENT / USE fields: `purpose`, `expectedAttendance`,
//     `requestedStartsAt` / `requestedEndsAt` on
//     `createBookingRequestBaseSchema`, whose `refineIntentShape` is what
//     makes them the RENT/USE form.
// A test pins every key below to those schemas' shapes, so a rename there
// fails here.
//
// TWO CONTRACTS FOR CALLERS (S2 / S3) — the table only agrees with itself if
// both sides feed it the same thing:
//   1. The CLIENT evaluates the SAME VALUES the server does. The form's live
//      ticks and inline errors run `isFieldSatisfied` over the OUTPUT of
//      `buildBookingRequestPayload` / `buildSpaceRequestPayload`
//      (apps/web/.../request-to-play-form.helpers.ts) — trimmed, parsed,
//      dropped-when-invalid — never over raw input text. A tick on "   " or
//      on a URL the builder drops is a tick the server will refuse.
//   2. The SERVER passes `placeRows: null` for an UNCLAIMED place (nobody has
//      authority to have set standards there), so it resolves to calendar
//      rows or the platform defaults only — see resolve-booking-standards.ts.
//
// Unknown fields are TOTAL, not a throw: a newer API can send a field an
// older web bundle has never heard of. Such a field applies to no intent, is
// always satisfied, and can never be REQUIRED.
// ─────────────────────────────────────────────────────────────────────────────

/** Every item a list may hold per (owner, intent) (FR-001). */
export const BOOKING_STANDARD_ITEMS_MAX = 12;
/** Venue-written example pitches per (owner, intent) (FR-002). */
export const BOOKING_PITCH_EXAMPLES_MAX = 3;
/** Column bounds (VarChar) — the write schemas cap the SANITIZED value. */
export const BOOKING_STANDARD_LABEL_MAX = 80;
export const BOOKING_STANDARD_HINT_MAX = 240;
export const BOOKING_PITCH_EXAMPLE_TITLE_MAX = 80;
export const BOOKING_PITCH_EXAMPLE_BODY_MAX = 1500;

/**
 * The fields of a booking-request payload a standard can point at. Every key
 * optional and nullable, so ONE type accepts all three callers:
 *   - `createBookingRequest`'s parsed input (PERFORM and RENT/USE),
 *   - `createBookingInquiry`'s parsed input (the anonymous embed, PERFORM),
 *   - the web form's payload builders (instants as ISO strings, pre-parse).
 */
export type BookingStandardsPayload = {
  readonly message?: string | null;
  readonly preferredDates?: readonly string[] | null;
  readonly expectedDraw?: number | null;
  readonly genre?: string | null;
  readonly lineupSize?: number | null;
  readonly setLengthMinutes?: number | null;
  readonly techNeeds?: string | null;
  readonly feeType?: string | null;
  readonly linkMusic?: string | null;
  readonly linkVideo?: string | null;
  readonly linkSocial?: string | null;
  readonly linkEpk?: string | null;
  /**
   * The signed-in bill (`includeSelf` + `acts`) or the anonymous embed's
   * (`acts` only — its `actName` is always the bill's first row).
   */
  readonly bill?: {
    readonly includeSelf?: boolean;
    readonly acts?: readonly unknown[];
  } | null;
  readonly purpose?: string | null;
  readonly expectedAttendance?: number | null;
  readonly requestedStartsAt?: Date | string | null;
  readonly requestedEndsAt?: Date | string | null;
};

export type BookingStandardFieldSpec = {
  /** The intents whose form HAS this field. CUSTOM applies to all. */
  readonly intents: readonly BookingIntent[];
  /**
   * The payload keys this field reads — where the form puts an inline error
   * for an unmet REQUIRED item (FR-005). `[]` for CUSTOM.
   */
  readonly payloadKeys: readonly (keyof BookingStandardsPayload)[];
  /**
   * Whether a venue may mark the item REQUIRED. False for CUSTOM (D2a:
   * nothing to check) and for the fields the create schema ALREADY demands
   * for every intent that has them (MESSAGE, PREFERRED_DATES for PERFORM;
   * PURPOSE, REQUESTED_WINDOW for RENT/USE) — a REQUIRED item there could
   * never be the thing that blocks, so it would only mislead. Those may still
   * be listed as SUGGESTED prompts. Core enforces this (the item schema); the
   * SQL CHECK covers CUSTOM only, so the catalogue can change without a
   * migration.
   */
  readonly canBeRequired: boolean;
  readonly isSatisfied: (payload: BookingStandardsPayload) => boolean;
};

const PERFORM_ONLY = ["PERFORM"] as const satisfies readonly BookingIntent[];
const SPACE_INTENTS = ["RENT", "USE"] as const satisfies readonly BookingIntent[];
const ALL_INTENTS = [
  "PERFORM",
  "RENT",
  "USE",
] as const satisfies readonly BookingIntent[];

/** Non-blank text. Whitespace-only is "not provided" on both sides. */
function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Every count / duration a standard can require is a positive number. */
function hasPositiveNumber(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** A parsed Date (server) or a parseable ISO string (the web payload). */
function hasInstant(value: Date | string | null | undefined): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return hasText(value) && !Number.isNaN(Date.parse(value as string));
}

/**
 * BILL means "the pitch names at least one act OTHER than the sender"
 * (review decision 2026-09-25, refining FR-006). The sender's own act never
 * counts — a REQUIRED bill item that the sender alone could meet would block
 * almost nothing. Since lineup v3 L12 an EMPTY bill (no sender, no acts) is
 * a legal request, and this item is what still refuses it where a venue
 * requires a bill. Therefore:
 *   - no bill (the pre-bill contract: the sender is the act) → NOT satisfied;
 *   - `includeSelf: true` with no `acts` → NOT satisfied;
 *   - ≥ 1 entry in `acts` (tagged or external) → satisfied;
 *   - the anonymous embed's bill: its `actName` is row 0 and is NOT in
 *     `acts`, so it is satisfied only by ≥ 1 act beyond it — the same rule.
 */
function billHasAnotherAct(bill: BookingStandardsPayload["bill"]): boolean {
  return (bill?.acts?.length ?? 0) > 0;
}

/**
 * The catalogue. A `Record` over the enum, so adding a Prisma/types member
 * without a row here is a compile error.
 */
export const BOOKING_STANDARD_FIELD_SPECS: {
  readonly [F in BookingStandardField]: BookingStandardFieldSpec;
} = {
  MESSAGE: {
    // PERFORM only: the RENT/USE form has no message box (the server derives
    // one from the purpose when absent), so a required message there could
    // never be met from the form.
    intents: PERFORM_ONLY,
    payloadKeys: ["message"],
    // Schema-mandatory for PERFORM (`refineIntentShape`).
    canBeRequired: false,
    isSatisfied: (p) => hasText(p.message),
  },
  PREFERRED_DATES: {
    intents: PERFORM_ONLY,
    payloadKeys: ["preferredDates"],
    // Schema-mandatory for PERFORM (`refineIntentShape`).
    canBeRequired: false,
    isSatisfied: (p) =>
      Array.isArray(p.preferredDates) &&
      p.preferredDates.some((date) => hasText(date)),
  },
  EXPECTED_DRAW: {
    intents: PERFORM_ONLY,
    payloadKeys: ["expectedDraw"],
    canBeRequired: true,
    isSatisfied: (p) => hasPositiveNumber(p.expectedDraw),
  },
  GENRE: {
    intents: PERFORM_ONLY,
    payloadKeys: ["genre"],
    canBeRequired: true,
    isSatisfied: (p) => hasText(p.genre),
  },
  LINEUP_SIZE: {
    intents: PERFORM_ONLY,
    payloadKeys: ["lineupSize"],
    canBeRequired: true,
    isSatisfied: (p) => hasPositiveNumber(p.lineupSize),
  },
  SET_LENGTH: {
    intents: PERFORM_ONLY,
    payloadKeys: ["setLengthMinutes"],
    canBeRequired: true,
    isSatisfied: (p) => hasPositiveNumber(p.setLengthMinutes),
  },
  TECH_NEEDS: {
    intents: PERFORM_ONLY,
    payloadKeys: ["techNeeds"],
    canBeRequired: true,
    isSatisfied: (p) => hasText(p.techNeeds),
  },
  FEE: {
    // The fee ASK: which kind (guarantee / door split / negotiable). The
    // amount stays optional even when a fee is required — NEGOTIABLE carries
    // none by rule (`hasConsistentFeeAsk`).
    intents: PERFORM_ONLY,
    payloadKeys: ["feeType"],
    canBeRequired: true,
    isSatisfied: (p) => hasText(p.feeType),
  },
  LINK_MUSIC: {
    intents: PERFORM_ONLY,
    payloadKeys: ["linkMusic"],
    canBeRequired: true,
    isSatisfied: (p) => hasText(p.linkMusic),
  },
  LINK_VIDEO: {
    intents: PERFORM_ONLY,
    payloadKeys: ["linkVideo"],
    canBeRequired: true,
    isSatisfied: (p) => hasText(p.linkVideo),
  },
  LINK_SOCIAL: {
    intents: PERFORM_ONLY,
    payloadKeys: ["linkSocial"],
    canBeRequired: true,
    isSatisfied: (p) => hasText(p.linkSocial),
  },
  LINK_EPK: {
    intents: PERFORM_ONLY,
    payloadKeys: ["linkEpk"],
    canBeRequired: true,
    isSatisfied: (p) => hasText(p.linkEpk),
  },
  BILL: {
    // RENT/USE with a bill is BILL_NOT_ALLOWED, so PERFORM only. Satisfied by
    // another act, never by the sender alone — see billHasAnotherAct.
    intents: PERFORM_ONLY,
    payloadKeys: ["bill"],
    canBeRequired: true,
    isSatisfied: (p) => billHasAnotherAct(p.bill),
  },
  PURPOSE: {
    intents: SPACE_INTENTS,
    payloadKeys: ["purpose"],
    // Schema-mandatory for RENT/USE (`refineIntentShape`).
    canBeRequired: false,
    isSatisfied: (p) => hasText(p.purpose),
  },
  EXPECTED_ATTENDANCE: {
    intents: SPACE_INTENTS,
    payloadKeys: ["expectedAttendance"],
    canBeRequired: true,
    isSatisfied: (p) => hasPositiveNumber(p.expectedAttendance),
  },
  REQUESTED_WINDOW: {
    // A window is both ends — a start with no end is not a window yet.
    intents: SPACE_INTENTS,
    payloadKeys: ["requestedStartsAt", "requestedEndsAt"],
    // Schema-mandatory for RENT/USE (`refineIntentShape`).
    canBeRequired: false,
    isSatisfied: (p) =>
      hasInstant(p.requestedStartsAt) && hasInstant(p.requestedEndsAt),
  },
  CUSTOM: {
    // D2a: a free-text line has nothing the server can check, so it is
    // always "satisfied" and can never be REQUIRED.
    intents: ALL_INTENTS,
    payloadKeys: [],
    canBeRequired: false,
    isSatisfied: () => true,
  },
};

/** Every field, in the enum's declaration order. */
export const BOOKING_STANDARD_FIELDS = Object.keys(
  BOOKING_STANDARD_FIELD_SPECS,
) as BookingStandardField[];

/**
 * The spec for a field this bundle KNOWS, else undefined. An own-property
 * check, not `in` / a bare index: "constructor" or "toString" from the wire
 * must not resolve to an Object.prototype member. (`hasOwnProperty.call`
 * rather than `Object.hasOwn` — this leaf ships to browsers and Hermes.)
 */
function specOf(field: string): BookingStandardFieldSpec | undefined {
  return Object.prototype.hasOwnProperty.call(BOOKING_STANDARD_FIELD_SPECS, field)
    ? BOOKING_STANDARD_FIELD_SPECS[field as BookingStandardField]
    : undefined;
}

/** Whether `field` is one this bundle knows (a newer API may send others). */
export function isKnownBookingStandardField(
  field: string,
): field is BookingStandardField {
  return specOf(field) !== undefined;
}

/**
 * Whether the form for `intent` has `field` at all. An UNKNOWN field applies
 * to no intent (so the resolver drops it) — never a throw.
 */
export function fieldAppliesToIntent(
  field: BookingStandardField,
  intent: BookingIntent,
): boolean {
  return specOf(field)?.intents.includes(intent) ?? false;
}

/** The fields a venue may pick for `intent` (the editor's menu), CUSTOM last. */
export function fieldsForIntent(intent: BookingIntent): BookingStandardField[] {
  return BOOKING_STANDARD_FIELDS.filter((field) =>
    fieldAppliesToIntent(field, intent),
  );
}

/**
 * Whether a venue may mark `field` REQUIRED — see
 * {@link BookingStandardFieldSpec.canBeRequired}. Unknown field → false.
 */
export function fieldCanBeRequired(field: BookingStandardField): boolean {
  return specOf(field)?.canBeRequired ?? false;
}

/**
 * THE predicate. Used by the form's live ticks and inline errors and by the
 * server's STANDARDS_UNMET gate — never re-implement it elsewhere. An
 * UNKNOWN field is satisfied (it can block nothing) — never a throw.
 */
export function isFieldSatisfied(
  field: BookingStandardField,
  payload: BookingStandardsPayload,
): boolean {
  return specOf(field)?.isSatisfied(payload) ?? true;
}
