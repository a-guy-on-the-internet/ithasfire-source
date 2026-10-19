/**
 * Change type captured by an outbox row. Mirrors the Prisma `EventChangeType`
 * enum; kept as a string union at the port boundary so core/jobs never import
 * `@prisma/client`.
 */
export type EventChangeType =
  | "CANCELLED"
  | "RESCHEDULED"
  | "VENUE_CHANGED"
  | "ARCHIVED"
  | "UNPUBLISHED";

export interface EventChangeNoticeRecord {
  id: string;
  eventId: string;
  changeType: EventChangeType;
  /** Denormalized JSON-serializable diff. Typed by the job layer, not here. */
  payload: unknown;
  createdAt: Date;
  dispatchedAt: Date | null;
  attempts: number;
  /**
   * Durable per-recipient dedup: humanIds that have already been notified for
   * THIS notice across prior drain runs. The drain subtracts these from the
   * resolved audience before fanning out, so a partial fan-out that retries on
   * a later tick only targets the still-un-notified remainder — no recipient
   * is ever notified twice, even after the `notify` idempotency key TTL lapses.
   */
  notifiedHumanIds: string[];
}

export interface CreateEventChangeNoticeInput {
  eventId: string;
  changeType: EventChangeType;
  /** JSON-serializable. */
  payload: unknown;
}

export interface ListUndispatchedEventChangeNoticesInput {
  limit: number;
  /**
   * Only notices never attempted (`attempts = 0`). A write-triggered drain
   * run sets it so a failing notice is retried on the scheduled run's cadence
   * rather than on every write (see `DRAIN_TRIGGERS` in @th/ports/job-trigger).
   */
  freshOnly?: boolean;
}

/**
 * Transactional outbox for event-change notifications. A use-case that
 * cancels/reschedules/venue-changes/archives/unpublishes an event calls
 * {@link create} inside the SAME `repos.tx` as the mutation, so the notice
 * commits atomically with the change. A scheduled jobs-service task drains
 * {@link listUndispatched} rows, fans out to watchers, then flips them via
 * {@link markDispatched}; {@link incrementAttempts} records drain retries.
 */
export interface EventChangeNoticesRepo {
  /** Insert one PENDING (undispatched) outbox row. */
  create(input: CreateEventChangeNoticeInput): Promise<EventChangeNoticeRecord>;

  /**
   * Undispatched notices (`dispatchedAt IS NULL`), oldest first, capped at
   * `limit`. The drain's claim window.
   */
  listUndispatched(
    input: ListUndispatchedEventChangeNoticesInput,
  ): Promise<EventChangeNoticeRecord[]>;

  /** Flip the given notices to dispatched at `at`. No-op on an empty array. */
  markDispatched(ids: string[], at: Date): Promise<void>;

  /** Bump `attempts` on the given notices. No-op on an empty array. */
  incrementAttempts(ids: string[]): Promise<void>;

  /**
   * Append `humanIds` to a notice's {@link EventChangeNoticeRecord.notifiedHumanIds}
   * set (deduped/idempotent). Called after a drain run finishes fanning a notice
   * out to record who was successfully notified this run, so a subsequent retry
   * skips them. No-op on an empty array.
   */
  markNotified(id: string, humanIds: string[]): Promise<void>;

  /**
   * Retention purge: delete DISPATCHED notices whose `dispatchedAt` is older
   * than `cutoff` (`dispatchedAt IS NOT NULL AND dispatchedAt < cutoff`).
   * Returns the number of rows deleted. NEVER deletes undispatched/in-flight
   * notices — those are still owed to recipients. Bounds financial data
   * (CANCELLED payloads carry buyer humanIds + refund cents) at rest.
   */
  deleteDispatchedBefore(cutoff: Date): Promise<number>;
}
