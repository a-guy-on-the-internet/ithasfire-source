import { getAppErrorCode } from "./app-error";

/**
 * `EVENT_MOVED` (409): a venue confirmation is a vouch for a DATE, and the
 * event's start changed after the venue's screen loaded (the organizer moved
 * it). Core refuses and writes nothing; the venue has to see the new date and
 * confirm again.
 *
 * `startsAt` is the event's CURRENT start when the server knows it (the venue
 * can see the event, so its screen can say what it moved to) and NULL when
 * the move was caught by the write's compare-and-set — then only a refetch
 * can say where it went. Meta rides `error.data.meta` (the API's
 * errorFormatter, same channel as `quota-error.ts`).
 */
export type EventMovedInfo = { startsAt: Date | null };

export function extractEventMoved(error: unknown): EventMovedInfo | null {
  if (getAppErrorCode(error) !== "EVENT_MOVED") return null;
  const meta = (error as { data?: { meta?: unknown } }).data?.meta;
  const raw =
    meta && typeof meta === "object"
      ? (meta as { startsAt?: unknown }).startsAt
      : null;
  const startsAt = typeof raw === "string" ? new Date(raw) : null;
  return {
    startsAt:
      startsAt !== null && Number.isFinite(startsAt.getTime())
        ? startsAt
        : null,
  };
}
