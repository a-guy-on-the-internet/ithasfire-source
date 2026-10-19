/**
 * What an outbox row is FOR. Mirrors the Prisma `RsvpNoticeKind` enum.
 *
 *  - `CONFIRMATION` — "you're going". Enqueued right after a NEWLY-created
 *    RSVP row. The historical (and default) kind.
 *  - `DATE_CANCELLED` — "that night is off". Enqueued by `cancelEventDate`,
 *    one row per LIVE per-date RSVP, inside the transaction that flips the
 *    occurrence SCHEDULED -> CANCELLED. Always carries an `eventDateId`.
 *    Also enqueued by `callOffRemainingDates` when a community listing is
 *    cancelled or archived: ONE row per person (on their earliest remaining
 *    night), which the drain renders as "the whole listing is off" because
 *    the event is no longer PUBLISHED.
 */
export type RsvpNoticeKind = "CONFIRMATION" | "DATE_CANCELLED";

export interface RsvpNoticeRecord {
  id: string;
  eventId: string;
  /**
   * NULL for an event-level RSVP confirmation; set when the user RSVP'd to
   * ONE occurrence (`EventDate`) of a recurring listing — the drain then
   * resolves the DATE's startsAt/endsAt for the message. Always set for a
   * `DATE_CANCELLED` notice.
   */
  eventDateId: string | null;
  humanId: string;
  /** See {@link RsvpNoticeKind}. Rows written before call-offs are CONFIRMATION. */
  kind: RsvpNoticeKind;
  createdAt: Date;
  dispatchedAt: Date | null;
  attempts: number;
}

export interface CreateRsvpNoticeInput {
  eventId: string;
  /** Omit/null for an event-level RSVP; the EventDate id for a per-date RSVP. */
  eventDateId?: string | null;
  humanId: string;
}

export interface CreateDateCancelledNoticesInput {
  eventId: string;
  eventDateId: string;
  /** One notice per id. Duplicates within the array are the caller's problem. */
  humanIds: readonly string[];
}

export interface ListUndispatchedRsvpNoticesInput {
  limit: number;
  /**
   * Only notices never attempted (`attempts = 0`). A write-triggered drain
   * run sets it so a failing notice is retried on the scheduled run's cadence
   * rather than on every write (see `DRAIN_TRIGGERS` in @th/ports/job-trigger).
   */
  freshOnly?: boolean;
}

/**
 * Single-recipient outbox for per-RSVP notifications. Two kinds ride it (see
 * {@link RsvpNoticeKind}): the "you're going" CONFIRMATION, and the "that
 * night is off" DATE_CANCELLED a moderator call-off enqueues. One table on
 * purpose — the drain, the retry/dead-letter bookkeeping and the retention
 * purge are identical for both, and a second outbox is a second thing to
 * forget to drain.
 *
 * rsvp-to-event
 * calls {@link create} right after a NEWLY-created RSVP row (best-effort
 * sequential write — the RSVP upsert deliberately runs outside any
 * transaction, see the event-rsvps adapter docstring, so this is NOT a
 * transactional outbox; a missed confirmation beats a failed RSVP). A
 * scheduled jobs-service task drains {@link listUndispatched} rows, sends one
 * in-app + email confirmation per row, then flips them via
 * {@link markDispatched}; {@link incrementAttempts} records drain retries.
 *
 * Mirrors EventChangeNoticesRepo minus the fan-out bookkeeping: one recipient
 * per row means no payload column and no notifiedHumanIds set — the notify
 * idempotency key (`rsvp-confirmed:{noticeId}` / `rsvp-date-cancelled:{noticeId}`)
 * is the double-send guard.
 */
export interface RsvpNoticesRepo {
  /** Insert one PENDING (undispatched) CONFIRMATION outbox row. */
  create(input: CreateRsvpNoticeInput): Promise<RsvpNoticeRecord>;

  /**
   * Bulk-insert one PENDING `DATE_CANCELLED` row per human. Returns the number
   * of rows written. No-op (0) on an empty `humanIds`.
   *
   * MUST be called inside the same `repos.tx` as the SCHEDULED -> CANCELLED
   * flip. That is the whole idempotency story: the flip is a guarded
   * compare-and-set, so exactly one transaction ever observes the transition,
   * and these rows commit or roll back with it. There is deliberately no
   * unique index behind this — the transaction is the guarantee, which also
   * leaves a later call-off free to notify again after a restore.
   */
  createDateCancelled(
    input: CreateDateCancelledNoticesInput,
  ): Promise<number>;

  /**
   * Delete UNDISPATCHED `DATE_CANCELLED` rows for one occurrence. Returns the
   * number deleted.
   *
   * Called by `restoreEventDate`, in the restoring transaction. A night called
   * off by mistake and put straight back must not still mail "that night is
   * off" on the next drain tick. DISPATCHED rows are left alone: they were
   * already sent, and the retention purge owns them.
   */
  deletePendingDateCancelledForDate(eventDateId: string): Promise<number>;

  /**
   * Undispatched notices (`dispatchedAt IS NULL`), oldest first, capped at
   * `limit`. The drain's claim window (FOR UPDATE SKIP LOCKED in the adapter
   * so overlapping drain runs never double-process a notice).
   */
  listUndispatched(
    input: ListUndispatchedRsvpNoticesInput,
  ): Promise<RsvpNoticeRecord[]>;

  /** Flip the given notices to dispatched at `at`. No-op on an empty array. */
  markDispatched(ids: string[], at: Date): Promise<void>;

  /** Bump `attempts` on the given notices. No-op on an empty array. */
  incrementAttempts(ids: string[]): Promise<void>;

  /**
   * Retention purge: delete DISPATCHED notices whose `dispatchedAt` is older
   * than `cutoff` (`dispatchedAt IS NOT NULL AND dispatchedAt < cutoff`).
   * Returns the number of rows deleted. NEVER deletes undispatched/in-flight
   * notices — those are still owed to recipients.
   */
  deleteDispatchedBefore(cutoff: Date): Promise<number>;
}
