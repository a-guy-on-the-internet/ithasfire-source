/**
 * Dispute Jobs
 *
 * Ops are told about a chargeback ONCE, when it opens (Discord, with the
 * evidence due date) — and never again. The desk shows the deadline, but
 * nobody is paged as it closes in, and a dispute whose webhook-time evidence
 * assembly failed sits with no draft at all. This file's daily chase closes
 * both gaps: sweep, self-heal, one alert.
 */
import { z } from "zod";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import {
  sweepDisputeEvidenceDeadlines,
  type DisputeEvidenceDeadlineAlert,
} from "@th/core/use-cases/disputes/evidence/sweep-dispute-evidence-deadlines";
import { formatCents } from "@th/core/lib/currency-utils";
import { logAndReport } from "@th/adapters/infra/discord-alerts";
import type { DiscordAlertField } from "@th/adapters/infra/discord-alerts";
import { buildCloudLoggingUrl, fireDiscordAlert } from "../lib/discord-alerts";

/** Discord embed descriptions cap at 4096 chars; 15 lines stays well under. */
export const DISPUTE_CHASE_MAX_ALERT_LINES = 15;
const EVENT_TITLE_MAX_CHARS = 48;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * "overdue 2d" / "due in 5h" / "no due date" — coarse on purpose: the desk
 * has the exact timestamp, the alert only needs to rank urgency at a glance.
 */
export function formatDueRelative(dueBy: Date | null, now: Date): string {
  if (!dueBy) return "no due date";
  const diff = dueBy.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const unit =
    abs >= DAY_MS
      ? `${Math.floor(abs / DAY_MS)}d`
      : abs >= HOUR_MS
        ? `${Math.floor(abs / HOUR_MS)}h`
        : "<1h";
  return diff < 0 ? `overdue ${unit}` : `due in ${unit}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatDisputeAlertLine(
  alert: DisputeEvidenceDeadlineAlert,
  now: Date,
): string {
  const parts = [
    `\`${formatDueRelative(alert.dueBy, now)}\``,
    formatCents(alert.amountCents, alert.currency),
    truncate(alert.eventTitle ?? "(no event)", EVENT_TITLE_MAX_CHARS),
    alert.owner ?? "(unknown owner)",
    `evidence: ${alert.evidenceStatus ?? "none"}`,
    alert.deskUrl ? `[desk](${alert.deskUrl})` : alert.disputeId,
  ];
  return parts.join(" · ");
}

// ─────────────────────────────────────────────────────────────────────────────
// disputes.chase-evidence-deadlines - Daily chase of evidence deadlines
// (14:00 CT cron + manually triggerable from the platform jobs page)
// ─────────────────────────────────────────────────────────────────────────────
export const chaseEvidenceDeadlines = defineScheduledTask({
  name: "disputes.chase-evidence-deadlines",
  description:
    "Daily chase of chargeback evidence deadlines: sweeps OPEN disputes near or past their evidence deadline, with no deadline, with no evidence package, or whose last submit failed; re-runs the assembler for missing packages; raises ONE Discord alert (error colour when anything is overdue) linking each dispute to the platform desk. Silent when nothing needs attention.",
  input: z.object({
    dueWithinDays: z.number().int().min(1).max(14).default(3),
  }),
  schedule: getSchedule("disputes.chase-evidence-deadlines"),
  handler: async ({ input, ctx }) => {
    const now = ctx.clock.now();
    ctx.logger.info("disputes.chase-evidence-deadlines.start", {
      dueWithinDays: input.dueWithinDays,
    });

    // The use case never throws on a per-dispute heal failure (it reports and
    // keeps sweeping); a throw here is operational (DB down) and rides the
    // job error-boundary like any other job crash.
    const result = await sweepDisputeEvidenceDeadlines(
      {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        publicAppUrl: ctx.appBaseUrl,
        // safeReporter-wrapped Sentry.captureException from the composition
        // root — the heal swallow branch and the assembler's per-source
        // degrades report through it.
        reportError: ctx.reportError,
      },
      { now, dueWithinDays: input.dueWithinDays },
    );

    const counts = {
      overdue: 0,
      due_soon: 0,
      no_due_date: 0,
      submit_failed: 0,
      unassembled: 0,
    };
    for (const alert of result.alerts) counts[alert.bucket] += 1;

    const summary = {
      runId: ctx.runId,
      dueWithinDays: input.dueWithinDays,
      scanned: result.scanned,
      healed: result.healed,
      healFailed: result.healFailed,
      alerts: result.alerts.length,
      ...counts,
    };

    if (result.alerts.length === 0) {
      ctx.logger.info("disputes.chase-evidence-deadlines.clean", summary);
      return result;
    }

    const shown = result.alerts.slice(0, DISPUTE_CHASE_MAX_ALERT_LINES);
    const hidden = result.alerts.length - shown.length;
    const lines = shown.map((alert) => formatDisputeAlertLine(alert, now));
    // "+N more" counts the rest of the capped 200-row feed the repo returned,
    // not the whole table — a backlog past 200 reads as "+185 more".
    if (hidden > 0) lines.push(`+${hidden} more`);

    const logsUrl = buildCloudLoggingUrl(ctx.runId);
    const fields: DiscordAlertField[] = [
      { name: "Overdue", value: String(counts.overdue), inline: true },
      { name: "Due soon", value: String(counts.due_soon), inline: true },
      { name: "No due date", value: String(counts.no_due_date), inline: true },
      {
        name: "Submit failed",
        value: String(counts.submit_failed),
        inline: true,
      },
      { name: "No package", value: String(counts.unassembled), inline: true },
      {
        name: "Healed",
        value: `${result.healed} assembled · ${result.healFailed} failed`,
        inline: true,
      },
      { name: "Run ID", value: ctx.runId, inline: true },
    ];
    if (logsUrl) {
      fields.push({ name: "Logs", value: logsUrl, inline: false });
    }

    const overdueIds = result.alerts
      .filter((a) => a.bucket === "overdue")
      .map((a) => a.disputeId);
    const anyOverdue = overdueIds.length > 0;

    // ONE alert per run. Overdue is the only bucket where money is already
    // lost by default (Stripe auto-closes an unanswered dispute), so it is
    // the only one that escalates to error colour + a Sentry event; the rest
    // are a warning that a human should look today. logAndReport's Discord
    // send is env-gated and swallows its own delivery failures (and guards
    // the captureException call), so a dead webhook never fails the sweep —
    // the heal already happened by this point.
    await logAndReport({
      logger: ctx.logger,
      level: anyOverdue ? "error" : "warn",
      message: "disputes.chase-evidence-deadlines.attention",
      extra: {
        ...summary,
        overdueDisputeIds: overdueIds,
        disputeIds: result.alerts.map((a) => a.disputeId),
      },
      ...(anyOverdue
        ? {
            report: {
              captureException: ctx.reportError,
              error: new Error("dispute_evidence_overdue"),
              context: {
                tags: { job: "disputes.chase-evidence-deadlines" },
                extra: { runId: ctx.runId, overdueDisputeIds: overdueIds },
              },
            },
          }
        : {}),
      alert: {
        send: fireDiscordAlert,
        payload: {
          title: anyOverdue
            ? "Dispute evidence OVERDUE"
            : "Dispute evidence deadlines need attention",
          colour: anyOverdue ? "error" : "warning",
          description: lines.join("\n"),
          fields,
        },
      },
    });

    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Export all dispute jobs
// ─────────────────────────────────────────────────────────────────────────────
export const disputeJobs = [chaseEvidenceDeadlines];
