/**
 * Converting UTC instants into a venue's local calendar.
 *
 * Availability is reasoned about in the venue's own day: a 9pm Austin show is
 * tomorrow in UTC, so bucketing `startsAt` by its UTC date marks the wrong
 * night for every late show. Everything the picker renders — which dates exist,
 * which minutes are busy — is computed here first, in local terms.
 *
 * Callers pass a zone in and fall back to {@link DEFAULT_VENUE_TIMEZONE}. The
 * zone to pass is `Event.timezone`, which is itself derived at creation from
 * the venue's address — `Place.timezone` for a linked venue,
 * `SavedLocation.timezone` for a freeform address (venue-hierarchy FR-004, see
 * `save-event-shared.ts`).
 */

import { DEFAULT_VENUE_TIMEZONE } from "@th/types/datetime";

/**
 * Last-resort zone when nothing else is known. Matches the `Event.timezone`
 * column default in `event.prisma` AND the final fallback in
 * `finalizeSaveEvent` — keep the three in step. Defined in `@th/types` so the
 * UI's card fallback is the same constant.
 */
export { DEFAULT_VENUE_TIMEZONE };

export type LocalParts = {
  /** Local calendar date as YYYY-MM-DD. */
  date: string;
  /** Minutes from local midnight, 0–1439. */
  minutes: number;
};

const cache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = cache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    cache.set(timeZone, f);
  }
  return f;
}

/** True when the runtime accepts the zone — an unknown id would otherwise throw
 *  deep inside a formatter on a request that had nothing to do with time. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return DEFAULT_VENUE_TIMEZONE;
  return isValidTimeZone(timeZone) ? timeZone : DEFAULT_VENUE_TIMEZONE;
}

/** An instant, expressed as the venue's local date and minute-of-day. */
export function toLocalParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  // en-CA + hour12:false yields 24-hour parts, but midnight is "24" in some
  // ICU versions — normalise so 24:00 is 00:00 of the same formatted date.
  const hour = Number(get("hour")) % 24;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
  };
}

/** YYYY-MM-DD for the local date `offsetDays` after `from`'s local date. */
export function addLocalDays(dateKey: string, offsetDays: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  // Anchored at UTC noon so a day step can never be eaten by a DST shift.
  const anchor = new Date(Date.UTC(y!, m! - 1, d!, 12));
  anchor.setUTCDate(anchor.getUTCDate() + offsetDays);
  return anchor.toISOString().slice(0, 10);
}

/** Day-of-week (0=Sun) for a local date key, without timezone re-entry. */
export function localDayOfWeek(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).getUTCDay();
}

/** Inclusive list of local date keys from `start`, `count` days long. */
export function localDateRange(start: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(addLocalDays(start, i));
  return out;
}

/**
 * The instant that a local date's midnight corresponds to, give or take DST.
 * Used only to bound database queries, so an hour of slop at the edges is fine
 * — the precise bucketing is done with {@link toLocalParts} afterwards.
 */
export function localDateToApproxInstant(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 0, 0, 0));
}
