import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { PendingObjectDeletionRecord } from "@th/ports/repos/pending-object-deletions";

import {
  drainLoopInputShape,
  drainLoopOutputShape,
  runDrainPasses,
} from "../../lib/drain-loop";
import { describeError } from "../../lib/io";
import {
  isPageImageKeyReferenced,
  isPageReferenceCheckedSource,
  type PageImageReferenceRepos,
} from "../entity-pages/page-image-references";
import { reportableStorageError } from "./reportable-storage-error";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const drainPendingDeletionsInputSchema = z.object({
  /**
   * Max rows to take per pass. A run takes passes until the outbox is empty,
   * a pass has trouble, or `maxPasses` / `timeBudgetMs` is spent.
   */
  limit: z.number().int().positive().default(50),
  /** Attempts after which a row is dead-lettered instead of retried. */
  maxAttempts: z.number().int().positive().default(8),
  /** Base backoff in seconds for the first retry; doubles each attempt. */
  baseBackoffSeconds: z.number().int().positive().default(60),
  /** Upper bound on a single backoff delay (6h). */
  maxBackoffSeconds: z.number().int().positive().default(21_600),
  ...drainLoopInputShape,
});

export type DrainPendingDeletionsInput = z.infer<
  typeof drainPendingDeletionsInputSchema
>;

export const drainPendingDeletionsOutputSchema = z.object({
  /** Rows examined this run. */
  processed: z.number(),
  /** Rows whose objects were deleted and removed from the outbox. */
  deleted: z.number(),
  /** Rows that failed and were scheduled for a later retry. */
  retried: z.number(),
  /** Rows that exhausted maxAttempts and were dead-lettered. */
  deadLettered: z.number(),
  /** Rows whose processing threw outside the delete (bookkeeping). */
  unhandled: z.number(),
  /**
   * Rows removed WITHOUT deleting their object because the page uses the
   * object again (a handover Clear's or a draft Discard's image the owner
   * put back).
   */
  skippedStillReferenced: z.number(),
  ...drainLoopOutputShape,
});

export type DrainPendingDeletionsOutput = z.infer<
  typeof drainPendingDeletionsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type DrainPendingDeletionsDeps = {
  /**
   * `entityPages` and `places` serve the live-reference re-check of a
   * handover Clear's and a draft Discard's rows
   * ({@link isPageImageKeyReferenced}).
   */
  repos: Pick<Repos, "pendingObjectDeletions"> & PageImageReferenceRepos;
  fileStorage: Pick<FileStoragePort, "deleteObject" | "listObjects">;
  logger: LoggerPort;
  clock: ClockPort;
  /**
   * Reports a dead-lettered row. Dead letters are terminal (nothing retries
   * them), and some rows are privacy deletions (an image upload's original
   * with its EXIF GPS), so one must reach Sentry, not just a log.
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/** Page size for prefix listing — the file-storage port caps lists at 1000. */
const PREFIX_LIST_LIMIT = 1000;

/**
 * Drains the object-storage deletion outbox: claims due rows, deletes the
 * underlying objects, and records the outcome with exponential backoff +
 * dead-lettering.
 *
 * No row leasing: overlapping drain runs that re-process the same row are
 * harmless because BOTH halves of the work are idempotent —
 *   1. `FileStoragePort.deleteObject` succeeds on a missing object, and
 *   2. the bookkeeping repo methods (`markDeleted`/`markFailed`/`markDead`) are
 *      0-row no-ops on a vanished row (they use deleteMany/updateMany, not
 *      delete/update, so a peer that already drained the row can't make this
 *      run throw P2025).
 * `markDeleted` returns the affected count so a 0 (peer beat us) is recorded as
 * already-drained rather than double-counted or misread as a failure. A
 * per-item outer guard additionally contains any unexpected throw so a single
 * row can never abort the batch. This matches the codebase's single-runner
 * scheduled-job convention while staying correct under Cloud Scheduler's
 * at-least-once retries. The `status, nextAttemptAt` index backs the due query,
 * and the success path hard-deletes the row so the table stays small.
 *
 * A run takes passes of `limit` rows until nothing is due (`runDrainPasses`):
 * one 50-row pass per scheduled tick could not keep up with an outbox every
 * image finalize writes to. It stops early on the first pass with trouble (a
 * retry, a dead letter, an unhandled row), and on `maxPasses` /
 * `timeBudgetMs`, reporting `hasMore`; the next scheduled run continues.
 *
 * A row from a moderator place page handover's Clear
 * (`COMMUNITY_HANDOVER_CLEAR_DELETION_SOURCE`) names a LIVE page image the
 * owner may have put back since (Undo, re-sending the old avatar); a row
 * from a draft Discard (`PAGE_DRAFT_DISCARD_DELETION_SOURCE`) names a draft
 * image a live editor may have put on the page since (draft saves and
 * publishes cancel the row; the live editors do not). Right
 * before deleting, the drain re-reads the page (`sourceId`) and, when
 * anything on it still mentions the key, removes the row WITHOUT deleting
 * the object (`skippedStillReferenced`). A failed re-check keeps the object
 * and takes the failed-delete path (backoff, then dead letter), reported
 * each attempt, so it never stalls the outbox. The window left is a write
 * that lands between the re-check and the delete.
 */
export async function drainPendingDeletions(
  deps: DrainPendingDeletionsDeps,
  rawInput: unknown,
): Promise<DrainPendingDeletionsOutput> {
  const { repos, fileStorage, logger, clock } = deps;
  const input = drainPendingDeletionsInputSchema.parse(rawInput ?? {});

  const result: DrainPendingDeletionsOutput = {
    processed: 0,
    deleted: 0,
    retried: 0,
    deadLettered: 0,
    unhandled: 0,
    skippedStillReferenced: 0,
    passes: 0,
    hasMore: false,
  };

  const loop = await runDrainPasses({
    clock,
    maxPasses: input.maxPasses,
    timeBudgetMs: input.timeBudgetMs,
    pass: async ({ pastDeadline }) => {
      const due = await repos.pendingObjectDeletions.listDue({
        now: clock.now(),
        limit: input.limit,
      });
      const troubleBefore =
        result.retried + result.deadLettered + result.unhandled;
      let outOfTime = false;

      for (const item of due) {
        // Budget spent: leave the rest due and hand off (`hasMore`).
        if (pastDeadline()) {
          outOfTime = true;
          break;
        }
        result.processed++;
        // Outer guard: one row must NEVER abort the batch — not even if a
        // repo bookkeeping call throws. Any escape from processItem is
        // contained to this iteration, logged, and the loop continues.
        // (Without a lease, overlapping runs can race the same row; the
        // bookkeeping repo methods are idempotent no-ops on a vanished row,
        // but we still defend against unexpected throws.) A row stuck here
        // keeps its schedule and comes back every run, so it is an error
        // and reported, not a warning.
        try {
          await processItem({ item, deps, input, result });
        } catch (err) {
          result.unhandled++;
          logger.error("drain.item_unhandled_error", {
            id: item.id,
            targetKey: item.targetKey,
            targetKind: item.targetKind,
            source: item.source,
            err,
            error: describeError(err),
          });
          report(deps, err, {
            tags: {
              job: "storage.drain-pending-deletions",
              step: "item_unhandled",
              source: item.source ?? undefined,
            },
            extra: { id: item.id, targetKey: item.targetKey },
          });
        }
      }

      const trouble =
        result.retried + result.deadLettered + result.unhandled - troubleBefore;
      return {
        wantsAnother: (due.length >= input.limit || outOfTime) && trouble === 0,
      };
    },
  });
  result.passes = loop.passes;
  result.hasMore = loop.hasMore;

  logger.info("drain.completed", result);
  return result;
}

/** Best-effort reporting must never change the outcome. */
function report(
  deps: Pick<DrainPendingDeletionsDeps, "reportError">,
  err: unknown,
  context: Parameters<ReporterPort>[1],
): void {
  try {
    deps.reportError?.(reportableStorageError(err), context);
  } catch {
    // Swallowed: there is nowhere else to report a reporter failure.
  }
}

/**
 * Processes a single outbox row. Separates the *object delete* (whose failure
 * triggers retry / dead-letter) from *recording the outcome* (whose failure
 * must never be misclassified as a delete failure). Mutates `result` counters.
 */
async function processItem(args: {
  item: PendingObjectDeletionRecord;
  deps: DrainPendingDeletionsDeps;
  input: DrainPendingDeletionsInput;
  result: DrainPendingDeletionsOutput;
}): Promise<void> {
  const { item, deps, input, result } = args;
  const { repos, fileStorage, logger, clock } = deps;

  let deleteError: unknown;

  // 0) A page image (handover Clear, draft Discard) the page uses again is
  //    kept: drop the row, never the object. A failed re-check is treated
  //    like a failed delete (the object is NOT deleted): the row backs off
  //    through markFailed and eventually dead-letters, so it never sits at
  //    the front of every pass. Reported each attempt (a database read
  //    failed, not storage). A row of these sources the re-check cannot
  //    resolve (no page id, or a PREFIX target) fails closed the same way:
  //    neither writer produces one, so it is a bug, never a blind delete.
  if (isPageReferenceCheckedSource(item.source)) {
    let referenced = false;
    try {
      if (item.sourceId === null || item.targetKind !== "KEY") {
        throw new Error("page_reference_recheck_unresolvable");
      }
      referenced = await isPageImageKeyReferenced(
        repos,
        item.sourceId,
        item.targetKey,
      );
    } catch (err) {
      deleteError = err;
      logger.error("drain.reference_recheck_failed", {
        id: item.id,
        targetKey: item.targetKey,
        source: item.source,
        sourceId: item.sourceId,
        err,
        error: describeError(err),
      });
      report(deps, err, {
        tags: {
          job: "storage.drain-pending-deletions",
          step: "reference_recheck",
          source: item.source,
        },
        extra: {
          id: item.id,
          targetKey: item.targetKey,
          attempts: item.attempts + 1,
        },
      });
    }
    if (deleteError === undefined && referenced) {
      const removed = await repos.pendingObjectDeletions.markDeleted(item.id);
      if (removed > 0) result.skippedStillReferenced++;
      logger.info("drain.skipped_still_referenced", {
        id: item.id,
        targetKey: item.targetKey,
        source: item.source,
        sourceId: item.sourceId,
      });
      return;
    }
  }

  // 1) Attempt the actual object deletion (unless the re-check above
  //    failed). Only a failure here or there means the storage delete
  //    didn't happen and the row should be retried / dead-lettered.
  //    Bookkeeping failures are handled separately below so a successful
  //    delete is never recorded as a failure.
  if (deleteError === undefined) {
    try {
      await deleteTarget(item, fileStorage);
    } catch (err) {
      deleteError = err;
    }
  }

  if (deleteError === undefined) {
    // Delete succeeded → record success. markDeleted is idempotent: a 0-row
    // result means a peer run already drained this row, so we neither run the
    // failure path nor double-count `deleted`.
    const removed = await repos.pendingObjectDeletions.markDeleted(item.id);
    if (removed > 0) {
      result.deleted++;
    } else {
      logger.info("drain.already_drained", {
        id: item.id,
        targetKey: item.targetKey,
      });
    }
    return;
  }

  // 2) The object delete failed → schedule a backed-off retry or dead-letter.
  const lastError = String(deleteError);
  const attempts = item.attempts + 1;

  if (attempts >= input.maxAttempts) {
    // Logged and reported BEFORE the bookkeeping: if `markDead` throws, the
    // object is still undeleted and someone must hear about it (the row
    // stays PENDING and the outer guard reports that throw as well).
    const details = {
      id: item.id,
      targetKey: item.targetKey,
      targetKind: item.targetKind,
      attempts,
      source: item.source,
      sourceId: item.sourceId,
      error: lastError,
    };
    logger.error("drain.dead_letter", details);
    report(deps, deleteError, {
      tags: {
        job: "storage.drain-pending-deletions",
        step: "dead_letter",
        source: item.source ?? undefined,
      },
      extra: details,
    });
    await repos.pendingObjectDeletions.markDead({ id: item.id, lastError });
    result.deadLettered++;
  } else {
    const backoffSeconds = Math.min(
      input.baseBackoffSeconds * 2 ** (attempts - 1),
      input.maxBackoffSeconds,
    );
    const nextAttemptAt = new Date(
      clock.now().getTime() + backoffSeconds * 1000,
    );
    await repos.pendingObjectDeletions.markFailed({
      id: item.id,
      lastError,
      nextAttemptAt,
    });
    result.retried++;
  }
}

/**
 * Removes the object(s) a single outbox row points at. A mid-way failure throws
 * so the whole row is retried later — deletes are idempotent, so re-deleting
 * already-removed objects on the retry is safe.
 */
async function deleteTarget(
  item: PendingObjectDeletionRecord,
  fileStorage: Pick<FileStoragePort, "deleteObject" | "listObjects">,
): Promise<void> {
  if (item.targetKind === "KEY") {
    await fileStorage.deleteObject({ key: item.targetKey });
    return;
  }

  // PREFIX: paginate the prefix and delete every object under it (e.g. an HLS
  // playlist + all its `.ts` segments).
  let cursor: string | undefined;
  do {
    const page = await fileStorage.listObjects({
      prefix: item.targetKey,
      cursor,
      limit: PREFIX_LIST_LIMIT,
    });
    for (const obj of page.keys) {
      await fileStorage.deleteObject({ key: obj.key });
    }
    cursor = page.nextCursor;
  } while (cursor);
}
