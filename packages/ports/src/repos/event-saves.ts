import type {
  CursorResult,
  EventSaveRecord,
  SavedEventListItem,
} from "@th/types/repos/event-saves";

export interface EventSaveKeyInput {
  eventId: string;
  humanId: string;
}

export type SavedEventsScope = "upcoming" | "past";

export interface ListSavedEventsForHumanInput {
  humanId: string;
  /** upcoming = event.startsAt >= now; past = event.startsAt < now. */
  scope: SavedEventsScope;
  cursor?: string | null;
  limit?: number;
  /** Boundary for the upcoming|past split. Defaults to the adapter's wall clock. */
  now?: Date;
}

export interface GetSavedStateForEventsInput {
  humanId: string;
  /** Bounded to ≤50 ids at the use-case boundary (NFR-001), not here. */
  eventIds: string[];
}

export interface ListHumanIdsForEventInput {
  eventId: string;
  cursor?: string | null;
  limit?: number;
}

/**
 * Private keep-for-later bookmarks (watchlist) for events. Idempotent per
 * (eventId, humanId) via the DB unique constraint; saves are never exposed as
 * a public count — the only by-event surface is the humanId fan-out consumed
 * by the change-notification dispatch.
 */
export interface EventSavesRepo {
  /** Idempotent: re-saving returns the existing row with `created: false`. */
  upsert(
    input: EventSaveKeyInput,
  ): Promise<{ save: EventSaveRecord; created: boolean }>;

  /** Idempotent: deleting a non-existent save is a no-op. */
  delete(
    input: EventSaveKeyInput,
  ): Promise<{ deleted: boolean; saveId: string | null }>;

  existsForUser(input: EventSaveKeyInput): Promise<boolean>;

  /**
   * The user's own saves joined to lean event summaries, most-recently-saved
   * first (createdAt desc, id desc). Cursor is the save id.
   */
  listForHuman(
    input: ListSavedEventsForHumanInput,
  ): Promise<CursorResult<SavedEventListItem>>;

  /** Batch saved flags for event cards; every requested id gets an entry. */
  getSavedStateForEvents(
    input: GetSavedStateForEventsInput,
  ): Promise<Record<string, boolean>>;

  /**
   * Watcher fan-out for the change-notification dispatch (FR-006). Keyset on
   * the compound unique's (eventId, humanId) — cursor is the last humanId.
   */
  listHumanIdsForEvent(
    input: ListHumanIdsForEventInput,
  ): Promise<CursorResult<string>>;
}

export type { CursorResult, EventSaveRecord, SavedEventListItem };
