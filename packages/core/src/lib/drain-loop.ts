import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";

/**
 * Loop-until-empty for outbox drains.
 *
 * A drain used to take ONE batch per cron tick, which was fine while the tick
 * came every 2-5 minutes. Now that a drain runs when a write wakes it (plus a
 * sparse safety-net schedule), a backlog larger than one batch must not wait
 * for the next wake-up, so each run keeps taking batches while there is
 * clearly more work and the last batch went cleanly.
 *
 * It stops on the FIRST pass that had trouble (a retry, a dead-letter, an
 * unhandled row). Trouble means a dependency is failing, and hammering it with
 * the rest of the queue in the same run only burns attempts faster; the next
 * scheduled run takes over at its normal spacing.
 *
 * Bounded twice, so one run always fits inside Cloud Run's request timeout
 * (300s), Pub/Sub's push ack deadline and Cloud Scheduler's attempt deadline:
 * `maxPasses` and a wall-clock `timeBudgetMs`. The time budget is enforced
 * INSIDE a pass too — each drain checks `deadlineAt` before every item (and
 * the event-change fan-out before every recipient), so one pass cannot
 * overrun it by more than a single send. A run that stops on a bound while
 * work remains reports
 * `hasMore: true`; the jobs service then wakes the drain again (see
 * `apps/jobs/src/app.ts`), so a big backlog continues in fresh requests
 * instead of waiting for the schedule.
 */
export const drainLoopInputShape = {
  /**
   * Who started the run. The scheduled safety net sends `"schedule"` (its
   * manifest `payload`) so the jobs service can tell it apart from a
   * write-triggered wake-up even where the two would otherwise send the same
   * body (the image-moderation drain, whose wake-up is `{}`). The drain itself
   * ignores it.
   */
  origin: z.enum(["schedule"]).optional(),
  /** Batches one run may take before it hands off (`hasMore`). */
  maxPasses: z.number().int().positive().max(100).default(20),
  /** Wall-clock budget for one run before it hands off (`hasMore`). */
  timeBudgetMs: z.number().int().positive().max(240_000).default(120_000),
} as const;

export const drainLoopOutputShape = {
  /** Batches taken this run. */
  passes: z.number().int().nonnegative(),
  /**
   * True when the run stopped on `maxPasses` / `timeBudgetMs` while the last
   * batch still indicated more work. The caller should run the drain again.
   */
  hasMore: z.boolean(),
} as const;

export type DrainPassVerdict = {
  /**
   * True when the pass was full (or partially fanned out, or stopped on the
   * deadline with items left) AND went cleanly.
   */
  wantsAnother: boolean;
};

export type DrainPassContext = {
  passIndex: number;
  /** True once the run's time budget is spent. Check before each item. */
  pastDeadline: () => boolean;
};

export async function runDrainPasses(args: {
  clock: ClockPort;
  maxPasses: number;
  timeBudgetMs: number;
  pass: (ctx: DrainPassContext) => Promise<DrainPassVerdict>;
}): Promise<{ passes: number; hasMore: boolean }> {
  const startedAt = args.clock.now().getTime();
  const deadlineAt = startedAt + args.timeBudgetMs;
  const pastDeadline = () => args.clock.now().getTime() >= deadlineAt;
  let passes = 0;
  for (;;) {
    const { wantsAnother } = await args.pass({
      passIndex: passes,
      pastDeadline,
    });
    passes += 1;
    if (!wantsAnother) return { passes, hasMore: false };
    const elapsed = args.clock.now().getTime() - startedAt;
    if (passes >= args.maxPasses || elapsed >= args.timeBudgetMs) {
      return { passes, hasMore: true };
    }
  }
}
