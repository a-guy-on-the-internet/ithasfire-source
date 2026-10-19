/**
 * The RRULE half of the calendar export.
 *
 * A recurring community listing (a weekly open mic with 52 upcoming dates) has
 * to leave this app as a REPEATING calendar entry, not as one appointment on
 * the next date. This module turns the page's already-computed cadence summary
 * into the RRULE value both the .ics writer (`ical.ts`) and the Google Calendar
 * template URL (`web-calendar.ts`) need.
 *
 * ## The governing rule: never claim more than the schedule says
 *
 * `CalendarRecurrence` is the wire form of `summarizeRecurrence`
 * (`packages/core/src/use-cases/events/_shared/summarize-recurrence.ts`), which
 * is DELIBERATELY LOSSY — it drops `COUNT`, `BYSETPOS`, the nth-prefix on a
 * BYDAY entry (`2WE` → `WE`), `BYMONTHDAY`, and more. That loss is harmless for
 * a sentence on a page ("Every Wednesday, 8:00 PM" is vague, never wrong by a
 * week) but it is NOT harmless in an exported RRULE, which a calendar client
 * expands into real appointments.
 *
 * So this builder returns `null` — meaning "export as a single event" — for
 * every shape it cannot state exactly. Under-claiming shows the user one
 * correct date; over-claiming puts wrong appointments in their calendar. The
 * refusals are enumerated on {@link buildRRuleValue}.
 *
 * ## What this module does NOT decide
 *
 * Whether `DTSTART` is written in UTC or with a `TZID` — that is `ical.ts`'s
 * call, and it matters: an RRULE is expanded against DTSTART's own basis, so a
 * UTC DTSTART makes a weekly rule drift by an hour at every DST boundary and
 * can put `BYDAY=WE` on the wrong weekday (the seeded 8:00 PM Wednesday open
 * mic in America/Chicago starts at 01:00Z on a THURSDAY). See `ical.ts`.
 */

/** The frequencies `summarizeRecurrence` can phrase. */
export type CalendarRecurrenceFreq = "DAILY" | "WEEKLY" | "MONTHLY";

/**
 * A recurring listing's rule as it crosses into the browser.
 *
 * Structurally identical to `CommunityRecurrenceSummary` (`@/server/events`) on
 * purpose, so the server summary passes straight through the page into the
 * export with no mapping layer. Declared here rather than imported from
 * `@/server/events` to keep `lib/calendar` free of server-module imports — it
 * is bundled into client islands.
 */
export interface CalendarRecurrence {
  freq: CalendarRecurrenceFreq;
  /** >= 1. 1 means every day / week / month. */
  interval: number;
  /** RRULE two-letter weekday codes, Monday-first; `[]` when absent. */
  byday: string[];
  /**
   * ISO 8601 **instant** of the rule's UNTIL bound, or `null` when the series
   * is unbounded.
   *
   * `null` must stay `null` all the way out: the upcoming-dates list the page
   * renders is capped (hence its `truncated` flag), so its last row is NOT the
   * end of the series and must never be borrowed as one.
   */
  until: string | null;
}

/** RRULE weekday codes in RFC 5545 order. */
const WEEKDAY_CODES = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

/** Monday-first, so the emitted BYDAY is deterministic regardless of input order. */
const WEEKDAY_ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

const FREQS = new Set<string>(["DAILY", "WEEKLY", "MONTHLY"]);

/**
 * The RRULE **value** for a cadence — `FREQ=WEEKLY;BYDAY=WE` — or `null` when
 * the cadence cannot be stated exactly.
 *
 * Returned WITHOUT the `RRULE:` prefix so both consumers can build from it: the
 * .ics writer prepends `RRULE:`, Google's template URL wants `recur=RRULE:…`.
 *
 * ### Emitted
 * - `FREQ=` always.
 * - `INTERVAL=` only when > 1 (1 is the RFC 5545 default; omitting it keeps the
 *   line short and matches what calendar clients themselves write).
 * - `BYDAY=` only for `WEEKLY` with a non-empty day list, normalised to
 *   Monday-first order.
 * - `UNTIL=` only when `until` is set, as a UTC timestamp ending in `Z`.
 *
 * ### Refused (returns `null` → single-event export)
 * - An unrecognised `freq`, or an `interval` that is not a finite integer >= 1.
 *   Clamping a garbage interval to 1 would turn a fortnightly series into a
 *   weekly one.
 * - A `byday` entry outside the seven weekday codes. Dropping it would silently
 *   widen the rule to every day of the period.
 * - `DAILY` with any `byday`. No cadence can be both, and
 *   `summarizeRecurrence` already refuses the combination upstream; this is the
 *   same refusal, not a second opinion.
 * - `MONTHLY` with any `byday` — the important one. `summarizeRecurrence` drops
 *   `BYSETPOS` and the nth-prefix, so a "second Wednesday of the month" rule
 *   arrives here as `{ freq: MONTHLY, byday: ["WE"] }`. Emitting
 *   `FREQ=MONTHLY;BYDAY=WE` would book FOUR OR FIVE nights a month where the
 *   schedule has one, and dropping the BYDAY to emit a bare `FREQ=MONTHLY`
 *   would book the wrong day-of-month. Neither is the schedule, so neither
 *   ships. (`MONTHLY` with no `byday` is fine: it repeats on DTSTART's own
 *   day-of-month, which is exactly what the stored rule means.)
 * - An `until` that is present but not a parseable instant. Dropping it would
 *   export a finite series as an endless one.
 */
export function buildRRuleValue(
  recurrence: CalendarRecurrence | null | undefined,
): string | null {
  if (!recurrence) return null;

  const { freq, interval, byday, until } = recurrence;

  if (typeof freq !== "string" || !FREQS.has(freq)) return null;

  if (
    typeof interval !== "number" ||
    !Number.isFinite(interval) ||
    !Number.isInteger(interval) ||
    interval < 1
  ) {
    return null;
  }

  const days = normalizeByday(byday);
  if (days === null) return null;

  // DAILY and MONTHLY cannot carry a day list out of here — see the doc block.
  if (days.length > 0 && freq !== "WEEKLY") return null;

  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (days.length > 0) parts.push(`BYDAY=${days.join(",")}`);

  if (until !== null && until !== undefined) {
    const formatted = formatUntil(until);
    if (!formatted) return null;
    parts.push(`UNTIL=${formatted}`);
  }

  return parts.join(";");
}

/**
 * The day list de-duplicated and put in Monday-first order, or `null` when any
 * entry is not a weekday code. `[]` (no day constraint) is a valid result.
 */
function normalizeByday(byday: unknown): string[] | null {
  if (byday === null || byday === undefined) return [];
  if (!Array.isArray(byday)) return null;

  const seen = new Set<string>();
  for (const entry of byday) {
    if (typeof entry !== "string") return null;
    const code = entry.trim().toUpperCase();
    if (!WEEKDAY_CODES.has(code)) return null;
    seen.add(code);
  }

  return WEEKDAY_ORDER.filter((code) => seen.has(code));
}

/**
 * `UNTIL` as the UTC form RFC 5545 §3.3.5 requires — `YYYYMMDDTHHMMSSZ`.
 *
 * `until` is ALREADY a real instant: `summarizeRecurrence` resolved the stored
 * rule's floating wall-clock bound against the event's timezone before it ever
 * reached the wire. Re-shifting it here would move the end of the series by the
 * zone's offset, so this only reformats — `Date` → ISO → strip separators.
 */
function formatUntil(until: string): string | null {
  const date = new Date(until);
  if (Number.isNaN(date.getTime())) return null;
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}
