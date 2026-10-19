import type { EventStatus } from "@th/ports/repos/events";

/**
 * Event statuses that make an anchored draft DEAD for booking purposes. A
 * CANCELLED/ARCHIVED draft keeps its `draftEventId` link (only a delete
 * SetNulls the anchor), but handing it back as "the event for this booking"
 * would be a lie — so the anchor short-circuit, the envelope's liveness walk
 * and confirm-booking-hold's pre-flight all treat it as "no event" through
 * this one predicate.
 */
export const DEAD_BOOKING_EVENT_STATUSES = ["CANCELLED", "ARCHIVED"] as const;
type DeadBookingEventStatus = (typeof DEAD_BOOKING_EVENT_STATUSES)[number];

/**
 * Narrows to a SUBTYPE of `T` (status ∉ dead), not to `T` itself. With
 * `event is T`, TypeScript eliminated `T` in the `!` branch and left only
 * `null | undefined` — so `anchored?.status` in dead-draft handling was
 * `.status` on `never` (TS2339), though a CANCELLED row is very much a `T`.
 * The constraint is `EventStatus`, not `string`: `Exclude<string, "CANCELLED">`
 * is just `string`, and the subtype would collapse back to `T`, reopening
 * the same hole.
 */
export function isLiveBookingEvent<T extends { status: EventStatus }>(
  event: T | null | undefined,
): event is T & { status: Exclude<EventStatus, DeadBookingEventStatus> } {
  return (
    event != null &&
    !(DEAD_BOOKING_EVENT_STATUSES as readonly string[]).includes(event.status)
  );
}

/**
 * The show is upcoming and not dead for booking purposes: live
 * ({@link isLiveBookingEvent}) and not started (`startsAt > now`, the late
 * join's cut-off). Owner ruling 2026-10-01: only such a show has its act
 * passed by a lineup leave — `leaveEventLineup` / `listMyLineups` (through
 * `event-humans/_shared/lineup-leave-booking`) and the guarded pass
 * (`declineBookingRequestAct`'s `onlyWhileEventUpcoming`) share this rule.
 */
export function isUpcomingLiveBookingShow(
  event: { status: EventStatus; startsAt: Date },
  now: Date,
): boolean {
  return (
    isLiveBookingEvent(event) && event.startsAt.getTime() > now.getTime()
  );
}
