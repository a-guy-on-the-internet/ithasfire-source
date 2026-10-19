import type {
  ApplyOccurrenceOverridesInput,
  AttachEventToOccurrenceInput,
  BulkDeletePlannedInput,
  BulkDeletePlannedResult,
  BulkDetachInput,
  BulkDetachResult,
  BulkUpsertEventSeriesOccurrencesInput,
  CreateEventSeriesOccurrenceInput,
  EventSeriesCalendarInfo,
  EventSeriesListFilters,
  EventSeriesListResult,
  EventSeriesOccurrenceDTO,
  EventSeriesOccurrenceListFilters,
  EventSeriesOccurrenceListResult,
  EventSeriesOccurrenceRecord,
  EventSeriesOccurrenceStatus,
  EventSeriesRecord,
  MarkOccurrenceStatusIfInput,
  MarkOccurrenceStatusInput,
  PublicSeriesDateRecord,
  UniqueOccurrenceCheckInput,
  ArchiveEventSeriesRepoInput,
  CreateEventSeriesRepoInput,
  UpdateEventSeriesRepoPatch,
} from "@th/types";

export interface EventSeriesRepo {
  getById(seriesId: string): Promise<EventSeriesRecord | null>;
  findActiveByName(
    ownerScope: EventSeriesRecord["ownerScope"],
    ownerId: string,
    normalizedName: string,
  ): Promise<EventSeriesRecord | null>;
  /**
   * Whether ANY series row — including ARCHIVED ones — holds this normalized
   * name for the owner. The DB unique constraint
   * `(ownerScope, ownerId, nameNormalized)` spans archived rows, so callers
   * picking a fresh name must check beyond {@link findActiveByName} or the
   * insert dies on the constraint mid-transaction.
   */
  nameExists(
    ownerScope: EventSeriesRecord["ownerScope"],
    ownerId: string,
    normalizedName: string,
  ): Promise<boolean>;
  create(input: CreateEventSeriesRepoInput): Promise<EventSeriesRecord>;
  update(
    seriesId: string,
    patch: UpdateEventSeriesRepoPatch,
  ): Promise<EventSeriesRecord>;
  archive(input: ArchiveEventSeriesRepoInput): Promise<EventSeriesRecord>;
  listByOwner(filters: EventSeriesListFilters): Promise<EventSeriesListResult>;
}

export interface EventSeriesOccurrencesRepo {
  getById(occurrenceId: string): Promise<EventSeriesOccurrenceRecord | null>;
  listBySeries(
    filters: EventSeriesOccurrenceListFilters,
  ): Promise<EventSeriesOccurrenceListResult>;
  bulkUpsert(
    input: BulkUpsertEventSeriesOccurrencesInput,
  ): Promise<{ count: number }>;
  /**
   * Create-only bulk insert. Unlike {@link bulkUpsert} (which keys on
   * (seriesId, ordinal) and silently UPDATEs an existing row on ordinal
   * collision — overwriting its startsAt/status), a collision here throws
   * `OCCURRENCE_ALLOCATION_CONFLICT` so the surrounding transaction rolls
   * back loudly. Used by reconcile's insert path, whose cross-retry
   * idempotency rests on startsAt dedupe, not ordinal upserts.
   */
  bulkCreate(
    input: BulkUpsertEventSeriesOccurrencesInput,
  ): Promise<{ count: number }>;
  /**
   * Insert a single occurrence and return the created record. Used by
   * addSeriesOccurrence (manual one-off dates), which needs the new row's id —
   * {@link bulkUpsert} only returns a count. Throws
   * `OCCURRENCE_ALLOCATION_CONFLICT` on a (seriesId, ordinal) collision.
   */
  create(
    input: CreateEventSeriesOccurrenceInput,
  ): Promise<EventSeriesOccurrenceRecord>;
  /** Total number of occurrences (all statuses) for a series. */
  countBySeries(seriesId: string): Promise<number>;
  attachEvent(
    input: AttachEventToOccurrenceInput,
  ): Promise<EventSeriesOccurrenceDTO>;
  applyOverrides(
    input: ApplyOccurrenceOverridesInput,
  ): Promise<EventSeriesOccurrenceDTO>;
  markStatus(
    input: MarkOccurrenceStatusInput,
  ): Promise<EventSeriesOccurrenceDTO>;
  /**
   * Guarded conditional transition (see {@link MarkOccurrenceStatusIfInput}).
   * Returns `updated: false` when the row no longer matches the expectations
   * — callers translate that into their domain conflict error.
   */
  markStatusIf(
    input: MarkOccurrenceStatusIfInput,
  ): Promise<{ updated: boolean }>;
  uniqueCheck(input: UniqueOccurrenceCheckInput): Promise<boolean>;
  /** Lightweight lookup: which of these event IDs belong to a series? */
  getCalendarInfoForEventIds(
    eventIds: string[],
  ): Promise<EventSeriesCalendarInfo[]>;
  /** Delete PLANNED occurrences that no longer match the schedule (future-only). */
  bulkDeletePlanned(
    input: BulkDeletePlannedInput,
  ): Promise<BulkDeletePlannedResult>;
  /** Mark occurrences as DETACHED (soft-orphan). */
  bulkDetach(input: BulkDetachInput): Promise<BulkDetachResult>;
  /** Fetch all occurrences for a series filtered by statuses (unbounded, capped by maxOccurrences). */
  listBySeriesAndStatuses(
    seriesId: string,
    statuses: EventSeriesOccurrenceStatus[],
    afterDate: Date,
  ): Promise<EventSeriesOccurrenceRecord[]>;
  /** Resolve the series an event belongs to via its occurrence link, if any. */
  findSeriesIdByEventId(
    eventId: string,
  ): Promise<{ seriesId: string; seriesName: string } | null>;
  /**
   * List a series' published, public sibling dates for the buyer-facing date
   * switcher. Only returns occurrences whose linked event is PUBLISHED and
   * PUBLIC, ordered by startsAt asc and capped at `limit`.
   */
  listPublishedDatesBySeriesId(
    seriesId: string,
    limit: number,
  ): Promise<PublicSeriesDateRecord[]>;
}

export type {
  ApplyOccurrenceOverridesInput,
  AttachEventToOccurrenceInput,
  BulkDeletePlannedInput,
  BulkDeletePlannedResult,
  BulkDetachInput,
  BulkDetachResult,
  BulkUpsertEventSeriesOccurrencesInput,
  CreateEventSeriesOccurrenceInput,
  EventSeriesCalendarInfo,
  EventSeriesListFilters,
  EventSeriesListResult,
  EventSeriesOccurrenceDTO,
  EventSeriesOccurrenceListFilters,
  EventSeriesOccurrenceListResult,
  EventSeriesOccurrenceRecord,
  EventSeriesOccurrenceStatus,
  EventSeriesRecord,
  MarkOccurrenceStatusIfInput,
  MarkOccurrenceStatusInput,
  PublicSeriesDateRecord,
  UniqueOccurrenceCheckInput,
  ArchiveEventSeriesRepoInput,
  CreateEventSeriesRepoInput,
  UpdateEventSeriesRepoPatch,
} from "@th/types";
