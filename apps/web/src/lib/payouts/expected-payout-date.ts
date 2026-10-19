import {
  computePayoutDate,
  PAYOUT_TZ,
} from "@th/core/lib/payout-scheduling/compute-payout-date";
import type { PayoutSchedule } from "@th/types";

/**
 * The date an event's ADVANCE sales mature for payout, from core's own rule
 * (`computePayoutDate`: day after for ASAP, otherwise Sundays at midnight
 * Central, with the Saturday/Sunday roll for WEEK_OF_EVENT). Same basis as
 * the credit writer: the event's end, or its start when it has no end.
 *
 * It is the SCHEDULE date. A sale made in the last two business days before
 * it (door sales, mostly) waits for its own funds to clear
 * (`applyAvailabilityFloor`), so the copy says "expected", not "on".
 *
 * Format the result with `PAYOUT_DATE_FORMAT` so the calendar day is the
 * Central one: midnight CT is still the previous evening on the US west
 * coast.
 */
export function expectedPayoutDate(
  schedule: PayoutSchedule,
  event: {
    startsAt?: Date | string | null;
    endsAt?: Date | string | null;
  },
): Date | null {
  const basis = event.endsAt ?? event.startsAt;
  if (!basis) return null;
  const date = basis instanceof Date ? basis : new Date(basis);
  if (Number.isNaN(date.getTime())) return null;
  return computePayoutDate(date, schedule);
}

/** `Intl.DateTimeFormat` options for an expected payout date. */
export const PAYOUT_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: PAYOUT_TZ,
};
