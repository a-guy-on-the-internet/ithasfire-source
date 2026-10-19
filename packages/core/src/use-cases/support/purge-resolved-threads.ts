import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ── Goal ─────────────────────────────────────────────────────────────────────
// Retention purge for the support chat. DELETE (not anonymize) RESOLVED threads
// whose `resolvedAt` is older than the retention window. We delete because the
// PII here is the free-text message bodies, which can't be meaningfully
// anonymized while keeping any value — and the cascade (SupportMessage.thread
// onDelete: Cascade) makes a thread delete fully remove the conversation.
//
// Only RESOLVED threads are eligible (OPEN / AWAITING_HUMAN are never touched;
// reopening a thread clears resolvedAt, so RESOLVED implies resolvedAt is set).
//
// Each repo call deletes at most `limit` rows (so no single deleteMany locks a
// huge set), but the use case LOOPS until the backlog for this run's cutoff is
// drained — i.e. a pass deletes fewer than `limit` rows. This keeps the daily
// cron's promise honest: the privacy page makes an UNCONDITIONAL "deleted 12
// months after resolved" claim, so we must fully drain each run rather than
// leak the surplus to tomorrow. `maxBatches` is a safety cap so a pathological
// backlog can't spin forever in one invocation.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const purgeResolvedSupportThreadsInputSchema = z
  .object({
    /** Days after a thread RESOLVES before it (and its messages) are deleted. */
    retentionDays: z.number().int().positive(),
    /** Max threads deleted per repo call (bounds each deleteMany). */
    limit: z.number().int().min(1).max(5000).default(1000),
    /**
     * Safety cap on the number of delete passes per run. The loop drains the
     * backlog (stops once a pass deletes < limit), but this bounds a worst case;
     * default 100 drains up to limit*100 = 100k threads/run.
     */
    maxBatches: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

export const purgeResolvedSupportThreadsOutputSchema = z
  .object({
    deleted: z.number().int().nonnegative(),
    cutoff: z.date(),
    /** Number of delete passes performed this run. */
    batches: z.number().int().nonnegative(),
  })
  .strict();

export type PurgeResolvedSupportThreadsInput = z.infer<
  typeof purgeResolvedSupportThreadsInputSchema
>;
export type PurgeResolvedSupportThreadsOutput = z.infer<
  typeof purgeResolvedSupportThreadsOutputSchema
>;

export type PurgeResolvedSupportThreadsDeps = {
  repos: Pick<Repos, "supportThreads">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function purgeResolvedSupportThreads(
  deps: PurgeResolvedSupportThreadsDeps,
  rawInput: unknown,
): Promise<PurgeResolvedSupportThreadsOutput> {
  const input = parseInput(purgeResolvedSupportThreadsInputSchema, rawInput);

  // Cutoff = now minus the retention window. Threads resolved before this are
  // past their window and eligible for deletion. Computed ONCE so every pass
  // shares the same boundary (a drifting cutoff across passes could otherwise
  // re-include rows that resolved during the run).
  const cutoff = new Date(
    deps.clock.now().getTime() - input.retentionDays * MS_PER_DAY,
  );

  let deleted = 0;
  let batches = 0;
  let capReached = false;

  // Drain the backlog: keep deleting bounded batches until a pass removes fewer
  // than `limit` rows (nothing left) or we hit the safety cap.
  for (;;) {
    const pass = await deps.repos.supportThreads.deleteResolvedThreadsBefore({
      before: cutoff,
      limit: input.limit,
    });
    batches += 1;
    deleted += pass.deleted;

    // A short pass means the eligible set is drained for this cutoff.
    if (pass.deleted < input.limit) {
      break;
    }
    // A full pass that hits the cap means there may still be eligible rows; flag
    // it so a deep backlog is visible (next run picks up the remainder).
    if (batches >= input.maxBatches) {
      capReached = true;
      break;
    }
  }

  if (capReached) {
    deps.logger?.warn("support.purge-resolved-threads.batch_cap_reached", {
      retentionDays: input.retentionDays,
      cutoff,
      deleted,
      batches,
      maxBatches: input.maxBatches,
    });
  }

  deps.logger?.info("support.purge_resolved_threads", {
    retentionDays: input.retentionDays,
    cutoff,
    deleted,
    batches,
  });

  return purgeResolvedSupportThreadsOutputSchema.parse({
    deleted,
    cutoff,
    batches,
  });
}
