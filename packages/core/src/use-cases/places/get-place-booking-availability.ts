import { z } from "zod";

import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  CalendarAvailabilityRow,
  CalendarWithSpacesRow,
} from "@th/ports/repos/calendars";

import { venueConfirmedFilterFor } from "../../lib/venue-confirmation";
import {
  DEFAULT_SLOT_RULES,
  dayStatus,
  freeGaps,
  slotStarts,
  takenRatio,
  toBusy,
  toWindow,
  type Interval,
} from "../../lib/availability-intervals";
import {
  addLocalDays,
  localDateRange,
  localDateToApproxInstant,
  localDayOfWeek,
  resolveTimeZone,
  toLocalParts,
} from "../../lib/venue-local-time";

// ─────────────────────────────────────────────────────────────────────────────
// What a performer may see
//
// Public read, and every field is chosen against the same rule: it may state
// WHEN the space is free, and name what is ALREADY PUBLIC, and nothing else.
//   · opening windows        → posted hours, public
//   · published events       → already listed on the venue page, named
//   · blackout dates         → the date is gone; the venue's private `note` is
//                              read here but never placed on the output shape
//   · draft events / holds   → NOT represented; a venue that wants a night held
//                              blacks it out
//   · rival booking requests → NOT represented, ever
//
// Times are MINUTES FROM LOCAL MIDNIGHT, and may exceed 1440 for a night that
// runs past midnight. The server owns the timezone maths so the client renders
// numbers instead of re-deriving a venue's day from instants.
//
// ── CALENDAR SCOPE (venue-hierarchy FR-005/FR-007) ──────────────────────────
//
// This read is answered FOR ONE CALENDAR — the place's default unless the
// caller names one. Two things follow from that, and both were bugs before:
//
//   1. RULES come from `CalendarAvailability`, filtered to `calendarId === null`
//      (place-wide: the venue is shut) OR the resolved calendar's own rows.
//      Another calendar's hours must never widen or narrow this one. Same
//      filter as `get-calendar-events.ts` — deliberately identical.
//   2. OCCUPANCY is narrowed to the resolved calendar's SPACES: an event on a
//      space this calendar does not schedule into no longer blocks it.
//
// WHAT THIS DOES NOT DO — read before assuming a per-space answer. The unit of
// the answer is the CALENDAR, and a calendar's spaces are ORed flat: a day is
// busy if ANY of them is taken. So two spaces on ONE calendar still block each
// other, exactly as before. A venue only gets per-space clarity by putting the
// spaces on DIFFERENT calendars — which is the product's stated shape ("if you
// want per-space clarity, make a calendar per space"), and matters because the
// DEFAULT shape is one calendar joined to every space (`upsert-place` mints one
// Main Calendar + one Main Space; `backfill-venue-defaults` joins the default
// calendar to the place's first space). An owner who adds a "Back Bar" and
// ticks it onto Main Calendar gets the old behaviour, correctly.
//
// A per-space answer would need a per-space dimension in the day-status model
// (`windows`/`free`/`slots`/`takenRatio` are all currently one set per day) —
// a deliberate design move, not an oversight. `get-place-booking-availability.
// test.ts` documents the one-calendar-two-spaces case as KNOWN-BLOCKING.
//
// CONSERVATIVE NULL-SPACE RULE: an event with `spaceId: null` has UNKNOWN
// placement (pre-hierarchy rows, or an event created without naming a space),
// so it blocks EVERY calendar. Under-blocking oversells a room that is
// actually taken; over-blocking merely hides a slot a human can still grant by
// hand. The same reasoning applies one level up: when no calendar resolves, or
// the resolved calendar has no spaces joined, the space filter is NOT applied
// at all and the whole place's diary blocks — the pre-hierarchy behaviour.
//
// ISOLATION: `calendarId` is client-supplied on a PUBLIC procedure. It is
// resolved against the PLACE'S OWN calendar list, so a calendar belonging to
// another place is indistinguishable from a missing one (CALENDAR_NOT_FOUND) —
// same posture as `create-booking-request.ts`.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_DAYS = 62;

const intervalSchema = z
  .object({ start: z.number().int(), end: z.number().int() })
  .strict();

const bookingSchema = z
  .object({
    title: z.string(),
    start: z.number().int(),
    end: z.number().int().nullable(),
    /** The event carried no end time, so its span was assumed to closing. */
    assumedEnd: z.boolean(),
  })
  .strict();

const daySchema = z
  .object({
    date: z.string(),
    dayOfWeek: z.number().int().min(0).max(6),
    status: z.enum(["past", "blackout", "closed", "full", "partial", "free"]),
    windows: z.array(intervalSchema),
    free: z.array(intervalSchema),
    slots: z.array(z.number().int()),
    takenRatio: z.number().min(0).max(1),
    bookings: z.array(bookingSchema),
  })
  .strict();

export const getPlaceBookingAvailabilityInputSchema = z
  .object({
    placeId: z.string().uuid(),
    /** First local date to report, YYYY-MM-DD. */
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    days: z.number().int().min(1).max(MAX_DAYS).default(MAX_DAYS),
    /** Venue IANA timezone. Falls back to the platform default when absent. */
    timezone: z.string().optional(),
    /**
     * Which programming stream to answer for. Omitted = the place's DEFAULT
     * calendar. A calendar belonging to another place surfaces as
     * CALENDAR_NOT_FOUND (see the module header's isolation note).
     */
    calendarId: z.string().uuid().optional(),
  })
  .strict();

export type GetPlaceBookingAvailabilityInput = z.infer<
  typeof getPlaceBookingAvailabilityInputSchema
>;

export const getPlaceBookingAvailabilityOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    /**
     * The calendar this answer was computed for — echoed so a client that
     * omitted `calendarId` knows which stream it got, and can quote it back on
     * the booking request. Null when the place has no calendars at all, in
     * which case only place-wide rules applied.
     */
    calendarId: z.string().uuid().nullable(),
    timezone: z.string(),
    slotRules: z
      .object({
        step: z.number().int(),
        minSlot: z.number().int(),
        changeover: z.number().int(),
      })
      .strict(),
    days: z.array(daySchema),
  })
  .strict();

export type GetPlaceBookingAvailabilityOutput = z.infer<
  typeof getPlaceBookingAvailabilityOutputSchema
>;

export type GetPlaceBookingAvailabilityDeps = {
  repos: Pick<Repos, "calendars" | "events" | "places">;
  logger?: LoggerPort;
  /** Injected so "past" is testable and the caller controls the clock. */
  now?: () => Date;
};

/**
 * Which calendar this read answers for, and which spaces its occupancy is
 * narrowed to.
 *
 * `spaceIds` is UNDEFINED — not `[]` — whenever placement is unknowable (no
 * calendar, or a calendar with no spaces joined). Undefined means "do not
 * filter", so the whole place blocks; `[]` would mean "only null-space events
 * block", which is the under-blocking direction. The distinction is
 * load-bearing all the way down to the Prisma `where`.
 */
type ResolvedScope = {
  calendar: CalendarWithSpacesRow | null;
  spaceIds: string[] | undefined;
};

async function resolveScope(
  repos: Pick<Repos, "calendars">,
  placeId: string,
  requestedCalendarId: string | undefined,
): Promise<ResolvedScope> {
  // ONE read: the place's own calendars, each with its joined spaces. Reading
  // through the place is what makes cross-place isolation structural — a
  // foreign calendarId simply is not in this list, so it cannot be confirmed
  // to exist, let alone read from.
  const calendars = await repos.calendars.listByPlace(placeId);

  let calendar: CalendarWithSpacesRow | null;
  if (requestedCalendarId !== undefined) {
    calendar = calendars.find((c) => c.id === requestedCalendarId) ?? null;
    if (!calendar) {
      // Deliberately indistinguishable from "no such calendar anywhere" —
      // mirrors create-booking-request. A public procedure must not confirm
      // that some other venue owns this id.
      throw fail("CALENDAR_NOT_FOUND");
    }
  } else {
    // At most one default per place (SQL partial unique). A place with
    // calendars but no default is not an error here: fall through to
    // place-wide rules rather than guessing at a stream on the venue's behalf.
    calendar = calendars.find((c) => c.isDefault) ?? null;
  }

  // RETIRED spaces are kept: a retired room can still hold events booked
  // before it was retired, and those nights are genuinely gone.
  const spaceIds = calendar?.spaces.map((s) => s.id) ?? [];
  return {
    calendar,
    // Zero spaces = placement unknowable → block conservatively (see the
    // type's doc and the module header).
    spaceIds: spaceIds.length > 0 ? spaceIds : undefined,
  };
}

export async function getPlaceBookingAvailability(
  deps: GetPlaceBookingAvailabilityDeps,
  rawInput: unknown,
): Promise<GetPlaceBookingAvailabilityOutput> {
  const input = getPlaceBookingAvailabilityInputSchema.parse(rawInput);
  const timezone = resolveTimeZone(input.timezone);
  const now = deps.now?.() ?? new Date();
  const rules = DEFAULT_SLOT_RULES;

  const dates = localDateRange(input.from, input.days);
  const firstDate = dates[0]!;
  const lastDate = dates[dates.length - 1]!;

  // Resolved FIRST: a bad `calendarId` must fail before anything about this
  // place's diary or hours is read.
  const scope = await resolveScope(
    deps.repos,
    input.placeId,
    input.calendarId,
  );
  const resolvedCalendarId = scope.calendar?.id ?? null;

  // ── Rules: recurring weekday windows, and one-off closures ───────────────
  // Place-wide rows (`calendarId === null`) apply to every stream; the rest
  // must belong to THIS calendar. Same predicate as get-calendar-events.ts.
  // When no calendar resolved, `resolvedCalendarId` is null and the second
  // clause collapses into the first — place-wide rows, and nothing else.
  const allRules = await deps.repos.calendars.listAvailabilityForPlace(
    input.placeId,
  );
  const rules_rows = allRules.filter(
    (row: CalendarAvailabilityRow) =>
      row.calendarId === null || row.calendarId === resolvedCalendarId,
  );

  const windowsByDow = new Map<number, Interval[]>();
  const blackouts = new Set<string>();

  for (const row of rules_rows) {
    if (row.date) {
      // A dated row is a closure when `isOpen` is false. Dated OPEN rows are a
      // per-date override the picker does not model yet — ignored rather than
      // guessed at, so they can never silently widen availability.
      if (!row.isOpen) {
        blackouts.add(toLocalParts(row.date, timezone).date);
      }
      continue;
    }
    if (row.dayOfWeek === null || !row.isOpen) continue;
    if (!row.startTime || !row.endTime) continue;
    const window = toWindow(row.startTime, row.endTime);
    if (!window) continue;
    const list = windowsByDow.get(row.dayOfWeek) ?? [];
    list.push(window);
    windowsByDow.set(row.dayOfWeek, list);
  }

  // ── Bookings: PUBLISHED + public events only ─────────────────────────────
  // Read in OCCURRENCES, not events. A recurring listing is one event row that
  // takes the space many nights; an event-shaped read reports only the pinned
  // first date, leaving every later night of a residency falsely bookable.
  // Widened a day each side so a show that starts late on the boundary date
  // still lands in the right local bucket.
  //
  // Narrowed to THIS CALENDAR's spaces — an event on a space this calendar
  // does not schedule into no longer blocks it. (Spaces within the calendar
  // are ORed flat; see the module header's KNOWN-BLOCKING note.) `spaceIds` is
  // omitted — never `[]` — when placement is unknowable, which blocks the
  // whole place; the repo keeps null-space rows either way.
  //
  // Confirmed-only (venue-confirmation spec, docs/specs/2026-08-27): a
  // third-party event the venue has not vouched for occupies nothing — it is
  // excluded from availability exactly as from conflict detection. The place
  // row supplies the owner ids the SQL predicate needs (`isVenueConfirmed`).
  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  const occurrences = await deps.repos.events.listPublishedOccurrencesByPlace({
    placeId: input.placeId,
    from: localDateToApproxInstant(addLocalDays(firstDate, -1)),
    to: localDateToApproxInstant(addLocalDays(lastDate, 2)),
    limit: 500,
    // `!== undefined`, not truthiness: `[]` is truthy today, but the whole
    // point of the undefined/[] distinction is that it must not depend on that.
    ...(scope.spaceIds !== undefined ? { spaceIds: scope.spaceIds } : {}),
    venueConfirmedFor: venueConfirmedFilterFor(place),
  });

  const bookingsByDate = new Map<
    string,
    Array<{ start: number; end: number | null; title: string | null }>
  >();

  for (const event of occurrences) {
    const startParts = toLocalParts(event.startsAt, timezone);
    const endParts = event.endsAt ? toLocalParts(event.endsAt, timezone) : null;
    // An end on a later local date is a night that ran past midnight; express
    // it as minutes beyond 1440 rather than as a second, phantom booking.
    const end = endParts
      ? endParts.date === startParts.date
        ? endParts.minutes
        : endParts.minutes + 1440
      : null;
    const list = bookingsByDate.get(startParts.date) ?? [];
    list.push({ start: startParts.minutes, end, title: event.title });
    bookingsByDate.set(startParts.date, list);
  }

  const todayKey = toLocalParts(now, timezone).date;

  const days = dates.map((date) => {
    const dow = localDayOfWeek(date);
    const isBlackout = blackouts.has(date);
    const isPast = date < todayKey;
    const openWindows = windowsByDow.get(dow) ?? [];
    const busy = toBusy(bookingsByDate.get(date) ?? [], openWindows, rules);

    // A blackout or a past date closes the WHOLE date, so it must report no
    // bookable time at all — a status alone is not enough, because a client
    // that renders `slots` without re-checking `status` would happily offer a
    // slot on a night the venue has shut. Bookings are still reported: a show
    // on that date is public fact, and hiding it would look like a mistake.
    const bookable = !isBlackout && !isPast;
    const windows = bookable ? openWindows : [];
    const gaps = bookable ? freeGaps(openWindows, busy, rules) : [];
    const slots = bookable ? slotStarts(gaps, rules) : [];

    return {
      date,
      dayOfWeek: dow,
      status: dayStatus({
        isPast,
        isBlackout,
        windows: openWindows,
        gaps,
        slots,
      }),
      windows,
      free: gaps,
      slots,
      takenRatio: bookable ? takenRatio(openWindows, gaps) : 0,
      bookings: busy.map((b) => ({
        // A public event always has a title; the fallback keeps the shape
        // total rather than leaking an empty string as a name.
        title: b.title ?? "Booked",
        // Report the SHOW's own span, not the buffered one — the changeover is
        // ours, and a performer reading "6pm–1am" for a 7pm gig would be
        // misinformed about the room.
        start: b.start + rules.changeover,
        end: b.assumedEnd ? null : b.end - rules.changeover,
        assumedEnd: b.assumedEnd,
      })),
    };
  });

  return getPlaceBookingAvailabilityOutputSchema.parse({
    placeId: input.placeId,
    calendarId: resolvedCalendarId,
    timezone,
    slotRules: rules,
    days,
  });
}
