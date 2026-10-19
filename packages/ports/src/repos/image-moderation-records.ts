import type {
  ClaimDueImageModerationsInput,
  RequeueDegradedModerationsInput,
  CountModerationQueueHealthInput,
  CountModerationSeverityHistogramInput,
  ModerationQueueHealth,
  ModerationQueueHealthByKind,
  ModerationQueueTotals,
  ModerationSeverityBucket,
  CreateImageModerationRecordInput,
  ImageModerationRecord,
  ListFlaggedImageModerationsInput,
  ListQueueHealthSignalInput,
  MarkImageModerationFailedInput,
  MarkImageModerationOrphanedInput,
  MarkImageModerationResultInput,
  RequeueImageModerationForRescanInput,
  ResolveUnscannableImageModerationInput,
  ReviewImageModerationInput,
} from "@th/types/repos/image-moderation-records";

/**
 * Repository for image moderation records — one row per moderated public object,
 * keyed by its R2 storage key. The table is BOTH the moderation verdict store
 * AND its own drain outbox: a `status = "PENDING"` row is a to-do the jobs-service
 * worker claims ({@link claimDue}), runs through the provider, and resolves via
 * {@link markResult} / {@link markFailed}. Read-time gating uses {@link getByKey}
 * / {@link resolveByKeys}; the moderator queue uses {@link listFlagged} /
 * {@link review}.
 */
export interface ImageModerationRecordsRepo {
  /**
   * Upsert a moderation record for a storage key (idempotent on `storageKey`).
   * If a record for the key already exists it is RESET to PENDING (attempts 0,
   * nextAttemptAt = now) with the descriptive fields (publicUrl, contentType,
   * subject, kind, createdByHumanId) refreshed — this re-queues the object for
   * moderation on image replacement / re-upload to the same key. New rows are
   * created with `status` defaulting to "PENDING".
   */
  create(
    input: CreateImageModerationRecordInput,
  ): Promise<ImageModerationRecord>;

  /** Read a single record by its storage key, or null if none exists. */
  getByKey(storageKey: string): Promise<ImageModerationRecord | null>;

  /**
   * Batch read for read-time gating: resolve many storage keys at once into a
   * Map keyed by storageKey. Keys with no record are simply absent from the Map
   * (callers treat absence as APPROVED — legacy/unmoderated objects).
   */
  resolveByKeys(
    storageKeys: string[],
  ): Promise<Map<string, ImageModerationRecord>>;

  /** Read a single record by id, or null if none exists. */
  getById(id: string): Promise<ImageModerationRecord | null>;

  /**
   * Claim due records for the drain worker — `status = "PENDING" AND
   * nextAttemptAt <= now` — ordered by `nextAttemptAt` ascending, limited to
   * `limit`.
   */
  claimDue(
    input: ClaimDueImageModerationsInput,
  ): Promise<ImageModerationRecord[]>;

  /**
   * Write a provider verdict back onto the record (matched by `storageKey`):
   * set status/maxSeverity/categories/provider/degraded/moderatedAt. Idempotent
   * — re-running with the same verdict is a no-op-equivalent overwrite.
   */
  markResult(input: MarkImageModerationResultInput): Promise<void>;

  /**
   * Record a failed drain attempt (matched by id): increment `attempts`, set
   * `lastError` + `nextAttemptAt`. Stays PENDING for the next attempt.
   */
  markFailed(input: MarkImageModerationFailedInput): Promise<void>;

  /**
   * Terminally resolve a record whose object no longer exists in storage
   * (`getObject` answered `not_found`) — status ORPHANED, no verdict.
   *
   * A separate method rather than a {@link markResult} call because markResult's
   * input REQUIRES `maxSeverity` / `categories` / `provider` / `degraded`, and
   * an orphan has none of them. Forcing a placeholder severity through it would
   * put a fabricated number on a row that was never scanned, and setting
   * `degraded: true` would make the row eligible for `requeueDegraded`, which
   * would revive an object that can never be fetched — the exact churn loop the
   * `requeues` cap exists to bound.
   *
   * Implementations MUST scope the write to still-PENDING rows, same
   * compare-and-set as markResult, so an overlapping run or a human decision is
   * never clobbered. `attempts` is deliberately NOT incremented: this is a
   * resolution, not a failed try.
   */
  markOrphaned(input: MarkImageModerationOrphanedInput): Promise<void>;

  /**
   * Send dead-lettered DEGRADED rows back to PENDING so the drain re-scores
   * them once the provider recovers.
   *
   * THE SELECTION IS THE SAFETY PROPERTY. Implementations MUST match on all
   * four of:
   *   - `status = "FLAGGED"` — never touches APPROVED or REJECTED, both of
   *     which are terminal human decisions.
   *   - `degraded = true` — never touches a real CONTENT verdict. An image the
   *     provider actually scored at/above threshold must not be silently
   *     re-scored into visibility by a retry; only a human clears that.
   *   - `reviewedAt IS NULL` — defence in depth. A human decision today always
   *     moves status off FLAGGED, so this is redundant with the first clause;
   *     it is here so that a FUTURE review path which leaves status alone
   *     cannot have its decision quietly undone by this job.
   *   - `requeues < maxRequeues` — bounds the churn loop for objects that can
   *     never be scanned (deleted event, GC'd media). See the `requeues` column
   *     comment.
   *
   * Resets `attempts`/`lastError`/`nextAttemptAt` and clears the verdict fields
   * (`degraded`, `maxSeverity`, `moderatedAt`) so the row is genuinely undecided
   * again, and INCREMENTS `requeues`. Returns the number of rows moved.
   */
  requeueDegraded(input: RequeueDegradedModerationsInput): Promise<number>;

  /**
   * Count the five queue-health signals in one place. Read-only; used by the
   * hourly health report that decides whether to raise a Discord alert.
   */
  countQueueHealth(
    input: CountModerationQueueHealthInput,
  ): Promise<ModerationQueueHealth>;

  /**
   * ALL-TIME totals for the two WINDOWED health signals. See
   * {@link ModerationQueueTotals} for why this is a second method rather than
   * two more keys on {@link ModerationQueueHealth} — in one line: the five
   * health predicates are what the hourly Discord alert pages about, and these
   * two numbers must not be able to change that.
   *
   * Takes no cutoffs because it has no window. Read-only.
   */
  countQueueTotals(): Promise<ModerationQueueTotals>;

  /**
   * The five health signals split by {@link ImageModerationKind}.
   *
   * Implementations MUST reuse the SAME predicate builder `countQueueHealth`
   * uses — a `groupBy` per signal over the identical WHERE, not five new
   * WHEREs. A breakdown that defines "overdue" separately from the tile it sits
   * under is the same drift bug the shared builder was extracted to kill, one
   * level down and harder to spot, because the columns still add up to
   * SOMETHING.
   */
  countQueueHealthByKind(
    input: CountModerationQueueHealthInput,
  ): Promise<ModerationQueueHealthByKind>;

  /**
   * Distribution of `maxSeverity` over rows the provider actually SCORED in a
   * caller-passed window, bucketed by integer severity.
   *
   * AGGREGATE COUNTS ONLY. No row identity leaves this method — no id, no
   * storage key, no subject, no URL. The question it answers is "is the review
   * threshold in the right place", and the answer is a shape, not a list.
   *
   * Ordered by `severity` ascending. Buckets with no rows are simply absent —
   * densifying 0..6 is presentation, and the caller does it.
   */
  countSeverityHistogram(
    input: CountModerationSeverityHistogramInput,
  ): Promise<ModerationSeverityBucket[]>;

  /**
   * Drill into ONE of the five {@link countQueueHealth} buckets: the rows that
   * count covered, paged with the same opaque cursor convention as
   * {@link listFlagged}.
   *
   * Implementations MUST select with the very predicate `countQueueHealth` used
   * for that signal — one shared WHERE builder, not a second copy. A count and
   * a list that define "overdue" separately drift the first time a cutoff moves,
   * and the failure mode is the worst kind: a tile that says 12 opening a page
   * that shows 9, with nothing in either place admitting which is wrong.
   *
   * Ordering is newest-first on whatever instant is meaningful for the bucket —
   * `moderatedAt desc` for the four moderated buckets, `nextAttemptAt ASC` for
   * `pendingOverdue`, where the OLDEST overdue row is the interesting one
   * (it dates the outage).
   *
   * Read-only. This is an ops surface, not a review surface.
   */
  listQueueHealthSignal(input: ListQueueHealthSignalInput): Promise<{
    items: ImageModerationRecord[];
    nextCursor: string | null;
  }>;

  /**
   * List FLAGGED records for the moderator queue, newest `moderatedAt` first,
   * limited to `limit`, with an opaque cursor for pagination.
   */
  listFlagged(input: ListFlaggedImageModerationsInput): Promise<{
    items: ImageModerationRecord[];
    nextCursor: string | null;
  }>;

  /**
   * Apply a moderator decision (matched by id, only when currently FLAGGED):
   * set status APPROVED|REJECTED + reviewer fields. This is a compare-and-set on
   * `status = "FLAGGED"`; it returns the affected row count so the caller can
   * distinguish a real FLAGGED→decision transition (1) from a no-op re-review of
   * an already-decided record (0) — FR-009's approve-after-hold notification
   * must fire ONLY on a genuine transition, without a racey extra read.
   */
  review(input: ReviewImageModerationInput): Promise<number>;

  /**
   * OPERATOR ACTION: terminally resolve ONE unscannable row to ORPHANED.
   *
   * The `degradedExhausted` bucket is, by definition, rows past the requeue cap
   * that no automation will ever touch again. Until now the recorded fix was a
   * hand-written UPDATE against production.
   *
   * THE WHERE IS THE ENTIRE SAFETY PROPERTY, exactly as it is for
   * {@link requeueDegraded}. Implementations MUST match on all four of:
   *   - `status = "FLAGGED"`   — never touches a terminal APPROVED/REJECTED row.
   *   - `degraded = true`      — THE clause that matters. `degraded = false` is
   *     a genuine CONTENT hold: an image the provider actually scored at or
   *     above threshold, awaiting a moderator. This path must never become a
   *     way to make that judgement disappear without a moderator making it.
   *   - `reviewedAt IS NULL`   — idempotency, and defence in depth against a
   *     future review path that leaves `status` alone.
   *   - `requeues >= maxRequeues` — only rows that have genuinely exhausted the
   *     automation. A row still inside its retry budget is not this operator's
   *     problem; the requeue job will get to it.
   *
   * RESOLVES TO ORPHANED, NOT REJECTED, and the difference is not cosmetic. A
   * REJECT enqueues the R2 object for deletion — for an object we were never
   * able to FETCH, that is a deletion aimed at bytes whose existence we could
   * not establish. ORPHANED is already the documented terminal state for "there
   * is nothing here to judge" (see {@link markOrphaned} and the
   * `ImageModerationStatus` docs): invisible on public surfaces, out of the
   * moderator queue, out of the requeue selection, and — crucially — carrying
   * no fabricated verdict.
   *
   * WHAT IT DELIBERATELY DOES NOT WRITE, following `markOrphaned`'s reasoning:
   *   - `moderatedAt` is LEFT ALONE. `orphanedRecent` counts ORPHANED rows by
   *     `moderatedAt >= degradedSince`, and that signal means "storage is
   *     answering gone for things that are not". Re-stamping it here would make
   *     an operator's own cleanup page the operator, which is the fastest way
   *     to teach someone to ignore the channel.
   *   - `degraded` stays TRUE. It is the record of WHY this row ended up here.
   *     ORPHANED already excludes the row from `requeueDegraded` (which matches
   *     `status = "FLAGGED"`), so nothing is gained by clearing it and the
   *     history is lost.
   *   - `attempts` / `requeues` are not touched. This is a resolution, not
   *     another failed try.
   *
   * Returns the affected row count so the caller can distinguish a real
   * transition (1) from "already resolved, or never eligible" (0) WITHOUT a
   * second read and without throwing.
   */
  resolveUnscannable(
    input: ResolveUnscannableImageModerationInput,
  ): Promise<number>;

  /**
   * OPERATOR ACTION: send ONE row back to PENDING so the drain re-scores it —
   * after a provider outage, or a threshold change that should be applied
   * retroactively.
   *
   * WHY THIS IS NOT JUST {@link create}. `create` is idempotent on `storageKey`
   * and RESETS whatever it finds, which is correct for a re-upload and a
   * loaded gun for an operator button: pointed at an `APPROVED` or `REJECTED`
   * record it silently revives a human decision, and re-scanning a REJECTED
   * image can put it back into circulation. A read-then-`create` guard in a use
   * case is not enough either — it is a TOCTOU window against a moderator
   * deciding the same row.
   *
   * So the guard is the WHERE, and implementations MUST match:
   *   - `status = "PENDING"`, OR
   *   - `status = "ORPHANED"`, OR
   *   - `status = "FLAGGED" AND degraded = true`
   *
   * i.e. only MACHINE states. `APPROVED`, `REJECTED` and `FLAGGED` with
   * `degraded = false` are human decisions and are unreachable from here by
   * construction, not by a caller remembering to check.
   *
   * ONE WRINKLE ON `ORPHANED`, since {@link resolveUnscannable} landed: that
   * status is no longer purely machine-made. An operator resolving an
   * unscannable row writes `reviewedByHumanId` / `reviewedAt` / `reviewNote`
   * onto an ORPHANED row, and a rescan admits ORPHANED unconditionally, so it
   * WILL clear all three. That is accepted, not overlooked:
   *   - It is PROVENANCE loss, not an undone decision. The operator resolved
   *     "there is nothing here to judge"; a rescan asserts there might be
   *     something after all, which is a legitimate thing to believe when a
   *     bucket is restored or a storage fault is fixed. Nothing about the
   *     image's fate is being reversed — the row goes back to PENDING and gets
   *     scored on its merits.
   *   - The record survives where it matters: `resolveUnscannable` writes an
   *     `image_moderation.resolved_unscannable` audit row inside the same
   *     transaction, and audit rows are not touched here.
   *   - Both paths are ADMIN-only, so this is one operator revisiting another
   *     operator's call, not an escalation.
   * If the reviewer fields ever need to survive a rescan, exclude
   * operator-resolved orphans by matching `reviewedAt IS NULL` on the ORPHANED
   * branch — but do it deliberately, because it also makes those rows
   * permanently unscannable.
   *
   * Writes the same "genuinely undecided again" reset `create` writes — PENDING,
   * `attempts` 0, `nextAttemptAt = now`, verdict and review columns cleared —
   * and leaves the DESCRIPTIVE columns (kind, subject, publicUrl, contentType,
   * createdByHumanId) alone, because nothing about the object changed.
   * `requeues` is NOT incremented: that counter bounds the automated churn
   * loop, and spending an operator's deliberate retry out of the automation's
   * budget would let a human quietly exhaust it.
   *
   * Returns the affected row count: 1 = requeued, 0 = not in a machine state
   * (or gone).
   */
  requeueForRescan(
    input: RequeueImageModerationForRescanInput,
  ): Promise<number>;
}

export type {
  ClaimDueImageModerationsInput,
  RequeueDegradedModerationsInput,
  RequeueImageModerationForRescanInput,
  ResolveUnscannableImageModerationInput,
  CountModerationQueueHealthInput,
  CountModerationSeverityHistogramInput,
  ModerationQueueHealth,
  ModerationQueueHealthByKind,
  ModerationQueueTotals,
  ModerationSeverityBucket,
  CreateImageModerationRecordInput,
  ImageModerationCategory,
  ImageModerationCategoryScore,
  ImageModerationKind,
  ImageModerationRecord,
  ImageModerationStatus,
  ImageModerationSubjectType,
  ListFlaggedImageModerationsInput,
  ListQueueHealthSignalInput,
  ModerationQueueHealthSignal,
  MarkImageModerationFailedInput,
  MarkImageModerationOrphanedInput,
  MarkImageModerationResultInput,
  ReviewImageModerationInput,
} from "@th/types/repos/image-moderation-records";

// Value (not type) re-export: the ordered signal tuple transports build their
// enums from, so a drill-down enum can never list a bucket the repo cannot
// serve — or miss one it can.
export { MODERATION_QUEUE_HEALTH_SIGNALS } from "@th/types/repos/image-moderation-records";
