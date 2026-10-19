import type { CalendarHold } from "./event-calendar-types";

// ─────────────────────────────────────────────────────────────────────────────
// HOLD OVERLAY helpers (booking-holds spec 2026-08-25, FR-014).
//
// A hold is a DATE, not a time — `date` is the place-local calendar day as
// `YYYY-MM-DD`. Consumed by the booking-hold pickers (`components/bookings`);
// the admin calendar engine under `./calendar/` has its own hold model.
//
// PURE, so the per-day grouping is pinned by tests without a render.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LIVE holds only (ACTIVE or CHALLENGED, not lapsed) — the server projects
 * `lapsed` for us and a lapsed hold is already released in every sense that
 * matters to a booker. Ordered by position: the line, as the venue keeps it.
 */
export function liveCalendarHolds(holds: readonly CalendarHold[]): CalendarHold[] {
  return holds
    .filter((h) => (h.status === "ACTIVE" || h.status === "CHALLENGED") && !h.lapsed)
    .slice()
    .sort((a, b) => a.position - b.position);
}

/** `date` → that day's live holds, in line order. */
export function indexHoldsByDay(
  holds: readonly CalendarHold[],
): Map<string, CalendarHold[]> {
  const map = new Map<string, CalendarHold[]>();
  for (const hold of liveCalendarHolds(holds)) {
    const list = map.get(hold.date);
    if (list) list.push(hold);
    else map.set(hold.date, [hold]);
  }
  return map;
}

/**
 * The act name a hold line shows, or null when the overlay has none to show.
 * Chain: a non-blank pitched `actName`, else the sender's non-blank platform
 * `performerDisplayName` (resolved server-side in `booking-hold-overlay.ts`),
 * else null → the caller renders the "unnamed act" catalog string. Blank or
 * whitespace-only names are treated as absent rather than painted as an
 * empty line.
 */
export function holdActLabel(
  hold: Pick<CalendarHold, "actName" | "performerDisplayName">,
): string | null {
  for (const candidate of [hold.actName, hold.performerDisplayName]) {
    const name = candidate?.trim() ?? "";
    if (name.length > 0) return name;
  }
  return null;
}
