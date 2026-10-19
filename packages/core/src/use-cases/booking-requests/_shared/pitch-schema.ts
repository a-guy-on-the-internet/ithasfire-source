import { z } from "zod";

import {
  BOOKING_SET_LENGTH_PRESETS,
  BOOKING_FEE_AMOUNT_MAX_CENTS,
} from "../constants";
import {
  plainTextMultilineOptional,
  plainTextMultilineRequired,
} from "../../../lib/sanitize-plain-text";

// ─────────────────────────────────────────────────────────────────────────────
// Shared booking-pitch schema fragments
//
// Single source of truth for the pitch-field validation rules shared by the
// signed-in create path (`create-booking-request.ts`) and the anonymous embed
// inquiry (`embeds/create-booking-inquiry.ts`, booking-request-embed-button
// FR-004/NFR-002). Extracted 2026-07-13 WITHOUT changing
// `createBookingRequest`'s external contract — both callers `.extend()` this
// fragment with their own identity/context fields and re-apply `.strict()`.
// ─────────────────────────────────────────────────────────────────────────────

/** http(s)-only URL, ≤2000 chars. Direct API calls must be rejected too. */
export const optionalHttpUrl = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .optional();

/**
 * Act / band name rule. Optional on the signed-in path (the sender profile
 * already names them), REQUIRED on the anonymous embed form — chain
 * `.optional()` at the call site.
 */
export const bookingActNameSchema = z.string().trim().min(1).max(120);

/**
 * A requested night: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` once the performer
 * has also picked a start time from the venue's availability.
 *
 * The time is deliberately a bare wall clock with NO offset. The frame is the
 * venue's local time — that is what a bill means by "doors at 8" — and pinning
 * an offset here would freeze a UTC instant that DST later moves. Storage is
 * unchanged: `BookingRequest.preferredDates` is a JSON array of strings, and
 * every reader downstream already types it as `z.array(z.string())`, so a row
 * written before times existed still validates.
 */
export const bookingPreferredDateSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/,
    "preferred_date_format",
  )
  .refine((value) => {
    // The regex admits 2026-02-31; a round-trip through Date does not.
    const [datePart] = value.split("T");
    const [y, m, d] = datePart!.split("-").map(Number);
    const probe = new Date(Date.UTC(y!, m! - 1, d!));
    return (
      probe.getUTCFullYear() === y &&
      probe.getUTCMonth() === m! - 1 &&
      probe.getUTCDate() === d
    );
  }, "preferred_date_invalid");

/**
 * The pitch fields common to BOTH create paths, with identical rules:
 * sanitized multi-line free text, ISO preferred dates, preset-validated set
 * length, capped fee ask, and http(s)-only typed link slots.
 *
 * Deliberately NOT `.strict()` — callers extend it and apply strictness on
 * the final object.
 */
export const bookingPitchFieldsSchema = z.object({
  message: plainTextMultilineRequired(2000).pipe(z.string().min(10)),
  preferredDates: z.array(bookingPreferredDateSchema).min(1).max(10),
  expectedDraw: z.number().int().positive().max(1_000_000).optional(),
  genre: z.string().trim().min(1).max(120).optional(),
  lineupSize: z.number().int().min(1).max(100).optional(),
  setLengthMinutes: z
    .number()
    .int()
    .refine(
      (v) => (BOOKING_SET_LENGTH_PRESETS as readonly number[]).includes(v),
      { message: "set_length_not_a_preset" },
    )
    .optional(),
  // Sanitized multi-line free text (same posture as `message`) but optional
  // and without the 10-char floor.
  techNeeds: plainTextMultilineOptional(2000).optional(),
  feeType: z.enum(["GUARANTEE", "DOOR_SPLIT", "NEGOTIABLE"]).optional(),
  feeAmountCents: z
    .number()
    .int()
    .positive()
    .max(BOOKING_FEE_AMOUNT_MAX_CENTS)
    .optional(),
  // Typed link slots — replace the legacy `links` array on the create path.
  linkMusic: optionalHttpUrl,
  linkVideo: optionalHttpUrl,
  linkSocial: optionalHttpUrl,
  linkEpk: optionalHttpUrl,
});

/**
 * Cross-field fee-ask rule shared by both create paths: a fee amount only
 * makes sense for a concrete ask (GUARANTEE/DOOR_SPLIT). NEGOTIABLE (or an
 * omitted feeType) must not carry an amount. The amount itself stays optional
 * even for GUARANTEE/DOOR_SPLIT. Use as
 * `.refine(hasConsistentFeeAsk, FEE_ASK_REFINE_PARAMS)`.
 */
export function hasConsistentFeeAsk(v: {
  feeAmountCents?: number;
  feeType?: "GUARANTEE" | "DOOR_SPLIT" | "NEGOTIABLE";
}): boolean {
  return (
    v.feeAmountCents === undefined ||
    v.feeType === "GUARANTEE" ||
    v.feeType === "DOOR_SPLIT"
  );
}

/**
 * Refine params paired with {@link hasConsistentFeeAsk}. Deliberately NOT
 * `as const`: zod v4's refine config wants a MUTABLE `path: PropertyKey[]`,
 * and a readonly tuple fails typecheck.
 */
export const FEE_ASK_REFINE_PARAMS: {
  message: string;
  path: PropertyKey[];
} = {
  message: "fee_amount_requires_guarantee_or_door_split",
  path: ["feeAmountCents"],
};
