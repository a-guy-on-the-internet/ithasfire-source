import { DateTime } from "luxon";

import type {
  BookingHoldOwnerKind,
  BookingHoldRecord,
} from "@th/ports/repos/booking-holds";
import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";

// ─────────────────────────────────────────────────────────────────────────────
// Lazy expiry — ONE pure predicate shared by every surface (NFR-004).
//
// The hold table stores rows as written; nothing schedules an expiry (spec:
// no cron). Instead every read projects a lapse and every mutation settles
// it first (`settle-lapsed-holds.ts`). Three lapses exist:
//   - EXPIRED     (FR-007): CHALLENGED and `respondBy` has passed → released,
//                            WITH notifications (act + staff email).
//   - PAST_DATE   (FR-010): the hold's date is before today in the PLACE's
//                            zone → released, WITHOUT notifications.
//   - GRANT_ENDED (holds-without-a-request FR-004, lazy half): a BOOKER
//                            hold whose booking grant was revoked, or whose
//                            `expiresAt` is at or before now → released.
//                            The grant's end facts ride the hold record (the
//                            adapter joins the grant row).
//
// PAST_DATE wins when several apply: a night that has already come and gone
// is dead regardless of the challenge, and telling an act "your challenge
// lapsed" about a date in the past is noise, not information. EXPIRED then
// wins over GRANT_ENDED: the challenge ran out first in the hold's own
// story, and the revoke's exemption below must never mask it.
//
// EXEMPTION (`exemptGrantId`): revoking a grant stamps `revokedAt` and THEN
// settles the booker's lines in the same transaction (revoke.ts). Without
// the exemption that settle would release every hold the revoker chose to
// KEEP before they are converted to place holds. The revoke passes its own
// grant id; every other caller passes nothing.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingHoldLapse = "EXPIRED" | "PAST_DATE" | "GRANT_ENDED";

/**
 * What the predicate reads. Every hold record is one; the owner kind and the
 * grant's end facts are optional so a projection that only carries the line
 * columns still type-checks (it can then never see GRANT_ENDED).
 */
export type LapseCheckableHold = Pick<
  BookingHoldRecord,
  "status" | "respondBy" | "date"
> & {
  ownerKind?: BookingHoldOwnerKind;
  grantId?: string;
  grantRevokedAt?: Date | null;
  grantExpiresAt?: Date | null;
};

export type HoldLapseOptions = {
  /** A grant whose end is NOT a lapse in this call (the revoke's own). */
  exemptGrantId?: string;
};

/** The GRANT_ENDED rule alone: a BOOKER hold on a revoked or expired grant. */
export function isHoldGrantEnded(
  hold: LapseCheckableHold,
  now: Date,
  options: HoldLapseOptions = {},
): boolean {
  if (hold.ownerKind !== "BOOKER") return false;
  if (options.exemptGrantId !== undefined && hold.grantId === options.exemptGrantId) {
    return false;
  }
  if (hold.grantRevokedAt) return true;
  return (
    hold.grantExpiresAt !== null &&
    hold.grantExpiresAt !== undefined &&
    hold.grantExpiresAt.getTime() <= now.getTime()
  );
}

/** `YYYY-MM-DD` for `now` as seen in `zone` (an IANA zone, already resolved). */
export function todayInZone(now: Date, zone: string): string {
  const iso = DateTime.fromJSDate(now, { zone }).toISODate();
  // `toISODate` is null only for an invalid DateTime, which an invalid zone
  // produces. Callers resolve the zone with `resolveBookingTimezone` first,
  // so this is a programmer-error backstop, not a runtime branch.
  if (!iso) {
    throw new Error(`booking_hold_lapse_invalid_zone:${zone}`);
  }
  return iso;
}

/**
 * Null for a hold that is live and on time (or not live at all — RELEASED /
 * CONFIRMED rows never lapse), else which lapse applies.
 *
 * Pure: `now` and `placeTz` are inputs, so the same hold gives the same
 * answer on the inbox, the thread, the calendar and the mutation
 * precondition. Date comparison is LEXICAL on ISO `YYYY-MM-DD` strings, which
 * orders correctly by construction.
 */
export function isHoldLapsed(
  hold: LapseCheckableHold,
  now: Date,
  placeTz: string,
  options: HoldLapseOptions = {},
): BookingHoldLapse | null {
  if (
    !(LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(hold.status)
  ) {
    return null;
  }
  if (hold.date < todayInZone(now, placeTz)) {
    return "PAST_DATE";
  }
  if (
    hold.status === "CHALLENGED" &&
    hold.respondBy &&
    hold.respondBy.getTime() < now.getTime()
  ) {
    return "EXPIRED";
  }
  if (isHoldGrantEnded(hold, now, options)) {
    return "GRANT_ENDED";
  }
  return null;
}
