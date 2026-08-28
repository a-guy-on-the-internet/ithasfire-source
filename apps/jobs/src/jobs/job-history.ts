/**
 * Job-run history retention.
 *
 * jobs.prune-run-history — a daily cron that trims `JobRun` to the retention
 * cap across every job.
 *
 * Why a scheduled sweep instead of trimming on write: `PostgresJobRunTracker`
 * used to prune inside `record()`, wrapping INSERT + SELECT-overflow + DELETE
 * in a transaction. That is O(writes) — every job run paid five statements to
 * hold history at 50 rows. Measured 2026-08-25 in production over 7d, JobRun
 * bookkeeping was ~90k queries/week, roughly half of it that SELECT/DELETE
 * pair. It is the same workload that exhausted the Upstash quota on
 * 2026-07-28 and was relocated to Postgres by the fix for that.
 *
 * Daily is O(1/day) and the table only overshoots by one day of runs per job
 * in between (~96 rows for a 15-minute-cron job). A daily job costs one Cloud Run
 * invocation — the cron-load concern from the 2026-07-30 retune was about the
 * 2- and 5-minute jobs, not this.
 *
 * No-op on the Redis backend, which trims natively via ZREMRANGEBYRANK.
 */
import { z } from "zod";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";

export const pruneRunHistory = defineScheduledTask({
  name: "jobs.prune-run-history",
  description:
    "Trim JobRun history to the retention cap across all jobs (no-op on the Redis backend, which trims on write).",
  input: z.object({
    /** Override the retained-runs-per-job cap for a one-off deeper trim. */
    maxPerJob: z.coerce.number().int().min(1).max(1000).optional(),
  }),
  schedule: getSchedule("jobs.prune-run-history"),
  handler: async ({ input, ctx }) => {
    const deleted =
      input.maxPerJob === undefined
        ? await ctx.runTracker.pruneRuns()
        : await ctx.runTracker.pruneRuns(input.maxPerJob);

    ctx.logger.info("jobs.prune-run-history.completed", { deleted });
    return { deleted };
  },
});

export const jobHistoryJobs = [pruneRunHistory];
