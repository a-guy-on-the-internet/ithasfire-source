/**
 * Attendee Review Jobs
 *
 * Weekly recompute of the ReviewAggregate snapshots served publicly on event,
 * venue, organizer/owner and series surfaces (attendee-reviews FR-004).
 */
import { z } from "zod";
import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { recomputeReviewAggregates } from "@th/core/use-cases/attendee-reviews/recompute-review-aggregates";
import {
  sendAttendeeReviewDigests,
  sendAttendeeReviewDigestsInputSchema,
} from "@th/core/use-cases/post-event-prompts";

// ─────────────────────────────────────────────────────────────────────────────
// attendee-reviews.recompute-aggregates - Weekly public snapshot rebuild
// ─────────────────────────────────────────────────────────────────────────────
// Deliberately weekly: the delay is the anonymity mechanism (attendee-reviews
// FR-003/FR-004) — a fresh attendee review changes nothing public until the
// next recompute, so an organizer/venue can't correlate a public shift with a
// specific recent attendee. Full recompute across all four subject types,
// idempotent, per-subject failure isolation with guarded reportError.
export const recomputeReviewAggregatesJob = defineScheduledTask({
  name: "attendee-reviews.recompute-aggregates",
  description:
    "Weekly rebuild of the anonymized attendee-review aggregate snapshots (threshold-gated, bucketed) served on event, venue, organizer and series surfaces.",
  input: z.object({
    batchSize: z.number().int().min(1).max(500).optional(),
  }),
  schedule: getSchedule("attendee-reviews.recompute-aggregates"),
  handler: async ({ input, ctx }) => {
    const result = await recomputeReviewAggregates(
      {
        repos: {
          attendeeReviews: ctx.repos.attendeeReviews,
          reviewAggregates: ctx.repos.reviewAggregates,
        },
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      input,
    );
    ctx.logger.info("attendee-reviews.recompute-aggregates.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// attendee-review-digests.send - Weekly attendee review-prompt EMAIL digest
// ─────────────────────────────────────────────────────────────────────────────
// The EMAIL half of the attendee review prompt (attendee-prompt-delivery-
// hygiene FR-002/004/005/007). In-app still fires per-show via
// post-event-prompts.dispatch; this weekly run sends ONE digest per human
// listing their un-reviewed, still-in-window shows, with a one-click
// unsubscribe + 3-strike soft suppression. Idempotent per (human, week) via
// NotificationDigestLog. Skips cleanly when the mailer or the unsubscribe
// secret is unconfigured — never ships an unsubscribe-less marketing email.
export const sendAttendeeReviewDigestsJob = defineScheduledTask({
  name: "attendee-review-digests.send",
  description:
    "Weekly attendee review-prompt email digest: one email per human listing " +
    "their un-reviewed, still-in-window attended shows, with a one-click " +
    "unsubscribe and 3-strike soft auto-suppression. In-app prompts are " +
    "unaffected. Idempotent per (human, week).",
  input: sendAttendeeReviewDigestsInputSchema,
  schedule: getSchedule("attendee-review-digests.send"),
  handler: async ({ input, ctx }) => {
    if (!ctx.mailer) {
      ctx.logger.warn(
        "attendee-review-digests.send.skipped_mailer_unconfigured",
      );
      return { skipped: "mailer_unconfigured" as const };
    }
    if (!ctx.unsubscribeSecret) {
      ctx.logger.warn(
        "attendee-review-digests.send.skipped_unsubscribe_secret_unconfigured",
      );
      return { skipped: "unsubscribe_secret_unconfigured" as const };
    }

    const result = await sendAttendeeReviewDigests(
      {
        repos: { notificationDigests: ctx.repos.notificationDigests },
        mailer: ctx.mailer,
        clock: ctx.clock,
        appBaseUrl: ctx.appBaseUrl,
        unsubscribeSecret: ctx.unsubscribeSecret,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      input,
    );
    ctx.logger.info("attendee-review-digests.send.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Export all attendee-review jobs
// ─────────────────────────────────────────────────────────────────────────────
export const attendeeReviewJobs = [
  recomputeReviewAggregatesJob,
  sendAttendeeReviewDigestsJob,
];
