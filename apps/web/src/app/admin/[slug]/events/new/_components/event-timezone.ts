/**
 * Which clock the event builder types in — and when a venue selection moves it.
 *
 * ## The bug this exists to close
 *
 * A brand-new event used to be stamped with
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` — the ORGANIZER'S BROWSER
 * zone. The server resolves `Event.timezone` as
 * `explicit param > existing event's zone > linked Place.timezone > default`,
 * so an explicit browser zone outranks the venue's derived zone by design: a
 * Nashville organizer booking a New York room stamped `America/Chicago`, and
 * every time on that event (door time, address reveal, scheduled price flips,
 * sales windows) then rendered an hour off for everyone.
 *
 * ## Interpretation decision: THE WALL CLOCK STAYS, THE INSTANT MOVES
 *
 * When the zone adopts a venue AFTER the organizer has typed a date/time,
 * "8:00 PM" stays "8:00 PM at the venue". The underlying instant moves.
 * The alternative (freeze the instant, so 8:00 PM Central becomes 9:00 PM
 * Eastern) is rejected because:
 *
 *  1. An organizer typing 8:00 PM means DOORS AT 8, not an instant. Nobody
 *     books a room by UTC offset.
 *  2. The builder holds `startsAt`/`endsAt` as bare `datetime-local` wall-clock
 *     strings and only resolves them to instants at SAVE, via
 *     `toIsoInTimeZone(value, eventTimezone)`. "Wall clock stays" is therefore
 *     the zero-transform reading: nothing is re-derived, so nothing can drift
 *     through a DST bracket or a gap/ambiguous reading on the way.
 *  3. Freezing the instant would preserve an instant that was itself computed
 *     from the browser's zone — i.e. it would preserve the exact artifact this
 *     change removes.
 *
 * The cost is real and is why {@link resolveTimezoneForPlaceSelection} is
 * conservative: on an event that has ALREADY been saved, adopting a new zone
 * and saving moves the show. So adoption never fires on a no-op re-selection
 * of the venue the event is already at, and the caller must SHOW the organizer
 * that the zone moved (`admin.ebTimezoneAdoptedNote`) rather than doing it
 * silently.
 *
 * ## Two sources, one rule
 *
 * A zone can arrive from either half of the location control:
 *
 *  - a LINKED PLACE, which carries `Place.timezone` in the picker row —
 *    {@link resolveTimezoneForPlaceSelection};
 *  - a FREEFORM ADDRESS, which carries only lat/lng, so the zone has to be
 *    fetched (`places.resolveTimezone`) before it can be judged —
 *    {@link shouldRequestTimezoneForCoordinates} decides whether that fetch is
 *    worth making, and {@link resolveTimezoneForAddressCoordinates} judges the
 *    answer.
 *
 * Both funnel through the SAME adoption test ({@link adoptIfUsable}), so the
 * two sources cannot drift into different rules: a zone is adopted only when
 * it exists, the runtime knows it, and it differs from the current one.
 *
 * Pure (no React) so all callers — the full builder, quick-create, and the
 * address hook that wraps the endpoint — share one rule and it can be
 * unit-tested without rendering any of them.
 */

import { isKnownTimeZone } from "./event-builder-helpers";

/** The slice of a picked place this decision reads. */
export type TimezoneSourcePlace = {
  placeId: string;
  name: string;
  /** Null = unknown (legacy row / failed lookup / projection without it). */
  timezone: string | null;
};

/**
 * Where an adopted zone came from — drives which sentence the note shows.
 *
 * A venue has a name to put in the copy ("the local time at Bowery Ballroom").
 * A freeform address has none: the organizer typed a street, and echoing that
 * string back at them adds nothing, so the address variant names the source
 * generically. Modelled as a union rather than `name: string | null` so the
 * note cannot be handed "adopted, from nothing".
 */
export type TimezoneAdoptionSource =
  | { kind: "venue"; name: string }
  | { kind: "address" };

export type TimezoneAdoptionResult = {
  /** The zone the builder should type in after this selection. */
  timezone: string;
  /**
   * Non-null only when this actually MOVED the zone — carries what the
   * organizer needs told: what supplied the zone, and what it replaced.
   * Null means "nothing changed"; the caller must not re-announce.
   */
  adopted: {
    source: TimezoneAdoptionSource;
    timezone: string;
    previousTimezone: string;
  } | null;
};

/** A point on the map. Both halves required — a half-set pair is not a point. */
export type TimezoneCoordinates = { lat: number; lng: number };

/**
 * The shared adoption test, applied identically to a venue's stored zone and
 * to a freeform address's looked-up one.
 *
 * A candidate is adopted only when ALL of these hold:
 *
 *  - it exists (null = unknown → keep the current zone; never guess);
 *  - the runtime recognizes it. `toIsoInTimeZone` THROWS on an unknown id, so
 *    adopting an unparseable one would break save outright;
 *  - it differs from the current zone (otherwise there is nothing to announce).
 */
function adoptIfUsable(
  currentTimezone: string,
  candidate: string | null | undefined,
  source: TimezoneAdoptionSource,
): TimezoneAdoptionResult {
  const unchanged: TimezoneAdoptionResult = {
    timezone: currentTimezone,
    adopted: null,
  };

  if (!candidate) return unchanged;
  if (candidate === currentTimezone) return unchanged;
  if (!isKnownTimeZone(candidate)) return unchanged;

  return {
    timezone: candidate,
    adopted: {
      source,
      timezone: candidate,
      previousTimezone: currentTimezone,
    },
  };
}

/**
 * Stable identity for a point, used to answer "did the coordinates actually
 * change?" without floating-point equality games.
 *
 * Six decimals (~11 cm) matches the staleness key `LocationSection` already
 * uses for its reverse-geocode round trips, so the two gates agree on what
 * counts as "the same spot". Returns null for a missing or non-finite pair —
 * there is nothing to look up and nothing to compare.
 */
export function coordinateKey(
  coordinates: TimezoneCoordinates | null | undefined,
): string | null {
  if (!coordinates) return null;
  const { lat, lng } = coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Out of range: `places.resolveTimezone` validates -90..90 / -180..180 and
  // would 400. Treat it as "no point" rather than shipping a doomed request.
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export type ShouldRequestTimezoneArgs = {
  /** The address's coordinates right now (null/undefined = none). */
  coordinates: TimezoneCoordinates | null | undefined;
  /**
   * Key of the coordinates a lookup was last STARTED for — including the
   * baseline recorded when the address was hydrated or restored, which is why
   * simply loading an existing event asks for nothing.
   */
  lastRequestedKey: string | null;
};

/**
 * Is a `places.resolveTimezone` call warranted for these coordinates?
 *
 * The endpoint sits behind a reverse-geocode that fires on map drags and
 * address edits, and a drag re-emits the SAME point twice (once for the pin,
 * once when the geocoded address lands). Keying on the point collapses that to
 * one request and makes re-selecting the same address free.
 */
export function shouldRequestTimezoneForCoordinates({
  coordinates,
  lastRequestedKey,
}: ShouldRequestTimezoneArgs): boolean {
  const key = coordinateKey(coordinates);
  if (key === null) return false;
  return key !== lastRequestedKey;
}

export type ResolveTimezoneForAddressCoordinatesArgs = {
  /** The zone the builder is currently typing in. */
  currentTimezone: string;
  /** The point the lookup was made for. */
  requestedCoordinates: TimezoneCoordinates;
  /** The point the address holds NOW (null = the organizer cleared it). */
  currentCoordinates: TimezoneCoordinates | null | undefined;
  /** What the lookup returned. Null = unknown (ocean, data gap, failure). */
  timezone: string | null | undefined;
};

/**
 * Decide the builder's zone from a freeform address's looked-up zone.
 *
 * Beyond {@link adoptIfUsable}, one extra gate: the answer must still be about
 * the address on screen. The lookup is asynchronous, so a reply can land after
 * the organizer has dragged on or cleared the field — and clearing must NOT
 * revert the zone (the typed times keep meaning what they meant, and the only
 * thing to revert to is the browser zone this whole change exists to stop
 * trusting).
 */
export function resolveTimezoneForAddressCoordinates({
  currentTimezone,
  requestedCoordinates,
  currentCoordinates,
  timezone,
}: ResolveTimezoneForAddressCoordinatesArgs): TimezoneAdoptionResult {
  const requestedKey = coordinateKey(requestedCoordinates);
  const currentKey = coordinateKey(currentCoordinates);
  if (requestedKey === null || requestedKey !== currentKey) {
    return { timezone: currentTimezone, adopted: null };
  }
  return adoptIfUsable(currentTimezone, timezone, { kind: "address" });
}

export type ResolveTimezoneForPlaceSelectionArgs = {
  /** The zone the builder is currently typing in. */
  currentTimezone: string;
  /** The place that was selected BEFORE this change (null = none). */
  previousPlaceId: string | null;
  /** The newly selected place, or null when the organizer cleared it. */
  place: TimezoneSourcePlace | null;
};

/**
 * Decide the builder's zone after a place-picker selection.
 *
 * Adoption is deliberately narrow — beyond the shared {@link adoptIfUsable}
 * test (zone exists · runtime knows it · it differs), it only fires when:
 *
 *  - a place was selected (clearing NEVER reverts the zone: the organizer's
 *    typed times keep meaning what they meant, and there is nothing better to
 *    revert to than the browser zone we are trying to stop trusting);
 *  - it is a DIFFERENT place than the one already selected. Re-picking the
 *    venue the event is already at is a no-op, so it must not restamp an
 *    already-saved event whose stored zone disagrees with the venue's.
 */
export function resolveTimezoneForPlaceSelection({
  currentTimezone,
  previousPlaceId,
  place,
}: ResolveTimezoneForPlaceSelectionArgs): TimezoneAdoptionResult {
  const unchanged: TimezoneAdoptionResult = {
    timezone: currentTimezone,
    adopted: null,
  };

  if (!place) return unchanged;
  if (previousPlaceId !== null && previousPlaceId === place.placeId) {
    return unchanged;
  }

  return adoptIfUsable(currentTimezone, place.timezone, {
    kind: "venue",
    name: place.name,
  });
}
