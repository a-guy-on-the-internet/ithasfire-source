import { z } from "zod";

import type { EventDateRecord } from "@th/ports/repos/event-dates";

// ─────────────────────────────────────────────────────────────────────────────
// EventDate expansion — ONE pure projector shared by every calendar read
// (event-calendar-redesign FR-003; docs/specs/2026-09-02).
//
// A community listing is ONE `Event` with many `EventDate` rows;
// `Event.startsAt` is a pinned MIRROR of its next upcoming row. A calendar
// that reads only `Event.startsAt` paints one chip and hides every other
// night. This projector turns such an event into one occurrence per
// SCHEDULED row, each carrying "Date N of M" for the peek, and leaves every
// other event exactly as it was:
//
//   · rows present → one occurrence per SCHEDULED row; `startsAt`/`endsAt`
//     come from the row; the pinned parent instant is NOT emitted again (it
//     mirrors one of the rows — emitting it would double-paint that night);
//   · no rows      → the parent, `occurrence: null`. Single-date events and
//     series events (EventSeries already mints one Event per date, spec
//     current_state) both take this path unchanged;
//   · CANCELLED rows are skipped and do not count toward `total` — a called-
//     off night is not a chip and "Date 3 of 12" must count real dates.
//
// `window` (optional) drops EXPANDED occurrences outside `[from, to]` using
// an OVERLAP test (`startsAt <= to && (endsAt ?? startsAt) >= from`). The
// repo range reads opt into matching an event by ANY in-window SCHEDULED
// EventDate (`includeDateOccurrences`), so its out-of-window rows must be
// trimmed here — the query admitted the event, not each of its nights.
// Parent fallbacks are NOT trimmed: an event with no SCHEDULED rows can only
// have been admitted by the repo's own window on `Event.startsAt`, which is
// the caller's contract, not this projector's (and the repo's date clause
// is SCHEDULED-only, so "admitted for a row that turned out cancelled"
// cannot happen).
//
// DELIBERATE DROP — rows exist, none in the window: an event that HAS
// SCHEDULED rows but none overlapping `window` emits NOTHING. There is no
// fallback to the pinned parent. This is reachable when the repo admitted
// the event through the parent-overlap arm (`Event.startsAt` in range) while
// the row mirroring that instant has since been CANCELLED, or when a caller
// passes a window narrower than the one the repo used. A cancelled night is
// not a show, and painting the parent instant would put a chip on exactly
// the night that was called off — so the event vanishes from that window on
// purpose. Pinned by "rows exist, none in window" in the tests.
//
// Shared by design (spec risk: "a bug in the projector regresses dashboard,
// place, and embed simultaneously instead of one surface at a time" — the
// mitigation is one unit-tested function, not three implementations).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Date N of M" for an EventDate-expanded occurrence; null for an event with
 * no EventDate rows (single-date or series). `index` is 1-based over the
 * event's SCHEDULED rows in `startsAt` order.
 */
export const calendarOccurrenceSchema = z
  .object({
    index: z.number().int().min(1),
    total: z.number().int().min(1),
    eventDateId: z.string().uuid(),
  })
  .strict()
  .nullable();

export type CalendarOccurrence = z.infer<typeof calendarOccurrenceSchema>;

/** The minimum an event row must carry to be expanded. */
export type ExpandableEvent = {
  id: string;
  startsAt: Date | null;
  endsAt?: Date | null;
};

export type ExpandableEventDate = Pick<
  EventDateRecord,
  "id" | "eventId" | "startsAt" | "endsAt" | "status"
>;

export type ExpandEventDatesOptions = {
  /**
   * Inclusive overlap window for EXPANDED occurrences (EventDate rows);
   * omitted = keep every row. Events without rows pass through regardless
   * — see the module header.
   */
  window?: { from?: Date; to?: Date };
  /**
   * `"startsAt"` re-sorts the flattened output chronologically (stable on
   * input order for ties) — a calendar wants its chips in time order, and
   * expansion interleaves one event's nights among the others'. Omitted =
   * input order, occurrences contiguous per event (a paginated listing must
   * not have its page order rewritten).
   */
  sort?: "startsAt";
};

export type ExpandedOccurrence<E extends ExpandableEvent> = E & {
  occurrence: CalendarOccurrence;
};

function overlapsWindow(
  startsAt: Date | null,
  endsAt: Date | null | undefined,
  window: { from?: Date; to?: Date } | undefined,
): boolean {
  if (!window || startsAt === null) return true;
  const end = endsAt ?? startsAt;
  if (window.to && startsAt.getTime() > window.to.getTime()) return false;
  if (window.from && end.getTime() < window.from.getTime()) return false;
  return true;
}

/**
 * Expand `events` against their `dates` — see the module header for the
 * rules. Pure: no clock, no repo. `dates` may hold rows for events not in
 * `events` (they are ignored) and any status (CANCELLED is skipped).
 */
export function expandEventDates<E extends ExpandableEvent>(
  events: readonly E[],
  dates: readonly ExpandableEventDate[],
  options: ExpandEventDatesOptions = {},
): ExpandedOccurrence<E>[] {
  const scheduledByEvent = new Map<string, ExpandableEventDate[]>();
  for (const date of dates) {
    if (date.status !== "SCHEDULED") continue;
    const list = scheduledByEvent.get(date.eventId) ?? [];
    list.push(date);
    scheduledByEvent.set(date.eventId, list);
  }
  for (const list of scheduledByEvent.values()) {
    list.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }

  const out: Array<{ order: number; row: ExpandedOccurrence<E> }> = [];
  let order = 0;
  for (const event of events) {
    const rows = scheduledByEvent.get(event.id);
    if (rows && rows.length > 0) {
      const total = rows.length;
      rows.forEach((row, i) => {
        if (!overlapsWindow(row.startsAt, row.endsAt, options.window)) return;
        out.push({
          order: order++,
          row: {
            ...event,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            occurrence: { index: i + 1, total, eventDateId: row.id },
          },
        });
      });
      continue;
    }
    out.push({ order: order++, row: { ...event, occurrence: null } });
  }

  if (options.sort === "startsAt") {
    out.sort((a, b) => {
      const at = a.row.startsAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const bt = b.row.startsAt?.getTime() ?? Number.POSITIVE_INFINITY;
      return at - bt || a.order - b.order;
    });
  }
  return out.map((entry) => entry.row);
}
