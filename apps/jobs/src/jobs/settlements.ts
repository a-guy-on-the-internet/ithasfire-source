/**
 * Settlement Jobs
 *
 * Revenue is written as SETTLEMENT_CREDIT ledger entries during order
 * finalization. This file wires the payout side: a scheduled batch runner
 * that pays `max(0, payable)` per (payee, currency) (daily cron + manually
 * triggerable).
 *
 * `settlements.execute-transfer` is DELETED with the settlement claim
 * machinery (spec 2026-08-10 §7) — there is no per-settlement transfer any
 * more; money moves only through the batch, off the ledger.
 */
import { z } from "zod";
import { defineJob, defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { runPayoutBatch } from "@th/core/use-cases/settlements/run-batch";
import { verifyLedgerInvariants } from "@th/core/use-cases/settlements/verify-ledger-invariants";
import { notifyPayoutCompleted } from "@th/core/use-cases/settlements/notify-payout-completed";
import { notify as notifyUseCase } from "@th/core/use-cases/comms/notify";
import { logAndReport } from "@th/adapters/infra/discord-alerts";
import type { DiscordAlertField } from "@th/adapters/infra/discord-alerts";
import { buildCloudLoggingUrl, fireDiscordAlert } from "../lib/discord-alerts";
import { Sentry } from "../instrument";

// ─────────────────────────────────────────────────────────────────────────────
// settlements.run-batch - Consolidated per-payee payout batch (daily cron + manually triggerable)
// ─────────────────────────────────────────────────────────────────────────────
export const runBatch = defineScheduledTask({
  name: "settlements.run-batch",
  description:
    "Consolidated per-payee payout batch. Runs daily at midnight CT and can be triggered manually from the platform jobs page.",
  input: z.object({
    limit: z.number().int().min(1).max(500).default(100),
  }),
  schedule: getSchedule("settlements.run-batch"),
  handler: async ({ input, ctx }) => {
    ctx.logger.info("settlements.run-batch.start", { limit: input.limit });

    // Best-effort "you've been paid out" notifier. Built here so run-batch
    // stays decoupled from the comms wiring. `notify` persists the in-app
    // notification and dispatches email/SMS via the same ports other
    // notification jobs use (mailer/sms are null when unconfigured —
    // notify degrades gracefully per channel).
    const notify = (payload: Parameters<typeof notifyUseCase>[1]) =>
      notifyUseCase(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          mailer: ctx.mailer ?? undefined,
          sms: ctx.sms ?? undefined,
          push: ctx.push ?? undefined,
          logger: ctx.logger,
        },
        payload,
      );
    const payoutsUrl = ctx.appBaseUrl
      ? `${ctx.appBaseUrl.replace(/\/+$/, "")}/sell/payouts`
      : undefined;

    let result: Awaited<ReturnType<typeof runPayoutBatch>>;
    try {
      result = await runPayoutBatch(
        {
          repos: ctx.repos,
          payments: ctx.payments,
          idempotency: ctx.idempotency,
          clock: ctx.clock,
          logger: ctx.logger,
          // Report per-item payout failures that run-batch SWALLOWS (transfer
          // throws + payee-eligibility fail branches). These never reach the
          // job error-boundary, so capture them here to avoid silent losses.
          // The `crashed` catch below re-throws and is caught by the boundary
          // (D1) — do NOT capture there too, or issues would be duplicated.
          reportError: Sentry.captureException,
          notifyPayee: (args) =>
            notifyPayoutCompleted(
              { repos: ctx.repos, notify, logger: ctx.logger },
              { ...args, payoutsUrl },
            ),
        },
        { limit: input.limit },
      );
    } catch (err) {
      // Crash-level alert: DB down, Redis down, or any unhandled throw
      // means the batch didn't even get to process items. Fire an alert
      // before re-throwing so the failure is never silent.
      const message = err instanceof Error ? err.message : String(err);
      const logsUrl = buildCloudLoggingUrl(ctx.runId);
      // Discord embed field values are capped at 1024 chars; truncate
      // the message defensively so a giant stack frame doesn't trip the
      // delivery (the full thing is in Cloud Logging).
      const truncatedMessage =
        message.length > 1000 ? `${message.slice(0, 997)}...` : message;
      const fields: DiscordAlertField[] = [
        { name: "Error", value: truncatedMessage, inline: false },
        { name: "Run ID", value: ctx.runId, inline: true },
        { name: "Limit", value: String(input.limit), inline: true },
      ];
      if (logsUrl) {
        fields.push({ name: "Logs", value: logsUrl, inline: false });
      }
      await logAndReport({
        logger: ctx.logger,
        level: "error",
        message: "settlements.run-batch.crashed",
        extra: {
          runId: ctx.runId,
          limit: input.limit,
          error: message,
        },
        alert: {
          send: fireDiscordAlert,
          payload: {
            title: "Settlement Batch CRASHED",
            colour: "error",
            description:
              "Batch failed before completion. Manual investigation required.",
            fields,
          },
        },
      });
      throw err;
    }

    const summary = {
      payoutId: result.payoutId,
      payeesConsidered: result.payeesConsidered,
      itemsCreated: result.itemsCreated,
      itemsTransferred: result.itemsTransferred,
      itemsFailed: result.itemsFailed,
      itemsSkippedBelowMinimum: result.itemsSkippedBelowMinimum,
      itemsSkippedIneligible: result.itemsSkippedIneligible,
      itemsSkippedPayableDropped: result.itemsSkippedPayableDropped,
      itemsSkippedClaimLost: result.itemsSkippedClaimLost,
      payeesDeferredByLimit: result.payeesDeferredByLimit,
      itemsLedgerHealed: result.itemsLedgerHealed,
      itemsHeldForSuspension: result.itemsHeldForSuspension,
      itemsFullyWithheld: result.itemsFullyWithheld,
      totalTransferredCents: result.totalTransferredCents,
      totalPayableClaimedCents: result.totalPayableClaimedCents,
      reserveHeldCents: result.reserveHeldCents,
      itemsWithReserveHeld: result.itemsWithReserveHeld,
      reserveReleasedCents: result.reserveReleasedCents,
      itemsWithReserveReleased: result.itemsWithReserveReleased,
      connectFeeCents: result.connectFeeCents,
      itemsWithConnectAccountFee: result.itemsWithConnectAccountFee,
    };

    if (result.itemsTransferred > 0 || result.itemsFailed > 0) {
      const dollars = (result.totalTransferredCents / 100).toFixed(2);
      const colour = result.itemsFailed > 0 ? "warning" : "info";
      // Only surface the per-reason skip breakdown when there's something to
      // report — clean runs shouldn't carry a noisy "0 · 0 · 0" field.
      const hasSkips =
        result.itemsSkippedBelowMinimum > 0 ||
        result.itemsSkippedIneligible > 0 ||
        result.itemsSkippedPayableDropped > 0 ||
        result.itemsSkippedClaimLost > 0 ||
        result.itemsHeldForSuspension > 0;
      const skippedField: DiscordAlertField[] = hasSkips
        ? [
            {
              name: "Skipped",
              value: `${result.itemsSkippedBelowMinimum} below-min · ${result.itemsSkippedIneligible} ineligible · ${result.itemsSkippedPayableDropped} payable-dropped · ${result.itemsSkippedClaimLost} claim-lost · ${result.itemsHeldForSuspension} suspended`,
              inline: true,
            },
          ]
        : [];
      // Backlog pressure. A payee deferred tonight has older money tomorrow
      // and outranks tonight's winners, so a one-off number is the queue
      // working; a persistently non-zero one means the cap is too low and
      // payouts are systematically late.
      const deferredField: DiscordAlertField[] =
        result.payeesDeferredByLimit > 0
          ? [
              {
                name: "Deferred by limit",
                value: `${result.payeesDeferredByLimit} payee(s) — raise the batch limit if this persists`,
                inline: true,
              },
            ]
          : [];
      // A crashed previous run left money that had LEFT unrecorded on the
      // ledger; this run replayed it from the stored plan. Rare by
      // construction, and worth a look every single time.
      const healedField: DiscordAlertField[] =
        result.itemsLedgerHealed > 0
          ? [
              {
                name: "Ledger healed",
                value: `${result.itemsLedgerHealed} item(s) from a previous crashed run`,
                inline: true,
              },
            ]
          : [];
      // Stripe's $2 monthly active-account fee, withheld from membership-only
      // payouts. Only surfaced when something was actually withheld — a
      // permanent "$0.00 withheld" line would just be noise on the 99% of runs
      // that are pure ticketing.
      const connectFeeField: DiscordAlertField[] =
        result.connectFeeCents > 0
          ? [
              {
                name: "Connect fee withheld",
                value: `$${(result.connectFeeCents / 100).toFixed(2)} · ${result.itemsWithConnectAccountFee} item(s)`,
                inline: true,
              },
            ]
          : [];
      // Items whose entire net was consumed by withholding complete WITHOUT a
      // Stripe transfer — those are the runs a venue is most likely to ask
      // about, so call them out when they happen.
      const fullyWithheldField: DiscordAlertField[] =
        result.itemsFullyWithheld > 0
          ? [
              {
                name: "Fully withheld",
                value: `${result.itemsFullyWithheld} item(s) — no Stripe transfer`,
                inline: true,
              },
            ]
          : [];
      // Rolling reserve on membership payouts. Same posture as the debt
      // field: only surfaced when the batch actually deferred or returned
      // reserve money — pure-ticketing runs stay clean.
      const reserveField: DiscordAlertField[] =
        result.reserveHeldCents > 0 || result.reserveReleasedCents > 0
          ? [
              {
                name: "Reserve",
                value: `held $${(result.reserveHeldCents / 100).toFixed(2)} · ${result.itemsWithReserveHeld} item(s) · released $${(result.reserveReleasedCents / 100).toFixed(2)} · ${result.itemsWithReserveReleased} item(s)`,
                inline: true,
              },
            ]
          : [];
      await logAndReport({
        logger: ctx.logger,
        level: result.itemsFailed > 0 ? "warn" : "info",
        message: "settlements.run-batch.completed",
        extra: summary,
        alert: {
          send: fireDiscordAlert,
          payload: {
            title: "Settlement Batch Processed",
            colour,
            fields: [
              {
                name: "Payout ID",
                value: result.payoutId ?? "none",
                inline: false,
              },
              {
                name: "Transferred",
                value: String(result.itemsTransferred),
                inline: true,
              },
              {
                name: "Failed",
                value: String(result.itemsFailed),
                inline: true,
              },
              {
                name: "Payees",
                value: `${result.itemsTransferred}/${result.payeesConsidered} paid`,
                inline: true,
              },
              ...skippedField,
              ...deferredField,
              ...healedField,
              ...connectFeeField,
              ...fullyWithheldField,
              ...reserveField,
              { name: "Total", value: `$${dollars}`, inline: true },
            ],
          },
        },
      });
    } else {
      ctx.logger.info("settlements.run-batch.completed", summary);
    }

    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// settlements.verify-ledger - Read-only ledger invariant sweep (daily cron,
// a few hours AFTER the payout batch, + manually triggerable)
// ─────────────────────────────────────────────────────────────────────────────
export const verifyLedger = defineScheduledTask({
  name: "settlements.verify-ledger",
  description:
    "Read-only ledger reconciliation sweep (spec 2026-08-10 §9). Recomputes the PayeeLedgerBalance rollups from entries, checks per-(order,payee) refund conservation, and flags finalized orders missing their SETTLEMENT_CREDITs. Reports violations (Sentry + Discord); never repairs.",
  input: z.object({
    graceMinutes: z.number().int().min(0).max(1440).default(30),
  }),
  schedule: getSchedule("settlements.verify-ledger"),
  handler: async ({ input, ctx }) => {
    ctx.logger.info("settlements.verify-ledger.start", {
      graceMinutes: input.graceMinutes,
    });

    // The use case never throws on a VIOLATION (it reports and keeps
    // sweeping); a throw here is operational (DB down) and rides the job
    // error-boundary like any other job crash.
    const result = await verifyLedgerInvariants(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // Grouped per-invariant Sentry reports (one per violated class per
        // run). ctx.reportError is the safeReporter-wrapped
        // Sentry.captureException from the jobs composition root.
        reportError: ctx.reportError,
      },
      { graceMinutes: input.graceMinutes },
    );

    const totalViolations =
      result.rollupDriftCount +
      result.conservationViolationCount +
      result.completenessGapCount;

    const summary = {
      rollupDriftCount: result.rollupDriftCount,
      conservationViolationCount: result.conservationViolationCount,
      completenessGapCount: result.completenessGapCount,
    };

    if (totalViolations > 0) {
      const logsUrl = buildCloudLoggingUrl(ctx.runId);
      const fields: DiscordAlertField[] = [
        {
          name: "Rollup drift",
          value: String(result.rollupDriftCount),
          inline: true,
        },
        {
          name: "Conservation",
          value: String(result.conservationViolationCount),
          inline: true,
        },
        {
          name: "Completeness",
          value: String(result.completenessGapCount),
          inline: true,
        },
        { name: "Run ID", value: ctx.runId, inline: true },
      ];
      if (logsUrl) {
        fields.push({ name: "Logs", value: logsUrl, inline: false });
      }
      // The per-invariant Sentry reports (with samples) fired inside the use
      // case; this is the human-facing rollup. logAndReport's Discord send is
      // env-gated inside fireDiscordAlert and never fails the job.
      await logAndReport({
        logger: ctx.logger,
        level: "error",
        message: "settlements.verify-ledger.violations",
        extra: { runId: ctx.runId, ...summary, samples: result.samples },
        alert: {
          send: fireDiscordAlert,
          payload: {
            title: "Ledger invariant violation",
            colour: "error",
            description:
              "The ledger reconciliation sweep found invariant violations. " +
              "Read-only job — nothing was repaired. Investigate via Sentry " +
              "(ledger_invariant_violation) before the next payout batch.",
            fields,
          },
        },
      });
    } else {
      ctx.logger.info("settlements.verify-ledger.clean", summary);
    }

    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Export all settlement jobs
// ─────────────────────────────────────────────────────────────────────────────
export const settlementJobs = [runBatch, verifyLedger];
