/**
 * Lineup Notice Jobs
 *
 * - lineup-notices.continue-sweep: continues a post-publish "you're on the
 *   lineup" sweep that ran out of its time budget (core
 *   `event-humans/_shared/lineup-sweep-continuation.ts`).
 *
 * NOT a cron job, on purpose: it runs only when a sweep with rows left asked
 * the delayed scheduler (Cloud Tasks, on the dedicated lineup-notice-sweep
 * queue) for it, and it
 * re-queues itself only while rows remain, up to a bound. No overflow, no
 * run — nothing here wakes the database on a timer.
 */
import { defineJob } from "../lib/define-job";
import {
  continueLineupNoticeSweep,
  continueLineupNoticeSweepInputSchema,
} from "@th/core/use-cases/event-humans/continue-lineup-notice-sweep";
import { notify as notifyUseCase } from "@th/core/use-cases/comms/notify";

export const continueLineupNoticeSweepJob = defineJob({
  // = LINEUP_SWEEP_CONTINUE_JOB (core); a literal so validate-manifest can
  // read it. lineup-notices.test.ts pins the two together.
  name: "lineup-notices.continue-sweep",
  description:
    "Continue a post-publish lineup-notice sweep that ran out of time: tell the rest of the event's owed lineup people (exactly once per row), re-queue itself while rows remain, give up and report after 5 runs. Triggered through the delayed scheduler (Cloud Tasks); never on a timer.",
  input: continueLineupNoticeSweepInputSchema,
  handler: async ({ input, ctx }) => {
    if (!ctx.lineupNoticeLedger) {
      // Without the API's ledger every row reads as "not owed": sweeping
      // would tell nobody and look successful. Refuse loudly instead —
      // THROWING, because only a throw reaches the 500 in app.ts; a handler
      // that returns `{ success: false }` still answers 200 (app.ts sends
      // `{ success: true, result }` for any value a handler returns), so
      // Cloud Tasks would treat the hop as delivered, never retry, and the
      // chain would end here with nothing queued. Rerunning is safe: no row
      // was touched.
      const err = new Error(
        "lineup-notices.continue-sweep: lineupNoticeLedger not wired; rows stay owed",
      );
      ctx.logger.error("lineup_notices.continue_sweep_unavailable", {
        eventId: input.eventId,
        attempt: input.attempt,
      });
      try {
        ctx.reportError(err, {
          tags: { job: "lineup-notices.continue-sweep", reason: "no_ledger" },
          extra: { eventId: input.eventId, attempt: input.attempt },
        });
      } catch {
        // Best-effort: a throwing reporter must not change the outcome.
      }
      throw err;
    }
    const mailer = ctx.mailer;
    if (!mailer) {
      // Same refusal shape as the ledger above, and for a worse fault: with
      // no mailer `sendEmail` returns `skipped: "port_unavailable"` (NOT
      // "failed"), so nothing reports it, and `sendLineupAdded` still
      // commits the row's 10-YEAR SENT record. Every row this run touched
      // would be in-app-only, permanently, and silently. A refused job that
      // Cloud Tasks retries is strictly better — and refusing means
      // THROWING: a returned `{ success: false }` is still a 200 out of
      // app.ts, which Cloud Tasks reads as delivered and never retries. The
      // throw is what produces the non-2xx. No row was touched, so the
      // rerun is safe.
      const err = new Error(
        "lineup-notices.continue-sweep: mailer not configured; rows stay owed rather than being told in-app only, forever",
      );
      ctx.logger.error("lineup_notices.continue_sweep_unavailable", {
        reason: "no_mailer",
        eventId: input.eventId,
        attempt: input.attempt,
      });
      try {
        ctx.reportError(err, {
          tags: { job: "lineup-notices.continue-sweep", reason: "no_mailer" },
          extra: { eventId: input.eventId, attempt: input.attempt },
        });
      } catch {
        // Best-effort: a throwing reporter must not change the outcome.
      }
      throw err;
    }

    // notify() with the jobs container's mailer/push bound, as the other
    // notification jobs build it — the notice's email leg sends from here.
    const notify = (payload: Parameters<typeof notifyUseCase>[1]) =>
      notifyUseCase(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          mailer,
          sms: ctx.sms ?? undefined,
          push: ctx.push ?? undefined,
          logger: ctx.logger,
          reportError: ctx.reportError,
        },
        payload,
      );

    const result = await continueLineupNoticeSweep(
      {
        repos: ctx.repos,
        idempotency: ctx.lineupNoticeLedger,
        notify,
        mailer,
        publicAppUrl: ctx.appBaseUrl,
        clock: ctx.clock,
        rateLimit: ctx.rateLimit ?? null,
        logger: ctx.logger,
        // Every swallowed send failure and the give-up are reported here
        // (jobs has no pino → Sentry integration; this is the only path).
        reportError: ctx.reportError,
        // The next hop goes on the DEDICATED lineup-sweep queue
        // (infra/terraform/lineup-notice-sweep.tf), not the search drain's:
        // that one is pinned to `max_concurrent_dispatches = 1` because
        // overlapping DRAINS would read the same marks, and a continuation
        // holding the single slot for up to the 300s dispatch deadline made
        // search-document drains queue behind lineup work. The composition
        // root (apps/jobs/src/lib/container.ts) resolves the fallback to the
        // search-drain scheduler for environments applied before that queue
        // existed, so there is exactly one thing to read here.
        sweepContinuation: ctx.lineupSweepContinuation ?? null,
      },
      input,
    );

    ctx.logger.info("lineup_notices.continue_sweep.completed", {
      eventId: input.eventId,
      attempt: input.attempt,
      ...result,
    });
    if (result.outcome === "unfinished") {
      // Rows are left and the scheduler REFUSED attempt + 1 (already
      // reported). Fail the request so Cloud Tasks retries THIS attempt
      // (the lineup-notice-sweep queue allows max_attempts = 5); the SENT
      // claims make the rerun safe.
      // `gave_up` stays a 200: retrying the last attempt cannot help. So
      // does `unconfirmed` — there the scheduler never answered, so attempt
      // + 1 may well be queued, and a retry would add a second chain for it
      // (plus a DLQ entry) on no evidence. It is reported instead.
      throw new Error(
        "lineup-notices.continue-sweep: rows left and the next run could not be queued",
      );
    }
    return {
      success: result.outcome !== "gave_up" && result.outcome !== "unconfirmed",
      result,
    };
  },
});

export const lineupNoticeJobs = [continueLineupNoticeSweepJob];
