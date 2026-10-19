import type { TxRepos } from "@th/ports/repos";
import type { BookingHoldHolder } from "@th/ports/repos/booking-holds";
import type { PlaceBookingGrantRecord } from "@th/ports/repos/place-booking-grants";

import { actorActsForParty } from "../../booking-requests/_shared/place-access";
import { grantStatusAt, sameGrantee } from "../../place-booking-grants/_shared/grant-context";

/**
 * Trap m (hold-line.ts LOCKING): a booker's authority, re-read on the grant
 * row under `SELECT … FOR SHARE` (`lockSharedAtPlace`), BEFORE any line lock
 * (lock order place → grant → line). Revoke and update write that row, so a
 * booker action and a revoke serialise on it. True when, on the locked row,
 * the grant is still active (accepted, not declined, revoked or expired at
 * `now`), still covers the calendar, still names `holder`, and the actor
 * still acts for `holder` (an org editor demoted since the gate, a delegation
 * withdrawn). Each caller throws its own refusal on false.
 */
export async function bookerGrantStillCoversUnderLock(
  tx: TxRepos,
  args: {
    grantId: string;
    placeId: string;
    calendarId: string;
    holder: BookingHoldHolder;
    actorHumanId: string;
    now: Date;
  },
): Promise<PlaceBookingGrantRecord | null> {
  const grant = await tx.placeBookingGrants.lockSharedAtPlace({
    id: args.grantId,
    placeId: args.placeId,
  });
  if (
    !grant ||
    grantStatusAt(grant, args.now) !== "active" ||
    (grant.calendarId !== null && grant.calendarId !== args.calendarId) ||
    !sameGrantee(grant.grantee, args.holder)
  ) {
    return null;
  }
  if (!(await actorActsForParty(tx, args.actorHumanId, args.holder))) return null;
  return grant;
}
