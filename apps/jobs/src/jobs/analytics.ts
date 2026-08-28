/**
 * Analytics Jobs
 *
 * Nightly batch jobs for event statistics and resale price snapshots.
 *
 * Schedule (all UTC):
 *   03:15 – sell-through rollup (folded into daily-stats)
 *   03:30 – event daily stats
 *   04:00 – resale price snapshots (depends on daily-stats)
 */
import { z } from "zod";
import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { computeEventDailyStats } from "@th/core/use-cases/analytics/compute-event-daily-stats";
import { computeResalePriceSnapshots } from "@th/core/use-cases/analytics/compute-resale-price-snapshots";

// ─────────────────────────────────────────────────────────────────────────────
// analytics.event-daily-stats - Nightly event stats aggregation
// ─────────────────────────────────────────────────────────────────────────────
export const eventDailyStats = defineScheduledTask({
  name: "analytics.event-daily-stats",
  description:
    "Nightly aggregation of per-event sell-through, revenue, and ticket stats.",
  input: z.object({
    lookbackDays: z.number().int().min(0).max(365).optional(),
    lookaheadDays: z.number().int().min(0).max(365).optional(),
    limit: z.number().int().min(0).optional(),
  }),
  schedule: getSchedule("analytics.event-daily-stats"),
  handler: async ({ input, ctx }) => {
    ctx.logger.info("analytics.event-daily-stats.start", { input });

    try {
      const result = await computeEventDailyStats(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          logger: ctx.logger,
        },
        {
          lookbackDays: input.lookbackDays ?? 90,
          lookaheadDays: input.lookaheadDays ?? 180,
          limit: input.limit ?? 0,
        },
      );

      ctx.logger.info("analytics.event-daily-stats.completed", {
        eventsProcessed: result.eventsProcessed,
        rowsUpserted: result.rowsUpserted,
        durationMs: result.durationMs,
      });

      return { success: true, ...result };
    } catch (error) {
      ctx.logger.error("analytics.event-daily-stats.failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// analytics.resale-price-snapshots - Nightly resale price suggestion refresh
// ─────────────────────────────────────────────────────────────────────────────
export const resalePriceSnapshots = defineScheduledTask({
  name: "analytics.resale-price-snapshots",
  description:
    "Nightly refresh of resale price suggestions based on recent market data.",
  input: z.object({
    lookaheadDays: z.number().int().min(1).max(365).optional(),
    minSampleSize: z.number().int().min(1).optional(),
  }),
  schedule: getSchedule("analytics.resale-price-snapshots"),
  handler: async ({ input, ctx }) => {
    ctx.logger.info("analytics.resale-price-snapshots.start", { input });

    try {
      const result = await computeResalePriceSnapshots(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          logger: ctx.logger,
        },
        {
          lookaheadDays: input.lookaheadDays ?? 180,
          minSampleSize: input.minSampleSize ?? 3,
        },
      );

      ctx.logger.info("analytics.resale-price-snapshots.completed", {
        eventsProcessed: result.eventsProcessed,
        snapshotsUpserted: result.snapshotsUpserted,
        dataBackedCount: result.dataBackedCount,
        heuristicCount: result.heuristicCount,
        durationMs: result.durationMs,
      });

      return { success: true, ...result };
    } catch (error) {
      ctx.logger.error("analytics.resale-price-snapshots.failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Export all analytics jobs
// ─────────────────────────────────────────────────────────────────────────────
export const analyticsJobs = [eventDailyStats, resalePriceSnapshots];
