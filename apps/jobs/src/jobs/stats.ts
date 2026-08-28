import { z } from "zod";

import { computeHumanStats } from "@th/core/use-cases/humans";
import { computeOrgStats } from "@th/core/use-cases/orgs";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";

export const computeHumanStatsJob = defineScheduledTask({
  name: "humans.compute-human-stats",
  description:
    "Recomputes materialized performer stats from attributions, events, and follows.",
  input: z.object({
    humanId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  schedule: getSchedule("humans.compute-human-stats"),
  handler: async ({ input, ctx }) => {
    const result = await computeHumanStats(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      },
      input,
    );

    ctx.logger.info("humans.compute-human-stats.completed", result);
    return result;
  },
});

export const computeOrgStatsJob = defineScheduledTask({
  name: "orgs.compute-org-stats",
  description:
    "Recomputes materialized organization stats from events, orders, attributions, and follows.",
  input: z.object({
    orgId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  schedule: getSchedule("orgs.compute-org-stats"),
  handler: async ({ input, ctx }) => {
    const result = await computeOrgStats(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      },
      input,
    );

    ctx.logger.info("orgs.compute-org-stats.completed", result);
    return result;
  },
});

export const statsJobs = [computeHumanStatsJob, computeOrgStatsJob];
