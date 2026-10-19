import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DelayedJobSchedulerPort } from "@th/ports/delayed-jobs";
import type { TxRepos } from "@th/ports/repos";
import { createInMemorySearchReindexPending } from "@th/test-utils/fakes/search-reindex-pending";

import {
  DEFAULT_DRAIN_MIN_DELAY_MS,
  DEFAULT_DRAIN_WINDOW_MS,
  SCHEDULE_TIMEOUT_MS,
  SEARCH_REINDEX_DRAIN_JOB,
  drainSlot,
  markForSearchReindex,
  resetScheduledDrainMemo,
  scheduleSearchReindexDrain,
  type SearchReindexDrainTrigger,
} from "../search-reindex-marks";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-30T12:00:30.000Z");

function fakeScheduler(impl?: DelayedJobSchedulerPort["scheduleOnce"]) {
  const keys = new Set<string>();
  // Default: Cloud Tasks semantics — the second create of a key is a 409.
  const fallback: DelayedJobSchedulerPort["scheduleOnce"] = async (input) => {
    if (keys.has(input.dedupeKey)) return { status: "duplicate" };
    keys.add(input.dedupeKey);
    return { status: "scheduled" };
  };
  const scheduleOnce = vi.fn(impl ?? fallback);
  return { scheduleOnce } satisfies DelayedJobSchedulerPort;
}

describe("markForSearchReindex", () => {
  it("writes one row per entity through the TRANSACTION's repo, collapsing duplicates", async () => {
    const pending = createInMemorySearchReindexPending();
    const tx = { searchReindexPending: pending } as unknown as TxRepos;

    await markForSearchReindex(
      tx,
      [
        { kind: "event", id: EVENT_ID },
        { kind: "place", id: PLACE_ID },
        { kind: "event", id: EVENT_ID },
      ],
      NOW,
    );

    expect([...pending.rows.keys()].sort()).toEqual([
      `event:${EVENT_ID}`,
      `place:${PLACE_ID}`,
    ]);
    // One bump per mark call, duplicates collapsed.
    expect(pending.rows.get(`event:${EVENT_ID}`)?.generation).toBe(1);
  });

  it("re-marking bumps the generation and resets the failure count", async () => {
    const pending = createInMemorySearchReindexPending();
    const tx = { searchReindexPending: pending } as unknown as TxRepos;
    await markForSearchReindex(tx, [{ kind: "event", id: EVENT_ID }], NOW);
    await pending.recordFailure(
      [{ entityType: "event", entityId: EVENT_ID, generation: 1 }],
      { error: "boom", at: NOW },
    );
    expect(pending.rows.get(`event:${EVENT_ID}`)?.attempts).toBe(1);

    await markForSearchReindex(tx, [{ kind: "event", id: EVENT_ID }], NOW);

    const row = pending.rows.get(`event:${EVENT_ID}`)!;
    expect(row.generation).toBe(2);
    expect(row.attempts).toBe(0);
  });

  it("does nothing for an empty list", async () => {
    const mark = vi.fn();
    await markForSearchReindex(
      { searchReindexPending: { mark } } as unknown as TxRepos,
      [],
      NOW,
    );
    expect(mark).not.toHaveBeenCalled();
  });

  it("a FAILING mark propagates — it must fail the write, never be swallowed inside its transaction", async () => {
    const tx = {
      searchReindexPending: {
        mark: vi.fn(async () => {
          throw new Error("insert failed");
        }),
      },
    } as unknown as TxRepos;

    await expect(
      markForSearchReindex(tx, [{ kind: "event", id: EVENT_ID }], NOW),
    ).rejects.toThrow("insert failed");
  });
});

describe("drainSlot", () => {
  it("runs no earlier than the delay, inside one window after it", () => {
    const { runAt } = drainSlot(NOW, 180_000, 120_000);
    const earliest = NOW.getTime() + 180_000;
    expect(runAt.getTime()).toBeGreaterThanOrEqual(earliest);
    expect(runAt.getTime()).toBeLessThan(earliest + 120_000);
    expect(runAt.getTime() % 120_000).toBe(0);
  });

  it("edits inside one slot share a dedupe key; the next slot gets a new one", () => {
    // Slots are epoch-aligned 2-minute buckets: earliest runs 12:03:01 and
    // 12:04:00 both land on 12:04; 12:04:01 lands on 12:06.
    const a = drainSlot(new Date("2026-09-30T12:00:01.000Z"), 180_000, 120_000);
    const b = drainSlot(new Date("2026-09-30T12:01:00.000Z"), 180_000, 120_000);
    const c = drainSlot(new Date("2026-09-30T12:01:01.000Z"), 180_000, 120_000);
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(c.dedupeKey).not.toBe(a.dedupeKey);
  });
});

describe("scheduleSearchReindexDrain", () => {
  let trigger: SearchReindexDrainTrigger;
  let scheduler: ReturnType<typeof fakeScheduler>;
  const clock = { now: () => NOW };

  beforeEach(() => {
    scheduler = fakeScheduler();
    trigger = { scheduler };
  });

  it("is `unavailable` (and harmless) without a trigger", async () => {
    await expect(
      scheduleSearchReindexDrain({ clock }, { reason: "t" }),
    ).resolves.toBe("unavailable");
  });

  it("asks for ONE drain run a slot out, with the drain job and its dedupe key", async () => {
    const outcome = await scheduleSearchReindexDrain(
      { searchReindexDrain: trigger, clock },
      { reason: "saveEvent" },
    );

    expect(outcome).toBe("scheduled");
    expect(scheduler.scheduleOnce).toHaveBeenCalledTimes(1);
    const input = scheduler.scheduleOnce.mock.calls[0]![0];
    const slot = drainSlot(
      NOW,
      DEFAULT_DRAIN_MIN_DELAY_MS,
      DEFAULT_DRAIN_WINDOW_MS,
    );
    expect(input).toEqual({
      jobName: SEARCH_REINDEX_DRAIN_JOB,
      payload: {},
      runAt: slot.runAt,
      dedupeKey: slot.dedupeKey,
    });
  });

  it("a burst on one instance makes ONE scheduler call while that run is still ahead", async () => {
    for (let i = 0; i < 5; i += 1) {
      await scheduleSearchReindexDrain(
        { searchReindexDrain: trigger, clock },
        { reason: "burst" },
      );
    }
    expect(scheduler.scheduleOnce).toHaveBeenCalledTimes(1);
  });

  it("across instances the scheduler's dedupe answers `duplicate`", async () => {
    const other: SearchReindexDrainTrigger = { scheduler };
    await scheduleSearchReindexDrain(
      { searchReindexDrain: trigger, clock },
      { reason: "a" },
    );
    const second = await scheduleSearchReindexDrain(
      { searchReindexDrain: other, clock },
      { reason: "b" },
    );
    expect(second).toBe("duplicate");
    expect(scheduler.scheduleOnce).toHaveBeenCalledTimes(2);
  });

  it("a backoff delay bypasses the memo and asks for a LATER slot", async () => {
    await scheduleSearchReindexDrain(
      { searchReindexDrain: trigger, clock },
      { reason: "edit" },
    );
    await scheduleSearchReindexDrain(
      { searchReindexDrain: trigger, clock },
      { reason: "drain", delayMs: 20 * 60_000 },
    );
    expect(scheduler.scheduleOnce).toHaveBeenCalledTimes(2);
    const [first, second] = scheduler.scheduleOnce.mock.calls.map((c) =>
      c[0].runAt.getTime(),
    );
    expect(second!).toBeGreaterThan(first!);
  });

  it("a failing scheduler is logged at ERROR and REPORTED, and never throws", async () => {
    scheduler = fakeScheduler(async () => {
      throw new Error("cloud tasks 503");
    });
    trigger = { scheduler };
    const logger = { error: vi.fn(), info: vi.fn() };
    const reportError = vi.fn();

    const outcome = await scheduleSearchReindexDrain(
      {
        searchReindexDrain: trigger,
        clock,
        logger: logger as never,
        reportError,
      },
      { reason: "saveEvent" },
    );

    expect(outcome).toBe("failed");
    expect(logger.error).toHaveBeenCalledWith(
      "search.reindex_drain_schedule_failed",
      expect.objectContaining({ reason: "saveEvent" }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { op: "scheduleSearchReindexDrain", useCase: "saveEvent" },
    });
  });

  it("a failed schedule is not remembered: the next edit tries again", async () => {
    let fail = true;
    scheduler = fakeScheduler(async () => {
      if (fail) throw new Error("blip");
      return { status: "scheduled" };
    });
    trigger = { scheduler };
    await scheduleSearchReindexDrain(
      { searchReindexDrain: trigger, clock },
      { reason: "a" },
    );
    fail = false;
    await expect(
      scheduleSearchReindexDrain(
        { searchReindexDrain: trigger, clock },
        { reason: "b" },
      ),
    ).resolves.toBe("scheduled");
  });

  it("a THROWING reporter cannot turn the swallow into a failed write", async () => {
    scheduler = fakeScheduler(async () => {
      throw new Error("down");
    });
    const outcome = await scheduleSearchReindexDrain(
      {
        searchReindexDrain: { scheduler },
        clock,
        reportError: () => {
          throw new Error("sentry exploded");
        },
      },
      { reason: "x" },
    );
    expect(outcome).toBe("failed");
  });

  it("a scheduler that never answers is cut off at the timeout", async () => {
    vi.useFakeTimers();
    try {
      scheduler = fakeScheduler(() => new Promise(() => {}));
      const reportError = vi.fn();
      const pendingOutcome = scheduleSearchReindexDrain(
        { searchReindexDrain: { scheduler }, clock, reportError },
        { reason: "hang" },
      );
      await vi.advanceTimersByTimeAsync(SCHEDULE_TIMEOUT_MS + 1);
      await expect(pendingOutcome).resolves.toBe("failed");
      expect(reportError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetScheduledDrainMemo forgets the in-process slot", async () => {
    await scheduleSearchReindexDrain(
      { searchReindexDrain: trigger, clock },
      { reason: "a" },
    );
    resetScheduledDrainMemo(trigger);
    await scheduleSearchReindexDrain(
      { searchReindexDrain: trigger, clock },
      { reason: "b" },
    );
    expect(scheduler.scheduleOnce).toHaveBeenCalledTimes(2);
  });
});
