import { toIsoInTimeZone } from "@/app/admin/[slug]/events/new/_components/event-builder-helpers";

import {
  buildRrule,
  weekdayOf,
  type MonthlyMode,
  type Weekday,
} from "./build-rrule";

/**
 * Bridges the community listing form's structured "Repeats" inputs to the
 * `recurrenceSchedule` payload `community.createListing` accepts. Composes the
 * pure {@link buildRrule} string with timezone-correct `dtstart` / `until` ISO
 * instants (via the shared {@link toIsoInTimeZone}). The server pins the
 * expansion window + cap — we only send kind + rule + bounds.
 */

export type RecurrenceFreqChoice = "NONE" | "WEEKLY" | "MONTHLY";

export interface CommunityRecurrenceForm {
  freq: RecurrenceFreqChoice;
  /** "Every N weeks/months"; coerced to an integer >= 1 downstream. */
  interval: number;
  /** WEEKLY only. */
  byWeekday: Weekday[];
  /** MONTHLY only. */
  monthlyMode: MonthlyMode;
  /** "YYYY-MM-DD" from the native date input, or "" when unset. */
  untilLocal: string;
  /** "YYYY-MM-DDTHH:mm" — the first occurrence (shared with the base start). */
  startsAtLocal: string;
  /** IANA timezone the local values are interpreted in. */
  timezone: string;
}

/** RRULE variant of the community `recurrenceScheduleSchema`. */
export interface RecurrenceScheduleRrule {
  kind: "RRULE";
  rrule: string;
  dtstart: string;
  until?: string;
}

/**
 * Parse a `datetime-local` wall-time ("YYYY-MM-DDTHH:mm") into a Date whose UTC
 * calendar fields equal that wall-time — the shape {@link buildRrule} reads for
 * weekday / day-of-month derivation.
 */
function wallTimeToUtcDate(local: string): Date | null {
  const [datePart, timePart = "00:00"] = local.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }
  return new Date(
    Date.UTC(year, month - 1, day, hour || 0, minute || 0, 0),
  );
}

/**
 * Compile the form's recurrence state into a `recurrenceSchedule` payload, or
 * `null` when the listing does not repeat (single-date, unchanged behavior).
 * Returns `null` on incomplete input so a partially-filled section never
 * ships a malformed rule — the caller validates completeness separately.
 */
export function buildRecurrenceSchedule(
  form: CommunityRecurrenceForm,
): RecurrenceScheduleRrule | null {
  if (form.freq === "NONE") return null;
  if (!form.startsAtLocal) return null;

  const wall = wallTimeToUtcDate(form.startsAtLocal);
  if (!wall) return null;

  const dtstart = toIsoInTimeZone(form.startsAtLocal, form.timezone);
  const untilIso = form.untilLocal
    ? toIsoInTimeZone(`${form.untilLocal}T23:59`, form.timezone)
    : undefined;

  const rrule = buildRrule({
    freq: form.freq,
    interval: form.interval,
    byWeekday: form.freq === "WEEKLY" ? form.byWeekday : [],
    startsAt: wall,
    monthlyMode: form.monthlyMode,
    until: untilIso ? new Date(untilIso) : null,
  });

  return {
    kind: "RRULE",
    rrule,
    dtstart,
    ...(untilIso ? { until: untilIso } : {}),
  };
}

/** RRULE weekday of a `datetime-local` wall-time — used to seed the day picker. */
export function weekdayOfLocal(local: string): Weekday | null {
  const wall = wallTimeToUtcDate(local);
  return wall ? weekdayOf(wall) : null;
}
