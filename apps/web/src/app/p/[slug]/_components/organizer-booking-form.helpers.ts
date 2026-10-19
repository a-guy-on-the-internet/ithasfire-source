/**
 * Pure helpers for the organizer→performer "Request to book" form
 * (organizer-booking-requests FR-009). Kept free of React so they can be
 * unit-tested like `request-to-play-form.helpers`.
 *
 * Server-side limits live in
 * `packages/core/src/use-cases/booking-requests/create-organizer-booking-request.ts`
 * (message 10–2000 chars, 1–3 ISO dates, set-length must be a preset, fee
 * amount only for GUARANTEE / DOOR_SPLIT, optional own-event attach). The
 * single-source-of-truth constants come from core's dependency-free
 * `constants` leaf (NOT the use-case barrel) so this client bundle never
 * pulls the schema graph's `sanitize-html` transitive dep.
 */

import {
  BOOKING_SET_LENGTH_PRESETS,
  BOOKING_FEE_AMOUNT_MAX_CENTS,
} from "@th/core/use-cases/booking-requests/constants";
import { toMinorUnits } from "@th/core/lib/currency-utils";
import type { BookingFeeType } from "@th/types/repos/booking-requests";

import { getAppErrorCode } from "@/lib/app-error";
import {
  BOOKING_FEE_CURRENCY,
  BOOKING_MESSAGE_MAX,
  BOOKING_MESSAGE_MIN,
  BOOKING_MAX_DATES,
} from "./blocks/request-to-play-form.helpers";

/** Fee types that carry a concrete amount (mirrors the server cross-field rule). */
const PAYING_FEE_TYPES: readonly BookingFeeType[] = ["GUARANTEE", "DOOR_SPLIT"];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OrganizerBookingFormValues = {
  message: string;
  /** ISO `YYYY-MM-DD` strings; empty entries are dropped before validation. */
  preferredDates: string[];
  /** Raw select value — "" or one of `BOOKING_SET_LENGTH_PRESETS` as a string. */
  setLengthMinutes: string;
  /** Fee-ask type; "" means unspecified. */
  feeType: "" | BookingFeeType;
  /** Raw major-unit (dollars) money input; converted to cents on submit. */
  feeAmountDollars: string;
  /** Attached own-event id; "" means none. */
  attachedEventId: string;
};

export type OrganizerBookingFormErrorKey =
  | "admin.bkErrMessageTooShort"
  | "admin.bkErrDates"
  | "admin.bkErrSetLength"
  | "admin.bkErrFeeAmount";

/** Wire payload for `bookingRequests.createToPerformer` (minus identities). */
export type OrganizerBookingPayload = {
  message: string;
  preferredDates: string[];
  setLengthMinutes?: number;
  feeType?: BookingFeeType;
  feeAmountCents?: number;
  attachedEventId?: string;
};

/**
 * Validates form values; returns either the wire payload for
 * `bookingRequests.createToPerformer` or the i18n key of the first problem
 * found. Mirrors `buildBookingRequestPayload`'s posture for the shared fields.
 */
export function buildOrganizerBookingPayload(
  values: OrganizerBookingFormValues,
):
  | { ok: true; payload: OrganizerBookingPayload }
  | { ok: false; errorKey: OrganizerBookingFormErrorKey } {
  const message = values.message.trim();
  if (
    message.length < BOOKING_MESSAGE_MIN ||
    message.length > BOOKING_MESSAGE_MAX
  ) {
    return { ok: false, errorKey: "admin.bkErrMessageTooShort" };
  }

  const dates = values.preferredDates
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  if (
    dates.length < 1 ||
    dates.length > BOOKING_MAX_DATES ||
    dates.some((d) => !ISO_DATE_RE.test(d))
  ) {
    return { ok: false, errorKey: "admin.bkErrDates" };
  }

  let setLengthMinutes: number | undefined;
  const setLengthRaw = values.setLengthMinutes.trim();
  if (setLengthRaw.length > 0) {
    const parsed = Number(setLengthRaw);
    if (
      !Number.isInteger(parsed) ||
      !(BOOKING_SET_LENGTH_PRESETS as readonly number[]).includes(parsed)
    ) {
      return { ok: false, errorKey: "admin.bkErrSetLength" };
    }
    setLengthMinutes = parsed;
  }

  // Cross-field rule (mirrors the server refine): a fee amount is only ever
  // emitted for GUARANTEE / DOOR_SPLIT — for NEGOTIABLE or an unspecified fee
  // type the amount is dropped entirely.
  const feeType: BookingFeeType | undefined =
    values.feeType === "" ? undefined : values.feeType;
  const isPayingFee =
    feeType !== undefined && PAYING_FEE_TYPES.includes(feeType);
  let feeAmountCents: number | undefined;
  if (isPayingFee) {
    const amountRaw = values.feeAmountDollars.trim();
    if (amountRaw.length > 0) {
      const dollars = Number(amountRaw);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        return { ok: false, errorKey: "admin.bkErrFeeAmount" };
      }
      const cents = toMinorUnits(dollars, BOOKING_FEE_CURRENCY);
      if (
        !Number.isInteger(cents) ||
        cents <= 0 ||
        cents > BOOKING_FEE_AMOUNT_MAX_CENTS
      ) {
        return { ok: false, errorKey: "admin.bkErrFeeAmount" };
      }
      feeAmountCents = cents;
    }
  }

  const attachedEventId = values.attachedEventId.trim();

  return {
    ok: true,
    payload: {
      message,
      preferredDates: dates,
      ...(setLengthMinutes !== undefined ? { setLengthMinutes } : {}),
      ...(feeType !== undefined ? { feeType } : {}),
      ...(feeAmountCents !== undefined ? { feeAmountCents } : {}),
      ...(attachedEventId.length > 0 ? { attachedEventId } : {}),
    },
  };
}

type TrpcLikeError = {
  data?: { code?: string } | null;
  message?: string;
};

/**
 * Maps `bookingRequests.createToPerformer` failures to a user-facing i18n key.
 * Canonical AppErrorCodes come from the use case
 * (`PERFORMER_NOT_ACCEPTING_REQUESTS`, `DUPLICATE_OPEN_REQUEST`,
 * `EVENT_NOT_FOUND` / `NOT_RESOURCE_OWNER` for the attach,
 * `CANNOT_BOOK_OWN_ACT`).
 */
export function mapCreateOrganizerBookingError(err: unknown): string {
  const e = err as TrpcLikeError;
  const code = getAppErrorCode(err);
  if (code === "DUPLICATE_OPEN_REQUEST") return "admin.bkOrgErrDuplicate";
  if (code === "PERFORMER_NOT_ACCEPTING_REQUESTS") {
    return "admin.bkOrgErrNotAccepting";
  }
  if (code === "EVENT_NOT_FOUND" || code === "NOT_RESOURCE_OWNER") {
    return "admin.bkOrgErrEventNotOwned";
  }
  if (code === "CANNOT_BOOK_OWN_ACT") return "admin.bkOrgErrOwnAct";
  if (e?.data?.code === "FORBIDDEN") return "admin.bkErrForbidden";
  return "admin.bkErrGeneric";
}
