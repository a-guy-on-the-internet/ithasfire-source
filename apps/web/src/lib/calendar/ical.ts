/**
 * Generate an iCalendar (.ics) file content string for an event.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc5545
 */

import { buildRRuleValue, type CalendarRecurrence } from "./recurrence";
import { buildVTimezoneLines } from "./vtimezone";
import { resolveEnd } from "./event-end";
import { createZoneClock } from "./zoned-time";

export interface CalendarEventData {
  /**
   * Stable identity of the thing being exported — the event id, or the
   * occurrence's own id for a per-date entry on a recurring listing.
   *
   * This is the UID basis, and UID is the calendar's IDENTITY KEY for an entry:
   * clients treat a second import of the same UID as an UPDATE to the entry
   * they already hold. A UID that changes between downloads therefore makes
   * "Add to calendar" twice into two appointments, which is what this field
   * exists to prevent. Optional because not every surface that offers the
   * download holds an id (the admin preview renders `EventContent` without
   * one); see {@link buildUid} for the deterministic fallback.
   */
  id?: string;
  /** Event title / summary */
  title: string;
  /**
   * ISO 8601 start date-time. PRECONDITION: readable. `generateICalString`
   * throws a RangeError on an unreadable start, so a caller checks it first
   * (`readableIso`, `@/lib/readable-date`) and offers no export without one.
   */
  startsAt: string;
  /** ISO 8601 end date-time (optional; defaults to 2 hours after start) */
  endsAt?: string;
  /** Location text */
  location?: string;
  /** Plain-text description */
  description?: string;
  /** URL of the event page */
  url?: string;
  /**
   * IANA timezone of the event (`America/Chicago`). REQUIRED for
   * {@link CalendarEventData.recurrence} to be exported — a recurring entry
   * cannot be stated faithfully without it (see `zoned-time.ts`).
   */
  timezone?: string;
  /**
   * The listing's cadence. When present, resolvable and exactly expressible,
   * the VEVENT carries an `RRULE` and its DTSTART/DTEND move to `TZID` form.
   * When absent, `null`, or not exactly expressible, the output is the
   * single-event UTC export, byte for byte.
   */
  recurrence?: CalendarRecurrence | null;
}

/**
 * Format a JS Date into an iCal DTSTART/DTEND value (UTC).
 * Format: YYYYMMDDTHHMMSSZ
 */
function formatICalDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * Escape special characters for iCalendar text fields.
 */
function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Fold a content line to the 75-octet limit of RFC 5545 §3.1: the line is cut
 * and each continuation is prefixed with CRLF + one space, which parsers strip.
 *
 * Applied ONLY to the `RRULE` line, which is the one line this module adds that
 * can exceed 75 octets (`RRULE:FREQ=WEEKLY;INTERVAL=99;BYDAY=MO,TU,WE,TH,FR,SA,SU;UNTIL=…`
 * reaches 79). `SUMMARY` / `DESCRIPTION` / `LOCATION` have always been emitted
 * unfolded here and are left alone deliberately: folding them would change the
 * bytes of every export this app has ever produced, which is a separate change
 * from adding recurrence and wants its own regression pass.
 */
function foldICalLine(line: string): string {
  const MAX = 75;
  if (line.length <= MAX) return line;

  const parts = [line.slice(0, MAX)];
  let pos = MAX;
  while (pos < line.length) {
    // 74 payload octets per continuation: the leading space counts toward 75.
    parts.push(` ${line.slice(pos, pos + MAX - 1)}`);
    pos += MAX - 1;
  }
  return parts.join("\r\n");
}

/**
 * A `UID` that is the SAME on every download of the same event, so re-adding an
 * event updates the calendar entry instead of duplicating it.
 *
 * Prefers the caller's `id` — the event's (or occurrence's) real identity, which
 * survives a retitle, a venue change and a reschedule. Without one, falls back
 * to a digest of the fields that identify the entry. The fallback is weaker
 * (editing the title mints a new UID, so the user would get a second entry) but
 * it is DETERMINISTIC, which is the property that was missing: the previous
 * scheme appended `Math.random()` and so guaranteed a duplicate on every single
 * re-download.
 *
 * `@ithasfire` is kept as-is: it is the existing domain suffix, and changing it
 * would orphan entries users already hold.
 */
function buildUid(event: CalendarEventData, start: Date): string {
  const id = event.id?.trim();
  if (id) return `${id}@ithasfire`;

  // A separator no field can contain, so "Open Mic" + "" cannot digest to the
  // same string as "Open" + "Mic". Written as an escape: a raw NUL in a source
  // file makes git treat it as binary.
  const digest = [
    event.title,
    event.startsAt,
    event.endsAt ?? "",
    event.location ?? "",
  ].join("\u0000");

  return `${formatICalDate(start)}-${hash36(digest)}@ithasfire`;
}

/**
 * FNV-1a, base36. Not a security primitive — a short, stable, dependency-free
 * spread over the identity fields so two different events on the same start
 * instant do not collide onto one UID.
 */
function hash36(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // `Math.imul` keeps the multiply in 32-bit space; `>>> 0` makes it unsigned.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

type RecurringExport = {
  timezone: string;
  /** The RRULE value, without the `RRULE:` prefix. */
  rrule: string;
  /** Floating local `YYYYMMDDTHHMMSS`, to be read against `TZID=timezone`. */
  dtstart: string;
  dtend: string;
  /** `BEGIN:VTIMEZONE … END:VTIMEZONE`. */
  vtimezone: string[];
};

/**
 * Everything the recurring branch needs, or `null` to export a single event.
 *
 * The recurring export is ALL-OR-NOTHING, and that is the point. An `RRULE` hung
 * off a UTC `DTSTART` is expanded on a UTC basis, which drifts the local start
 * time by an hour at every DST boundary and can land `BYDAY` on the wrong
 * weekday (`zoned-time.ts` has the worked example). So the rule only ships
 * alongside a `TZID` DTSTART/DTEND *and* the `VTIMEZONE` that defines it. If any
 * piece is unavailable — no timezone, a timezone the runtime cannot resolve, a
 * cadence `buildRRuleValue` refuses to state exactly — the whole thing collapses
 * to the single-event UTC output this module has always produced. Showing one
 * correct night is a smaller lie than repeating the wrong one.
 */
function resolveRecurringExport(
  event: CalendarEventData,
  start: Date,
  end: Date,
): RecurringExport | null {
  const rrule = buildRRuleValue(event.recurrence);
  if (!rrule || !event.timezone) return null;

  const clock = createZoneClock(event.timezone);
  if (!clock) return null;

  const dtstart = clock.wallTime(start);
  const dtend = clock.wallTime(end);
  if (!dtstart || !dtend) return null;

  const until = event.recurrence?.until ? new Date(event.recurrence.until) : null;
  const vtimezone = buildVTimezoneLines(
    event.timezone,
    start,
    until && !Number.isNaN(until.getTime()) ? until : null,
  );
  if (!vtimezone) return null;

  return { timezone: event.timezone, rrule, dtstart, dtend, vtimezone };
}

/**
 * Generate an iCalendar (.ics) string.
 */
export function generateICalString(event: CalendarEventData): string {
  const start = new Date(event.startsAt);
  const end = resolveEnd(start, event.endsAt);

  const uid = buildUid(event, start);

  const recurring = resolveRecurringExport(event, start, end);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ithas Fire//Event//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  if (recurring) {
    // Google Calendar reads this hint on import; harmless everywhere else.
    lines.push(`X-WR-TIMEZONE:${recurring.timezone}`, ...recurring.vtimezone);
  }

  lines.push("BEGIN:VEVENT", `UID:${uid}`);

  if (recurring) {
    lines.push(
      `DTSTART;TZID=${recurring.timezone}:${recurring.dtstart}`,
      `DTEND;TZID=${recurring.timezone}:${recurring.dtend}`,
      foldICalLine(`RRULE:${recurring.rrule}`),
    );
  } else {
    lines.push(`DTSTART:${formatICalDate(start)}`, `DTEND:${formatICalDate(end)}`);
  }

  lines.push(`SUMMARY:${escapeICalText(event.title)}`);

  if (event.location) {
    lines.push(`LOCATION:${escapeICalText(event.location)}`);
  }
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeICalText(event.description)}`);
  }
  if (event.url) {
    lines.push(`URL:${event.url}`);
  }

  lines.push(
    `DTSTAMP:${formatICalDate(new Date())}`,
    "END:VEVENT",
    "END:VCALENDAR",
  );

  return lines.join("\r\n");
}

/**
 * Trigger a browser download of an .ics file for the given event data.
 */
export function downloadICalFile(event: CalendarEventData): void {
  const content = generateICalString(event);
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${event.title.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50)}.ics`;
  document.body.appendChild(anchor);
  anchor.click();

  // Cleanup
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
