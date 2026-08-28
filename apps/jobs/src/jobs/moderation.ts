/**
 * Image Moderation Jobs
 *
 * - moderation.drain-image-moderations: drains the image-moderation outbox
 *   (the ImageModerationRecord table is its own outbox — a PENDING row is a
 *   to-do). Claims due rows and runs moderate-image for each, out of band from
 *   the upload request, with exponential backoff on transient provider failures
 *   and fail-closed dead-lettering (FLAGGED + degraded) on exhaustion. A fresh
 *   FLAGGED verdict fires the uploader HOLD notification.
 *
 * - moderation.report-queue-health: hourly count of the four ways this queue
 *   goes wrong, raising a Discord alert only when one of them is non-zero.
 *
 * - moderation.requeue-degraded: revives rows the SCANNER failed on (not rows
 *   the scanner judged), so a provider outage longer than the drain's ~3-day
 *   retry window stops leaving a permanent manual backlog.
 *
 * Structure mirrors storage.drain-pending-deletions (the drain template) and
 * community.dispatch-rsvp-confirmations (the `notify` closure).
 */
import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { logAndAlert } from "@th/adapters/infra/discord-alerts";

import { buildCloudLoggingUrl, fireDiscordAlert } from "../lib/discord-alerts";
import {
  drainImageModerations,
  drainImageModerationsInputSchema,
  moderateImage,
  requeueDegradedModerations,
  requeueDegradedModerationsInputSchema,
  reportModerationQueueHealth,
  reportModerationQueueHealthInputSchema,
} from "@th/core/use-cases/moderation";
import { notify as notifyUseCase } from "@th/core/use-cases/comms/notify";

// ─────────────────────────────────────────────────────────────────────────────
// moderation.drain-image-moderations
// Drains the image-moderation outbox with per-row retry + dead-lettering.
// ─────────────────────────────────────────────────────────────────────────────

export const drainImageModerationsJob = defineScheduledTask({
  name: "moderation.drain-image-moderations",
  description:
    "Drain the image-moderation outbox (PENDING ImageModerationRecord rows) and " +
    "run each image through the moderation provider (Azure AI Content Safety, " +
    "or the auto-approving stub when unconfigured), writing the verdict back " +
    "onto the record. Retries transient provider failures with exponential " +
    "backoff and dead-letters exhausted rows to FLAGGED+degraded so they " +
    "surface in the human review queue rather than staying hidden. A fresh " +
    "FLAGGED verdict fires the uploader HOLD notification.",
  input: drainImageModerationsInputSchema,
  schedule: getSchedule("moderation.drain-image-moderations"),
  handler: async ({ input, ctx }) => {
    // moderate-image bound to the provider + storage deps, injected as a
    // closure so the drain stays decoupled from the ModerationPort /
    // FileStoragePort (mirrors how community.dispatch injects `notify`).
    const moderateImageFn = (storageKey: string) =>
      moderateImage(
        {
          repos: { imageModerationRecords: ctx.repos.imageModerationRecords },
          fileStorage: ctx.fileStorage,
          moderation: ctx.moderation,
          config: {
            reviewThreshold: ctx.imageModerationReviewThreshold,
            categoryThresholds: ctx.imageModerationCategoryThresholds,
          },
          logger: ctx.logger,
          reportError: ctx.reportError,
        },
        { storageKey },
      );

    // Best-effort notifier, mirroring community.dispatch-rsvp-confirmations:
    // `notify` persists the in-app notification and dispatches email/push via
    // the ports bound in the jobs container (null-safe when unconfigured).
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

    const result = await drainImageModerations(
      {
        repos: { imageModerationRecords: ctx.repos.imageModerationRecords },
        moderateImage: moderateImageFn,
        notify,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError,
        appBaseUrl: ctx.appBaseUrl,
      },
      input,
    );

    ctx.logger.info("moderation.drain-image-moderations.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// moderation.requeue-degraded
// Revives dead-lettered DEGRADED rows so a long provider outage self-heals.
// ─────────────────────────────────────────────────────────────────────────────

export const requeueDegradedModerationsJob = defineScheduledTask({
  name: "moderation.requeue-degraded",
  description:
    "Send dead-lettered DEGRADED image-moderation rows back to PENDING so the " +
    "drain re-scores them once the provider recovers. Only rows the SCANNER " +
    "failed on are eligible — a real content verdict, or any row a human has " +
    "decided, is never revived. Bounded by a per-row requeue cap so an object " +
    "that can never be scanned (deleted event, GC'd media) stops cycling and " +
    "stays FLAGGED for a human.",
  input: requeueDegradedModerationsInputSchema,
  schedule: getSchedule("moderation.requeue-degraded"),
  handler: async ({ input, ctx }) => {
    const result = await requeueDegradedModerations(
      {
        repos: { imageModerationRecords: ctx.repos.imageModerationRecords },
        clock: ctx.clock,
        logger: ctx.logger,
      },
      input,
    );

    ctx.logger.info("moderation.requeue-degraded.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// moderation.report-queue-health
// The alert a human actually acts on. Sentry had the August 2026 provider 401s
// for ~2 weeks and nobody noticed, because an adapter error inside a jobs
// process reads like noise. A count that should be zero and isn't does not.
// ─────────────────────────────────────────────────────────────────────────────

export const reportModerationQueueHealthJob = defineScheduledTask({
  name: "moderation.report-queue-health",
  description:
    "Hourly health read over the image-moderation queue: images overdue for " +
    "draining (the drain is dead), images that failed to scan recently (the " +
    "provider is failing), images that exhausted the requeue cap (unscannable), " +
    "and flagged images awaiting human review too long (nobody is chasing them, " +
    "because uploaders are not emailed about holds). Raises a Discord alert ONLY " +
    "when at least one count is non-zero — no heartbeat, so an alert always means " +
    "something.",
  input: reportModerationQueueHealthInputSchema,
  schedule: getSchedule("moderation.report-queue-health"),
  handler: async ({ input, ctx }) => {
    const result = await reportModerationQueueHealth(
      {
        repos: { imageModerationRecords: ctx.repos.imageModerationRecords },
        clock: ctx.clock,
        logger: ctx.logger,
      },
      input,
    );

    if (result.unhealthy) {
      const logsUrl = buildCloudLoggingUrl(ctx.runId);
      const fields = [
        {
          name: "Overdue for scan",
          value: String(result.counts.pendingOverdue),
          inline: true,
        },
        {
          name: "Failed to scan",
          value: String(result.counts.degradedRecent),
          inline: true,
        },
        {
          name: "Unscannable",
          value: String(result.counts.degradedExhausted),
          inline: true,
        },
        {
          name: "Awaiting review",
          value: String(result.counts.awaitingReview),
          inline: true,
        },
      ];
      if (logsUrl) {
        fields.push({ name: "Logs", value: logsUrl, inline: false });
      }

      // logAndAlert (not logAndReport): this is an operational signal, not a
      // thrown error, and the underlying sender is env-gated + swallows its own
      // failures — an unreachable Discord must never fail a health check.
      await logAndAlert({
        logger: ctx.logger,
        level: "warn",
        message: "moderation.report-queue-health.unhealthy",
        extra: { runId: ctx.runId, ...result.counts },
        alert: {
          send: fireDiscordAlert,
          payload: {
            title: "Image moderation queue needs attention",
            colour: "warning",
            description: result.problems.join("\n\n"),
            fields,
          },
        },
      });
    }

    ctx.logger.info("moderation.report-queue-health.completed", result.counts);
    return result;
  },
});

export const moderationJobs = [
  drainImageModerationsJob,
  requeueDegradedModerationsJob,
  reportModerationQueueHealthJob,
];
