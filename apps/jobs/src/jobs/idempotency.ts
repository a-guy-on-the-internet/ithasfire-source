/**
 * Idempotency retention.
 *
 * idempotency.purge-expired — a daily cron that DELETES idempotency records
 * whose retention window has passed.
 *
 * Why this job exists at all: expiry is only self-managing on the Redis
 * backend, which sets `EX` on every write. Prod moved to the Prisma backend on
 * 2026-07-30 to escape an Upstash quota (see `docs/ops/resource-burn.md`,
 * RB-0001) and silently inherited unbounded table growth — a relational store
 * has no TTL. Reads already filter on `expiresAt`, so nothing was ever
 * INCORRECT; the rows simply accumulate, and `resultJson` caches whole success
 * payloads, so the space is real.
 *
 * The port answers this per-backend (`purgeExpired`), so running this against
 * Redis is a harmless no-op that returns 0 on the first pass. That means the
 * cron stays correct if the backend is ever switched back, rather than needing
 * to be remembered and disabled.
 *
 * Drains in bounded passes rather than one statement so a large backlog can't
 * emit an enormous DELETE, with a cap on passes so a pathological clock or a
 * misbehaving adapter can't spin forever.
 */
import { z } from "zod";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";

/** Records deleted per pass. */
const DEFAULT_BATCH = 1000;

/**
 * Safety cap on passes. At the default batch this drains 100k records per run —
 * far beyond any plausible backlog — while bounding a runaway loop if an
 * adapter ever returns a full batch without actually deleting.
 */
const MAX_PASSES = 100;

export const purgeExpiredIdempotency = defineScheduledTask({
  name: "idempotency.purge-expired",
  description:
    "Delete idempotency records past their retention window (no-op on the Redis backend, which expires keys itself).",
  input: z.object({
    /** Override the per-pass delete cap. */
    batch: z.coerce.number().int().min(1).max(5000).optional(),
  }),
  schedule: getSchedule("idempotency.purge-expired"),
  handler: async ({ input, ctx }) => {
    const batch = input.batch ?? DEFAULT_BATCH;

    let deleted = 0;
    let passes = 0;
    let drained = false;
    // `passes` counts calls MADE, so it is incremented before the drain check.
    // A `for (...; passes++)` here would skip the increment on `break` and
    // under-report by one on every drained run.
    while (passes < MAX_PASSES) {
      const n = await ctx.idempotency.purgeExpired(batch);
      passes++;
      deleted += n;
      // A short pass means the backlog is drained. The Redis adapter returns 0
      // immediately, so this exits after one pass there.
      if (n < batch) {
        drained = true;
        break;
      }
    }

    if (!drained) {
      // Not an error — the next run continues — but it should be visible,
      // because a backlog this size means the job has been failing or the
      // retention window is mis-set.
      ctx.logger.warn("idempotency.purge-expired.cap_reached", {
        deleted,
        passes,
        batch,
      });
    }

    return { deleted, passes, drained };
  },
});

export const idempotencyJobs = [purgeExpiredIdempotency];
