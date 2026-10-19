import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  deriveConnectCapabilities,
  syncConnectAccount,
} from "./sync-connect-account";

/**
 * Pull-based reconciliation of connected-account capability state.
 *
 * `account.updated` is the only PUSH writer of `Payee.chargesEnabled` /
 * `payoutsEnabled`, and a webhook that is never delivered, fails signature
 * verification, or fails our own shape guard is simply gone — Stripe does not
 * retry a 2xx and we answer 2xx. The live-read write-back in
 * `getConnectStatus` heals a row opportunistically, but only for orgs that
 * happen to load a page. This job is the backstop for everyone else, and the
 * reason an org can no longer be silently unable to publish a paid event.
 *
 * Two jobs in one, and the second matters more:
 *
 *  1. It HEALS. Each account is re-read from Stripe and written through the
 *     same `syncConnectAccount` the webhook uses, so there is exactly one
 *     derivation and the pull path cannot drift from the push path.
 *  2. It MEASURES. Every row whose live state differs from what we had stored
 *     is counted and logged as `drifted`. That number is the honest answer to
 *     "are we still losing webhooks?", which nobody could answer during the
 *     incident. A healthy platform reports zero drift; a non-zero count is a
 *     webhook-delivery problem wearing a different hat, not a reason to run
 *     this job more often.
 *
 * Failure policy: one bad account must never abort the sweep. Per-account
 * failures are caught, counted, and reported, and the run still returns a
 * result. The batch is ordered stalest-first, so an account that fails
 * repeatedly stays near the head and is retried on the next run — see
 * `starvation` in the notes below.
 */

// ── Schema ───────────────────────────────────────────────────────────────────

export const reconcileConnectAccountsInputSchema = z
  .object({
    /**
     * How many accounts to re-read from Stripe in one run. Each costs one
     * `accounts.retrieve`, issued sequentially — deliberately not parallel, so
     * this job can never be the thing that exhausts our Stripe rate limit and
     * takes checkout down with it.
     */
    limit: z.number().int().min(1).max(500).default(200),
    /**
     * Wall-clock budget. The sweep stops cleanly when it is exceeded and the
     * cursor resumes next run.
     *
     * Cloud Scheduler's default attempt deadline is 180s, and 200 sequential
     * Stripe reads on a cold instance can exceed that. A truncated run is not
     * merely "fewer rows" — everything after the loop is lost, including the
     * alert that says an organizer was blocked. Bounding ourselves means the
     * run always reaches its own reporting.
     */
    maxDurationMs: z.number().int().min(1_000).max(600_000).default(120_000),
    /**
     * Per-account deadline for the Stripe read.
     *
     * The budget above is only checked between rows — an in-flight `await`
     * can't be preempted — so without this the worst case is
     * `maxDurationMs + one full Stripe call`. The Stripe SDK's default request
     * timeout is 80s (plus network retries), which would blow straight past
     * Cloud Scheduler's 180s deadline on a single hung call. Bounding it here
     * keeps the overshoot small, and a timed-out account is simply counted as
     * failed and retried next run.
     */
    perAccountTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(20_000),
  })
  .strict();

export type ReconcileConnectAccountsInput = z.infer<
  typeof reconcileConnectAccountsInputSchema
>;

export const reconcileConnectAccountsOutputSchema = z.object({
  /** Rows the query returned. May exceed `scanned` when the run is truncated. */
  listed: z.number().int(),
  /**
   * Rows actually processed. Always equals
   * `unchanged + drifted + failed + skipped` — including on a truncated run,
   * where `listed` is the larger number. The Discord alert renders this, and an
   * operator reading "scanned 200" on a run that reached 60 would badly
   * misjudge the coverage.
   */
  scanned: z.number().int(),
  /**
   * Rows whose stored state already matched Stripe — the healthy majority.
   * In `forceConnectCapabilities` mode this instead means "written", since the
   * Stripe read is discarded and drift is not measured at all.
   */
  unchanged: z.number().int(),
  /** Rows the webhook had left wrong. This is the signal — it should be 0. */
  drifted: z.number().int(),
  /** Of `drifted`, those that went from can't-be-paid to can-be-paid. */
  healedToPayable: z.number().int(),
  /**
   * Of `drifted`, those that went the OTHER way: payable -> not payable.
   *
   * Time-critical, and for a while it was the quiet half of this job. This
   * sweep runs 22:30 America/Chicago and `settlements.run-batch` runs 00:00 in
   * the same timezone — 90 minutes later. A payee demoted here fails the
   * batch's `payoutsEnabled` eligibility gate and is SKIPPED: their ledger
   * credits stay unconsumed, so the first batch after the capability is fixed
   * pays them in full (ledger-authoritative cutover, spec 2026-08-10 — there
   * is no failed settlement row and nothing to reset).
   *
   * So this number is "payees who do not get paid tonight unless someone
   * looks", and the 90 minutes is the whole window in which looking helps.
   */
  demotedFromPayable: z.number().int(),
  /** Accounts whose Stripe read or write failed. Retried next run. */
  failed: z.number().int(),
  /**
   * Rows we read but did not write: no Stripe account, or the repo's guards
   * refused (RESTRICTED, or a newer observation already won). Kept distinct so
   * `scanned` always equals `unchanged + drifted + failed + skipped`.
   */
  skipped: z.number().int(),
  /** True when the wall-clock budget cut the run short. */
  truncated: z.boolean(),
  /** RESTRICTED payees still holding a Stripe account — cannot self-heal. */
  restrictedWithAccount: z.number().int(),
});

export type ReconcileConnectAccountsOutput = z.infer<
  typeof reconcileConnectAccountsOutputSchema
>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type ReconcileConnectAccountsDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Expected: this use case swallows per-account failures so one bad account
   * can't abort the sweep, and per the repo convention a deliberate swallow
   * must be reported. A silently-failing reconcile job is worse than no
   * reconcile job — it looks like coverage while providing none.
   */
  reportError?: ReporterPort;
  /** Dev-only capability override. Production must never pass `true`. */
  forceConnectCapabilities?: boolean;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * How many per-account failures get an individual Sentry event before the rest
 * collapse into one summary. A batch-wide cause fails every row, and N separate
 * reports for one root cause is noise, not signal.
 */
const FAILURE_SAMPLE_LIMIT = 3;

export async function reconcileConnectAccounts(
  deps: ReconcileConnectAccountsDeps,
  rawInput: unknown = {},
): Promise<ReconcileConnectAccountsOutput> {
  const input = parseInput(reconcileConnectAccountsInputSchema, rawInput);

  const forced = deps.forceConnectCapabilities === true;
  const startedAt = deps.clock.now().getTime();

  // Counted BEFORE the loop on purpose: a run cut short by the time budget
  // still reports it. These are payees that can neither publish nor be paid
  // and that nothing in the system can heal.
  const restrictedWithAccount = await countRestricted(deps);

  const payees = await deps.repos.payees.listForCapabilityReconcile({
    limit: input.limit,
  });

  let unchanged = 0;
  let drifted = 0;
  let healedToPayable = 0;
  let demotedFromPayable = 0;
  let failed = 0;
  let skipped = 0;
  let truncated = false;
  const failureSamples: Array<{ payeeId: string; error: string }> = [];

  for (const payee of payees) {
    if (deps.clock.now().getTime() - startedAt >= input.maxDurationMs) {
      truncated = true;
      break;
    }

    // The repo query filters these out, but the port doesn't guarantee it and
    // a null account id would make the Stripe call meaningless.
    if (!payee.stripeAccountId) {
      skipped += 1;
      continue;
    }

    try {
      // BEFORE the read, deliberately. `observedAt` is "when was this true",
      // not "when did we write it". Stamped after the read, a webhook for a
      // change that lands during our read window carries an EARLIER
      // `event.created` than our stamp — so the ordering guard would let this
      // sweep's now-stale snapshot overwrite a fresher truth. Stamping first
      // makes the guard resolve that race the right way: a genuinely newer
      // event wins, and we simply lose this row until the next run.
      const observedAt = deps.clock.now();
      const status = await withTimeout(
        deps.payments.getConnectAccountStatus({
          accountId: payee.stripeAccountId,
        }),
        input.perAccountTimeoutMs,
        `stripe_account_read_timeout after ${input.perAccountTimeoutMs}ms`,
      );

      const snapshot = {
        stripeAccountId: payee.stripeAccountId,
        chargesEnabled: status.chargesEnabled,
        payoutsEnabled: status.payoutsEnabled,
        // Load-bearing: `deriveConnectCapabilities` ANDs `transfers` in.
        // Dropping capabilities here would make this sweep more permissive
        // than the webhook and, being the newest observation, it would win.
        capabilities: status.capabilities ?? null,
        requirements: status.requirements,
        defaultCurrency: payee.defaultCurrency,
      };

      const derived = deriveConnectCapabilities(
        snapshot,
        deps.forceConnectCapabilities === true,
      );
      // Re-read the row immediately before comparing. `payee` came from the
      // batch query, which for the last rows of a 200-row run is up to two
      // minutes stale — and a perfectly healthy `account.updated` landing in
      // that window would make us compare against a pre-webhook snapshot and
      // report "lost webhook detected" for a webhook that arrived on time.
      // This narrows that window from minutes to milliseconds.
      const current = (await deps.repos.payees.getById(payee.id)) ?? payee;

      // `status` is compared too. It is redundant today (it is a pure function
      // of the two booleans) but it independently gates publish and checkout,
      // so a legacy row with both booleans right and the wrong status would
      // otherwise be repaired silently and counted as `unchanged`.
      //
      // Under `forced` the Stripe read is discarded entirely, so a difference
      // here means "not already true/true", not "Stripe disagrees" — the
      // measurement is meaningless and the escalation below is suppressed.
      const wasDrifted =
        !forced &&
        (derived.chargesEnabled !== current.chargesEnabled ||
          derived.payoutsEnabled !== current.payoutsEnabled ||
          derived.status !== current.status);

      const synced = await syncConnectAccount(
        {
          repos: deps.repos,
          logger: deps.logger,
          reportError: deps.reportError,
        },
        {
          account: snapshot,
          observedAt,
          source: "live-read",
          forceEnabled: forced,
        },
      );

      // Only count what actually landed. `syncCapabilities` can refuse the
      // write (RESTRICTED, a newer observation won the ordering guard while
      // we were reading Stripe, or the row vanished mid-run), and counting a
      // refused write as a heal would page someone with "we restored payouts
      // for 1 payee" when we restored nothing — a phantom incident.
      if (synced.outcome !== "applied") {
        skipped += 1;
        continue;
      }

      if (!wasDrifted) {
        unchanged += 1;
        continue;
      }

      drifted += 1;
      const becamePayable = derived.payoutsEnabled && !current.payoutsEnabled;
      if (becamePayable) healedToPayable += 1;
      const lostPayable = !derived.payoutsEnabled && current.payoutsEnabled;
      if (lostPayable) demotedFromPayable += 1;

      // Logged per row on purpose: each one is a webhook we lost, and the
      // before/after is what tells you whether the loss was a promotion (an
      // org that couldn't publish) or a demotion (an org we'd have paid into
      // an account that can't receive it).
      deps.logger?.info("stripe_connect_reconcile_drift", {
        payeeId: payee.id,
        stripeAccountId: payee.stripeAccountId,
        subjectType: payee.subjectType,
        subjectId: payee.subjectId,
        before: {
          chargesEnabled: current.chargesEnabled,
          payoutsEnabled: current.payoutsEnabled,
          status: current.status,
        },
        after: derived,
        becamePayable,
        lostPayable,
      });
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      deps.logger?.error("stripe_connect_reconcile_account_failed", {
        payeeId: payee.id,
        stripeAccountId: payee.stripeAccountId,
        error: message,
      });
      // LATCHED. A global cause — Stripe down, an expired key, an unconfigured
      // `STRIPE_SECRET_KEY` whose stub throws on every call — fails every row
      // in the batch, and reporting each one individually would be a
      // several-hundred-event Sentry flood that buries the signal it is meant
      // to be. Report the first few with detail; the rest roll into one summary
      // at the end.
      if (failureSamples.length < FAILURE_SAMPLE_LIMIT) {
        failureSamples.push({ payeeId: payee.id, error: message });
        report(deps, err, {
          payeeId: payee.id,
          stripeAccountId: payee.stripeAccountId,
        });
      }
    }
  }

  const processed = unchanged + drifted + failed + skipped;
  const result: ReconcileConnectAccountsOutput = {
    listed: payees.length,
    scanned: processed,
    unchanged,
    drifted,
    healedToPayable,
    demotedFromPayable,
    failed,
    skipped,
    truncated,
    restrictedWithAccount,
  };

  // One summary for a batch-wide failure, on top of the sampled few above.
  // `logger.error` alone is not enough here: apps/jobs has no Sentry pino
  // integration (see apps/jobs/src/app.ts), so in the process that actually
  // runs this sweep an unreported error level line reaches Cloud Logging and
  // nothing else.
  if (failed > FAILURE_SAMPLE_LIMIT) {
    report(
      deps,
      new Error(
        `Connect reconcile: ${failed}/${processed} processed accounts failed to read from Stripe`,
      ),
      {
        failed,
        scanned: processed,
        listed: payees.length,
        truncated,
        samples: failureSamples,
      },
    );
  }

  if (forced) {
    // Drift is unmeasurable in this mode (the Stripe read is discarded), so
    // say so rather than reporting a misleading zero.
    deps.logger?.info("stripe_connect_reconcile_completed_forced", result);
    return result;
  }

  // `logger.error` when we actually healed something payable: a row that was
  // wrong in that direction means an org WAS blocked from publishing a paid
  // event and nobody knew. That is the incident, caught by the backstop rather
  // than by a support ticket, and it should page someone to look at webhook
  // delivery — the reconcile job is not a fix for a broken webhook endpoint.
  if (result.healedToPayable > 0) {
    deps.logger?.error(
      "stripe_connect_reconcile_healed_blocked_payees",
      result,
    );
  } else {
    deps.logger?.info("stripe_connect_reconcile_completed", result);
  }

  // Demotions escalate SEPARATELY, not as an `else` — a single run can both
  // heal one payee and demote another, and the two need different people
  // doing different things (chase webhook delivery vs. stop a payout failing
  // in 90 minutes). Folding them into one branch would silently drop
  // whichever lost the coin toss.
  if (result.demotedFromPayable > 0) {
    deps.logger?.error(
      "stripe_connect_reconcile_demoted_payable_payees",
      result,
    );
  }

  return result;
}

/**
 * Reject after `ms` rather than inheriting the Stripe SDK's 80s default. The
 * loop's wall-clock budget is only checked between rows, so an unbounded
 * in-flight call is the one thing that can still overshoot the scheduler
 * deadline.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Best-effort report; a throwing reporter must never change behaviour. */
function report(
  deps: ReconcileConnectAccountsDeps,
  error: unknown,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: { area: "stripe-connect", op: "reconcile-connect-accounts" },
      extra,
    });
  } catch {
    // Intentionally empty.
  }
}

async function countRestricted(
  deps: ReconcileConnectAccountsDeps,
): Promise<number> {
  try {
    return await deps.repos.payees.countRestrictedWithStripeAccount();
  } catch (err) {
    deps.logger?.error("stripe_connect_reconcile_restricted_count_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    report(deps, err, { op: "reconcile-restricted-count" });
    return 0;
  }
}
