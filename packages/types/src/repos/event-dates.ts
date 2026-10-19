import type { EventSeriesSchedule } from "./event-series.js";

/**
 * Recurrence definition persisted on `Event.recurrenceSchedule`. Reuses the
 * ticketed-series {@link EventSeriesSchedule} shape (RRULE or FIXED_DATES) so
 * there is ONE schedule format across the codebase — the community recurring
 * listing does not invent a second one.
 */
export type RecurrenceSchedule = EventSeriesSchedule;

/**
 * How far ahead a recurring community listing is materialised into EventDate
 * rows on write, and the hard cap on occurrences ONE expansion pass may
 * generate. A rolling job extends the window over time; every write expands
 * from `now`.
 *
 * They live here, beside the record they size, rather than in `@th/core`
 * because two sides need the same numbers: the write path
 * (`applyRecurrenceForEvent`) uses them to build the desired set, and the
 * moderator's schedule page (`apps/web`, which has no `@th/core` dependency)
 * mirrors that arithmetic in the browser to say how many dates a rule change
 * would destroy BEFORE the write. That number is a promise about someone's
 * schedule; a hand-copied constant made it a promise nothing could check.
 * One definition, imported by both, is the drift guard.
 */
export const RECURRENCE_WINDOW_MONTHS = 12;
export const RECURRENCE_MAX_OCCURRENCES = 60;

export type EventDateStatus = "SCHEDULED" | "CANCELLED";

/**
 * A single expanded occurrence of a recurring event (currently community
 * listings). Single-date events have no rows; they use `Event.startsAt`
 * directly. `ordinal` is a per-event insertion-order identity, unique per
 * event, stable across re-expansions.
 */
export interface EventDateRecord {
  id: string;
  eventId: string;
  ordinal: number;
  startsAt: Date;
  endsAt: Date | null;
  status: EventDateStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Per-date RSVP row. Table exists in slice 1; use-cases land in a later slice. */
export interface EventDateRsvpRecord {
  id: string;
  eventDateId: string;
  humanId: string;
  createdAt: Date;
}
