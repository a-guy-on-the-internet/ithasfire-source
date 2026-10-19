import type { JobContext } from "./define-job";

/**
 * (job, reason) pairs whose "not configured" skip has already been reported
 * to Sentry in this process. Same one-shot discipline as `driftReported` and
 * `reportedModuleLoadFailures` in app.ts, and for the same reason: a missing
 * dependency is almost always PERMANENT for the life of the revision, so
 * `search.reindex-scheduled-price-flips` on its 30-minute cron would
 * otherwise capture 48 Sentry events a day for one unchanging fault.
 *
 * Once per PROCESS, not once ever: the latch lives in this module, so every
 * cold start and every extra instance reports the pair again. That bounds
 * the events to the number of process starts instead of the number of runs.
 *
 * Keyed by job AND reason, not by reason alone: each job that skips is its
 * own outage (a missing search backend silences eight of them), and the tag
 * has to name the job that stopped doing its work.
 */
const reported = new Set<string>();

/**
 * A handler that SKIPS because a dependency is not configured (no search
 * backend, no mailer, no Stripe key) calls this next to its log line, then
 * returns its skip result as before.
 *
 * Why the skip is not a throw: dev turns some of these dependencies off on
 * purpose, and a throw would push a DLQ entry and a Sentry event on every
 * scheduler tick. Why it is reported at all: `logger.warn` / `logger.info` do
 * not reach Sentry (CLAUDE.md), so in prod a cleared secret would make the
 * job a permanent silent no-op — app.ts answers 200 and records a `success`
 * run for any value a handler returns.
 *
 * Every tick still logs; this only bounds the REPORTING.
 */
export function reportNotConfiguredOnce(
  ctx: Pick<JobContext, "reportError">,
  { job, reason }: { job: string; reason: string },
): void {
  const key = `${job}\u0000${reason}`;
  if (reported.has(key)) return;
  // Latched BEFORE the call, like `driftReported`: a reporter that throws is
  // not retried on every tick either.
  reported.add(key);
  try {
    ctx.reportError(new Error(`${job}: ${reason}`), {
      tags: { area: "job-not-configured", job, reason },
    });
  } catch {
    // Best-effort: a throwing reporter must not change the outcome.
  }
}

/** Tests only: forget what has been reported, as a fresh process would. */
export function resetNotConfiguredReportsForTests(): void {
  reported.clear();
}
