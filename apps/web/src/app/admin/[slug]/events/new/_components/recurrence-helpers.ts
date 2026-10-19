/**
 * Pure helpers behind the RecurrenceBuilder. Kept free of React/Tamagui so
 * tests can import the REAL functions (RecurrenceBuilder.test.ts) instead of
 * mirroring them.
 *
 * ## ONE weekday basis: the event timezone's local calendar
 *
 * Every BYDAY / BYSETPOS this module emits, and every label it renders, speak
 * the SAME basis: the wall-clock calendar day in the event's own timezone. A
 * Nashville Friday-8pm show emits `BYDAY=FR` and reads "Every Friday". There
 * is no second basis and no shift between them.
 *
 * - {@link startWeekdayForSchedule} — the weekday token.
 * - {@link monthlyNthForSchedule} — the BYSETPOS ordinal within the local
 *   month (-1 for "last").
 * - {@link localCalendarWeekday} / {@link localMonthlyNth} — the same
 *   quantities computed straight from a "YYYY-MM-DD" calendar date.
 *
 * ### Why this note exists (do not re-introduce the shift)
 *
 * This module used to carry TWO bases. The backend built its RRule without a
 * tzid and the `rrule` package reads a Date's UTC fields as wall-clock, so
 * BYDAY/BYSETPOS were evaluated against the **UTC** calendar: a Nashville
 * Friday-8pm show is a Saturday-01:00-UTC instant, so the builder
 * deliberately emitted the shifted token `SA` while labelling it "Friday",
 * and `weekdayTokenShift` / `shiftWeekday` mapped between the two.
 *
 * The backend now drives `rrule` in floating wall-clock space and evaluates
 * in the event timezone (`packages/core/src/use-cases/events/_shared/
 * rrule-floating-time.ts`, used by expand-recurrence / expand-series /
 * reconcile-series-schedule / convert-event-to-series). A shifted token would
 * now land the series on the WRONG local day, so the shift helpers were
 * deleted rather than left returning 0 — a dormant shift is how this grows
 * back. Stored rules written under the old basis are migrated by
 * `apps/api/src/scripts/backfill/done/migrate-series-rrule-local-basis.ts`.
 *
 * The old "local wall-clock times drift by an hour across DST boundaries"
 * limitation is also gone: the backend now holds the local time-of-day fixed
 * across DST transitions and moves the UTC instant instead.
 */

// Named import only — rrule's ESM entry has no default export, and a default
// import hard-fails the Turbopack build (takes the whole admin app down in
// dev).
import { RRule } from "rrule";

import { zonedWallClockToInstant } from "@/lib/template-shift-offset";

import { toIsoInTimeZone } from "./event-builder-helpers";

/** Days of the week using RRULE abbreviations, Monday-first (RRULE order). */
export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** RRULE FREQ values the builder can emit. */
export type RepeatFreq = "DAILY" | "WEEKLY" | "MONTHLY";

/** Structured form of every RRULE shape the builder can emit. */
export type RecurrenceRule = {
  freq: RepeatFreq;
  /** >= 1. Omitted from the string when 1. */
  interval: number;
  /** WEEKLY: repeat days. MONTHLY nth-preset: single anchor day. */
  byday: Weekday[];
  /** MONTHLY nth-weekday preset: 1..5 or -1 ("last"). Null otherwise. */
  bysetpos: number | null;
  /** Total occurrence count bound (includes the event's own date). */
  count: number | null;
};

// ---------------------------------------------------------------------------
// RRULE string build / parse
// ---------------------------------------------------------------------------

export type BuildRruleArgs = {
  freq: RepeatFreq;
  interval?: number;
  byday?: Weekday[];
  bysetpos?: number | null;
  count?: number | null;
};

/**
 * Build a canonical RRULE string (no DTSTART/UNTIL — those travel separately
 * in the schedule payload). Part order is fixed so round-trips are
 * string-stable: FREQ;INTERVAL;BYDAY;BYSETPOS;COUNT.
 */
export function buildRrule(args: BuildRruleArgs): string {
  const interval = Math.max(1, Math.floor(args.interval ?? 1));
  const byday = args.byday ?? [];
  const parts: string[] = [`FREQ=${args.freq}`];

  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (args.freq !== "DAILY" && byday.length > 0) {
    // Keep RRULE weekday order for a stable string.
    const ordered = WEEKDAYS.filter((w) => byday.includes(w));
    parts.push(`BYDAY=${ordered.join(",")}`);
  }
  if (
    args.freq === "MONTHLY" &&
    args.bysetpos != null &&
    byday.length > 0
  ) {
    parts.push(`BYSETPOS=${args.bysetpos}`);
  }
  if (args.count != null) {
    parts.push(`COUNT=${Math.floor(args.count)}`);
  }

  return parts.join(";");
}

const PARSE_KEYS = new Set(["FREQ", "INTERVAL", "BYDAY", "BYSETPOS", "COUNT"]);

/**
 * Parse an RRULE string back into builder state. Round-trips everything
 * {@link buildRrule} can emit (INTERVAL>1, COUNT, BYSETPOS) plus the legacy
 * builder shapes (`FREQ=WEEKLY;BYDAY=…`, `FREQ=WEEKLY;INTERVAL=2;…`,
 * `FREQ=DAILY`, plain `FREQ=MONTHLY`).
 *
 * Returns null for anything the builder cannot faithfully re-emit (embedded
 * UNTIL, BYMONTHDAY, nth-prefixed BYDAY like `2SA`, YEARLY, unknown keys…) —
 * the UI then shows "Custom" and passes the raw string through unchanged.
 */
export function parseRrule(rrule: string): RecurrenceRule | null {
  const entries = rrule
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split("=") as [string, string?]);

  const seen = new Map<string, string>();
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.toUpperCase();
    if (!PARSE_KEYS.has(key) || rawValue == null || seen.has(key)) return null;
    seen.set(key, rawValue);
  }

  const freq = seen.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") return null;

  let interval = 1;
  const rawInterval = seen.get("INTERVAL");
  if (rawInterval != null) {
    if (!/^\d+$/.test(rawInterval)) return null;
    interval = parseInt(rawInterval, 10);
    if (interval < 1) return null;
  }

  let byday: Weekday[] = [];
  const rawByday = seen.get("BYDAY");
  if (rawByday != null) {
    const days = rawByday.split(",").map((d) => d.trim());
    if (!days.every((d) => (WEEKDAYS as readonly string[]).includes(d))) {
      return null; // nth-prefixed (2SA) or invalid entries → custom raw
    }
    byday = days as Weekday[];
  }

  let bysetpos: number | null = null;
  const rawSetpos = seen.get("BYSETPOS");
  if (rawSetpos != null) {
    if (!/^-?\d+$/.test(rawSetpos)) return null;
    bysetpos = parseInt(rawSetpos, 10);
    if (bysetpos !== -1 && (bysetpos < 1 || bysetpos > 5)) return null;
  }

  let count: number | null = null;
  const rawCount = seen.get("COUNT");
  if (rawCount != null) {
    if (!/^\d+$/.test(rawCount)) return null;
    count = parseInt(rawCount, 10);
    if (count < 1) return null;
  }

  // Combination validity — anything outside the builder's grammar → null.
  if (freq === "DAILY" && (byday.length > 0 || bysetpos != null)) return null;
  if (freq === "WEEKLY" && bysetpos != null) return null;
  if (freq === "MONTHLY") {
    if (byday.length > 1) return null;
    if (byday.length === 1 && bysetpos == null) return null;
    if (byday.length === 0 && bysetpos != null) return null;
  }

  return { freq, interval, byday, bysetpos, count };
}

/** Whether an RRULE string carries a COUNT bound (works on raw strings too). */
export function rruleHasCount(rrule: string): boolean {
  return /(^|;)\s*COUNT=\d+/i.test(rrule);
}

/**
 * Return `rrule` with its COUNT part replaced/removed/appended. Lets the
 * Ends chooser work even for raw pass-through rules the parser rejected.
 */
export function withCount(rrule: string, count: number | null): string {
  const stripped = rrule
    .split(";")
    .filter((p) => p.trim() && !/^COUNT=/i.test(p.trim()))
    .join(";");
  if (count == null) return stripped;
  return `${stripped};COUNT=${Math.floor(count)}`;
}

// ---------------------------------------------------------------------------
// Enumeration (client-side preview, backend parity)
// ---------------------------------------------------------------------------

/**
 * Enumerate the concrete occurrence instants of a schedule, exactly like the
 * backend does.
 *
 * `dtstartIso` must be the event-tz INSTANT as an ISO string (i.e.
 * `toIsoInTimeZone(startsAt, eventTimezone)`), matching what the schedule
 * payload carries. Pass `eventTimezone` so the preview matches what the
 * server actually writes.
 *
 * The `rrule` package is timezone-blind: it reads and writes a Date's UTC
 * fields and treats them as FLOATING wall-clock. So the rule is driven
 * entirely in floating space and converted at the boundaries — the same
 * recipe as the backend's
 * `packages/core/src/use-cases/events/_shared/rrule-floating-time.ts`, built
 * here on {@link instantToFloating} / {@link floatingToInstant} because
 * `apps/web` does not depend on `@th/core`.
 *
 * Without an `eventTimezone` there is no zone to evaluate in, so the rule is
 * driven on the instants as given (the pre-timezone behaviour). Callers that
 * have the event timezone should always pass it.
 */
export function enumerateOccurrences(
  rrule: string,
  dtstartIso: string,
  untilIso?: string,
  cap = 100,
  eventTimezone?: string,
): Date[] {
  try {
    const dtstart = new Date(dtstartIso);
    if (Number.isNaN(dtstart.getTime())) return [];

    const until = untilIso ? new Date(untilIso) : null;
    if (until && Number.isNaN(until.getTime())) return [];

    const options = RRule.parseString(rrule);

    if (!eventTimezone) {
      options.dtstart = dtstart;
      if (until) options.until = until;
      return new RRule(options).all((_, index) => index < cap);
    }

    const dtstartFloating = instantToFloating(dtstart, eventTimezone);
    if (!dtstartFloating) return [];
    options.dtstart = dtstartFloating;
    if (until) {
      const untilFloating = instantToFloating(until, eventTimezone);
      if (!untilFloating) return [];
      options.until = untilFloating;
    }

    const floating = new RRule(options).all((_, index) => index < cap);
    const instants: Date[] = [];
    for (const value of floating) {
      const instant = floatingToInstant(value, eventTimezone);
      if (instant) instants.push(instant);
    }
    return instants;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Floating wall-clock <-> instant (the `rrule` boundary)
// ---------------------------------------------------------------------------

/**
 * Project a REAL instant into floating space: a Date whose UTC fields carry
 * the instant's wall clock in `timeZone`.
 */
function instantToFloating(instant: Date, timeZone: string): Date | null {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(instant)
        .map((part) => [part.type, part.value]),
    ) as Record<string, string>;

    const utcMs = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return Number.isNaN(utcMs) ? null : new Date(utcMs);
  } catch {
    return null;
  }
}

/**
 * Re-interpret a floating Date's UTC fields as wall-clock in `timeZone` and
 * return the REAL instant. Delegates the offset solve to
 * {@link zonedWallClockToInstant}, which brackets DST transitions and, for an
 * ambiguous fall-back hour, resolves to the EARLIER offset — matching the
 * backend's Luxon behaviour.
 *
 * PRECISION: `zonedWallClockToInstant` resolves to the MINUTE (it hardcodes
 * `second = 0`), whereas the server's `floatingToInstant` carries seconds. The
 * guarantor that this cannot diverge is {@link toIsoInTimeZone}: every
 * `dtstart` reaching the builder is built by it from a `datetime-local` value,
 * whose seconds are always `:00`. If a seconds-bearing dtstart ever reached
 * here the preview would be up to 59s early, and — worse —
 * {@link reconcileWindowEndForConfig} would hand the server a `windowEnd` up
 * to 59s before the true final occurrence, orphaning it. So if that assumption
 * ever changes, this function must gain seconds rather than the callers being
 * trusted to round.
 */
function floatingToInstant(floating: Date, timeZone: string): Date | null {
  try {
    const instant = zonedWallClockToInstant(
      {
        year: floating.getUTCFullYear(),
        month: floating.getUTCMonth() + 1,
        day: floating.getUTCDate(),
        hour: floating.getUTCHours(),
        minute: floating.getUTCMinutes(),
      },
      timeZone,
    );
    return Number.isNaN(instant.getTime()) ? null : instant;
  } catch {
    return null;
  }
}

/**
 * ISO of the final enumerated instant of a config (COUNT- or UNTIL-bounded),
 * or null when nothing enumerates / the rule is invalid. Needed to compute
 * the reconcile windowEnd for COUNT-based schedules, which have no `until`.
 */
export function lastOccurrence(
  config: { rrule: string; dtstart: string; until?: string },
  cap = 100,
  eventTimezone?: string,
): string | null {
  const occurrences = enumerateOccurrences(
    config.rrule,
    config.dtstart,
    config.until,
    cap,
    eventTimezone,
  );
  const last = occurrences[occurrences.length - 1];
  return last ? last.toISOString() : null;
}

/**
 * The `windowEnd` the reconcile/generate tail should use for a config:
 * - UNTIL-bounded → the until instant (existing behavior);
 * - COUNT-bounded → the final enumerated occurrence (NOT dtstart — that
 *   would reconcile a zero-width window and never materialize the drafts);
 * - neither (defensive) → dtstart, the legacy fallback.
 */
export function reconcileWindowEndForConfig(
  config: {
    rrule: string;
    dtstart: string;
    until?: string;
  },
  eventTimezone?: string,
): string {
  const until = config.until?.trim();
  if (until) return until;
  if (rruleHasCount(config.rrule)) {
    // Must be enumerated on the SAME basis the server will use, or the
    // reconcile window can stop short and truncate the series.
    return lastOccurrence(config, 100, eventTimezone) ?? config.dtstart;
  }
  return config.dtstart;
}

// ---------------------------------------------------------------------------
// The basis: the event timezone's local calendar day
// ---------------------------------------------------------------------------

/**
 * UTC weekday abbreviation of the instant an ISO datetime string describes.
 * Kept for callers that already hold a UTC-fielded value (notably
 * {@link localCalendarWeekday}, which stamps a calendar date at UTC
 * midnight). Schedule logic should go through {@link startWeekdayForSchedule}
 * so the EVENT timezone decides the calendar day.
 */
export function dayOfWeekFromIso(iso: string): Weekday | null {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return WEEKDAYS[(d.getUTCDay() + 6) % 7] ?? null; // JS Sunday=0 → MO=0 offset
  } catch {
    return null;
  }
}

/** Does this datetime string carry an explicit `Z` or ±HH:MM offset? */
function hasExplicitZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
}

/**
 * The event-timezone calendar date ("YYYY-MM-DD") a start value names.
 *
 * Two input shapes reach this, and they must be handled differently:
 * - A `datetime-local` wall clock ("2026-08-07T20:00") is ALREADY expressed
 *   in the event timezone. Its date part IS the local date — converting it
 *   would apply the offset twice.
 * - A zone-qualified instant ("…Z" / "…-05:00", e.g. a server-loaded value)
 *   must be resolved INTO the event timezone.
 *
 * With no event timezone the instant branch falls back to UTC fields, which
 * is deterministic (the browser timezone must never decide a schedule).
 */
function localDatePartForStart(
  eventStartsAt: string,
  eventTimezone?: string,
): string | null {
  if (!eventStartsAt) return null;

  if (!hasExplicitZone(eventStartsAt)) {
    const datePart = eventStartsAt.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
  }

  const d = new Date(eventStartsAt);
  if (Number.isNaN(d.getTime())) return null;
  return localDatePartInZone(d, eventTimezone ?? "UTC");
}

/**
 * The weekday an RRULE schedule must include for the event's own start —
 * the event timezone's local calendar day.
 *
 * Matches the backend, which evaluates BYDAY in the event timezone (see the
 * module header). Computing this from the browser timezone would drift for
 * organizers editing from elsewhere (a Paris browser editing a Nashville
 * Friday-8pm show), so the event timezone is applied explicitly.
 */
export function startWeekdayForSchedule(
  eventStartsAt: string,
  eventTimezone?: string,
): Weekday | null {
  const datePart = localDatePartForStart(eventStartsAt, eventTimezone);
  return datePart ? localCalendarWeekday(datePart) : null;
}

/**
 * BYSETPOS ordinal for the monthly nth-weekday preset: the start's position
 * among same-weekday days of its LOCAL month. Returns -1 when it is the final
 * such weekday of the month (per the approved design, "last" wins over
 * "4th"), else 1..4.
 *
 * Shares {@link startWeekdayForSchedule}'s basis by construction — both read
 * the same local calendar date — so the emitted BYDAY and BYSETPOS always
 * describe the event's own start.
 */
export function monthlyNthForSchedule(
  eventStartsAt: string,
  eventTimezone?: string,
): number | null {
  const datePart = localDatePartForStart(eventStartsAt, eventTimezone);
  return datePart ? localMonthlyNth(datePart) : null;
}

/**
 * Weekday of the local calendar date the organizer typed
 * ("2026-08-07T20:00" → FR). Same basis as
 * {@link startWeekdayForSchedule}; this form takes the calendar date
 * directly, which is what the label paths already hold.
 */
export function localCalendarWeekday(eventStartsAt: string): Weekday | null {
  const datePart = eventStartsAt?.slice(0, 10);
  if (!datePart || !/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  return dayOfWeekFromIso(`${datePart}T00:00:00.000Z`);
}

/**
 * Ordinal of the local calendar date within its local month: -1 when it is
 * the final such weekday of the month, else 1..4. Pairs with
 * {@link localCalendarWeekday} — the same basis the emitted BYSETPOS uses,
 * so "Monthly on the last Friday" copy and the rule always agree.
 */
export function localMonthlyNth(eventStartsAt: string): number | null {
  const datePart = eventStartsAt?.slice(0, 10);
  if (!datePart || !/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const [year, month, day] = datePart.split("-").map(Number);
  if (!year || !month || !day) return null;
  return nthOfMonthFromParts(year, month - 1, day);
}

/** Shared nth-or-last computation over plain calendar parts. */
function nthOfMonthFromParts(
  year: number,
  monthIndex: number,
  day: number,
): number {
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  if (day + 7 > daysInMonth) return -1;
  return Math.floor((day - 1) / 7) + 1;
}

// ---------------------------------------------------------------------------
// Preset classification (edit-mode prefill)
// ---------------------------------------------------------------------------

export type RepeatSelection =
  | "NONE"
  | "WEEKLY"
  | "BIWEEKLY"
  | "MONTHLY_NTH"
  | "CUSTOM";

/**
 * Which REPEATS select entry a parsed rule corresponds to, given the
 * event-start's TOKEN-basis weekday and monthly ordinal. COUNT does not
 * affect classification — the Ends chooser is orthogonal to the preset.
 */
export function classifyRule(
  rule: RecurrenceRule | null,
  startDay: Weekday | null,
  monthlyNth: number | null,
): RepeatSelection {
  if (!rule) return "CUSTOM";
  if (
    rule.freq === "WEEKLY" &&
    rule.bysetpos == null &&
    rule.byday.length === 1 &&
    rule.byday[0] === startDay
  ) {
    if (rule.interval === 1) return "WEEKLY";
    if (rule.interval === 2) return "BIWEEKLY";
  }
  if (
    rule.freq === "MONTHLY" &&
    rule.interval === 1 &&
    rule.byday.length === 1 &&
    rule.byday[0] === startDay &&
    rule.bysetpos != null &&
    rule.bysetpos === monthlyNth
  ) {
    return "MONTHLY_NTH";
  }
  return "CUSTOM";
}

/**
 * Weekly/biweekly BYDAY sets must always include the event-start weekday —
 * the backend rejects a schedule that excludes the event's own start
 * (EVENT_START_NOT_IN_SCHEDULE). An empty set is fine: BYDAY is omitted and
 * the RRULE expands on the dtstart weekday by definition. Preserves RRULE
 * weekday order.
 */
export function withStartDayIncluded(
  days: Weekday[],
  startDay: Weekday | null,
): Weekday[] {
  if (!startDay || days.length === 0 || days.includes(startDay)) return days;
  return WEEKDAYS.filter((w) => w === startDay || days.includes(w));
}

/**
 * Whether a weekday chip is PINNED — selected and not removable, because it
 * is the event's own (label-basis) weekday and {@link withStartDayIncluded}
 * would put it straight back. The UI must render this state VISIBLY: a chip
 * that silently swallows the click is the defect this predicate exists to
 * make impossible (organizers on a Wednesday show reported a dead "Wed"
 * button with no explanation).
 *
 * Note the "selected" half of the condition: with a zero-length set BYDAY is
 * omitted entirely and nothing is pinned.
 */
export function isWeekdayPinned(
  day: Weekday,
  days: Weekday[],
  startDay: Weekday | null,
): boolean {
  return startDay != null && day === startDay && days.includes(day);
}

/**
 * Toggle `day` in a weekly BYDAY set, preserving RRULE weekday order.
 * Returns the SAME array reference when the toggle is refused (the day is
 * pinned by {@link isWeekdayPinned}) so callers can no-op on identity.
 */
export function toggleWeekday(
  days: Weekday[],
  day: Weekday,
  startDay: Weekday | null,
): Weekday[] {
  if (isWeekdayPinned(day, days, startDay)) return days;
  const next = days.includes(day)
    ? days.filter((d) => d !== day)
    : [...days, day];
  return WEEKDAYS.filter((w) => next.includes(w));
}

/**
 * ISO instant for the END of a locally-picked "Ends on" date, interpreted in
 * the EVENT timezone (mirrors build-recurrence-schedule.ts). A UTC end-of-day
 * (`T23:59:59Z`) would EXCLUDE the final occurrence of any UTC-midnight-
 * crossing series — a Nashville Fri-8pm show is a Sat-01:00Z instant, past
 * `T23:59:59Z` of the picked Friday.
 */
export function untilIsoForLocalDate(
  dateStr: string,
  eventTimezone?: string,
): string {
  if (!eventTimezone) return `${dateStr}T23:59:59.000Z`;
  try {
    return toIsoInTimeZone(`${dateStr}T23:59`, eventTimezone);
  } catch {
    return `${dateStr}T23:59:59.000Z`;
  }
}

/** "YYYY-MM-DD" of an instant in a timezone (browser-local when omitted). */
function localDatePartInZone(instant: Date, timeZone?: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      ...(timeZone ? { timeZone } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  } catch {
    return null;
  }
}

/**
 * Ordinal the monthly nth-weekday preset labels, read from the dtstart
 * INSTANT resolved into the event timezone — or null when that instant is
 * unusable (unparseable dtstart, unknown zone), in which case the preset is
 * suppressed and a stored monthly rule prefills as raw Custom.
 *
 * This used to also suppress the preset for a SHIFTED anchor (local weekday
 * != token weekday), because a UTC-basis "last Friday" rule could skip months
 * or land on 5th Fridays. With one basis that case no longer exists: the
 * emitted BYSETPOS is the local ordinal, so the label always describes the
 * rule. The instant-based read is kept because it is the robust one — it
 * works for a server-loaded value as well as a typed wall clock.
 */
export function monthlyPresetLocalOrdinal(args: {
  dtstartIso: string;
  eventTimezone?: string;
}): number | null {
  const dtstart = new Date(args.dtstartIso);
  if (Number.isNaN(dtstart.getTime())) return null;
  const datePart = localDatePartInZone(dtstart, args.eventTimezone ?? "UTC");
  if (!datePart) return null;
  return localMonthlyNth(datePart);
}

// ---------------------------------------------------------------------------
// Builder state <-> config mapping (pure, imported by the component AND the
// test suite so the emission contract is directly testable)
// ---------------------------------------------------------------------------

/** Data emitted by the builder for the parent form to consume. */
export type RecurrenceConfig = {
  /** Standard RRULE string (may carry INTERVAL / BYSETPOS / COUNT). */
  rrule: string;
  /** ISO datetime string for the recurrence start (event-tz instant). */
  dtstart: string;
  /** ISO end boundary. Absent for COUNT-bounded schedules. */
  until?: string;
  /** Total occurrence count (includes the event's own date) when COUNT-bounded. */
  count?: number;
};

export type RepeatSelectValue =
  | "none"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "custom";
/**
 * How the schedule stops.
 *
 * `"never"` is OPT-IN per surface, via {@link DeriveContext.allowNeverEnds}
 * and the builder's `allowNeverEnds` prop — the ticketed event builder does
 * NOT offer it and is unaffected: every path that reaches `"never"` requires
 * a caller to have asked for it. It exists because a COMMUNITY listing's
 * recurrence is routinely open-ended (a weekly open mic has no last night),
 * and without it the only way to re-save such a rule is to put an end on it —
 * which stops the rolling re-expansion job and silently retires the series.
 *
 * `buildConfigFromState` needs no branch for it: `"never"` takes neither the
 * COUNT path nor the UNTIL path, so the emitted config is the bare rule.
 */
export type EndMode = "count" | "until" | "never";
export type CustomUnit = "days" | "weeks" | "months";

export type BuilderState = {
  select: RepeatSelectValue;
  /** Custom panel: repeat every N units (1..12). */
  interval: number;
  unit: CustomUnit;
  /**
   * Custom weekly repeat days — LABEL basis (the local days the organizer
   * sees). Shifted to tokens at EMIT time so a start-time change (which can
   * change the label→token shift) never silently re-maps a stored selection
   * to different local days.
   */
  byday: Weekday[];
  /**
   * Pass-through for rules the structured panel can't represent (embedded
   * UNTIL, BYMONTHDAY, BYSETPOS-in-custom, …). Kept verbatim (minus COUNT,
   * which the Ends chooser owns) until the user edits a structured control,
   * which replaces it.
   */
  raw: string | null;
  endMode: EndMode;
  /**
   * Ends-after total show count — RAW input string so typing "10" is not
   * clamped per keystroke ("1" → 2 → "20"). Clamped at emit and on blur.
   */
  count: string;
  /** Ends-on date: "" | "YYYY-MM-DD" (user-picked) | full ISO (server-loaded). */
  until: string;
};

export type DeriveContext = {
  /** The event timezone's local calendar weekday — the ONE basis. */
  startDay: Weekday | null;
  /** Ordinal of that day within its local month (-1 = last). */
  monthlyNth: number | null;
  dtstartIso: string | null;
  eventTimezone?: string;
  /** Whether the monthly nth preset has an honest label (see
   * {@link monthlyPresetLocalOrdinal}); when false, stored monthly-nth rules
   * prefill as raw Custom instead. */
  monthlyPresetAvailable: boolean;
  /**
   * Whether this surface offers "Ends — never" (see {@link EndMode}).
   *
   * Absent/false everywhere the ticketed builder mounts, so prefill behaviour
   * there is byte-identical to before: an unbounded rule still lands in
   * `"until"` with an empty date, which is the state that asks the organizer
   * for an end. When true, that same rule prefills as `"never"` and
   * round-trips unchanged.
   */
  allowNeverEnds?: boolean;
};

export const ENUMERATION_CAP = 100;
export const COUNT_MIN = 2;
export const COUNT_MAX = 100;
export const INTERVAL_MIN = 1;
export const INTERVAL_MAX = 12;
export const DEFAULT_COUNT = 12;

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function extractRawCount(rrule: string): number | null {
  const match = /(?:^|;)\s*COUNT=(\d+)/i.exec(rrule);
  return match ? parseInt(match[1]!, 10) : null;
}

function unitToFreq(unit: CustomUnit): RepeatFreq {
  return unit === "days" ? "DAILY" : unit === "weeks" ? "WEEKLY" : "MONTHLY";
}

/**
 * Build the emitted config from builder state, or null while the section is
 * incomplete ("Doesn't repeat", until-mode without a date, unparseable count).
 */
export function buildConfigFromState(
  state: BuilderState,
  ctx: DeriveContext,
): RecurrenceConfig | null {
  if (state.select === "none" || !ctx.dtstartIso) return null;

  let countVal: number | null = null;
  if (state.endMode === "count") {
    const parsed = parseInt(state.count, 10);
    if (!Number.isFinite(parsed)) return null; // count field mid-edit
    countVal = clampInt(parsed, COUNT_MIN, COUNT_MAX);
  }

  let rrule: string | null = null;
  switch (state.select) {
    case "weekly":
      rrule = ctx.startDay
        ? buildRrule({ freq: "WEEKLY", byday: [ctx.startDay], count: countVal })
        : null;
      break;
    case "biweekly":
      rrule = ctx.startDay
        ? buildRrule({
            freq: "WEEKLY",
            interval: 2,
            byday: [ctx.startDay],
            count: countVal,
          })
        : null;
      break;
    case "monthly":
      rrule =
        ctx.startDay && ctx.monthlyNth != null
          ? buildRrule({
              freq: "MONTHLY",
              byday: [ctx.startDay],
              bysetpos: ctx.monthlyNth,
              count: countVal,
            })
          : null;
      break;
    case "custom":
      if (state.raw != null) {
        rrule = withCount(state.raw, countVal);
      } else {
        // Builder state and the emitted RRULE share one basis, so the
        // selected days go out verbatim.
        const days =
          state.unit === "weeks"
            ? withStartDayIncluded(state.byday, ctx.startDay)
            : [];
        rrule = buildRrule({
          freq: unitToFreq(state.unit),
          interval: clampInt(state.interval, INTERVAL_MIN, INTERVAL_MAX),
          byday: days,
          count: countVal,
        });
      }
      break;
  }
  if (!rrule) return null;

  let until: string | undefined;
  if (state.endMode === "until") {
    if (!state.until) return null; // still editing — parent shows the warning
    until = state.until.includes("T")
      ? state.until // server-loaded instant, kept verbatim
      : untilIsoForLocalDate(state.until, ctx.eventTimezone);
  }

  return {
    rrule,
    dtstart: ctx.dtstartIso,
    ...(until ? { until } : {}),
    ...(countVal != null ? { count: countVal } : {}),
  };
}

/** Derive builder state from a stored/emitted config (edit-mode prefill). */
export function deriveStateFromValue(
  value: RecurrenceConfig,
  ctx: DeriveContext,
): BuilderState {
  const parsed = parseRrule(value.rrule);
  const classified = classifyRule(parsed, ctx.startDay, ctx.monthlyNth);
  const select: RepeatSelectValue =
    classified === "WEEKLY"
      ? "weekly"
      : classified === "BIWEEKLY"
        ? "biweekly"
        : classified === "MONTHLY_NTH" && ctx.monthlyPresetAvailable
          ? "monthly"
          : "custom";

  // The structured custom panel can't express BYSETPOS — a monthly-nth rule
  // that lands in Custom (ordinal mismatch or suppressed preset) must pass
  // through raw or a rebuild would silently drop its BYSETPOS.
  const needsRaw =
    !parsed || (select === "custom" && parsed.bysetpos != null);

  const count = value.count ?? parsed?.count ?? extractRawCount(value.rrule);
  // `until` wins: a config carrying BOTH an rrule COUNT and an until must
  // not silently drop the until bound on prefill.
  //
  // With NEITHER bound the rule is open-ended, and the honest prefill depends
  // on whether the surface can say so: `"never"` when it can, and otherwise
  // the unchanged `"until"`-with-no-date, which renders as "choose an end
  // date" rather than inventing one.
  const endMode: EndMode = value.until
    ? "until"
    : count != null
      ? "count"
      : ctx.allowNeverEnds
        ? "never"
        : "until";

  return {
    select,
    interval: clampInt(parsed?.interval ?? 1, INTERVAL_MIN, INTERVAL_MAX),
    unit:
      parsed?.freq === "DAILY"
        ? "days"
        : parsed?.freq === "MONTHLY"
          ? "months"
          : "weeks",
    byday:
      parsed?.freq === "WEEKLY" && parsed.byday.length > 0
        ? WEEKDAYS.filter((w) => parsed.byday.includes(w))
        : ctx.startDay
          ? [ctx.startDay]
          : [],
    raw: needsRaw ? withCount(value.rrule, null) : null,
    endMode,
    count: String(clampInt(count ?? DEFAULT_COUNT, COUNT_MIN, COUNT_MAX)),
    until: value.until ?? "",
  };
}

/**
 * Degrade a "monthly" preset selection to raw Custom when the preset's
 * honest label disappears (e.g. the event time change shifted the anchor —
 * see {@link monthlyPresetLocalOrdinal}). Carries the CURRENT token rule as
 * a raw pass-through so the schedule semantics survive the degrade and the
 * summary stays honest (mirrors the prefill suppression path). Returns the
 * same reference when nothing needs to change.
 */
export function degradeMonthlySelection(
  state: BuilderState,
  ctx: DeriveContext,
): BuilderState {
  if (state.select !== "monthly" || ctx.monthlyPresetAvailable) return state;
  const rrule =
    ctx.startDay && ctx.monthlyNth != null
      ? buildRrule({
          freq: "MONTHLY",
          byday: [ctx.startDay],
          bysetpos: ctx.monthlyNth,
        })
      : null;
  return { ...state, select: "custom", unit: "months", raw: rrule };
}

/**
 * The state a builder mounts in with no stored config to prefill from.
 *
 * `allowNeverEnds` is the same opt-in as everywhere else in this module and
 * defaults to the original `"count"`, so the ticketed builder still opens on
 * "After 12 shows". It matters on a surface that HAS the never option: an
 * open-ended community listing whose rule the read-side phrasebook cannot
 * state (FIXED_DATES, a BYSETPOS rule, anything outside the subset) arrives
 * here with `value: null`, and defaulting it to a 12-occurrence bound offers
 * "end this series" as the resting choice on the one page built because
 * open-ended rules have to round-trip.
 */
export function defaultBuilderState(
  localDay: Weekday | null,
  allowNeverEnds = false,
): BuilderState {
  return {
    select: "none",
    interval: 1,
    unit: "weeks",
    byday: localDay ? [localDay] : [],
    raw: null,
    endMode: allowNeverEnds ? "never" : "count",
    count: String(DEFAULT_COUNT),
    until: "",
  };
}

export function configsEqual(
  a: RecurrenceConfig | null,
  b: RecurrenceConfig | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.rrule === b.rrule &&
    a.dtstart === b.dtstart &&
    (a.until ?? null) === (b.until ?? null) &&
    (a.count ?? null) === (b.count ?? null)
  );
}
