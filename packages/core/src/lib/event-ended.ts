/**
 * When an event is over, and whether it is over yet.
 *
 * An event ends at its `endsAt`; one without an end ends when it starts. The
 * boundary instant counts as over: at `now === end` the event has ended. This
 * is the rule `ensureEventOnSale` (checkout sales close, `now >= endsAt ??
 * startsAt`) and `rsvpToEvent` already apply inline; new callers should use
 * these helpers rather than restating it.
 *
 * For a series, pass the ticket's own occurrence row: every occurrence is its
 * own Event with its own start and end, so the ticket's `eventId` decides.
 */
export type EventTimes = {
  startsAt: Date;
  endsAt: Date | null;
};

export function eventEndedAt(event: EventTimes): Date {
  return event.endsAt ?? event.startsAt;
}

export function isEventPast(event: EventTimes, now: Date): boolean {
  return now.getTime() >= eventEndedAt(event).getTime();
}
