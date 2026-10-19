import type {
  TemplatePayoutTermsDraft,
  TemplateLocation,
  TemplateTicketType,
} from "./event-templates";

export type EventSeriesOwnerScope = "ORGANIZATION" | "HUMAN";

export type EventSeriesScheduleKind = "RRULE" | "FIXED_DATES";

export interface EventSeriesSchedule {
  kind: EventSeriesScheduleKind;
  rrule?: string | null;
  dtstart?: string | null;
  until?: string | null;
  dates?: string[] | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  maxOccurrencesPerExpand?: number | null;
}

export interface EventSeriesDefaults {
  titlePrefix?: string | null;
  location?: TemplateLocation | null;
  categories?: string[] | null;
  types?: string[] | null;
  attributes?: string[] | null;
  feePolicyId?: string | null;
  payoutTermsDraft?: TemplatePayoutTermsDraft | null;
  /** @deprecated Use payoutTermsDraft */
  agreementDraft?: TemplatePayoutTermsDraft | null;
  ticketTypes?: TemplateTicketType[] | null;
}

export type EventSeriesOccurrenceStatus =
  | "PLANNED"
  | "SKIPPED"
  | "GENERATED"
  | "PUBLISHED"
  | "CANCELLED"
  | "DETACHED";

export interface EventSeriesOccurrenceOverrides {
  title?: string | null;
  location?: TemplateLocation | null;
  types?: string[] | null;
  attributes?: string[] | null;
  /**
   * Marks a manually added one-off date (addSeriesOccurrence). Manual
   * occurrences are off-grid by design: reconcileSeriesSchedule must never
   * classify them as orphaned (deleted/detached) when they don't match the
   * series schedule.
   */
  manual?: boolean | null;
  /** Organizer note captured when the occurrence was skipped. Cleared on restore. */
  skipNote?: string | null;
  /** Organizer note captured when a manual occurrence was added. */
  note?: string | null;
}

export interface EventSeriesRecord {
  id: string;
  ownerScope: EventSeriesOwnerScope;
  ownerId: string;
  name: string;
  description: string | null;
  active: boolean;
  timezone: string;
  schedule: EventSeriesSchedule;
  templateId: string | null;
  defaults: EventSeriesDefaults | null;
  /** Null when the creating account has been deleted (creator detached). */
  createdByHumanId: string | null;
  updatedByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface CreateEventSeriesRepoInput {
  ownerScope: EventSeriesOwnerScope;
  ownerId: string;
  name: string;
  description: string | null;
  timezone: string;
  schedule: EventSeriesSchedule;
  templateId: string | null;
  defaults: EventSeriesDefaults | null;
  createdByHumanId: string;
  createdAt: Date;
}

export interface UpdateEventSeriesRepoPatch {
  name?: string;
  description?: string | null;
  timezone?: string;
  schedule?: EventSeriesSchedule;
  templateId?: string | null;
  defaults?: EventSeriesDefaults | null;
  active?: boolean;
  updatedByHumanId: string;
  updatedAt: Date;
}

export interface ArchiveEventSeriesRepoInput {
  seriesId: string;
  archivedAt: Date;
  archivedByHumanId: string;
}

export interface EventSeriesListFilters {
  ownerScope: EventSeriesOwnerScope;
  ownerId: string;
  activeOnly?: boolean;
  q?: string;
  limit: number;
  cursor?: string | null;
}

export interface EventSeriesListResult {
  items: EventSeriesRecord[];
  nextCursor?: string | null;
}

export interface EventSeriesOccurrenceRecord {
  id: string;
  seriesId: string;
  ordinal: number;
  startsAt: Date;
  endsAt: Date | null;
  status: EventSeriesOccurrenceStatus;
  eventId: string | null;
  overrides: EventSeriesOccurrenceOverrides | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventSeriesOccurrenceListFilters {
  seriesId: string;
  range?: { start: Date; end: Date };
  status?: EventSeriesOccurrenceStatus[];
  limit: number;
  cursor?: string | null;
}

export interface EventSeriesOccurrenceListResult {
  items: EventSeriesOccurrenceRecord[];
  nextCursor?: string | null;
}

export interface CreateEventSeriesOccurrenceInput {
  seriesId: string;
  /** Must be unique per series — callers allocate max(ordinal over ALL statuses) + 1. */
  ordinal: number;
  startsAt: Date;
  endsAt: Date | null;
  status: EventSeriesOccurrenceStatus;
  overrides: EventSeriesOccurrenceOverrides | null;
  createdAt: Date;
}

export interface BulkUpsertEventSeriesOccurrenceRow {
  seriesId: string;
  ordinal: number;
  startsAt: Date;
  endsAt?: Date | null;
  status: EventSeriesOccurrenceStatus;
}

export interface BulkUpsertEventSeriesOccurrencesInput {
  occurrences: BulkUpsertEventSeriesOccurrenceRow[];
}

export interface AttachEventToOccurrenceInput {
  occurrenceId: string;
  eventId: string;
  updatedAt: Date;
}

export interface ApplyOccurrenceOverridesInput {
  occurrenceId: string;
  overrides: EventSeriesOccurrenceOverrides | null;
  updatedAt: Date;
}

export interface MarkOccurrenceStatusInput {
  occurrenceId: string;
  status: EventSeriesOccurrenceStatus;
  updatedAt: Date;
}

/**
 * Guarded conditional status transition (compare-and-set). The expectations
 * ride in the UPDATE's WHERE clause, so a concurrent writer that changed the
 * row between the caller's read and this write makes the update a no-op
 * (`updated: false`) instead of corrupting state.
 */
export interface MarkOccurrenceStatusIfInput {
  occurrenceId: string;
  /** Only transition when the row currently holds this status. */
  expectStatus: EventSeriesOccurrenceStatus;
  /** When true, additionally require `eventId IS NULL`. */
  expectNoEvent?: boolean;
  status: EventSeriesOccurrenceStatus;
  updatedAt: Date;
}

export interface UniqueOccurrenceCheckInput {
  seriesId: string;
  ordinal?: number;
  startsAt?: Date;
}

export interface BulkDeletePlannedInput {
  seriesId: string;
  /** Delete PLANNED occurrences whose startsAt is NOT in this set AND startsAt > afterDate. */
  excludeStartsAtMs: Set<number>;
  /** Only consider occurrences starting after this date (future-only guard). */
  afterDate: Date;
}

export interface BulkDeletePlannedResult {
  deletedCount: number;
}

export interface BulkDetachInput {
  seriesId: string;
  occurrenceIds: string[];
  updatedAt: Date;
}

export interface BulkDetachResult {
  detachedCount: number;
}

export interface EventSeriesDTO extends EventSeriesRecord {}

export interface EventSeriesOccurrenceDTO extends EventSeriesOccurrenceRecord {}

/** Lightweight series info for calendar enrichment. */
export interface EventSeriesCalendarInfo {
  eventId: string;
  seriesId: string;
  seriesName: string;
  occurrenceId: string;
}

/** A single published, public date of a series for the buyer-facing switcher. */
export interface PublicSeriesDateRecord {
  occurrenceId: string;
  eventId: string;
  slug: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  timezone: string;
}
