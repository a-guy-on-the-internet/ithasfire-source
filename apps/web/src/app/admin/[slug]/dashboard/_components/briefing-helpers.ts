// ─────────────────────────────────────────────────────────────────────────────
// Pure selection helpers for the mobile "dashboard briefing" layout.
//
// These operate on the SAME `CalendarEvent[]` the dashboard already fetches
// for its calendar (trpc.events.listMine) — no extra queries. Kept pure
// (no React, no Date.now() internally) so the today/tonight boundary and the
// 7-day window are unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

import type { CalendarEvent } from "@/app/admin/[slug]/_components/event-calendar-types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Events with no `endsAt` stay "happening" for this long after doors —
 * without it the Tonight card (and its Scan CTA) would vanish at exactly
 * `startsAt`, the moment the organiser most needs it.
 */
const NO_END_GRACE_MS = 6 * 60 * 60 * 1000;

/** True when `a` and `b` fall on the same local calendar day. */
export function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * End-of-life instant for an event: `endsAt` when set, else `startsAt`
 * plus a grace window (see NO_END_GRACE_MS).
 */
function eventEnd(e: CalendarEvent): number | null {
  if (e.endsAt) return e.endsAt.getTime();
  return e.startsAt ? e.startsAt.getTime() + NO_END_GRACE_MS : null;
}

/**
 * The next upcoming PUBLISHED event: earliest `startsAt` among published
 * events that have not yet ended (an in-progress event with a future `endsAt`
 * still counts — it is "Tonight"). Returns `null` when there is none.
 */
export function selectNextEvent(
  events: CalendarEvent[],
  now: Date,
): CalendarEvent | null {
  let best: CalendarEvent | null = null;
  for (const e of events) {
    if (e.status !== "PUBLISHED" || !e.startsAt) continue;
    const end = eventEnd(e);
    if (end === null || end < now.getTime()) continue;
    if (!best || e.startsAt.getTime() < best.startsAt!.getTime()) best = e;
  }
  return best;
}

/**
 * "Tonight" test for the briefing band label: the event starts today, or it
 * started earlier and is still running right now.
 */
export function isHappeningToday(e: CalendarEvent, now: Date): boolean {
  if (!e.startsAt) return false;
  if (isSameCalendarDay(e.startsAt, now)) return true;
  const end = eventEnd(e);
  return e.startsAt.getTime() <= now.getTime() && end !== null && end >= now.getTime();
}

/**
 * Agenda rows for the "This week" band: events STARTING within the next 7
 * days (`[now, now + 7d)`), any status (the row's status badge carries the
 * DRAFT/CANCELLED signal), earliest first, capped at `max`.
 */
export function selectWeekAgenda(
  events: CalendarEvent[],
  now: Date,
  max = 4,
): CalendarEvent[] {
  const windowEnd = now.getTime() + WEEK_MS;
  return events
    .filter((e) => {
      if (!e.startsAt) return false;
      const start = e.startsAt.getTime();
      return start >= now.getTime() && start < windowEnd;
    })
    .sort((a, b) => a.startsAt!.getTime() - b.startsAt!.getTime())
    .slice(0, max);
}

/**
 * Count of published events that have not yet ended — the fourth cell of the
 * mobile proof band (the desktop stat cards only have three stats).
 */
export function countUpcomingPublished(
  events: CalendarEvent[],
  now: Date,
): number {
  return events.filter((e) => {
    if (e.status !== "PUBLISHED" || !e.startsAt) return false;
    const end = eventEnd(e);
    return end !== null && end >= now.getTime();
  }).length;
}
