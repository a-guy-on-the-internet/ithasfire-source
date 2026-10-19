import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const requeueDegradedModerationsInputSchema = z
  .object({
    /**
     * Max rows to revive per run. Advisory: the repo's `updateMany` has no
     * LIMIT, so this bounds intent rather than the statement — the eligible set
     * is an outage artefact and small by construction.
     */
    limit: z.number().int().positive().default(200),
    /**
     * How long a row must have been dead-lettered before it is eligible.
     * Non-zero so this job never fights the drain over a row that is still
     * inside its own retry window.
     */
    minAgeMinutes: z.number().int().nonnegative().default(15),
    /**
     * Cap on how many times a single row may be revived. Past this it stays
     * FLAGGED for a human — the honest terminal state for an object that can
     * never be scanned (deleted event, GC'd media).
     */
    maxRequeues: z.number().int().positive().default(3),
  })
  .strict();

export type RequeueDegradedModerationsInput = z.infer<
  typeof requeueDegradedModerationsInputSchema
>;

export const requeueDegradedModerationsOutputSchema = z
  .object({
    /** Rows moved back to PENDING this run. */
    requeued: z.number().int().nonnegative(),
  })
  .strict();

export type RequeueDegradedModerationsOutput = z.infer<
  typeof requeueDegradedModerationsOutputSchema
>;

export type RequeueDegradedModerationsDeps = {
  repos: Pick<Repos, "imageModerationRecords">;
  clock: ClockPort;
  logger: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Revive images the SCANNER failed on, so a provider outage stops leaving a
 * permanent manual backlog.
 *
 * WHY THIS EXISTS. `moderateImage` short-circuits on any non-PENDING record, so
 * a dead-lettered row was terminal: the only exit was a human clicking approve.
 * In August 2026 an Azure subscription lapsed, every image uploaded during the
 * window burned its (then 7-minute) retry budget, dead-lettered to
 * FLAGGED+degraded, and stayed invisible — with no path back that did not
 * involve raw SQL. Widening the retry window covers outages up to ~3 days; this
 * job covers everything longer.
 *
 * WHAT IT MUST NEVER DO. It must not resurrect a CONTENT verdict. An image the
 * provider actually scored at or above threshold, or that a human decided on,
 * is not eligible — the whole selection lives in `requeueDegraded`'s WHERE and
 * is documented on the port. This use case deliberately holds no logic of its
 * own beyond scheduling: there is no place here to accidentally widen the set.
 *
 * Not fail-closed-sensitive: reviving a row returns it to PENDING, which read
 * gating treats as NOT publicly visible on unvetted surfaces. A requeue can
 * therefore never make an unscanned image public — the worst case is that a row
 * cycles through PENDING and back to FLAGGED, costing provider calls.
 */
export async function requeueDegradedModerations(
  deps: RequeueDegradedModerationsDeps,
  rawInput: unknown = {},
): Promise<RequeueDegradedModerationsOutput> {
  const { repos, clock } = deps;
  const logger = deps.logger.child({ useCase: "requeueDegradedModerations" });
  const input = parseInput(requeueDegradedModerationsInputSchema, rawInput);

  const now = clock.now();
  const moderatedBefore = new Date(
    now.getTime() - input.minAgeMinutes * 60_000,
  );

  const requeued = await repos.imageModerationRecords.requeueDegraded({
    now,
    limit: input.limit,
    moderatedBefore,
    maxRequeues: input.maxRequeues,
  });

  if (requeued > 0) {
    // INFO not WARN: a non-zero count here is the system self-healing, which is
    // the desired outcome, not a problem. The thing worth alerting on is the
    // degraded verdicts themselves, which the drain already reports.
    logger.info("requeueDegradedModerations.requeued", {
      requeued,
      maxRequeues: input.maxRequeues,
      moderatedBefore: moderatedBefore.toISOString(),
    });
  }

  return requeueDegradedModerationsOutputSchema.parse({ requeued });
}
