/**
 * Pure helpers for the event builder's THIRD-PARTY venue cascade
 * (venue-confirmation spec, docs/specs/2026-08-27 "UI / Flow › Event
 * builder"): intent → calendar, and what of it goes on the wire.
 *
 * THE SPACE PICKER IS GONE (owner ruling, extending the hold picker's — see
 * the block comment atop `components/bookings/HoldDatePicker.tsx`). A request
 * asks for a DATE on a CALENDAR; the room is settled at accept/confirm, on
 * the draft event, where it is real. The cascade PRINTS the calendar's rooms
 * read-only and sends no `spaceId` at all — a hidden pass-through of a
 * hydrated room the organizer can no longer see would ride along after they
 * switched calendars, and the server would reject it (`SPACE_NOT_FOUND` /
 * `assertSpaceOnCalendar`) over a choice nobody made.
 *
 * Owned or granted venues never reach any of this — `viewer.authority` from
 * `places.getBookingOptions` gates the cascade at the section, and a
 * placement is only ever MINTED for a third party. So `resolveBuilderPlacement`
 * does not re-check authority: a null placement is the owner's case by
 * construction.
 *
 * Pure (no React, no DOM) so the offer/default/transition rules and the wire
 * shape are pinned by unit tests rather than discovered in a browser — the
 * same posture as `quick-create-helpers.ts`'s `resolveQuickCreatePlacement`,
 * which this mirrors.
 */

import {
  BOOKING_INTENTS,
  calendarAcceptsIntent,
  calendarsForIntent,
  defaultCalendarId,
  offeredIntents,
  pickDefaultIntent,
  type BookingIntent,
  type BookingOptionCalendar,
} from "@/app/p/[slug]/_components/blocks/request-to-play-form.helpers";

import type { LocationMode, LocationState } from "./LocationSection";

export type { BookingIntent, BookingOptionCalendar };
export { BOOKING_INTENTS };

/**
 * What the organizer chose under the picked venue. Carries the `placeId` it
 * was chosen FOR so a placement left over from a previous venue can never be
 * sent against a new one (the save path rejects a foreign calendar/space
 * with CALENDAR_NOT_FOUND / SPACE_NOT_FOUND — the cross-place isolation
 * invariant).
 */
export type BuilderPlacement = {
  placeId: string;
  bookingIntent: BookingIntent;
  calendarId: string;
};

/**
 * Where the current venue came from. A venue PICKED in this session commits
 * the cascade's defaults as soon as the options load, so a plain pick-and-
 * save produces a request against the venue's default calendar. A venue
 * HYDRATED from a saved event does not: `getEventForEdit` carries no
 * placement columns, so the cascade cannot know what was stored and must
 * not overwrite it with defaults. The organizer touching a control is what
 * turns a hydrated placement into a sent one.
 */
export type BuilderPlacementSource = "picked" | "hydrated";

/** The three intents' control labels, in display order. */
export const INTENT_LABEL_KEYS: Record<BookingIntent, string> = {
  PERFORM: "admin.ebIntentPlay",
  RENT: "admin.ebIntentRent",
  USE: "admin.ebIntentUse",
};

const findCalendar = (
  calendars: readonly BookingOptionCalendar[],
  id: string,
): BookingOptionCalendar | undefined => calendars.find((c) => c.id === id);

/**
 * The cascade's opening state for a venue: the default intent (PERFORM when
 * offered — the builder is someone putting on a show — else the first room
 * intent) and the venue's default calendar among those accepting it.
 *
 * Null when nothing can be asked: no calendars at all (the server cannot
 * create a request without a calendar), or no calendar accepting any
 * intent. The section renders the "not taking requests" line for that.
 */
export function deriveDefaultPlacement(args: {
  placeId: string;
  calendars: readonly BookingOptionCalendar[];
  acceptsBookingRequests: boolean;
}): BuilderPlacement | null {
  const { placeId, calendars, acceptsBookingRequests } = args;
  if (!acceptsBookingRequests || calendars.length === 0) return null;
  const offered = offeredIntents(calendars);
  const bookingIntent = pickDefaultIntent({
    offered,
    performerModeOn: true,
  });
  if (!bookingIntent) return null;
  const accepting = calendarsForIntent(calendars, bookingIntent);
  const calendarId = defaultCalendarId(accepting);
  if (!calendarId) return null;
  return { placeId, bookingIntent, calendarId };
}

/**
 * Switching intent keeps the calendar when it still accepts the new intent,
 * else falls to the default among those that do.
 */
export function placementForIntent(
  calendars: readonly BookingOptionCalendar[],
  current: BuilderPlacement,
  bookingIntent: BookingIntent,
): BuilderPlacement {
  const accepting = calendarsForIntent(calendars, bookingIntent);
  // Nothing accepts it (the control renders that intent disabled, so only a
  // stale caller lands here): leave the placement alone rather than mint a
  // RENT/USE placement with no room, which the server would reject.
  if (accepting.length === 0) return current;
  const keep = findCalendar(accepting, current.calendarId);
  const calendarId = keep?.id ?? defaultCalendarId(accepting) ?? current.calendarId;
  return { ...current, bookingIntent, calendarId };
}

/**
 * The organizer picked another of the venue's calendars. Nothing else to
 * re-validate now that the placement carries no room — the calendar select
 * only ever lists calendars of THIS place that accept the chosen intent.
 */
export function placementForCalendar(
  current: BuilderPlacement,
  calendarId: string,
): BuilderPlacement {
  return { ...current, calendarId };
}

/**
 * A placement can only be sent once it names a calendar — the request is
 * routed by calendar, and the server cannot create one without it. It never
 * names a ROOM: RENT and USE ask for a date on a calendar and the venue names
 * the room when it accepts. (Which calendars are offered for those two is
 * `calendarAcceptsIntent`'s business, and it does require an active room —
 * owner ruling 2026-09-23.)
 */
export function placementIsComplete(placement: BuilderPlacement): boolean {
  return placement.calendarId.length > 0;
}

/** Which of the three intents at least one calendar accepts, for the control. */
export function intentIsOffered(
  calendars: readonly BookingOptionCalendar[],
  intent: BookingIntent,
): boolean {
  return calendars.some((c) => calendarAcceptsIntent(c, intent));
}

export type BuilderPlacementPayload = {
  calendarId?: string;
  bookingIntent?: BookingIntent;
};

/**
 * The placement keys to spread into the save input, or `{}`.
 *
 * Sent ONLY when the placement is DIRTY (the organizer touched the cascade,
 * or a venue picked this session committed its defaults) AND the venue is a
 * linked Place chosen in place mode AND the placement was minted for exactly
 * that place. Everything else — an untouched hydrated venue (its stored
 * placement is seeded for display but not re-sent), address mode, a cleared
 * venue, a placement left over from a different venue — sends nothing, which
 * the save reads as "leave the stored columns alone" (`undefined` = patch
 * semantics; a venue CHANGE clears them server-side regardless).
 *
 * NO `spaceId` — in either direction. The cascade has no room control, so
 * the builder has no room opinion to state: sending one would submit a value
 * the organizer cannot see, and sending `null` would wipe a room the VENUE
 * assigned when it accepted. Omitting the key is patch semantics — "leave
 * `Event.spaceId` as it is" (`resolveVenuePlacement`).
 */
export function resolveBuilderPlacement(args: {
  locationMode: LocationMode;
  location: LocationState;
  placement: BuilderPlacement | null;
  /** True once the organizer (or a session pick's default commit) set it. */
  dirty: boolean;
}): BuilderPlacementPayload {
  const { locationMode, location, placement, dirty } = args;
  if (!dirty) return {};
  if (locationMode !== "place") return {};
  if (!location.thPlaceId) return {};
  if (placement?.placeId !== location.thPlaceId) return {};
  return {
    calendarId: placement.calendarId,
    bookingIntent: placement.bookingIntent,
  };
}

/* ── Radiogroup keyboard grammar ─────────────────────────────────────────── */

/** DOM id for one intent's radio, so focus can follow selection. */
export const intentDomId = (idBase: string, intent: BookingIntent): string =>
  `${idBase}-intent-${intent.toLowerCase()}`;

/**
 * The intent an arrow / Home / End key lands on, or `null` when the key is
 * not one this group handles (the component must never `preventDefault` a
 * key it did not act on — Tab especially — or the group is a keyboard trap).
 *
 * `order` is the ENABLED intents in display order: disabled radios are
 * skipped by arrows the same way a `<fieldset>` of native radios skips
 * them. Wraps at both ends; with nothing selected, forward lands on the
 * first and backward on the last.
 */
export function nextIntentForKey(
  current: BookingIntent | undefined,
  key: string,
  order: readonly BookingIntent[],
): BookingIntent | null {
  if (order.length === 0) return null;

  const forward = key === "ArrowRight" || key === "ArrowDown";
  const backward = key === "ArrowLeft" || key === "ArrowUp";

  if (key === "Home") return order[0] ?? null;
  if (key === "End") return order[order.length - 1] ?? null;
  if (!forward && !backward) return null;

  const idx = current === undefined ? -1 : order.indexOf(current);
  if (idx === -1) {
    return forward ? (order[0] ?? null) : (order[order.length - 1] ?? null);
  }
  const next = forward
    ? (idx + 1) % order.length
    : (idx - 1 + order.length) % order.length;
  return order[next] ?? null;
}
