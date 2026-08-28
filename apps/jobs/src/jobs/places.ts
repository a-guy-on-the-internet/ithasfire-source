/**
 * Place Jobs
 *
 * Background work related to place lifecycle:
 * - Cleaning up stale verification documents from R2
 * - Recalculating aggregate place stats from reviews
 */
import { z } from "zod";
import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { cleanupStaleVerificationDocs } from "@th/core/use-cases/places/cleanup-stale-verification-docs";
import { recalculatePlaceStats } from "@th/core/use-cases/place-reviews/recalculate-place-stats";
import { recomputePublicSnapshots } from "@th/core/use-cases/place-reviews/recompute-public-snapshots";

// ─────────────────────────────────────────────────────────────────────────────
// places.cleanup-stale-verification-docs - Daily cleanup of orphaned docs
// ─────────────────────────────────────────────────────────────────────────────
export const cleanupStaleVerificationDocsJob = defineScheduledTask({
  name: "places.cleanup-stale-verification-docs",
  description:
    "Daily cleanup of orphaned verification documents from R2 storage.",
  input: z.object({
    maxAgeDays: z.number().int().positive().optional(),
  }),
  schedule: getSchedule("places.cleanup-stale-verification-docs"),
  handler: async ({ input, ctx }) => {
    const result = await cleanupStaleVerificationDocs(
      {
        repos: {
          placeVerificationDocuments: ctx.repos.placeVerificationDocuments,
          placeVerificationRequests: ctx.repos.placeVerificationRequests,
          resourceQuotas: ctx.repos.resourceQuotas,
        },
        storage: ctx.fileStorage,
        clock: ctx.clock,
        logger: ctx.logger,
      },
      input,
    );
    ctx.logger.info("places.cleanup-stale-verification-docs.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// places.recalculate-place-stats - Periodic aggregation of review data
// ─────────────────────────────────────────────────────────────────────────────
export const recalculatePlaceStatsJob = defineScheduledTask({
  name: "places.recalculate-place-stats",
  description:
    "Recalculates aggregate stats (payout, scores, draw, flags, genre cloud) for places with stale review data.",
  input: z.object({
    batchSize: z.number().int().min(1).max(500).optional(),
  }),
  schedule: getSchedule("places.recalculate-place-stats"),
  handler: async ({ input, ctx }) => {
    const result = await recalculatePlaceStats(
      {
        repos: {
          placeReviews: ctx.repos.placeReviews,
          placeStats: ctx.repos.placeStats,
          events: ctx.repos.events,
          orders: ctx.repos.orders,
        },
        clock: ctx.clock,
        logger: ctx.logger,
      },
      input,
    );
    ctx.logger.info("places.recalculate-place-stats.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// places.recompute-public-snapshots - Weekly anonymized public snapshot build
// ─────────────────────────────────────────────────────────────────────────────
// Deliberately weekly and NOT chained off recalculate-place-stats: the delay
// is the anonymity mechanism (place-review-anonymization FR-002) — a venue
// can't correlate a public stats change with a specific recent gig.
export const recomputePublicSnapshotsJob = defineScheduledTask({
  name: "places.recompute-public-snapshots",
  description:
    "Weekly rebuild of the anonymized public review snapshots (threshold-gated, bucketed aggregates) served on place pages.",
  input: z.object({
    batchSize: z.number().int().min(1).max(500).optional(),
  }),
  schedule: getSchedule("places.recompute-public-snapshots"),
  handler: async ({ input, ctx }) => {
    const result = await recomputePublicSnapshots(
      {
        repos: {
          placeReviews: ctx.repos.placeReviews,
          placeStats: ctx.repos.placeStats,
          events: ctx.repos.events,
        },
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      input,
    );
    ctx.logger.info("places.recompute-public-snapshots.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Export all place jobs
// ─────────────────────────────────────────────────────────────────────────────
export const placeJobs = [
  cleanupStaleVerificationDocsJob,
  recalculatePlaceStatsJob,
  recomputePublicSnapshotsJob,
];
