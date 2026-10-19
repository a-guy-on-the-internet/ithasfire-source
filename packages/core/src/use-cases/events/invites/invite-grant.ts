import { z } from "zod";

import type { EventUnlocksRepo } from "@th/ports/repos/event-unlocks";
import type { EventInvitesRepo, EventRecord } from "@th/ports/repos/events";

import { isEventPast } from "../../../lib/event-ended";

/**
 * What a verified invite grant cookie (`th_ei_<eventId>`) carries into core.
 * SERVER-INJECTED by the transport after it checks the cookie's HMAC; no
 * client input may supply it. `expMs` is the event end the cookie was minted
 * with (FR-008).
 */
export const inviteGrantSchema = z
  .object({
    inviteId: z.string().uuid(),
    expMs: z.number().int().nonnegative(),
  })
  .strict();

export type InviteGrant = z.infer<typeof inviteGrantSchema>;

/**
 * The ONE rule for "does this invite grant open this event right now?"
 * (gated-event invite links FR-006, FR-007, FR-008, R5, R14):
 *
 *   - the event is PASSWORD- or APPLICATION-gated, not cancelled, and has not
 *     ended (derived at check time, never stored), and the cookie's own
 *     expiry has not passed;
 *   - the invite exists and belongs to THIS event;
 *   - a SHARED invite counts even after it was reset or turned off: those
 *     stop NEW entries only (R5, R14). Only "Reset and remove everyone"
 *     ends its grants (`grantsRevokedAt` set);
 *   - a PERSONAL invite counts only while not revoked (FR-006: revoking a
 *     guest removes everyone it let in).
 *
 * Lookup failures propagate: an unanswerable grant must never read as open.
 */
export async function inviteGrantHolds(
  eventInvites: Pick<EventInvitesRepo, "getById">,
  event: Pick<EventRecord, "id" | "gateType" | "status" | "startsAt" | "endsAt">,
  grant: InviteGrant | null | undefined,
  now: Date,
): Promise<boolean> {
  if (!grant) return false;
  if (event.gateType !== "PASSWORD" && event.gateType !== "APPLICATION") {
    return false;
  }
  if (event.status === "CANCELLED") return false;
  if (isEventPast(event, now)) return false;
  if (grant.expMs <= now.getTime()) return false;

  const invite = await eventInvites.getById(grant.inviteId);
  if (!invite || invite.eventId !== event.id) return false;
  if (invite.kind === "PERSONAL" && invite.revokedAt !== null) return false;
  if (invite.kind === "SHARED" && invite.grantsRevokedAt !== null) return false;
  return true;
}

/**
 * Was THIS viewer's access to this event removed by "Reset and remove
 * everyone" (`setEventSharedInvite` RESET_AND_REMOVE, owner ruling
 * 2026-10-06: removed guests are told why)?
 *
 * It answers only from the viewer's OWN proof, so it can never tell anything
 * to someone who never held access:
 *
 *   - signed out: the HMAC-verified `th_ei_` grant (the transport drops a
 *     forged, unsigned, expired or other-event cookie before core sees it)
 *     names a SHARED invite of this event whose `grantsRevokedAt` is set.
 *     Only RESET_AND_REMOVE writes `grantsRevokedAt` (`revokeSharedGrants`);
 *     a plain RESET or DISABLE stamps `revokedAt` only, and keeps people in.
 *   - signed in: the viewer's own EventUnlock row is revoked, still names a
 *     SHARED invite of this event with `grantsRevokedAt` set, and was revoked
 *     at or after that stamp. RESET_AND_REMOVE revokes with the same `now` it
 *     stamps with; an unlock revoked EARLIER (removed some other way, before
 *     the reset) does not count. Re-entering by any route clears `revokedAt`
 *     (`upsert`), so a viewer who is back in never carries it.
 *
 * Like `inviteGrantHolds`, nothing is said once the event is ungated,
 * cancelled, or over: there is no gate to explain then.
 *
 * Call it only when the gate is shut for this viewer. Lookup failures
 * propagate; `getEventGateState` swallows and reports them, because this is
 * an explanation, never an access decision.
 */
export async function removedByInviteReset(
  repos: {
    eventInvites: Pick<EventInvitesRepo, "getById">;
    eventUnlocks: Pick<EventUnlocksRepo, "get">;
  },
  event: Pick<EventRecord, "id" | "gateType" | "status" | "startsAt" | "endsAt">,
  viewer: {
    grant: InviteGrant | null | undefined;
    humanId: string | null | undefined;
  },
  now: Date,
): Promise<boolean> {
  if (event.gateType !== "PASSWORD" && event.gateType !== "APPLICATION") {
    return false;
  }
  if (event.status === "CANCELLED") return false;
  if (isEventPast(event, now)) return false;

  const removedShared = async (inviteId: string, revokedAt?: Date) => {
    const invite = await repos.eventInvites.getById(inviteId);
    if (!invite || invite.eventId !== event.id) return false;
    if (invite.kind !== "SHARED" || invite.grantsRevokedAt === null) {
      return false;
    }
    return (
      revokedAt === undefined ||
      revokedAt.getTime() >= invite.grantsRevokedAt.getTime()
    );
  };

  if (viewer.grant && viewer.grant.expMs > now.getTime()) {
    if (await removedShared(viewer.grant.inviteId)) return true;
  }

  if (viewer.humanId) {
    const unlock = await repos.eventUnlocks.get(event.id, viewer.humanId);
    if (unlock && unlock.revokedAt !== null && unlock.inviteId !== null) {
      if (await removedShared(unlock.inviteId, unlock.revokedAt)) return true;
    }
  }
  return false;
}
