export interface PushReceiptRecord {
  id: string;
  /** Expo push ticket id — the id used to look the receipt up. */
  ticketId: string;
  pushDeviceId: string;
  /** Polls that found NO receipt yet (drives the give-up budget). */
  attempts: number;
  /** Do not poll before this time. */
  checkAfter: Date;
  createdAt: Date;
}

export interface CreatePushReceiptsInput {
  items: Array<{
    ticketId: string;
    pushDeviceId: string;
  }>;
  /** Earliest time the drain may poll these tickets (send + ~15min). */
  checkAfter: Date;
}

export interface ListDuePushReceiptsInput {
  now: Date;
  limit: number;
}

export interface ReschedulePushReceiptsInput {
  ids: string[];
  /** New earliest poll time for the given rows. */
  checkAfter: Date;
}

/**
 * Outbox of Expo push tickets awaiting their delivery receipt (see the
 * `PushReceipt` model docstring). The ExpoPushAdapter send path writes one row
 * per ok-ticket via {@link createMany} (best-effort: a persist failure is
 * warn-logged, never surfaced to the send); the scheduled
 * `push.drain-receipts` job claims due rows via {@link listDue}, polls Expo,
 * and either {@link deleteByIds}s resolved/expired rows or
 * {@link reschedule}s rows whose receipt hasn't materialized yet.
 *
 * No row leasing (mirrors PendingObjectDeletionsRepo): overlapping drain runs
 * are harmless because deletion is a 0-row no-op on a vanished row, device
 * disabling is idempotent, and a double `reschedule` merely re-bumps the
 * attempt counter (giving up one poll earlier — safe).
 */
export interface PushReceiptsRepo {
  /**
   * Batch-insert pending receipts (attempts 0). Duplicates on the unique
   * `ticketId` are skipped defensively — no known path re-inserts a ticket
   * id (a retried Expo POST mints fresh ids), but this write must never be
   * able to throw into the send path. No-op on an empty `items` array.
   */
  createMany(input: CreatePushReceiptsInput): Promise<void>;

  /**
   * List rows due for a poll — `checkAfter <= now` — ordered by `checkAfter`
   * ascending, limited to `limit`.
   */
  listDue(input: ListDuePushReceiptsInput): Promise<PushReceiptRecord[]>;

  /**
   * Hard-delete resolved / given-up rows (the table drains to empty).
   * Idempotent: rows already drained by an overlapping run are 0-row no-ops.
   * Returns the number of rows actually removed. No-op on an empty array.
   */
  deleteByIds(ids: string[]): Promise<number>;

  /**
   * Record a receipt-still-missing poll: increment `attempts` and push
   * `checkAfter` back so the next drain retries later. updateMany-style —
   * vanished rows are 0-row no-ops. No-op on an empty `ids` array.
   */
  reschedule(input: ReschedulePushReceiptsInput): Promise<void>;
}
