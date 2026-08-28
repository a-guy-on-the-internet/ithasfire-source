/**
 * Community recurrence jobs
 *
 * Rolling-window maintenance for recurring community listings. A recurring
 * listing is ONE `Event` with a `recurrenceSchedule` + N `EventDate` rows, and
 * `Event.startsAt` is pinned to the first upcoming date. As dates pass, without
 * maintenance the listing's `startsAt` goes stale/past (dropping it out of
 * every `startsAt >= now` discovery + geo×category SEO query) and the far edge
 * of the RRULE window is never topped up. This daily job re-expands + re-pins.
 */
import { z } from "zod";

import { refreshRecurringEventDates } from "@th/core/use-cases/community/refresh-recurring-event-dates";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";

export const refreshRecurringDates = defineScheduledTask({
  name: "community.refresh-recurring-dates",
  description:
    "Rolling re-expansion of recurring community listings: top up EventDate windows and re-pin Event.startsAt to the next upcoming date.",
  input: z.object({
    trigger: z.object({ reason: z.string() }).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    maxEvents: z.number().int().min(1).max(50_000).optional(),
  }),
  schedule: getSchedule("community.refresh-recurring-dates"),
  handler: async ({ input, ctx }) => {
    const startedAt = Date.now();
    ctx.logger.info("community.refresh-recurring-dates.start", {
      limit: input.limit,
      maxEvents: input.maxEvents,
    });

    try {
      const summary = await refreshRecurringEventDates(
        { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
        {
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.maxEvents !== undefined
            ? { maxEvents: input.maxEvents }
            : {}),
        },
      );

      const durationMs = Date.now() - startedAt;
      ctx.logger.info("community.refresh-recurring-dates.completed", {
        ...summary,
        durationMs,
      });

      return { success: true, ...summary, durationMs };
    } catch (error) {
      // The use-case isolates per-event failures internally; a throw here means
      // a batch-level failure (e.g. the enumeration query / DB down). Surface
      // it, but never let the scheduler treat a partial run as a hard error
      // beyond this boundary.
      ctx.logger.error("community.refresh-recurring-dates.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const communityRecurrenceJobs = [refreshRecurringDates];
