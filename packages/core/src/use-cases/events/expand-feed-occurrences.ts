import type { ExpandableEventDate } from "./expand-event-dates";

// ─────────────────────────────────────────────────────────────────────────────
// Calendar-FEED occurrence expansion (public iCalendar feeds only).
//
// The on-site calendars use `expandEventDates`, which drops a CANCELLED night
// (a called-off night is not a chip). A subscribed calendar is different: it
// already holds the night from an earlier refresh, and a night that simply
// vanishes from the feed is a night the subscriber never hears was called
// off (most clients keep or silently delete it). So the feed keeps it, marked
// cancelled, under the SAME UID it carried while live:
//
//   · rows present → one occurrence per row, SCHEDULED or CANCELLED;
//     `cancelled` when the row is CANCELLED or the whole event is (a taken-
//     down listing flips its remaining nights to CANCELLED and keeps its
//     pinned `startsAt`, so the rows are the truth). The pinned parent instant
//     is never emitted again (it mirrors one of the rows);
//   · no rows      → the parent itself, `cancelled` when the event is.
//
// Everything is trimmed to `window` with an overlap test, parents included,
// and a cancelled occurrence must also end at or after `cancelledFrom`
// (only UPCOMING called-off nights are worth telling a subscriber about).
//
// Deliberately a separate function from `expandEventDates`: the place page,
// dashboard and embed calendars must keep hiding cancelled nights, and a flag
// on the shared projector would put that rule one wrong argument away.
// ─────────────────────────────────────────────────────────────────────────────

export type FeedExpandableEvent = {
  id: string;
  status: string;
  startsAt: Date;
  endsAt: Date | null;
  updatedAt?: Date | null;
};

export type FeedExpandableEventDate = ExpandableEventDate & {
  updatedAt?: Date | null;
};

export type FeedOccurrence<E extends FeedExpandableEvent> = {
  event: E;
  startsAt: Date;
  endsAt: Date | null;
  /** The EventDate row this night comes from; null for a single-date event. */
  eventDateId: string | null;
  cancelled: boolean;
  /** Latest of the event's and the night's `updatedAt`, when known. */
  lastModified: Date | null;
};

export type ExpandFeedOccurrencesOptions = {
  window: { from?: Date; to?: Date };
  /** A cancelled occurrence must end at/after this instant. */
  cancelledFrom?: Date;
};

function overlaps(
  startsAt: Date,
  endsAt: Date | null,
  window: { from?: Date; to?: Date },
): boolean {
  const end = endsAt ?? startsAt;
  if (window.to && startsAt.getTime() > window.to.getTime()) return false;
  if (window.from && end.getTime() < window.from.getTime()) return false;
  return true;
}

function latest(a: Date | null | undefined, b: Date | null | undefined) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

export function expandFeedOccurrences<E extends FeedExpandableEvent>(
  events: readonly E[],
  dates: readonly FeedExpandableEventDate[],
  options: ExpandFeedOccurrencesOptions,
): FeedOccurrence<E>[] {
  const rowsByEvent = new Map<string, FeedExpandableEventDate[]>();
  for (const date of dates) {
    if (date.status !== "SCHEDULED" && date.status !== "CANCELLED") continue;
    const list = rowsByEvent.get(date.eventId) ?? [];
    list.push(date);
    rowsByEvent.set(date.eventId, list);
  }

  const keep = (o: FeedOccurrence<E>) =>
    overlaps(o.startsAt, o.endsAt, options.window) &&
    (!o.cancelled ||
      !options.cancelledFrom ||
      (o.endsAt ?? o.startsAt).getTime() >= options.cancelledFrom.getTime());

  const out: Array<{ order: number; occurrence: FeedOccurrence<E> }> = [];
  let order = 0;
  for (const event of events) {
    const eventCancelled = event.status === "CANCELLED";
    const rows = rowsByEvent.get(event.id);
    const candidates: FeedOccurrence<E>[] =
      rows && rows.length > 0
        ? rows.map((row) => ({
            event,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            eventDateId: row.id,
            cancelled: eventCancelled || row.status === "CANCELLED",
            lastModified: latest(event.updatedAt, row.updatedAt),
          }))
        : [
            {
              event,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              eventDateId: null,
              cancelled: eventCancelled,
              lastModified: event.updatedAt ?? null,
            },
          ];
    for (const occurrence of candidates) {
      if (keep(occurrence)) out.push({ order: order++, occurrence });
    }
  }

  out.sort(
    (a, b) =>
      a.occurrence.startsAt.getTime() - b.occurrence.startsAt.getTime() ||
      a.order - b.order,
  );
  return out.map((entry) => entry.occurrence);
}
