import { zonedInstant } from "../helpers";
import type { CalendarEventItem, CalendarHoldItem } from "../types";

export const TZ = "America/Chicago";

/** Wall-clock in the paint zone → instant. */
export const at = (m: number, d: number, h: number, min = 0, tz = TZ, y = 2026) =>
  zonedInstant(y, m, d, h, min, tz);

export function event(over: Partial<CalendarEventItem> & { id: string }): CalendarEventItem {
  return {
    kind: "event",
    eventId: over.id,
    title: `Event ${over.id}`,
    status: "PUBLISHED",
    startsAt: at(9, 5, 20),
    endsAt: at(9, 5, 23),
    timezone: TZ,
    ...over,
  };
}

export function hold(over: Partial<CalendarHoldItem> & { id: string }): CalendarHoldItem {
  return {
    kind: "hold",
    title: `Act ${over.id}`,
    position: 1,
    status: "ACTIVE",
    startsAt: at(9, 5, 0),
    endsAt: null,
    ...over,
  };
}
