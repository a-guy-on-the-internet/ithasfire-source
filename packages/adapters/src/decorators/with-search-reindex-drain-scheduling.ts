import {
  scheduleSearchReindexDrain,
  type SearchReindexDrainTrigger,
} from "@th/core/use-cases/search/search-reindex-marks";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxOptions, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { SearchReindexPendingRepo } from "@th/ports/repos/search-reindex-pending";

/**
 * Schedules ONE delayed `search.drain-reindex-pending` run after a write that
 * marked entities for search reindex COMMITS (edit-triggered, batched search
 * reindex — core `search/search-reindex-marks.ts`).
 *
 * ## Why a repo decorator and not a call in each use case
 *
 * Same reasoning as `withOutboxDrainTriggers`: some twenty writers mark
 * (`markForSearchReindex`), several through shared helpers inside a caller's
 * transaction. The mark is the one step none of them can skip, so the
 * scheduling rides it, and a future WRITER only has to mark. A future
 * COMPOSITION ROOT still has to apply this decorator to the repos it builds
 * (today: `apps/api` dep.ts, the Better Auth provisioning roots, the jobs
 * container); without it the marks commit but wait for the next drain.
 *
 * ## Commit semantics
 *
 * - Inside `repos.tx(fn)`: a mark only flags the transaction. The schedule
 *   request is made after `repos.tx` resolves, i.e. after COMMIT, once per
 *   transaction. A rolled-back transaction schedules nothing.
 * - On the root repos (autocommit): the mark is committed when the call
 *   returns, so the schedule follows immediately.
 *
 * ## Failure semantics
 *
 * Awaited (request-based CPU on Cloud Run starves work left after the
 * response) and bounded by `SCHEDULE_TIMEOUT_MS`, and it NEVER throws into the
 * caller: `scheduleSearchReindexDrain` logs + reports a failure and the marks
 * stay committed for the next edit's drain or the nightly full reindex.
 *
 * ## Why it never polls
 *
 * Nothing here runs unless a write marked something. With no edits there is
 * no schedule request, no drain run, and no database wake-up.
 */
export type SearchReindexDrainSchedulingOptions = {
  trigger: SearchReindexDrainTrigger;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

function wrapPending(
  repo: SearchReindexPendingRepo,
  onMark: () => Promise<void> | void,
): SearchReindexPendingRepo {
  return {
    ...repo,
    mark: async (targets, at) => {
      await repo.mark(targets, at);
      if (targets.length > 0) await onMark();
    },
  };
}

export function withSearchReindexDrainScheduling(
  repos: Repos,
  options: SearchReindexDrainSchedulingOptions,
): Repos {
  const schedule = async (): Promise<void> => {
    await scheduleSearchReindexDrain(
      {
        searchReindexDrain: options.trigger,
        clock: options.clock,
        logger: options.logger,
        reportError: options.reportError,
      },
      { reason: "searchReindexPending.mark" },
    );
  };

  const root: Repos = {
    ...repos,
    searchReindexPending: wrapPending(repos.searchReindexPending, schedule),
  };

  root.tx = async <T>(
    fn: (tx: TxRepos) => Promise<T>,
    txOptions?: TxOptions,
  ): Promise<T> => {
    let marked = false;
    const result = await repos.tx(
      (tx) =>
        fn({
          ...tx,
          searchReindexPending: wrapPending(tx.searchReindexPending, () => {
            marked = true;
          }),
        }),
      txOptions,
    );
    if (marked) await schedule();
    return result;
  };

  return root;
}
