/**
 * EDIT-TRIGGERED, BATCHED SEARCH REINDEX — the write side.
 *
 * Search documents are a derived cache. Before this module, a write that
 * changed something search shows either refreshed it with a best-effort
 * post-commit call (`reindexAfterMutation`) whose failure was reported and
 * never retried, or did not refresh it at all — both stale until the nightly
 * `search.full-reindex`. On Cloud Run the post-commit call also runs AFTER the
 * response, on a throttled CPU, so "best-effort" was weaker than it looked.
 *
 * Three pieces now, all driven by edits and none by a timer:
 *
 *  1. MARK, IN THE EDIT'S TRANSACTION ({@link markForSearchReindex}): a row in
 *     `SearchReindexPending` per affected entity. It commits exactly when the
 *     edit does, so no crash, throttle or failed call can lose the refresh.
 *  2. IMMEDIATE ATTEMPT, AFTER COMMIT (`reindexAfterMutation`): unchanged
 *     incremental reindex; on success it clears the entity's row with the
 *     generation guard (a concurrent edit's newer mark survives).
 *  3. ONE DELAYED DRAIN PER BURST ({@link scheduleSearchReindexDrain}): once
 *     a transaction that marked commits, the repos decorator
 *     (`withSearchReindexDrainScheduling`, packages/adapters) asks the
 *     delayed scheduler for a `search.drain-reindex-pending` run about a
 *     minute out — inside the same database awake window as the edit —
 *     deduplicated per time slot, and AWAITS that request before `repos.tx`
 *     returns (so it happens while the request still has CPU). Writers only
 *     mark; the scheduling rides the repos they were handed. That holds only
 *     where the COMPOSITION ROOT applied the decorator — `apps/api` dep.ts,
 *     the Better Auth provisioning roots, and the jobs container do. A root
 *     that builds its own repos without it leaves its marks for the next
 *     edit's drain or the nightly run. The drain retries whatever is left and
 *     reschedules itself with backoff only while rows remain; an empty list
 *     ends the chain.
 *
 * NOTHING POLLS. With no edits, no drain is ever scheduled and the database
 * is never woken by this feature. The nightly full reindex stays as the
 * backstop and clears the list too.
 */
import type { ClockPort } from "@th/ports/clock";
import type { DelayedJobSchedulerPort } from "@th/ports/delayed-jobs";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { TxRepos } from "@th/ports/repos";
import type {
  SearchReindexEntityType,
  SearchReindexTarget,
} from "@th/ports/repos/search-reindex-pending";

import { describeError } from "../../lib/io";

/** Which search document to refresh. Same shape `reindexAfterMutation` takes. */
export type SearchReindexSelector = {
  kind: SearchReindexEntityType;
  id: string;
};

/** The jobs-service job that drains `SearchReindexPending`. */
export const SEARCH_REINDEX_DRAIN_JOB = "search.drain-reindex-pending";

/**
 * Earliest a scheduled drain runs after the edit that asked for it. About a
 * minute, so the drain lands inside the SAME database awake window as the
 * edit (Neon suspends after ~5 idle minutes) instead of waking it again.
 * Must stay above 0 (the env floor is 30s): with no delay, a drain
 * rescheduling itself would compute its OWN slot, whose name Cloud Tasks
 * refuses while that task runs.
 */
export const DEFAULT_DRAIN_MIN_DELAY_MS = 60_000;
/** Floor on any requested delay (the env schema enforces the same). */
export const MIN_DRAIN_DELAY_MS = 30_000;
/**
 * Drain runs are quantized to slots of this width: every edit whose earliest
 * run falls in the same slot shares one run (and one dedupe key), so an edit
 * gets its drain between `minDelay` and `minDelay + window` later (60–90s).
 */
export const DEFAULT_DRAIN_WINDOW_MS = 30_000;
/**
 * A drain already scheduled at least this far in the future covers a new
 * mark: it will read the mark, which is committed before we ask. Kept below
 * the minimum delay, so a freshly scheduled slot always counts.
 */
const SCHEDULED_RUN_MARGIN_MS = 20_000;
/**
 * Upper bound on the scheduler call. It sits on the user's write path (after
 * commit, before the response); a timeout is reported and the mark waits for
 * the next edit's drain or the nightly run.
 */
export const SCHEDULE_TIMEOUT_MS = 1_000;

/**
 * The composition root's handle on drain scheduling (given to the repos
 * decorator and to the drain job). Absent = no scheduler configured: marks
 * still commit, the immediate attempt still runs, and anything it could not
 * clear waits for the nightly full reindex.
 */
export type SearchReindexDrainTrigger = {
  scheduler: DelayedJobSchedulerPort;
  /** Default {@link DEFAULT_DRAIN_MIN_DELAY_MS}. */
  minDelayMs?: number;
  /** Default {@link DEFAULT_DRAIN_WINDOW_MS}. */
  windowMs?: number;
};

export function toSearchReindexTarget(
  selector: SearchReindexSelector,
): SearchReindexTarget {
  return { entityType: selector.kind, entityId: selector.id };
}

/**
 * Mark entities whose search documents this write makes stale. Call it
 * INSIDE the write's `repos.tx` callback with the TRANSACTION's repos, and do
 * not catch around it: a failed statement inside a Postgres transaction turns
 * its COMMIT into a silent ROLLBACK, so the error must fail the write.
 */
export async function markForSearchReindex(
  tx: Pick<TxRepos, "searchReindexPending">,
  selectors: readonly SearchReindexSelector[],
  at: Date,
): Promise<void> {
  if (selectors.length === 0) return;
  const pending = pendingRepoOf(tx);
  if (!pending) return;
  await pending.mark(selectors.map(toSearchReindexTarget), at);
}

/**
 * The repo, or `undefined` when the repos bag is a structural test double
 * that predates it (`{ … } as unknown as TxRepos` — hundreds of use-case
 * tests build those). Production cannot hit the `undefined` branch: the
 * Prisma adapter's `makeTxRepos` is checked with `satisfies Omit<TxRepos, …>`,
 * so a missing repo is a compile error, and every decorator spreads it
 * through. Only an ABSENT repo is skipped; a mark that FAILS still throws and
 * fails the write. Dedicated tests (`__tests__/search-reindex-marks*.test.ts`)
 * run every marking write path with the repo present.
 */
export function pendingRepoOf(
  repos: Pick<TxRepos, "searchReindexPending">,
): TxRepos["searchReindexPending"] | undefined {
  return (repos as Partial<Pick<TxRepos, "searchReindexPending">>)
    .searchReindexPending;
}

/**
 * The slot a drain asked for at `now` runs in, and its dedupe key. Pure.
 * Slots are absolute (epoch-aligned), so two instances asking inside the same
 * slot produce the same key and the scheduler keeps one task.
 */
export function drainSlot(
  now: Date,
  delayMs: number,
  windowMs: number,
): { runAt: Date; dedupeKey: string } {
  const earliest = now.getTime() + Math.max(0, delayMs);
  const width = Math.max(1, windowMs);
  const slot = Math.ceil(earliest / width) * width;
  return {
    runAt: new Date(slot),
    dedupeKey: `search-reindex-drain-${slot}`,
  };
}

/**
 * Latest slot this process has scheduled, per trigger. Lets a burst of edits
 * on one instance skip the scheduler call entirely while a run is still
 * ahead. Keyed by the trigger object, which the composition root creates
 * once.
 */
const scheduledSlotByTrigger = new WeakMap<SearchReindexDrainTrigger, number>();

/** Test hook: forget what this process believes it has scheduled. */
export function resetScheduledDrainMemo(
  trigger: SearchReindexDrainTrigger,
): void {
  scheduledSlotByTrigger.delete(trigger);
}

export type ScheduleDrainOutcome =
  | "scheduled"
  | "duplicate"
  | "covered"
  | "unavailable"
  | "failed";

export type ScheduleDrainDeps = {
  searchReindexDrain?: SearchReindexDrainTrigger;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

/**
 * Ask for ONE drain run about a minute out (see module doc). Never throws:
 * a failure is logged at error AND reported (ReporterPort convention) and the
 * marks simply wait for the next edit's drain or the nightly full reindex.
 *
 * `delayMs` overrides the configured minimum delay (the drain's own backoff).
 */
export async function scheduleSearchReindexDrain(
  deps: ScheduleDrainDeps,
  opts: { reason: string; delayMs?: number },
): Promise<ScheduleDrainOutcome> {
  const trigger = deps.searchReindexDrain;
  if (!trigger) return "unavailable";

  const now = deps.clock.now();
  // Never below the floor: see DEFAULT_DRAIN_MIN_DELAY_MS.
  const delayMs = Math.max(
    MIN_DRAIN_DELAY_MS,
    opts.delayMs ?? trigger.minDelayMs ?? DEFAULT_DRAIN_MIN_DELAY_MS,
  );
  const windowMs = trigger.windowMs ?? DEFAULT_DRAIN_WINDOW_MS;
  const { runAt, dedupeKey } = drainSlot(now, delayMs, windowMs);

  // A run this process already scheduled, still comfortably ahead, will read
  // this edit's (already committed) mark. Only for the default delay: a
  // backoff asks for a LATER run on purpose.
  const known = scheduledSlotByTrigger.get(trigger);
  if (
    opts.delayMs === undefined &&
    known !== undefined &&
    known >= now.getTime() + SCHEDULED_RUN_MARGIN_MS
  ) {
    return "covered";
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      trigger.scheduler.scheduleOnce({
        jobName: SEARCH_REINDEX_DRAIN_JOB,
        payload: {},
        runAt,
        dedupeKey,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `scheduleSearchReindexDrain: scheduler did not answer within ${SCHEDULE_TIMEOUT_MS}ms`,
              ),
            ),
          SCHEDULE_TIMEOUT_MS,
        );
      }),
    ]);
    if (opts.delayMs === undefined) {
      scheduledSlotByTrigger.set(
        trigger,
        Math.max(known ?? 0, runAt.getTime()),
      );
    }
    deps.logger?.info("search.reindex_drain_scheduled", {
      reason: opts.reason,
      status: result.status,
      runAt: runAt.toISOString(),
      dedupeKey,
    });
    return result.status;
  } catch (err) {
    try {
      deps.logger?.error("search.reindex_drain_schedule_failed", {
        reason: opts.reason,
        runAt: runAt.toISOString(),
        dedupeKey,
        error: describeError(err),
      });
    } catch {
      // Best-effort.
    }
    try {
      deps.reportError?.(err, {
        tags: { op: "scheduleSearchReindexDrain", useCase: opts.reason },
        extra: { runAt: runAt.toISOString(), dedupeKey },
      });
    } catch {
      // Best-effort: a throwing reporter must never fail the caller's write.
    }
    return "failed";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
