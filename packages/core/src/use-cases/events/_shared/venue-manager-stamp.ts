import type { AuthZPort } from "@th/ports/authz";
import type { TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

import {
  hasActiveVenueConfirmationStamp,
  isVenueOwnedEvent,
} from "../../../lib/venue-confirmation";

/**
 * THE VENUE SPEAKING THROUGH A SAVE (place-address-withholding W1 + N1,
 * 2026-09-25).
 *
 * Sarah owns a house personally and runs its shows under her org. The owner
 * arm of `isVenueConfirmed` matches only when the event's org / human is on
 * the place's owner list, so her org's shows read as a stranger's: at a
 * house that withholds its address, their ticket holders stayed locked until
 * she confirmed her own show in her own venue inbox.
 *
 * The ruling: when the SAVING actor can MANAGE the event's place
 * (`authz.canManagePlace` — OWNER / ADMIN / EDITOR of a place-owning org, or
 * a verified direct owner; never "any membership"), the save IS the venue's
 * word and stamps the confirmation. The EDITOR bar is ruled acceptable
 * (2026-09-25): an EDITOR of the owning org can already read the venue's
 * address and create venue-owned events, so the stamp gives them nothing
 * they do not have. The stamp goes through the same repo write the grant
 * path and the venue inbox use. The stamp arm then applies, with its
 * day-before floor (a venue that wants EXACT-time reveals owns the event
 * directly and gets the owner arm).
 *
 * WHEN a stamp is (re)written is the caller's rule (R3-2): the save stamps
 * a manager's show that has no active stamp, or that THIS save moved; an
 * unrelated edit of a show the organizer moved re-stamps nothing, so the
 * floor stays on the date the venue confirmed. Publish stamps only when no
 * stamp is active. This helper then writes only a stamp that is not already
 * CURRENT (`venueStampIsCurrent`).
 */

/** A stamp is current when active for this place AND recorded at this start. */
export function venueStampIsCurrent(
  event: Pick<
    EventRecord,
    | "placeId"
    | "startsAt"
    | "venueConfirmedAt"
    | "venueConfirmationWithdrawnAt"
    | "venueConfirmedPlaceId"
    | "venueConfirmedStartsAt"
  >,
): boolean {
  const confirmedStartsAt = event.venueConfirmedStartsAt ?? null;
  return (
    hasActiveVenueConfirmationStamp(event) &&
    confirmedStartsAt !== null &&
    confirmedStartsAt.getTime() === event.startsAt.getTime()
  );
}

/**
 * Whether `actorHumanId` may manage `placeId` — `canManagePlace` has the
 * final word; the rule lives in the authz adapter and is not re-derived here.
 */
export async function actorManagesPlace(
  authz: Pick<AuthZPort, "canManagePlace">,
  args: { actorHumanId: string; placeId: string },
): Promise<boolean> {
  const result = await authz.canManagePlace({
    actorHumanId: args.actorHumanId,
    placeId: args.placeId,
  });
  // Anything but a literal `allowed: true` is "not a manager" (fail closed).
  return result?.allowed === true;
}

/** Why a save stamped the venue confirmation, for the audit trail. */
export type VenueSaveStampVia = "grant" | "manager";

/**
 * The stamp's provenance. A grant stamp names its grant, so revoking a grant
 * (holds-without-a-request FR-003) can find the events confirmed under it.
 */
export type VenueSaveStampSource =
  | { via: "grant"; grantId: string }
  | { via: "manager" };

/**
 * Stamp (or re-stamp) the venue confirmation on a just-saved row, inside the
 * save's transaction, and audit it. A no-op returning the row unchanged when
 * the stamp is already current. The adapter records `venueConfirmedStartsAt`
 * from the row itself (N1).
 */
export async function stampVenueConfirmationForSave(
  tx: Pick<TxRepos, "events" | "audit">,
  args: {
    event: EventRecord;
    actorHumanId: string;
    at: Date;
  } & VenueSaveStampSource,
): Promise<EventRecord> {
  const placeId = args.event.placeId ?? null;
  if (placeId === null || venueStampIsCurrent(args.event)) return args.event;

  // A re-stamp for the SAME place keeps the booking request the original
  // confirmation came from: the provenance does not change because the
  // venue re-vouched for a new date.
  const priorRequestId =
    (args.event.venueConfirmedPlaceId ?? null) === placeId
      ? (args.event.venueConfirmationRequestId ?? null)
      : null;
  const stamped = await tx.events.setVenueConfirmation({
    eventId: args.event.id,
    placeId,
    // The saver vouches for their own event: a grant-holder the venue
    // trusts, or a person who manages the venue itself.
    confirmedByHumanId: args.actorHumanId,
    bookingRequestId: priorRequestId,
    at: args.at,
  });
  await tx.audit.log({
    entity: "event",
    entityId: stamped.id,
    action:
      args.via === "grant"
        ? "event.place_confirmed_by_grant"
        : "event.place_confirmed_by_manager",
    data: {
      placeId,
      calendarId: stamped.calendarId ?? null,
      actorHumanId: args.actorHumanId,
      confirmedStartsAt: stamped.startsAt.toISOString(),
      // A re-stamp after the saver moved the show, vs a first stamp.
      restamp: (args.event.venueConfirmedAt ?? null) !== null,
      // The grant the stamp rides (FR-003 revoke reads it back).
      ...(args.via === "grant" ? { grantId: args.grantId } : {}),
    },
    at: args.at,
  });
  return stamped;
}

/**
 * The place `actorHumanId` MANAGES among `[placeId]`, probed BEFORE a
 * transaction opens, or null. `canManagePlace` reads through the ROOT repos
 * (its own pool connection); asking it from inside an open transaction would
 * hold one connection while waiting on another, and enough concurrent saves
 * doing that starve the pool. So callers probe first and carry the answer
 * into their transaction, where {@link stampForPlaceManager} only honours it
 * for the SAME place.
 */
export async function probeManagedPlace(
  authz: Pick<AuthZPort, "canManagePlace">,
  args: { actorHumanId: string; placeId: string | null | undefined },
): Promise<string | null> {
  const placeId = args.placeId ?? null;
  if (placeId === null) return null;
  return (await actorManagesPlace(authz, {
    actorHumanId: args.actorHumanId,
    placeId,
  }))
    ? placeId
    : null;
}

/**
 * The W1 rule inside a transaction, for a transition with no trust
 * classification of its own (`publishEvent`): stamp when the event is at the
 * place the actor was probed to manage (`managedPlaceId`, from
 * {@link probeManagedPlace} — an event that moved since the probe gets
 * nothing), the owner arm does not already hold, there is no deliberate
 * withdrawal, and NO stamp is active (R3-2: publishing does not move the
 * show, so an active stamp — even one for a date the organizer has since
 * moved away from — is left exactly as the venue wrote it). Returns the row
 * to carry forward (stamped or unchanged).
 */
export async function stampForPlaceManager(
  tx: Pick<TxRepos, "events" | "audit" | "places">,
  args: {
    event: EventRecord;
    actorHumanId: string;
    managedPlaceId: string | null;
    at: Date;
  },
): Promise<EventRecord> {
  const placeId = args.event.placeId ?? null;
  if (placeId === null || placeId !== args.managedPlaceId) return args.event;
  if ((args.event.venueConfirmationWithdrawnAt ?? null) !== null) {
    return args.event;
  }
  if (hasActiveVenueConfirmationStamp(args.event)) return args.event;
  const place = await tx.places.getById(placeId);
  // No place row: nothing to vouch through. Owner arm: nothing to stamp.
  if (!place || isVenueOwnedEvent(args.event, place)) return args.event;
  return stampVenueConfirmationForSave(tx, {
    event: args.event,
    actorHumanId: args.actorHumanId,
    via: "manager",
    at: args.at,
  });
}
