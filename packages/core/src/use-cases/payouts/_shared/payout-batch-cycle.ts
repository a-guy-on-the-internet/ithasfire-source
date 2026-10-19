// ─────────────────────────────────────────────────────────────────────────────
// HOW OFTEN MONEY ACTUALLY LEAVES — the one fact about the payout BATCH that a
// read model has to know, written down where core can reach it.
//
// WHY A CONSTANT AND NOT A READ. The schedule lives in
// `apps/jobs/jobs.manifest.json` (`settlements.run-batch`), and core cannot
// import from `apps/jobs` — the dependency arrow points the other way and must
// keep pointing that way. So the cycle is recorded here, next to the reasoning
// that uses it.
//
// THE DRIFT IS GUARDED, NOT MERELY DOCUMENTED. `PAYOUT_BATCH_CRON_SOURCE`
// below is the exact cron string this interval was derived from, and
// `apps/jobs/src/scripts/validate-manifest.ts` asserts the manifest still says
// the same thing AND that no environment overrides the job in its tfvars
// `jobs_scheduler_overrides` (Terraform deploys an override in place of the
// manifest, so it would be the copy that actually runs). That script runs as
// a PRE-COMMIT hook and as the
// `manifest_drift_guard` job six prod deploy jobs declare `needs:` on, so
// rescheduling the batch without revisiting this file fails at commit time and
// again before anything rolls. The machine catches the drift; a human decides
// what the new interval should be, because only a human can.
//
// This module imports NOTHING on purpose. The validator loads it directly, and
// a gate should not be able to fail because some transitive import of a
// business rule blew up.
// ─────────────────────────────────────────────────────────────────────────────

/** The manifest key whose schedule this module records. */
export const PAYOUT_BATCH_JOB_NAME = "settlements.run-batch";

/**
 * The cron `settlements.run-batch` is scheduled on, VERBATIM, as at the last
 * time {@link PAYOUT_BATCH_CYCLE_MS} was reasoned about.
 *
 * Deliberately a string to compare, not a schedule to parse. The manifest
 * validator is explicit that it is a shape check and not a cron parser, and
 * that ruling stands: deriving an interval from an arbitrary cron expression
 * is a parser, and it would be wrong for the first non-trivial schedule
 * anyone writes. String equality catches EVERY change, including the ones a
 * parser would mis-read.
 */
export const PAYOUT_BATCH_CRON_SOURCE = "0 0 * * *";

/** The zone that cron is interpreted in. Midnight CENTRAL, never midnight UTC. */
export const PAYOUT_BATCH_TIMEZONE = "America/Chicago";

/**
 * How long money can sit payable before the batch has demonstrably had its
 * chance at it — 36 hours.
 *
 * NOT 24. The number has to survive three things at once, and each one pushes
 * it up:
 *
 *   1. THE WORST-CASE GAP BETWEEN TWO RUNS IS 25 HOURS, not 24. `0 0 * * *` in
 *      `America/Chicago` fires at midnight LOCAL, so the autumn fall-back day
 *      is 25 hours long. A 24-hour window starting just after midnight that
 *      day contains NO midnight at all. 25 always contains one.
 *   2. THE RUN IS NOT INSTANT. The batch plans, transfers and writes; a payee
 *      deferred by the per-run cap waits for the next one by design
 *      (`run-batch.ts` orders its feed by `oldestMaturedAt` precisely so that
 *      happens fairly).
 *   3. A LATE OR RETRIED RUN IS NORMAL. Cloud Scheduler is at-least-once with
 *      no promptness guarantee, and a job that fails and is retried hours
 *      later has still done its job.
 *
 * So: 25 hours of worst-case cycle plus 11 hours of slack. The error the
 * margin exists to prevent is one-directional — being LATE to tell an
 * organiser their payout looks stuck costs them a few hours of not knowing,
 * while being EARLY tells them their money is missing when it is merely on
 * schedule. Under-accusing is the only acceptable way to be wrong here.
 */
export const PAYOUT_BATCH_CYCLE_MS = 36 * 60 * 60 * 1000;
