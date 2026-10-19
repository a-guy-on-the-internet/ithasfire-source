import type { EventRecord, EventsRepo } from "@th/ports/repos/events";
import type { PlacesRepo } from "@th/ports/repos/places";
import type { PlaceRecord } from "@th/ports/repos/places";

import {
  venueConfirmationArm,
  type VenueConfirmationEventFields,
} from "../venue-confirmation";
import {
  holderAddressLine,
  resolveHolderAddress,
  type HolderAddress,
  type HolderAddressEventSource,
} from "./resolve-holder-address";

/**
 * Batch form of `resolveHolderAddress` for surfaces that show many events at
 * once (a my-RSVPs page, a volunteer calendar feed, a reminder batch).
 *
 * ONE place read per DISTINCT venue, so a page of forty RSVPs at three venues
 * costs three reads. The same row feeds both the venue's privacy state and
 * its confirmation arm (`venueConfirmationArm`), so the two can never come
 * from different reads. A read that throws is NOT swallowed: every caller is
 * a holder surface where "no address" is the safe failure and "the event
 * row's address" is not, so the caller's own error path (a failed request, a
 * job retry) is the right place for it.
 *
 * `activeHolder` is the CALLER's word that every viewer these addresses reach
 * is an active holder (an existing RSVP, an accepted volunteer). A surface
 * whose rows mix holders and non-holders resolves with `true` and gates each
 * row itself (see `gatedRowAddressText`). A surface whose answer depends on
 * the EVENT (an RSVP-er holds nothing at a cancelled event) passes a
 * per-event function instead, so the place reads stay one per venue.
 */
export async function resolveHolderAddressesForEvents<
  TEvent extends HolderAddressEventSource &
    VenueConfirmationEventFields & { id: string; startsAt?: Date | null },
>(args: {
  repos: { places: Pick<PlacesRepo, "getById"> };
  events: ReadonlyArray<TEvent>;
  activeHolder: boolean | ((event: TEvent) => boolean);
  now: Date;
}): Promise<Map<string, HolderAddress>> {
  const { repos, events, now, activeHolder } = args;

  const placeIds = [
    ...new Set(
      events
        .map((event) => event.placeId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const places = new Map<string, PlaceRecord | null>(
    await Promise.all(
      placeIds.map(
        async (placeId) =>
          [placeId, await repos.places.getById(placeId)] as const,
      ),
    ),
  );

  const out = new Map<string, HolderAddress>();
  for (const event of events) {
    const place = event.placeId ? (places.get(event.placeId) ?? null) : null;
    out.set(
      event.id,
      resolveHolderAddress({
        event,
        place,
        venueConfirmationArm: venueConfirmationArm(event, place),
        activeHolder:
          typeof activeHolder === "function"
            ? activeHolder(event)
            : activeHolder,
        actOnBill: false,
        now,
      }),
    );
  }
  return out;
}

/**
 * Same, starting from event ids (the volunteer reads carry only the id). An
 * id whose event no longer resolves is ABSENT from the result; callers treat
 * absent as "no address" (`holderAddressLine(undefined) === null`).
 */
export async function loadHolderAddressesForEventIds(args: {
  repos: {
    events: Pick<EventsRepo, "findManyByIds">;
    places: Pick<PlacesRepo, "getById">;
  };
  eventIds: ReadonlyArray<string | null | undefined>;
  activeHolder: boolean;
  now: Date;
}): Promise<Map<string, HolderAddress>> {
  const ids = [
    ...new Set(
      args.eventIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    ),
  ];
  if (ids.length === 0) return new Map();
  const events: EventRecord[] = await args.repos.events.findManyByIds(ids);
  return resolveHolderAddressesForEvents({
    repos: args.repos,
    events,
    activeHolder: args.activeHolder,
    now: args.now,
  });
}

/**
 * For read models that carry the Event row's `addressText` next to an
 * `eventId` (the volunteer rows): the line the holder may see in its place.
 *
 * A row that carried no address keeps none — the gate never ADDS a location
 * (an ask-path calendar entry must stay location-less). A row whose event did
 * not resolve gets none (fail closed). A row whose viewer is not an active
 * holder (`activeHolder !== true`: a PENDING, REJECTED or WITHDRAWN
 * volunteer) gets none either, not even the coarse label: the location goes
 * to the volunteers the organizer accepted.
 */
export function gatedRowAddressText(
  row: { eventId: string | null; addressText: string | null },
  addresses: ReadonlyMap<string, HolderAddress>,
  viewer: { activeHolder: boolean },
): string | null {
  if (viewer.activeHolder !== true) return null;
  if (row.addressText === null || !row.eventId) return null;
  return holderAddressLine(addresses.get(row.eventId));
}

/** The event ids whose rows carry an address, i.e. the ones worth resolving. */
export function eventIdsWithAddress(
  rows: ReadonlyArray<{ eventId: string | null; addressText: string | null }>,
): string[] {
  return rows
    .filter((row) => row.addressText !== null && row.eventId)
    .map((row) => row.eventId as string);
}
