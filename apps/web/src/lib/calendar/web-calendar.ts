/**
 * Deep-link helpers for adding events to Google Calendar and Outlook
 * without downloading an .ics file.
 */

import { resolveEnd } from "./event-end";
import { buildRRuleValue, type CalendarRecurrence } from "./recurrence";
import { createZoneClock } from "./zoned-time";

export interface WebCalendarEvent {
  title: string;
  /**
   * ISO 8601 start date-time. PRECONDITION: readable. Both builders throw a
   * RangeError on an unreadable start, so a caller checks it first
   * (`readableIso`, `@/lib/readable-date`) and offers no link without one.
   */
  startsAt: string;
  /** ISO 8601 end date-time (optional; defaults to 2 hours after start) */
  endsAt?: string;
  location?: string;
  description?: string;
  /**
   * IANA timezone of the event (`America/Chicago`). REQUIRED for
   * {@link WebCalendarEvent.recurrence} to reach Google — see
   * {@link buildGoogleCalendarUrl}.
   */
  timezone?: string;
  /**
   * The listing's cadence. Google's template URL can carry it; Outlook's cannot
   * (see {@link buildOutlookCalendarUrl}).
   */
  recurrence?: CalendarRecurrence | null;
}

/**
 * Format a Date into the compact format Google Calendar expects: 20260306T180000Z
 */
function toGoogleDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * Format a Date into the ISO 8601 format Outlook expects: 2026-03-06T18:00:00Z
 */
function toOutlookDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Returns a URL that opens Google Calendar's "new event" form pre-filled.
 *
 * ## Recurrence
 *
 * Google's template accepts `recur=RRULE:…`, and the rule is expanded against
 * whatever basis `dates` is in. A `Z`-suffixed `dates` is UTC, which would drift
 * the local start time at every DST boundary and can put `BYDAY` on the wrong
 * weekday — so the recurring form switches `dates` to the event's WALL CLOCK and
 * names the zone in `ctz`, Google's own timezone parameter. Both changes are
 * confined to the recurring branch: a non-recurring event produces exactly the
 * UTC URL it always has.
 *
 * If the cadence cannot be stated exactly, or the timezone is missing or
 * unresolvable, this degrades to the single-event UTC link rather than sending a
 * rule Google would expand onto the wrong nights.
 */
export function buildGoogleCalendarUrl(event: WebCalendarEvent): string {
  const start = new Date(event.startsAt);
  const end = resolveEnd(start, event.endsAt);

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${toGoogleDate(start)}/${toGoogleDate(end)}`,
  });

  const rrule = buildRRuleValue(event.recurrence);
  const clock = rrule && event.timezone ? createZoneClock(event.timezone) : null;
  const localStart = clock?.wallTime(start) ?? null;
  const localEnd = clock?.wallTime(end) ?? null;

  if (rrule && clock && localStart && localEnd) {
    params.set("dates", `${localStart}/${localEnd}`);
    params.set("ctz", clock.timeZone);
    params.set("recur", `RRULE:${rrule}`);
  }

  if (event.location) params.set("location", event.location);
  if (event.description) params.set("details", event.description);

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Returns a URL that opens Outlook's "new event" form pre-filled.
 * Works with Outlook.com (personal) accounts.
 *
 * ## Recurrence: not expressible, so not attempted
 *
 * The `outlook.live.com/calendar/0/action/compose` deep link has no recurrence
 * parameter — it accepts `subject`, `startdt`, `enddt`, `location`, `body`,
 * `allday` and `online`, and nothing that carries an RRULE. A recurring listing
 * therefore opens Outlook's compose form as a SINGLE event on the first date,
 * and the user repeats it there.
 *
 * That is a deliberate, honest degrade: inventing a parameter would silently
 * drop the recurrence anyway, and faking the repeat by pre-filling a later
 * `enddt` would claim a single long appointment the schedule never describes.
 * `recurrence` is accepted on the input type only so callers can pass one event
 * shape to all three builders. Users who want the repeat in Outlook should use
 * the .ics download, which does carry the `RRULE`.
 */
export function buildOutlookCalendarUrl(event: WebCalendarEvent): string {
  const start = new Date(event.startsAt);
  const end = resolveEnd(start, event.endsAt);

  const params = new URLSearchParams({
    rru: "addevent",
    subject: event.title,
    startdt: toOutlookDate(start),
    enddt: toOutlookDate(end),
    path: "/calendar/action/compose",
  });

  if (event.location) params.set("location", event.location);
  if (event.description) params.set("body", event.description);

  return `https://outlook.live.com/calendar/0/action/compose?${params.toString()}`;
}
