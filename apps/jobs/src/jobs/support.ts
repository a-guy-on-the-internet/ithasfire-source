/**
 * Support chat retention jobs.
 *
 * support.purge-resolved-threads — a daily cron that DELETES resolved support
 * threads (and their cascaded messages) once they're past the retention window
 * (SUPPORT_RETENTION_DAYS). We delete rather than anonymize because the PII is
 * the free-text message bodies, which can't be meaningfully anonymized while
 * keeping value; the cascade (SupportMessage.thread onDelete: Cascade) makes a
 * thread delete fully remove the conversation. Only RESOLVED threads whose
 * resolvedAt is older than the window are eligible — OPEN / AWAITING_HUMAN are
 * never touched. Each deleteMany is bounded by `limit`, but the use case loops
 * to fully drain the backlog every run (so the retention promise on the privacy
 * page stays honest), with a safety cap on the number of passes.
 */
import { z } from "zod";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { env } from "../lib/env";
import { purgeResolvedSupportThreads } from "@th/core/use-cases/support";

export const purgeResolvedThreads = defineScheduledTask({
  name: "support.purge-resolved-threads",
  description:
    "Delete resolved support threads (and their cascaded messages) past the retention window (SUPPORT_RETENTION_DAYS).",
  input: z.object({
    /** Override the env retention window for a one-off catch-up run. */
    retentionDays: z.coerce.number().int().positive().optional(),
    /** Override the per-run delete cap. */
    limit: z.coerce.number().int().min(1).max(5000).optional(),
  }),
  schedule: getSchedule("support.purge-resolved-threads"),
  handler: async ({ input, ctx }) => {
    // retentionDays resolves from env when not explicitly overridden. `limit` is
    // forwarded only when provided so the use-case schema applies its own
    // default (no duplicated default that could drift). The use case loops
    // internally to fully drain the backlog each run.
    const retentionDays = input.retentionDays ?? env.SUPPORT_RETENTION_DAYS;

    const result = await purgeResolvedSupportThreads(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      },
      {
        retentionDays,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
    );

    ctx.logger.info("support.purge-resolved-threads.completed", result);
    return result;
  },
});

export const supportJobs = [purgeResolvedThreads];
