/**
 * The decision half of the legacy third-party-event migration, kept pure so
 * it can be tested without a database.
 *
 * WHY THIS EXISTS (venue-confirmation-and-booking-intents spec,
 * docs/specs/2026-08-27 — Locked decisions, "Migration of existing
 * third-party published events at places", and Migrations step (4)): since
 * the spec, a PUBLISHED event at a place whose owner is not the place's owner
 * renders ADDRESS-ONLY and blocks nothing until the venue confirms it. Every
 * such event that already existed needs the request the venue confirms —
 * the event-first shape, `originEventId` set — and the venue told. No
 * grandfathering; no grace window (orchestrator decision 2026-09-02: prod is
 * dark, the address-only rule already applies, and the SQL confirmed-filter
 * cannot express a per-event window).
 *
 * WHAT IS A CANDIDATE — every PUBLISHED event with a `placeId` that is:
 *   - not VENUE-OWNED: its org / human is not among the place's VERIFIED,
 *     unrevoked owners (`isVenueOwnedEvent` in core — mirrored on the raw
 *     ownership rows here, the way the seed's stamp step mirrors it);
 *   - not venue-CONFIRMED: no active stamp (`hasActiveVenueConfirmationStamp`
 *     — stamped, not withdrawn, and stamped for THIS place). A withdrawn or
 *     never-confirmed event is a candidate; the venue said "not mine" or
 *     never looked, and the request is how it looks;
 *   - not already asked: no request carries its id as `originEventId`
 *     (the unique column — this is the idempotency of a re-run);
 *   - owned by somebody: an ownerless community listing has no requester.
 */

export interface LegacyEventRow {
  id: string;
  title: string;
  orgId: string | null;
  humanId: string | null;
  placeId: string | null;
  status: string;
  venueConfirmedAt: Date | null;
  venueConfirmedPlaceId: string | null;
  venueConfirmationWithdrawnAt: Date | null;
  /** A request already carries this event as `originEventId`. */
  hasOriginRequest: boolean;
}

/** A VERIFIED, unrevoked PlaceOwnership row. */
export interface LegacyOwnershipRow {
  placeId: string;
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
}

export interface PlannedLegacyEvent {
  eventId: string;
  title: string;
  placeId: string;
  ownerType: "org" | "human";
  ownerId: string;
}

export type LegacyEventSkipReason =
  | "not_published"
  | "no_place"
  | "venue_owned"
  | "venue_confirmed"
  | "already_requested"
  | "no_owner";

export interface LegacyThirdPartyEventsPlan {
  candidates: PlannedLegacyEvent[];
  skipped: Array<{ eventId: string; reason: LegacyEventSkipReason }>;
}

function isVenueOwned(
  event: Pick<LegacyEventRow, "orgId" | "humanId">,
  owners: readonly LegacyOwnershipRow[],
): boolean {
  return owners.some(
    (o) =>
      (o.ownerType === "ORGANIZATION" &&
        event.orgId !== null &&
        o.ownerId === event.orgId) ||
      (o.ownerType === "HUMAN" &&
        event.humanId !== null &&
        o.ownerId === event.humanId),
  );
}

/** Mirrors core's `hasActiveVenueConfirmationStamp` on the raw row. */
function hasActiveStamp(
  event: Pick<
    LegacyEventRow,
    | "placeId"
    | "venueConfirmedAt"
    | "venueConfirmedPlaceId"
    | "venueConfirmationWithdrawnAt"
  >,
): boolean {
  return (
    event.venueConfirmedAt !== null &&
    event.venueConfirmationWithdrawnAt === null &&
    event.placeId !== null &&
    event.venueConfirmedPlaceId === event.placeId
  );
}

export function planLegacyThirdPartyEvents(
  events: readonly LegacyEventRow[],
  ownerships: readonly LegacyOwnershipRow[],
): LegacyThirdPartyEventsPlan {
  const ownersByPlace = new Map<string, LegacyOwnershipRow[]>();
  for (const o of ownerships) {
    const list = ownersByPlace.get(o.placeId) ?? [];
    list.push(o);
    ownersByPlace.set(o.placeId, list);
  }

  const candidates: PlannedLegacyEvent[] = [];
  const skipped: LegacyThirdPartyEventsPlan["skipped"] = [];
  const skip = (eventId: string, reason: LegacyEventSkipReason) => {
    skipped.push({ eventId, reason });
  };

  for (const event of events) {
    if (event.status !== "PUBLISHED") {
      skip(event.id, "not_published");
      continue;
    }
    if (event.placeId === null) {
      skip(event.id, "no_place");
      continue;
    }
    if (isVenueOwned(event, ownersByPlace.get(event.placeId) ?? [])) {
      skip(event.id, "venue_owned");
      continue;
    }
    if (hasActiveStamp(event)) {
      skip(event.id, "venue_confirmed");
      continue;
    }
    if (event.hasOriginRequest) {
      skip(event.id, "already_requested");
      continue;
    }
    const owner = event.orgId
      ? ({ ownerType: "org", ownerId: event.orgId } as const)
      : event.humanId
        ? ({ ownerType: "human", ownerId: event.humanId } as const)
        : null;
    if (owner === null) {
      skip(event.id, "no_owner");
      continue;
    }
    candidates.push({
      eventId: event.id,
      title: event.title,
      placeId: event.placeId,
      ...owner,
    });
  }

  return { candidates, skipped };
}
