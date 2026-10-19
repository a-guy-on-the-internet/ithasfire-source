import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ImageModerationRecord } from "@th/ports/repos/image-moderation-records";
import type { ReporterPort } from "@th/ports/reporter";

import {
  drainLoopInputShape,
  drainLoopOutputShape,
  runDrainPasses,
} from "../../lib/drain-loop";
import { describeError, parseInput } from "../../lib/io";
import type { NotifyInput } from "../comms/notify";
import {
  normalizeAppBaseUrl,
  resolveImageModerationSubject,
} from "./image-moderation-subject";
import type { ModerateImageOutput } from "./moderate-image";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Orphans allowed in ONE drain run before the batch stops.
 *
 * ORPHANED is terminal and unrecoverable by any automation — the row leaves the
 * queue, leaves the requeue selection, and only manual SQL brings it back. That
 * is the right trade for the real case (one object deleted out from under one
 * record) and a catastrophe for the correlated one (storage answering
 * `not_found` for EVERY key because of a bucket/credential fault, which would
 * terminally orphan an entire batch per run until someone noticed).
 *
 * `mapS3Error` now classifies bucket-scope failures as `dependency_failed`, so
 * the known instance of that fault can no longer reach here. This is the
 * backstop for the ones we have not thought of: a mapper that mis-classifies
 * again, a new storage adapter, an S3-compatible host with its own error
 * vocabulary.
 *
 * THREE is chosen as "more than coincidence, less than a pattern". Objects are
 * deleted by unrelated user actions, so two orphans landing in the same 25-row
 * batch is plausible; a third in the same run is not, at this volume.
 *
 * A place page image removed on purpose before its scan (`removedBeforeScan`)
 * does not count: a place merge deletes all of the duplicate's page images at
 * once. That exemption cannot hide a storage fault, because it applies only to
 * a key the page no longer names; a missing image the page still shows counts.
 *
 * WHAT STOPPING ACTUALLY COSTS — it is NOT free, and the earlier claim that it
 * was is wrong. For a one-off it is nil: the skipped rows stay PENDING with
 * `nextAttemptAt` untouched, and the next run picks them up — the next upload
 * wakes the drain, and the scheduled safety net runs every 30 minutes (it was
 * every 2-5 minutes until 2026-09-30, when the drain became write-triggered,
 * and every 15 until 2026-10-08).
 * A tripped breaker deliberately does NOT hand off (`hasMore` stays false).
 * For a BACKLOG it is not free. `moderation.requeue-degraded` runs
 * hourly with no `take`,
 * so if it revives ~100 rows whose objects were meanwhile swept by
 * `storage.drain-pending-deletions`, this breaker turns that into ~34
 * consecutive drain runs at 3 orphans apiece — ~34 `orphan-breaker` Sentry
 * events, and fresh uploads queued behind the backlog. At the 30-minute
 * safety-net cadence that is up to ~17 hours with no uploads to wake it
 * (~8 hours at 15 minutes; one to three hours at 2-5 minutes).
 *
 * That is still the better failure: slow and loud beats fast and silent, since
 * the alternative is terminally hiding 100 images in a single pass with no
 * signal but a Sentry line. But an operator working a known backlog will want
 * to raise the bar rather than wait it out, which is why this is the DEFAULT
 * for `maxOrphansPerRun` and not a hardcoded constant.
 */
const MAX_ORPHANS_PER_RUN = 3;

export const drainImageModerationsInputSchema = z
  .object({
    /** Max rows to claim per drain (keeps the job bounded). */
    limit: z.number().int().positive().default(25),
    /**
     * Attempts after which a row is dead-lettered (FLAGGED+degraded).
     *
     * Was 5, which — with the backoff below — spent the entire budget in about
     * SEVEN MINUTES. That is a budget calibrated for a blip, and in August 2026
     * it met a multi-day outage (an expired Azure subscription): every image
     * uploaded during the window burned all five attempts within minutes and
     * dead-lettered permanently, so a provider billing lapse turned into a
     * manual backlog. See the window arithmetic on `maxBackoffSeconds`.
     */
    maxAttempts: z.number().int().positive().default(22),
    /** Base backoff in seconds for the first retry; doubles each attempt. */
    baseBackoffSeconds: z.number().int().positive().default(30),
    /**
     * Upper bound on a single backoff delay (6h, was 1h).
     *
     * WINDOW ARITHMETIC — with base 30s doubling and this 21600s ceiling, the
     * first ten attempts cost 30+60+120+…+15360 ≈ 8.5h, and each attempt after
     * that adds a flat 6h. At `maxAttempts` 22 the total window is roughly
     * **74 hours (~3 days)** before a row dead-letters. Any provider outage
     * shorter than that is now invisible to everyone — no hold, no backlog, no
     * human involved.
     *
     * The cost is that a long-retrying row keeps occupying a slot in
     * `claimDue`'s `limit`. At current volume that is irrelevant; if the queue
     * ever gets deep, order by `nextAttemptAt` already favours the due-soonest,
     * so fresh uploads are not starved by an old backlog.
     */
    maxBackoffSeconds: z.number().int().positive().default(21600),
    /**
     * Orphans allowed in one run before the batch stops — see
     * {@link MAX_ORPHANS_PER_RUN} for the reasoning and for what stopping
     * costs. Tunable (like every other bound here) so an operator working a
     * known backlog can raise it without a deploy.
     */
    maxOrphansPerRun: z
      .number()
      .int()
      .positive()
      .default(MAX_ORPHANS_PER_RUN),
    ...drainLoopInputShape,
  })
  .strict();

export type DrainImageModerationsInput = z.infer<
  typeof drainImageModerationsInputSchema
>;

export const drainImageModerationsOutputSchema = z
  .object({
    /** Rows claimed + examined this run. */
    processed: z.number().int().nonnegative(),
    /** Rows that got a fresh verdict (APPROVED or FLAGGED) this run. */
    moderated: z.number().int().nonnegative(),
    /**
     * Rows resolved to ORPHANED — the object was gone from storage, so there
     * was nothing to score. Counted apart from `moderated` (no verdict was
     * produced) and apart from `retried`/`deadLettered` (nothing failed). A
     * non-zero number here is a data-lifecycle signal: objects are being
     * deleted out from under live moderation records.
     */
    orphaned: z.number().int().nonnegative(),
    /**
     * Rows resolved to ORPHANED because a place page image was removed on
     * purpose before it was scanned (moderate-image's `removedOnPurpose`: a
     * Clear, a draft discard, a place merge). Counted apart from `orphaned`
     * and never toward the orphan circuit breaker: a merge deletes every page
     * image of the duplicate at once, which is a decision, not a storage
     * fault.
     */
    removedBeforeScan: z.number().int().nonnegative(),
    /** Rows that failed transiently and were scheduled for a later retry. */
    retried: z.number().int().nonnegative(),
    /** Rows that exhausted maxAttempts and were dead-lettered to FLAGGED. */
    deadLettered: z.number().int().nonnegative(),
    /**
     * Rows claimed but deliberately left untouched because the run tripped the
     * `maxOrphansPerRun` circuit breaker. They are still PENDING with their
     * `nextAttemptAt` unchanged, so the next run (a write-triggered one, or the
     * 30-minute safety net) retries
     * them — nothing is lost from ONE tripped run, and a non-zero value here is
     * the signal that storage is misbehaving rather than that one object went
     * missing. On a sustained backlog the cost is real; see
     * {@link MAX_ORPHANS_PER_RUN}.
     */
    unprocessed: z.number().int().nonnegative(),
    ...drainLoopOutputShape,
  })
  .strict();

export type DrainImageModerationsOutput = z.infer<
  typeof drainImageModerationsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `moderate-image` use case, injected as a CLOSURE so this drain doesn't
 * hold the ModerationPort / FileStoragePort itself — the jobs container closes
 * over `moderate-image` with its provider + storage deps bound (same shape as
 * community.dispatchRsvpNotifications injects `notify`). Tests pass a plain spy.
 */
export type ModerateImageFn = (
  storageKey: string,
) => Promise<ModerateImageOutput>;

/**
 * `notify` is typed against `NotifyInput` only (return value ignored) so this
 * drain stays decoupled from the comms wiring — same as the RSVP drain. The
 * jobs layer closes over the real `notify` use case with the mailer bound.
 */
export type DrainImageModerationsDeps = {
  /**
   * `events` (and, for a PLACE subject, `places` + `entityPages`) are
   * read-only: the HOLD notice names and links what the image is on. Without
   * `places` / `entityPages` a PLACE notice goes out without the name.
   * Best-effort: see resolveImageModerationSubject.
   */
  repos: Pick<Repos, "imageModerationRecords" | "events"> &
    Partial<Pick<Repos, "places" | "entityPages">>;
  moderateImage: ModerateImageFn;
  clock: ClockPort;
  logger: LoggerPort;
  notify?: (input: NotifyInput) => Promise<unknown>;
  /** Public web origin used to build absolute email URLs in HOLD notices. */
  appBaseUrl?: string;
  /** Dead-letter exhaustion reporting (NFR-005 / FR-006), guarded. */
  reportError?: ReporterPort;
};

/** Severity stamped on a dead-lettered (couldn't-scan) record. */
const DEAD_LETTER_SEVERITY = 6;
const HELD_VARIANT = "image.moderation.held" as const;


// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drains the image-moderation outbox (the `ImageModerationRecord` table is its
 * own outbox — a PENDING row is a to-do). Claims due rows and runs
 * `moderate-image` for each, out of band from the upload request.
 *
 * Structure mirrors drain-pending-deletions:
 *   - per-item outer guard so one bad row never aborts the batch;
 *   - on a fresh FLAGGED verdict, fire the uploader HOLD notification (FR-009) —
 *     never on APPROVED, never on the transient PENDING state. The notify
 *     idempotency key (`image-moderation-held:{id}`) makes a retried run a
 *     no-op if the first send landed;
 *   - an ORPHANED outcome (the object was deleted out from under the record) is
 *     a RESOLUTION, not a failure: moderate-image already wrote the terminal
 *     status, so this drain does not charge an attempt, schedule a retry, or
 *     notify. It is counted separately from `moderated` — no verdict exists;
 *   - transient failure (moderate-image threw, e.g. bytes temporarily
 *     unavailable) → exponential backoff via markFailed;
 *   - exhaustion (attempts+1 >= maxAttempts) → dead-letter: markResult
 *     FLAGGED+degraded so the image surfaces in the human queue rather than
 *     staying hidden forever OR auto-approving (fail-closed, NFR-005), fire the
 *     HOLD notification, and report to Sentry.
 *
 * No row leasing: claimDue only returns PENDING rows and both moderate-image and
 * the bookkeeping repo calls are idempotent, so overlapping runs are harmless.
 */
export async function drainImageModerations(
  deps: DrainImageModerationsDeps,
  rawInput: unknown,
): Promise<DrainImageModerationsOutput> {
  const { repos, clock } = deps;
  const input = parseInput(drainImageModerationsInputSchema, rawInput);
  const logger = deps.logger.child({
    useCase: "moderation.drainImageModerations",
  });

  const result: DrainImageModerationsOutput = {
    processed: 0,
    moderated: 0,
    orphaned: 0,
    removedBeforeScan: 0,
    retried: 0,
    deadLettered: 0,
    unprocessed: 0,
    passes: 0,
    hasMore: false,
  };

  // Loop until no row is due (see lib/drain-loop.ts). A pass wants another
  // only when it claimed a FULL batch, nothing in it failed (a retry or a
  // dead-letter means the provider is struggling) and the orphan breaker did
  // not trip. Retried rows are pushed out by `nextAttemptAt`, so a later pass
  // never re-claims them.
  const loop = await runDrainPasses({
    clock: deps.clock,
    maxPasses: input.maxPasses,
    timeBudgetMs: input.timeBudgetMs,
    pass: async ({ pastDeadline }) => {
      const due = await repos.imageModerationRecords.claimDue({
        now: clock.now(),
        limit: input.limit,
      });
      const failuresBefore = result.retried + result.deadLettered;
      let unhandled = 0;
      let processedThisPass = 0;
      let breakerTripped = false;
      let outOfTime = false;

      for (const record of due) {
        // Budget spent: leave the rest untouched and hand off (`hasMore`).
        if (pastDeadline()) {
          outOfTime = true;
          break;
        }
        // CIRCUIT BREAKER. Checked before each row, so the run stops the
        // moment the orphan count looks correlated rather than incidental —
        // see MAX_ORPHANS_PER_RUN. Counted per RUN (across passes). The
        // remaining rows are untouched (still PENDING, `nextAttemptAt`
        // unchanged); the next run picks them up once whatever is wrong with
        // storage is fixed.
        if (result.orphaned >= input.maxOrphansPerRun) {
          breakerTripped = true;
          result.unprocessed = due.length - processedThisPass;
          logger.error(
            "moderation.drainImageModerations.orphan_breaker_tripped",
            {
              orphaned: result.orphaned,
              unprocessed: result.unprocessed,
              limit: input.maxOrphansPerRun,
            },
          );
          // Guarded — a throwing reporter must never turn a defensive stop
          // into a job failure (CLAUDE.md error convention).
          try {
            deps.reportError?.(
              new Error(
                "image moderation drain stopped: too many orphans in one run",
              ),
              {
                tags: { area: "image-moderation", reason: "orphan-breaker" },
                extra: {
                  orphaned: result.orphaned,
                  unprocessed: result.unprocessed,
                  limit: input.maxOrphansPerRun,
                },
              },
            );
          } catch {
            // best-effort only
          }
          break;
        }

        result.processed += 1;
        processedThisPass += 1;
        // Outer guard: one row must NEVER abort the batch, not even if a repo
        // bookkeeping call throws unexpectedly. Any escape is contained here.
        try {
          await processRecord({ record, deps, input, result, logger });
        } catch (error) {
          unhandled += 1;
          logger.error("moderation.drainImageModerations.row_unhandled", {
            id: record.id,
            storageKey: record.storageKey,
            error: describeError(error),
          });
          // Charge the attempt (with backoff) so a row that keeps throwing
          // outside the moderate call is pushed out of `claimDue` instead of
          // heading every run, and dead-letters at `maxAttempts`. Reported,
          // and best-effort: a bookkeeping failure never aborts the batch.
          const report = (err: unknown, reason: string) => {
            try {
              deps.reportError?.(err, {
                tags: { area: "image-moderation", reason },
                extra: { id: record.id, storageKey: record.storageKey },
              });
            } catch {
              // best-effort only
            }
          };
          report(error, "row-unhandled");
          try {
            await handleFailure({ record, deps, input, result, logger, error });
          } catch (bookkeepingError) {
            logger.error(
              "moderation.drainImageModerations.unhandled_bookkeeping_failed",
              { id: record.id, error: describeError(bookkeepingError) },
            );
            report(bookkeepingError, "unhandled-bookkeeping-failed");
          }
        }
      }

      const failed =
        result.retried + result.deadLettered - failuresBefore + unhandled;
      return {
        wantsAnother:
          (due.length >= input.limit || outOfTime) &&
          failed === 0 &&
          !breakerTripped,
      };
    },
  });
  result.passes = loop.passes;
  result.hasMore = loop.hasMore;

  logger.info("moderation.drainImageModerations.completed", result);

  return drainImageModerationsOutputSchema.parse(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-record processing
// ─────────────────────────────────────────────────────────────────────────────

async function processRecord(args: {
  record: ImageModerationRecord;
  deps: DrainImageModerationsDeps;
  input: DrainImageModerationsInput;
  result: DrainImageModerationsOutput;
  logger: LoggerPort;
}): Promise<void> {
  const { record, deps, input, result, logger } = args;

  let output: ModerateImageOutput;
  try {
    output = await deps.moderateImage(record.storageKey);
  } catch (error) {
    await handleFailure({ record, deps, input, result, logger, error });
    return;
  }

  // A concurrent run resolved it (or the record vanished) — nothing to do.
  if (output.noop) {
    logger.info("moderation.drainImageModerations.noop", {
      id: record.id,
      storageKey: record.storageKey,
      status: output.status,
    });
    return;
  }

  // ORPHANED is a RESOLUTION, not a failure. The object is gone, so
  // moderate-image already wrote the terminal status; there is nothing to
  // retry, no attempt to charge, and — deliberately — no uploader HOLD notice,
  // because there is no image for anyone to act on. Returning BEFORE the
  // `moderated` increment keeps it out of the verdict count too.
  if (output.status === "ORPHANED") {
    // A deliberate removal is not evidence about storage: count it apart so
    // the breaker (which reads `orphaned`) never trips on a place merge.
    if (output.removedOnPurpose) {
      result.removedBeforeScan += 1;
      logger.info("moderation.drainImageModerations.removed_before_scan", {
        id: record.id,
        storageKey: record.storageKey,
      });
      return;
    }
    result.orphaned += 1;
    logger.info("moderation.drainImageModerations.orphaned", {
      id: record.id,
      storageKey: record.storageKey,
    });
    return;
  }

  result.moderated += 1;

  // Only a FLAGGED (held) outcome notifies the uploader (FR-009).
  if (output.status === "FLAGGED") {
    await fireHoldNotification({ record, deps, logger });
  }
}

/**
 * Records a transient moderate-image failure: backed-off retry, or — once the
 * attempt budget is exhausted — dead-letter the row to FLAGGED+degraded so it
 * surfaces in the human queue (never stuck PENDING, never auto-approved), fire
 * the HOLD notification, and report the exhaustion (NFR-005 / FR-006).
 */
async function handleFailure(args: {
  record: ImageModerationRecord;
  deps: DrainImageModerationsDeps;
  input: DrainImageModerationsInput;
  result: DrainImageModerationsOutput;
  logger: LoggerPort;
  error: unknown;
}): Promise<void> {
  const { record, deps, input, result, logger, error } = args;
  const { repos, clock } = deps;

  const lastError = describeError(error);
  const attempts = record.attempts + 1;

  if (attempts >= input.maxAttempts) {
    const now = clock.now();
    await repos.imageModerationRecords.markResult({
      storageKey: record.storageKey,
      status: "FLAGGED",
      maxSeverity: DEAD_LETTER_SEVERITY,
      categories: [],
      provider: "drain-exhausted",
      degraded: true,
      moderatedAt: now,
    });
    result.deadLettered += 1;

    // FR-006: exhaustion is a fail-closed swallow — surface it to Sentry.
    try {
      deps.reportError?.(
        error instanceof Error ? error : new Error(lastError),
        {
          tags: { area: "image-moderation", reason: "drain-exhausted" },
          extra: {
            id: record.id,
            storageKey: record.storageKey,
            attempts,
          },
        },
      );
    } catch {
      // best-effort only
    }

    logger.error("moderation.drainImageModerations.dead_letter", {
      id: record.id,
      storageKey: record.storageKey,
      attempts,
      error: lastError,
    });

    // The image is now FLAGGED (held) — notify the uploader like any hold.
    await fireHoldNotification({ record, deps, logger });
    return;
  }

  const backoffSeconds = Math.min(
    input.baseBackoffSeconds * 2 ** (attempts - 1),
    input.maxBackoffSeconds,
  );
  const nextAttemptAt = new Date(clock.now().getTime() + backoffSeconds * 1000);
  await repos.imageModerationRecords.markFailed({
    id: record.id,
    lastError,
    nextAttemptAt,
  });
  result.retried += 1;

  logger.warn("moderation.drainImageModerations.retry", {
    id: record.id,
    storageKey: record.storageKey,
    attempts,
    nextAttemptAt: nextAttemptAt.toISOString(),
    error: lastError,
  });
}

/**
 * Fires the uploader HOLD notification for a FLAGGED record (best-effort).
 * Skipped when there is no human uploader or no `notify` wired. The per-channel
 * idempotency key (derived inside notify) is keyed on the record id so a worker
 * retry can't double-send.
 */
async function fireHoldNotification(args: {
  record: ImageModerationRecord;
  deps: DrainImageModerationsDeps;
  logger: LoggerPort;
}): Promise<void> {
  const { record, deps, logger } = args;
  if (!deps.notify || !record.createdByHumanId) {
    return;
  }

  // Shared with the subject resolver: one trailing-slash trim, one validation.
  // A malformed PUBLIC_WEB_URL now yields `null` rather than a `helpUrl` that
  // fails the renderer's strict `.url()` and sinks the whole notice.
  const base = normalizeAppBaseUrl(deps.appBaseUrl);
  // Which event is this image on? Best-effort: a lookup failure or a deleted
  // event degrades to nulls and the notice still goes out.
  const subject = await resolveImageModerationSubject({
    record,
    repos: deps.repos,
    appBaseUrl: deps.appBaseUrl,
    logger,
    reportError: deps.reportError,
  });

  try {
    await deps.notify({
      humanId: record.createdByHumanId,
      variant: HELD_VARIANT,
      payload: {
        recordId: record.id,
        kind: record.kind,
        subjectType: record.subjectType,
        subjectId: record.subjectId,
        subjectTitle: subject.subjectTitle,
        subjectUrl: subject.subjectUrl,
        imageUrl: record.publicUrl,
        helpUrl: base ? `${base}/help` : null,
      },
      idempotencyKey: `image-moderation-held:${record.id}`,
    });
  } catch (error) {
    // A notification failure must never fail the drain — the verdict is already
    // committed; the hold notice is best-effort. But the swallow MUST be
    // Sentry-visible (CLAUDE.md: logger.warn is NOT captured — the silent-outage
    // bug class). Report alongside the warn, guarded so a throwing reporter can
    // never change behaviour.
    logger.warn("moderation.drainImageModerations.hold_notify_failed", {
      id: record.id,
      humanId: record.createdByHumanId,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { area: "image-moderation", reason: "notify-failed" },
        extra: { recordId: record.id, variant: HELD_VARIANT },
      });
    } catch {
      // best-effort only
    }
  }
}
