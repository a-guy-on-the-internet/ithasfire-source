/**
 * Stripe Connect jobs.
 *
 * Capability state on a `Payee` row (`chargesEnabled` / `payoutsEnabled`) has
 * exactly one push-based writer: the `account.updated` webhook. A delivery that
 * never arrives, fails signature verification, or fails our shape guard is
 * simply lost — Stripe does not retry a 2xx and we answer 2xx. The row then
 * stays wrong forever, the publish gate reads it and refuses paid events, and
 * the Payments settings page (which reads live Stripe) shows green. That is the
 * outage this job exists to make impossible.
 */
import {
  reconcileConnectAccounts,
  reconcileConnectAccountsInputSchema,
} from "@th/core/use-cases/stripe-connect";
import { logAndReport } from "@th/adapters/infra/discord-alerts";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { buildCloudLoggingUrl, fireDiscordAlert } from "../lib/discord-alerts";
import { Sentry } from "../instrument";

// ─────────────────────────────────────────────────────────────────────────────
// stripe-connect.reconcile-capabilities
// ─────────────────────────────────────────────────────────────────────────────
export const reconcileCapabilities = defineScheduledTask({
  name: "stripe-connect.reconcile-capabilities",
  description:
    "Re-read the stalest connected accounts from Stripe and write their capability state back through the same derivation the account.updated webhook uses. Backstop for lost webhooks; also reports how many rows had drifted.",
  // Reuse the use case's schema instead of restating the bounds — two copies
  // of `.default(200)` silently disagree the moment one is changed.
  input: reconcileConnectAccountsInputSchema,
  schedule: getSchedule("stripe-connect.reconcile-capabilities"),
  handler: async ({ input, ctx }) => {
    ctx.logger.info("stripe-connect.reconcile-capabilities.start", input);

    const result = await reconcileConnectAccounts(
      {
        repos: ctx.repos,
        payments: ctx.payments,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError,
        forceConnectCapabilities: ctx.forceConnectCapabilities,
      },
      input,
    );

    // Two alerts, not one, and NOT mutually exclusive — a single run can heal
    // one payee and demote another, and they need different people doing
    // different things on different clocks. Per-row before/after for both is
    // in the `stripe_connect_reconcile_drift` lines under this run id.
    const logsUrl = buildCloudLoggingUrl(ctx.runId);

    // Alert on healed-to-payable, not on drift generally.
    //
    // A row we corrected in the payable direction means an organizer WAS
    // blocked from publishing a paid event and nobody knew — the incident,
    // caught by the backstop instead of by a support ticket. The fix for that
    // is at the webhook endpoint, not here: this job running successfully is
    // not "resolved", it is "the outage was absorbed".
    if (result.healedToPayable > 0) {
      // AWAITED, not fire-and-forget. Cloud Run throttles this instance's CPU
      // the moment the response is written (no `cpu_idle = false`, and
      // `min_instance_count = 0`), so a `void`ed Discord POST and Sentry flush
      // can simply never complete — the one run that most needs to page
      // someone would page nobody. Every sibling call site in apps/jobs awaits
      // for the same reason.
      await logAndReport({
        logger: ctx.logger,
        level: "error",
        message: "stripe-connect.reconcile-capabilities.healed_blocked_payees",
        extra: result,
        report: {
          captureException: Sentry.captureException,
          error: new Error(
            `Reconcile restored payouts for ${result.healedToPayable} payee(s) — an account.updated webhook was lost`,
          ),
          context: {
            tags: { area: "stripe-connect", op: "reconcile-capabilities" },
            extra: result,
          },
        },
        alert: {
          send: fireDiscordAlert,
          payload: {
            title: "Stripe Connect: lost webhook detected",
            colour: "error",
            description:
              "The nightly reconcile found payees whose payout capability was stale in the blocking direction. Those orgs could not publish paid events until this ran. Check Stripe webhook delivery for `account.updated` — the reconcile is a backstop, not a fix.",
            fields: [
              {
                name: "Healed (now payable)",
                value: String(result.healedToPayable),
                inline: true,
              },
              { name: "Drifted", value: String(result.drifted), inline: true },
              {
                name: "Scanned",
                // `scanned` is rows PROCESSED. On a truncated run that is less
                // than the batch we listed, and reading it as full coverage
                // would badly misjudge how much of the population was checked.
                value: result.truncated
                  ? `${result.scanned} of ${result.listed} (run truncated)`
                  : String(result.scanned),
                inline: true,
              },
              ...(logsUrl ? [{ name: "Logs", value: logsUrl }] : []),
            ],
          },
        },
      });
    }

    // Drift in the OTHER direction, on a clock.
    //
    // This job runs 22:20 America/Chicago; `settlements.run-batch` runs 00:00
    // in the same timezone. A payee we just demoted hits the
    // `payee.payoutsEnabled` eligibility gate in run-batch 100 minutes from
    // now and is SKIPPED — their ledger credits are left unconsumed, so
    // nothing is lost and the next batch after the capability is fixed pays
    // them in full (ledger-authoritative cutover, spec 2026-08-10: there is
    // no failed settlement row to reset any more).
    //
    // Still an error-level page, not an FYI: it is "N payees do not get paid
    // tonight unless someone looks", and the 100 minutes is the whole window
    // in which looking is cheaper than explaining a missed payout.
    if (result.demotedFromPayable > 0) {
      await logAndReport({
        logger: ctx.logger,
        level: "error",
        message: "stripe-connect.reconcile-capabilities.demoted_payable_payees",
        extra: result,
        report: {
          captureException: Sentry.captureException,
          error: new Error(
            `Reconcile demoted ${result.demotedFromPayable} payee(s) out of payable — tonight's batch will skip them`,
          ),
          context: {
            tags: { area: "stripe-connect", op: "reconcile-capabilities" },
            extra: result,
          },
        },
        alert: {
          send: fireDiscordAlert,
          payload: {
            title: "Stripe Connect: payouts will be skipped tonight",
            colour: "error",
            description:
              "The nightly reconcile found payees Stripe no longer considers payable (usually a lapsed `transfers` capability). The payout batch runs at 00:00 America/Chicago and will SKIP them — their money stays on the ledger and is paid in full by the first batch after the capability is fixed. Nothing is lost and there is nothing to reset; the cost is a delayed payout, so fix the capability in Stripe.",
            fields: [
              {
                name: "Demoted (no longer payable)",
                value: String(result.demotedFromPayable),
                inline: true,
              },
              { name: "Drifted", value: String(result.drifted), inline: true },
              {
                name: "Scanned",
                value: result.truncated
                  ? `${result.scanned} of ${result.listed} (run truncated)`
                  : String(result.scanned),
                inline: true,
              },
              ...(logsUrl ? [{ name: "Logs", value: logsUrl }] : []),
            ],
          },
        },
      });
    }

    if (result.healedToPayable === 0 && result.demotedFromPayable === 0) {
      ctx.logger.info(
        "stripe-connect.reconcile-capabilities.completed",
        result,
      );
    }

    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Export all Stripe Connect jobs
// ─────────────────────────────────────────────────────────────────────────────
export const stripeConnectJobs = [reconcileCapabilities];
