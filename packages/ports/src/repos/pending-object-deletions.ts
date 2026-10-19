import type {
  CountPendingObjectDeletionsInput,
  EnqueuePendingObjectDeletionItem,
  EnqueuePendingObjectDeletionOnceItem,
  EnqueuePendingObjectDeletionOnceResult,
  ListDuePendingObjectDeletionsInput,
  MarkPendingObjectDeletionDeadInput,
  MarkPendingObjectDeletionFailedInput,
  PendingObjectDeletionOutboxHealth,
  PendingObjectDeletionRecord,
} from "@th/types/repos/pending-object-deletions";
import type { CancelPendingObjectDeletionsInput } from "@th/types/repos/pending-object-deletions";

/**
 * Transactional outbox for reliable object-storage (R2/S3) deletions.
 *
 * Callers write delete intents via {@link enqueueMany} inside the same DB
 * transaction as the owning row's cascade, so the intent commits atomically.
 * A scheduled drain job then claims due rows ({@link listDue}), deletes the
 * objects, and records the outcome ({@link markDeleted} / {@link markFailed} /
 * {@link markDead}).
 */
export interface PendingObjectDeletionsRepo {
  /**
   * Batch-insert delete intents (status PENDING, attempts 0, nextAttemptAt =
   * the item's `notBefore`, else now). No-op on an empty array.
   */
  enqueueMany(items: EnqueuePendingObjectDeletionItem[]): Promise<void>;

  /**
   * Insert one intent under a caller-chosen id unless a row with that id
   * already exists (`ON CONFLICT DO NOTHING`, so it never aborts the
   * caller's transaction). The id doubles as a claim: of N callers racing
   * on one id, exactly one gets `inserted: true`, which is how upload
   * finalizes with no row of their own decide a quota credit once
   * (`publish-stripped-upload.ts`). When the id is taken, returns the row
   * that holds it.
   */
  enqueueOnce(
    item: EnqueuePendingObjectDeletionOnceItem,
  ): Promise<EnqueuePendingObjectDeletionOnceResult>;

  /** One row by id; null once it has been drained (or never existed). */
  getById(id: string): Promise<PendingObjectDeletionRecord | null>;

  /**
   * List rows due for an attempt — `status = "PENDING" AND nextAttemptAt <=
   * now` — ordered by `nextAttemptAt` ascending, limited to `limit`.
   */
  listDue(
    input: ListDuePendingObjectDeletionsInput,
  ): Promise<PendingObjectDeletionRecord[]>;

  /**
   * Hard-delete the row on success (keeps the table small). Idempotent: a row
   * already drained by an overlapping run is a no-op. Returns the number of
   * rows actually removed (1 = this caller drained it, 0 = a peer beat it).
   */
  markDeleted(id: string): Promise<number>;

  /**
   * Record a failed attempt: increment `attempts`, set `lastError` +
   * `nextAttemptAt`, stay PENDING.
   */
  markFailed(input: MarkPendingObjectDeletionFailedInput): Promise<void>;

  /**
   * Dead-letter the row after exhausting its attempt budget: increment
   * `attempts`, set `lastError`, set `status = "DEAD"`.
   */
  markDead(input: MarkPendingObjectDeletionDeadInput): Promise<void>;

  /**
   * Hard-delete the PENDING rows of `input.source` whose targetKey is in
   * `input.targetKeys`: the producer queued them, and the keys are in use
   * again before the drain ran (the page editor's Discard queues draft-only
   * images with a grace delay; a later save that references one cancels it).
   * DEAD rows and other sources' rows are left alone. Returns how many rows
   * were removed; `0` for an empty list. Call inside the same `repos.tx()`
   * as the write that makes the key referenced again.
   */
  cancelPending(input: CancelPendingObjectDeletionsInput): Promise<number>;

  /**
   * Ops read: how many delete intents are DEAD, and how many are overdue.
   *
   * WHY THIS BELONGS ON A MODERATION DASHBOARD. A moderator REJECT writes the
   * decision and enqueues the R2 object here in ONE transaction. If this outbox
   * then stalls, we have told an uploader their image was removed while the
   * bytes are still served from a public CDN — and nothing anywhere surfaces
   * that. The moderation record says REJECTED, which is true and beside the
   * point.
   *
   * Read-only. Scope with `input.source` (see
   * {@link CountPendingObjectDeletionsInput}) to count one producer's rows
   * rather than the whole table.
   */
  countOutboxHealth(
    input: CountPendingObjectDeletionsInput,
  ): Promise<PendingObjectDeletionOutboxHealth>;
}

export type {
  CountPendingObjectDeletionsInput,
  EnqueuePendingObjectDeletionItem,
  EnqueuePendingObjectDeletionOnceItem,
  EnqueuePendingObjectDeletionOnceResult,
  ListDuePendingObjectDeletionsInput,
  MarkPendingObjectDeletionDeadInput,
  MarkPendingObjectDeletionFailedInput,
  PendingObjectDeletionKind,
  PendingObjectDeletionOutboxHealth,
  PendingObjectDeletionRecord,
  PendingObjectDeletionStatus,
} from "@th/types/repos/pending-object-deletions";
