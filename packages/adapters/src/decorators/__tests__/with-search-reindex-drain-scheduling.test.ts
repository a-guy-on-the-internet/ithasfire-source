import { describe, expect, it, vi } from "vitest";

import type {
  DelayedJobSchedulerPort,
  ScheduleJobOnceInput,
} from "@th/ports/delayed-jobs";
import type { Repos, TxRepos } from "@th/ports/repos";

import { withSearchReindexDrainScheduling } from "../with-search-reindex-drain-scheduling";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const EVENT = { entityType: "event" as const, entityId: "e1" };

/**
 * A `tx` that runs `fn` against a tx-scoped copy, throws through on failure
 * (rollback), and logs begin/commit so the schedule's position is visible.
 */
function makeRepos() {
  const log: string[] = [];
  const pendingFor = (scope: string) => ({
    mark: vi.fn(async () => void log.push(`${scope}:mark`)),
    getMany: vi.fn(async () => []),
    listDue: vi.fn(async () => []),
    clearIfUnchanged: vi.fn(async () => 0),
    recordFailure: vi.fn(async () => undefined),
  });
  const txScoped = {
    searchReindexPending: pendingFor("tx"),
    events: { getById: vi.fn(async () => null) },
  };
  const repos = {
    searchReindexPending: pendingFor("root"),
    events: { getById: vi.fn(async () => null) },
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => {
      log.push("tx:begin");
      const result = await fn(txScoped as unknown as TxRepos);
      log.push("tx:commit");
      return result;
    }),
  } as unknown as Repos;
  return { repos, txScoped, log };
}

function makeScheduler(log: string[], impl?: () => Promise<void>) {
  const scheduleOnce = vi.fn(async (_input: ScheduleJobOnceInput) => {
    log.push("schedule");
    if (impl) await impl();
    return { status: "scheduled" as const };
  });
  return {
    port: { scheduleOnce } satisfies DelayedJobSchedulerPort,
    scheduleOnce,
  };
}

describe("withSearchReindexDrainScheduling", () => {
  it("schedules ONE drain after a marking transaction COMMITS", async () => {
    const { repos, log } = makeRepos();
    const { port, scheduleOnce } = makeScheduler(log);
    const wrapped = withSearchReindexDrainScheduling(repos, {
      trigger: { scheduler: port },
      clock: { now: () => NOW },
    });

    await wrapped.tx(async (tx) => {
      await tx.searchReindexPending.mark([EVENT], NOW);
      await tx.searchReindexPending.mark(
        [{ entityType: "place", entityId: "p1" }],
        NOW,
      );
    });

    expect(log).toEqual([
      "tx:begin",
      "tx:mark",
      "tx:mark",
      "tx:commit",
      "schedule",
    ]);
    expect(scheduleOnce).toHaveBeenCalledTimes(1);
    expect(scheduleOnce.mock.calls[0]![0]).toMatchObject({
      jobName: "search.drain-reindex-pending",
    });
  });

  it("a rolled-back transaction schedules nothing", async () => {
    const { repos, log } = makeRepos();
    const { port, scheduleOnce } = makeScheduler(log);
    const wrapped = withSearchReindexDrainScheduling(repos, {
      trigger: { scheduler: port },
      clock: { now: () => NOW },
    });

    await expect(
      wrapped.tx(async (tx) => {
        await tx.searchReindexPending.mark([EVENT], NOW);
        throw new Error("edit failed");
      }),
    ).rejects.toThrow("edit failed");
    expect(scheduleOnce).not.toHaveBeenCalled();
  });

  it("a transaction that marks nothing schedules nothing", async () => {
    const { repos, log } = makeRepos();
    const { port, scheduleOnce } = makeScheduler(log);
    const wrapped = withSearchReindexDrainScheduling(repos, {
      trigger: { scheduler: port },
      clock: { now: () => NOW },
    });

    await wrapped.tx(async (tx) => {
      await tx.events.getById("e1");
      await tx.searchReindexPending.mark([], NOW);
    });
    expect(scheduleOnce).not.toHaveBeenCalled();
  });

  it("an autocommit mark on the root repos schedules right after it", async () => {
    const { repos, log } = makeRepos();
    const { port } = makeScheduler(log);
    const wrapped = withSearchReindexDrainScheduling(repos, {
      trigger: { scheduler: port },
      clock: { now: () => NOW },
    });

    await wrapped.searchReindexPending.mark([EVENT], NOW);
    expect(log).toEqual(["root:mark", "schedule"]);
  });

  it("a failing scheduler never fails the committed write, and is reported", async () => {
    const { repos, log } = makeRepos();
    const { port } = makeScheduler(log, async () => {
      throw new Error("cloud tasks down");
    });
    const reportError = vi.fn();
    const wrapped = withSearchReindexDrainScheduling(repos, {
      trigger: { scheduler: port },
      clock: { now: () => NOW },
      reportError,
    });

    await expect(
      wrapped.tx(async (tx) => {
        await tx.searchReindexPending.mark([EVENT], NOW);
        return "saved";
      }),
    ).resolves.toBe("saved");
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ op: "scheduleSearchReindexDrain" }),
      }),
    );
  });

  it("leaves every other repo untouched", () => {
    const { repos } = makeRepos();
    const wrapped = withSearchReindexDrainScheduling(repos, {
      trigger: { scheduler: makeScheduler([]).port },
      clock: { now: () => NOW },
    });
    expect(wrapped.events).toBe(repos.events);
  });
});
