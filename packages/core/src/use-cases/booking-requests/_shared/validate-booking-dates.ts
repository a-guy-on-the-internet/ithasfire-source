import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { addLocalDays } from "../../../lib/venue-local-time";
import {
  getPlaceBookingAvailability,
  type GetPlaceBookingAvailabilityDeps,
} from "../../places/get-place-booking-availability";

// ─────────────────────────────────────────────────────────────────────────────
// Server-side check of requested nights against the venue's availability.
//
// The picker is a courtesy; this is the authority. Without it a crafted request
// books a dark Monday at 4am, because `preferredDates` is otherwise just a
// string the client chose.
//
// THE ESCAPE HATCH THAT MATTERS: a venue that has never set opening hours has
// no policy to enforce, and today that is most of them. Rejecting against an
// empty ruleset would break booking requests platform-wide. So the window and
// slot rules only apply to venues that have actually declared hours; a venue
// with no rows at all is still checked for past dates, and a venue with only
// blackout rows is still checked for those.
//
// CALENDAR SCOPE: the check must be answered against the SAME calendar the
// request routes to, or a performer picking a slot the "Social Club" offers is
// rejected against the main stage's hours. `calendarId` is threaded through
// verbatim, including its CALENDAR_NOT_FOUND isolation behaviour.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingDateProblem = {
  /** The offending entry, exactly as submitted. */
  value: string;
  reason: "past" | "closed" | "blackout" | "full" | "time_not_offered";
};

export type ValidateBookingDatesDeps = {
  repos: Pick<Repos, "calendars" | "events" | "places">;
  logger?: LoggerPort;
  now?: () => Date;
};

/** A window wide enough that every weekday is represented, so "this venue has
 *  no hours at all" can be told apart from "not this particular Tuesday". */
const MIN_PROBE_DAYS = 7;
const MAX_PROBE_DAYS = 62;

function splitEntry(entry: string): { date: string; minutes: number | null } {
  const [date, time] = entry.split("T");
  if (!time) return { date: date!, minutes: null };
  const [h, m] = time.split(":").map(Number);
  return { date: date!, minutes: (h ?? 0) * 60 + (m ?? 0) };
}

function daysBetween(from: string, to: string): number {
  const parse = (k: string) => {
    const [y, m, d] = k.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/**
 * Returns every requested entry the venue cannot host. An empty array means
 * all of them are fine — or that the venue has no rules to check them against.
 */
export async function findUnavailableBookingDates(
  deps: ValidateBookingDatesDeps,
  input: {
    placeId: string;
    dates: readonly string[];
    timezone?: string;
    /** The calendar the request routes to. Omitted = the place's default. */
    calendarId?: string;
  },
): Promise<BookingDateProblem[]> {
  const entries = input.dates.map((value) => ({ value, ...splitEntry(value) }));
  if (entries.length === 0) return [];

  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = sorted[0]!.date;
  const last = sorted[sorted.length - 1]!.date;

  // One probe covers the usual case. A span wider than the cap is walked in
  // successive windows rather than silently truncated.
  const availabilityDeps: GetPlaceBookingAvailabilityDeps = {
    repos: deps.repos,
    logger: deps.logger,
    ...(deps.now ? { now: deps.now } : {}),
  };

  const byDate = new Map<
    string,
    { status: string; slots: number[] }
  >();
  let hasAnyWindows = false;

  let cursor = first;
  let guard = 0;
  while (daysBetween(cursor, last) >= 0 && guard < 12) {
    guard += 1;
    const remaining = daysBetween(cursor, last) + 1;
    const days = Math.min(MAX_PROBE_DAYS, Math.max(MIN_PROBE_DAYS, remaining));
    const availability = await getPlaceBookingAvailability(availabilityDeps, {
      placeId: input.placeId,
      from: cursor,
      days,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      // `!== undefined`, not truthiness: an empty-string id is a caller
      // error and must reach the schema, not be silently dropped into
      // "resolve the default".
      ...(input.calendarId !== undefined
        ? { calendarId: input.calendarId }
        : {}),
    });
    for (const day of availability.days) {
      byDate.set(day.date, { status: day.status, slots: day.slots });
      if (day.windows.length > 0) hasAnyWindows = true;
    }
    cursor = addLocalDays(cursor, days);
  }

  const problems: BookingDateProblem[] = [];

  for (const entry of entries) {
    const day = byDate.get(entry.date);
    if (!day) continue; // outside every probe — nothing to judge it against

    // Always wrong, ruleset or not: you cannot ask to play a night that has
    // already happened.
    if (day.status === "past") {
      problems.push({ value: entry.value, reason: "past" });
      continue;
    }
    // A blackout is an explicit closure, so it stands even for a venue that
    // has never set weekly hours.
    if (day.status === "blackout") {
      problems.push({ value: entry.value, reason: "blackout" });
      continue;
    }
    // No declared hours anywhere: no policy, nothing further to enforce.
    if (!hasAnyWindows) continue;

    if (day.status === "closed") {
      problems.push({ value: entry.value, reason: "closed" });
      continue;
    }
    if (day.slots.length === 0) {
      problems.push({ value: entry.value, reason: "full" });
      continue;
    }
    // A bare date on an open night is fine — the venue picks the time. A date
    // WITH a time must name a slot the venue actually offers.
    if (entry.minutes !== null && !day.slots.includes(entry.minutes)) {
      // A time past midnight belongs to the previous night's late run, where
      // the engine expresses it as minutes beyond 1440.
      if (!day.slots.includes(entry.minutes + 1440)) {
        problems.push({ value: entry.value, reason: "time_not_offered" });
      }
    }
  }

  return problems;
}
