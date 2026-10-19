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
import { reportNotConfiguredOnce } from "../lib/report-not-configured";
import { runPayoutBatch } from "@th/core/use-cases/settlements/run-batch";
import { verifyLedgerInvariants } from "@th/core/use-cases/settlements/verify-ledger-invariants";
import type { CheckPlatformSolvencyOutput } from "@th/core/use-cases/settlements/check-platform-solvency";
import { notifyPayoutCompleted } from "@th/core/use-cases/settlements/notify-payout-completed";
import { backfillProcessorFees } from "@th/core/use-cases/settlements/backfill-processor-fees";
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
          reportError: ctx.reportError,
        },
        payload,
      );
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
          // The payouts link is resolved PER PAYEE inside the notifier (an org
          // lands on its own /admin/<slug>/payouts; a human gets no link).
          // The first real payout shipped one global `/sell/payouts` URL from
          // here — the ticket-RESALE seller page — to an organization.
          notifyPayee: (args) =>
            notifyPayoutCompleted(
              {
                repos: ctx.repos,
                notify,
                logger: ctx.logger,
                // Without a Stripe key `ctx.payments` is a stub that THROWS
                // on every call; handing it over would report a Sentry error
                // per item for a field that was always going to be null.
                payments: ctx.paymentsConfigured ? ctx.payments : undefined,
                clock: ctx.clock,
                // The notifier's enrichment reads (org, orders, events,
                // balance, Connect schedule) are swallowed into a degraded
                // email; each swallow is reported here so it is not silent.
                reportError: Sentry.captureException,
              },
              { ...args, appBaseUrl: ctx.appBaseUrl ?? null },
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
      itemsFailedInsufficientPlatformBalance:
        result.itemsFailedInsufficientPlatformBalance,
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
      // The PLATFORM ran out of available balance mid-batch. Called out
      // separately from "Failed" because the remedy is entirely ours — top up
      // or slow our own Stripe payout schedule — and none of these payees did
      // anything wrong. Their money is untouched and re-plans on the next run.
      const floatField: DiscordAlertField[] =
        result.itemsFailedInsufficientPlatformBalance > 0
          ? [
              {
                name: "Platform balance short",
                value: `${result.itemsFailedInsufficientPlatformBalance} item(s) unfunded — top up; no payee is at fault`,
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
              ...floatField,
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
/**
 * One Discord field value summarising platform solvency.
 *
 * Only called when something is worth saying, so it optimises for "what is
 * wrong" rather than a full dump. Pure string building and deliberately
 * total: it runs INSIDE the alert path that reports the very violation it
 * describes, so throwing here would suppress the alert.
 *
 * `null` is NOT a clean bill of health — it means the check never ran (no
 * processor wired, or it faulted and already reported). Say that, rather than
 * printing zeros a reader would take for "nothing owed".
 */
function describeSolvency(
  solvency: CheckPlatformSolvencyOutput | null,
): string {
  if (!solvency) {
    return "Not measured — no processor wired, or the check faulted (already reported separately). This is NOT a clean bill of health.";
  }

  // `null` cents means the read failed. It must never render as "$0.00": the
  // whole point of the nullable fields is that an unknown balance is not a
  // zero balance.
  const money = (cents: number | null) =>
    cents === null ? "unknown" : `$${(cents / 100).toFixed(2)}`;

  const lines: string[] = [];

  // Degraded reads first — every figure below is suspect when either is set.
  if (solvency.ledgerUnavailable) {
    lines.push("⚠ Ledger read FAILED — liability figures are missing, not zero.");
  }
  if (solvency.balanceUnavailable) {
    lines.push("⚠ Stripe balance read FAILED — no solvency verdict drawn.");
  }

  for (const row of solvency.currencies) {
    const flags = [
      row.headroomBelowFloor ? "BELOW FLOOR" : null,
      row.tonightShortfall ? "TONIGHT SHORT" : null,
    ].filter((flag): flag is string => flag !== null);

    lines.push(
      `${row.currency.toUpperCase()}${flags.length > 0 ? ` — ${flags.join(" + ")}` : ""}: ` +
        `available ${money(row.stripeAvailableCents)} · ` +
        `liability ${money(row.liabilityCents)} · ` +
        `headroom ${money(row.headroomCents)} (floor ${money(row.headroomFloorCents)}) · ` +
        `tonight needs ${money(row.maturedPayableCents)}`,
    );
  }

  if (lines.length === 0) {
    return "Solvency checked; no per-currency detail reported.";
  }

  // Discord rejects the WHOLE embed when one field value exceeds 1024 chars,
  // so an account with many currencies must not silence the alert this field
  // is attached to. Trim by whole lines and say what was dropped.
  const LIMIT = 1024;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const suffixBudget = 48; // room for the "…and N more" line
    if (used + line.length + 1 > LIMIT - suffixBudget) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  if (dropped > 0) {
    kept.push(`…and ${dropped} more currency line(s) — see logs.`);
  }
  return kept.join("\n");
}

export const verifyLedger = defineScheduledTask({
  name: "settlements.verify-ledger",
  description:
    "Read-only ledger reconciliation sweep (spec 2026-08-10 §9). Recomputes the PayeeLedgerBalance rollups from entries, checks per-(order,payee) refund conservation, flags finalized orders missing their SETTLEMENT_CREDITs, and compares the PLATFORM Stripe balance against total liability. Reports violations (Sentry + Discord); never repairs.",
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
        // READ-ONLY use of the processor: the solvency leg calls
        // `getPlatformBalance()` and nothing else. A Stripe failure is
        // reported and swallowed INSIDE the use case — the three ledger
        // invariants must survive a Stripe outage.
        payments: ctx.payments,
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
      result.completenessGapCount +
      result.cancelledEventCashDebitCount +
      result.cancelledEventOpenDoorCardSaleCount;

    // Solvency is REPORTED, never gating: a breach here means "look now",
    // not "stop paying". `solvency: null` means NOT MEASURED (no processor
    // wired, or the check faulted and reported) — never "healthy".
    const solvency = result.solvency;
    const solvencyBreaches =
      solvency?.currencies.filter(
        (row) => row.headroomBelowFloor || row.tonightShortfall,
      ) ?? [];
    const solvencyAlarm =
      solvencyBreaches.length > 0 ||
      solvency?.balanceUnavailable === true ||
      solvency?.ledgerUnavailable === true;

    const summary = {
      rollupDriftCount: result.rollupDriftCount,
      conservationViolationCount: result.conservationViolationCount,
      completenessGapCount: result.completenessGapCount,
      cancelledEventCashDebitCount: result.cancelledEventCashDebitCount,
      cancelledEventOpenDoorCardSaleCount:
        result.cancelledEventOpenDoorCardSaleCount,
      solvency: solvency
        ? {
            balanceUnavailable: solvency.balanceUnavailable,
            ledgerUnavailable: solvency.ledgerUnavailable,
            currencies: solvency.currencies,
          }
        : null,
    };

    // One Discord field summarising every currency, only when there is
    // something to say — a clean run must not carry a permanent noise line.
    // Never allowed to fail the job: this is string building, and the send
    // itself is env-gated inside fireDiscordAlert.
    const solvencyField: DiscordAlertField[] = solvencyAlarm
      ? [
          {
            name: "Platform solvency",
            value: describeSolvency(solvency),
            inline: false,
          },
        ]
      : [];

    if (totalViolations > 0 || solvencyAlarm) {
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
        {
          name: "Cancelled-event cash debits",
          value: String(result.cancelledEventCashDebitCount),
          inline: true,
        },
        {
          // Report-only: a paid door card sale on a cancelled event that was
          // never refunded, or one the door sweep could not void. A person
          // refunds it; nothing does it automatically.
          name: "Cancelled-event door card sales",
          value: String(result.cancelledEventOpenDoorCardSaleCount),
          inline: true,
        },
        ...solvencyField,
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
            title:
              totalViolations > 0
                ? "Ledger invariant violation"
                : "Platform solvency warning",
            colour: "error",
            description:
              totalViolations > 0
                ? "The ledger reconciliation sweep found invariant violations. " +
                  "Read-only job — nothing was repaired. Investigate via Sentry " +
                  "(ledger_invariant_violation) before the next payout batch."
                : "The platform Stripe balance no longer comfortably covers what " +
                  "we owe. Read-only job — nothing was repaired or held. " +
                  "Investigate via Sentry (platform_solvency_headroom_low / " +
                  "platform_tonight_shortfall).",
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
// settlements.backfill-processor-fees - Read each charge's REAL Stripe fee and
// stamp it on the order (hourly cron + manually triggerable)
// ─────────────────────────────────────────────────────────────────────────────
export const backfillProcessorFeesJob = defineScheduledTask({
  name: "settlements.backfill-processor-fees",
  description:
    "Reads what Stripe actually charged to process each order, from the charge's balance transaction, and stamps Order.processorFeeCents — the only source of the processor-cost input to platform revenue; a rate-card estimate is a different number wearing its name. A failed read leaves the column NULL ('not attributed'), backs the row off for 6h and parks it after 24 failures; Sentry hears about a row on its first failure and when it is parked, never on the retries between. Hourly.",
  input: z.object({
    limit: z.number().int().min(1).max(500).default(100),
  }),
  schedule: getSchedule("settlements.backfill-processor-fees"),
  handler: async ({ input, ctx }) => {
    // `ctx.payments` is NEVER null — without a Stripe key it is a stub that
    // THROWS on every call (see container.ts). Branching on `paymentsConfigured`
    // is therefore the only correct guard; branching on `payments` being falsy
    // would sail straight into the stub and report every order as failed.
    if (!ctx.paymentsConfigured) {
      ctx.logger.info("settlements.backfill-processor-fees.skipped", {
        reason: "payments_not_configured",
      });
      // An info line does not reach Sentry (CLAUDE.md), and app.ts answers
      // 200 for this return: without the report a cleared Stripe key leaves
      // every order's processor fee unattributed, silently. Once per process.
      reportNotConfiguredOnce(ctx, {
        job: "settlements.backfill-processor-fees",
        reason: "payments_not_configured",
      });
      return {
        considered: 0,
        stamped: 0,
        alreadyStamped: 0,
        failed: 0,
        parked: 0,
        stampedCentsByCurrency: [],
        oldestUnstampedAt: null,
        skipped: "payments_not_configured" as const,
      };
    }

    const result = await backfillProcessorFees(
      {
        repos: ctx.repos,
        payments: ctx.payments,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      { limit: input.limit },
    );

    ctx.logger.info("settlements.backfill-processor-fees.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Export all settlement jobs
// ─────────────────────────────────────────────────────────────────────────────
export const settlementJobs = [
  runBatch,
  verifyLedger,
  backfillProcessorFeesJob,
];
