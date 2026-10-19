import type { TxRepos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";

import {
  exactPlaceLocationColumns,
  placeExactAddressChanged,
} from "../../../lib/location/place-event-location";

/**
 * EVENTS FOLLOW THEIR PLACE'S ADDRESS EDITS (owner ruling 2026-10-14: "Make
 * events follow the edits").
 *
 * An event at a place stores a save-time copy of the place's location. When
 * an EXACT place's address is edited (still EXACT), that copy is re-written
 * from the new row, inside the place write's transaction, so the event page,
 * order page, wallet pass and ticket email show the current address and the
 * email's address text agrees with its map pin (which comes from the copy).
 *
 * SCOPE (decided by the orchestrator, 2026-10-14): UPCOMING events at this
 * place — DRAFT or PUBLISHED and not ended (an in-progress event follows; a
 * recurring listing with a SCHEDULED date still ahead follows). Past events
 * keep the address they happened at; ARCHIVED, CANCELLED and COMPLETED rows
 * are history. The SQL is `EventsRepo.followPlaceAddress`.
 *
 * TIMEZONE, PER EVENT: only events whose own `Event.timezone` equals the
 * place's zone after this write are written. The rest are left alone and
 * audited as skipped, reason `timezone_differs` (whether the place just moved
 * zones or the event's own zone already differed): moving the street
 * without the zone would show the right address at the wrong local time, and rewriting the zone silently
 * would move every listed start time (an open owner question). The zone is
 * the one this write derived, else the place's stored one; when neither is
 * known the follow writes NOTHING (conservative: we cannot tell whether the
 * events' local times still hold) and every upcoming event is audited as
 * skipped, reason `timezone_unknown`.
 *
 * NOT TOUCHED: the tax stamp (tax resolves from `placeId`, never from the
 * copy; sold orders carry their own frozen rate and situs), the slug and
 * `regionCode` (a published URL is never rewritten), the event's timezone,
 * the reveal schedule and privacy columns (EXACT → EXACT changes neither).
 *
 * Returns the followed event ids: the one place a ticket-holder notice would
 * hang off, if the owner rules for one (open question; nothing is sent
 * today). Throws on any repo failure, so the place write rolls back with it.
 */
export type PlaceAddressFollowOutcome =
  | { kind: "not_applicable"; eventIds: []; skippedEventIds: [] }
  | {
      kind: "applied";
      /** Upcoming events now carrying the new address. */
      eventIds: string[];
      /** Upcoming events left on the old address (timezone differs/unknown). */
      skippedEventIds: string[];
    };

/** Ids listed in one audit row; `eventCount` always carries the total. */
export const FOLLOW_AUDIT_MAX_IDS = 200;

export async function followPlaceAddressOntoEvents(
  tx: Pick<TxRepos, "events" | "audit">,
  input: {
    placeBefore: PlaceRecord;
    placeAfter: PlaceRecord;
    /**
     * The place's zone after this write: the one it derived, else the
     * stored one, else null (unknown).
     */
    placeTimezone: string | null;
    actorHumanId: string;
    at: Date;
  },
): Promise<PlaceAddressFollowOutcome> {
  const { placeBefore, placeAfter, placeTimezone, actorHumanId, at } = input;
  if (!placeExactAddressChanged(placeBefore, placeAfter)) {
    return { kind: "not_applicable", eventIds: [], skippedEventIds: [] };
  }

  const { followedIds, skippedIds } = await tx.events.followPlaceAddress({
    placeId: placeAfter.id,
    columns: exactPlaceLocationColumns(placeAfter),
    timezone: placeTimezone,
    now: at,
  });

  const fromAddress = addressSummary(placeBefore);
  const toAddress = addressSummary(placeAfter);

  if (followedIds.length > 0) {
    await tx.audit.log({
      entity: "place",
      entityId: placeAfter.id,
      action: "place.events_address_followed",
      data: {
        actorHumanId,
        ...cappedIds(followedIds),
        placeTimezone,
        fromAddress,
        toAddress,
      },
      at,
    });
  }
  if (skippedIds.length > 0) {
    await tx.audit.log({
      entity: "place",
      entityId: placeAfter.id,
      action: "place.events_address_follow_skipped",
      data: {
        actorHumanId,
        reason: placeTimezone === null ? "timezone_unknown" : "timezone_differs",
        ...cappedIds(skippedIds),
        placeTimezone,
        fromAddress,
        toAddress,
      },
      at,
    });
  }

  return { kind: "applied", eventIds: followedIds, skippedEventIds: skippedIds };
}

function cappedIds(ids: string[]) {
  return ids.length > FOLLOW_AUDIT_MAX_IDS
    ? {
        eventIds: ids.slice(0, FOLLOW_AUDIT_MAX_IDS),
        truncated: true,
        eventCount: ids.length,
      }
    : { eventIds: ids, eventCount: ids.length };
}

/** An EXACT place's address, as its events copy it (public by definition). */
function addressSummary(place: PlaceRecord) {
  const c = exactPlaceLocationColumns(place);
  return {
    addressText: c.addressText,
    locality: c.locality,
    region: c.region,
    postalCode: c.postalCode,
    countryCode: c.countryCode,
    lat: c.lat,
    lng: c.lng,
  };
}
