import type { CursorResult } from "@th/types/repos/follows";

import type { EventRsvpRecord, EventStatus } from "@th/types";
// Reuse the watcher-fan-out input shape defined by the event-saves port so
// both by-event audience queries share one keyset contract (FR-004).
import type { ListHumanIdsForEventInput } from "./event-saves";

export interface EventRsvpKeyInput {
  eventId: string;
  humanId: string;
}

export interface ListEventRsvpsForUserInput {
  humanId: string;
  cursor?: string | null;
  limit?: number;
}

export interface ListEventRsvpsForUserResult {
  items: EventRsvpRecord[];
  nextCursor: string | null;
}

export interface ListUpcomingRsvpEventsForUserInput {
  humanId: string;
  /** An event counts while it has not ended: `Event.endsAt > now`. */
  now: Date;
  /** Only events in these statuses (the next-night read passes PUBLISHED). */
  eventStatuses: readonly EventStatus[];
  /** At most this many rows; the caller keeps it to a handful. */
  limit: number;
}

/** One RSVP'd, not-yet-ended event, soonest first. */
export interface UpcomingRsvpEventRow {
  eventId: string;
  startsAt: Date;
}

/**
 * Result of {@link EventRsvpsRepo.upsert}. `created` distinguishes a fresh
 * INSERT (`true`) from an idempotent re-RSVP that read the existing row back
 * (`false`) — the RSVP-confirmation enqueue fires ONLY on `created`, so
 * re-pressing the RSVP button never produces a duplicate confirmation.
 */
export interface UpsertEventRsvpResult {
  record: EventRsvpRecord;
  created: boolean;
}

/**
 * Personal "I'm going" markers for RSVP events. Idempotent per
 * (eventId, humanId) via the DB unique constraint; there is deliberately no
 * count/list-by-event surface — RSVPs are never exposed as a public count.
 */
export interface EventRsvpsRepo {
  /**
   * Idempotent: re-RSVPing returns the existing row with `created: false`;
   * only a fresh insert reports `created: true`.
   */
  upsert(input: EventRsvpKeyInput): Promise<UpsertEventRsvpResult>;
  /** Idempotent: deleting a non-existent RSVP is a no-op. */
  delete(input: EventRsvpKeyInput): Promise<void>;
  existsForUser(input: EventRsvpKeyInput): Promise<boolean>;
  /** Events the user said "I'm going" to (their own attendance intent only). */
  listForUser(
    input: ListEventRsvpsForUserInput,
  ): Promise<ListEventRsvpsForUserResult>;
  /**
   * The SAME ownership predicate as {@link listForUser} (the human's own
   * RSVP rows; cancelling deletes the row, so every row is live), narrowed to
   * events that have not ended and are in `eventStatuses`, ordered by
   * `(Event.startsAt, eventId)` ascending. Backs the navbar's next-night read,
   * which needs the soonest few rather than the newest-RSVP'd page.
   */
  listUpcomingEventsForUser(
    input: ListUpcomingRsvpEventsForUserInput,
  ): Promise<UpcomingRsvpEventRow[]>;

  /**
   * Watcher fan-out for the change-notification dispatch (FR-004). Keyset on
   * the compound unique's (eventId, humanId) — cursor is the last humanId.
   * Mirrors EventSavesRepo.listHumanIdsForEvent; the dispatch unions both.
   */
  listHumanIdsForEvent(
    input: ListHumanIdsForEventInput,
  ): Promise<CursorResult<string>>;
}

export type { EventRsvpRecord, ListHumanIdsForEventInput };
