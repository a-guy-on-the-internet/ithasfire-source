/**
 * Shared display helpers for BookingRequest statuses (venue inbox +
 * performer-side sent list).
 *
 * The status VOCABULARY and the open-status SET are imported from
 * `@th/types/repos/booking-requests`, not re-declared here. Both used to be
 * hand-written literals that happened to agree with the server's; that made
 * the booking-inbox-placement spec's LOW risk ("countOpen and the list views
 * disagree") a live drift hazard, since `bookingRequests.countOpen` counts
 * `OPEN_BOOKING_REQUEST_STATUSES` while these filters asked for a parallel
 * copy. One definition now feeds the repo finders, the count use case and this
 * client filter.
 *
 * Safe for the client bundle: that module is a runtime LEAF — its only imports
 * are `import type`, fully erased (same reason `BookingInbox.tsx` and the
 * public `/p/[slug]` blocks already value-import from `@th/types`).
 */

import { OPEN_BOOKING_REQUEST_STATUSES } from "@th/types/repos/booking-requests";

export type { BookingRequestStatus } from "@th/types/repos/booking-requests";
import type { BookingRequestStatus } from "@th/types/repos/booking-requests";

/**
 * Open requests are the ones a venue can still act on. Spread into a mutable
 * array because the shared constant is a `readonly` tuple and every consumer
 * passes this straight into a tRPC `statuses` input typed as a plain array.
 */
export const OPEN_BOOKING_STATUSES: BookingRequestStatus[] = [
  ...OPEN_BOOKING_REQUEST_STATUSES,
];

export const BOOKING_STATUS_LABEL_KEYS: Record<BookingRequestStatus, string> = {
  PENDING: "admin.bkStatusPending",
  VIEWED: "admin.bkStatusViewed",
  ACCEPTED: "admin.bkStatusAccepted",
  DECLINED: "admin.bkStatusDeclined",
  WITHDRAWN: "admin.bkStatusWithdrawn",
  EXPIRED: "admin.bkStatusExpired",
};

export function bookingStatusTone(
  status: BookingRequestStatus,
): "success" | "info" | "warning" | "neutral" {
  switch (status) {
    case "PENDING":
      return "warning";
    case "VIEWED":
      return "info";
    case "ACCEPTED":
      return "success";
    default:
      return "neutral";
  }
}

/**
 * Parse a `preferredDates` entry as a LOCAL date (avoids the UTC day shift a
 * bare `new Date("2026-11-13")` causes).
 *
 * Entries may already carry a wall clock: `bookingPreferredDateSchema` admits
 * both `YYYY-MM-DD` and `YYYY-MM-DDTHH:MM` (the performer picks a start time
 * out of the venue's availability). Appending `T00:00:00` unconditionally
 * produced `"2026-11-13T21:00T00:00:00"` → Invalid Date → a `RangeError:
 * Invalid time value` the moment `Intl` formatted it, which crashed every
 * surface that lists preferred dates (the venue booking inbox, the sent/
 * received lists, and the agreement header's "From booking request" block).
 * MEASURED against a real timed request, not hypothesised.
 *
 * The time is dropped here on purpose: every caller formats with `dateStyle`
 * only, and the pitch's chosen START time already has a structured home on the
 * agreement (`proposedDate`). An unparseable entry yields an Invalid Date, as
 * before — callers that can receive legacy/corrupt rows must still guard.
 */
export function isoDateToLocal(iso: string): Date {
  const [datePart] = iso.split("T");
  return new Date(`${datePart}T00:00:00`);
}

/** Fee-ask type on a booking-request pitch (mirrors `@th/types`). */
export type BookingFeeType = "GUARANTEE" | "DOOR_SPLIT" | "NEGOTIABLE";

export const BOOKING_FEE_TYPE_LABEL_KEYS: Record<BookingFeeType, string> = {
  GUARANTEE: "admin.bkFeeTypeGUARANTEE",
  DOOR_SPLIT: "admin.bkFeeTypeDOOR_SPLIT",
  NEGOTIABLE: "admin.bkFeeTypeNEGOTIABLE",
};

/**
 * Human-readable set-length label, e.g. 15 → "15 min", 90 → "1 hr 30 min".
 * Language-neutral abbreviations (min / hr) matching the compact picker.
 */
export function formatSetLength(minutes: number): string {
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs === 0) return `${mins} min`;
  if (mins === 0) return `${hrs} hr`;
  return `${hrs} hr ${mins} min`;
}
