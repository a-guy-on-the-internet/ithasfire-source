import { describe, expect, it, vi } from "vitest";

import type { DelayedJobSchedulerPort } from "@th/ports/delayed-jobs";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import { createInMemorySearchReindexPending } from "@th/test-utils/fakes/search-reindex-pending";

import {
  DRAIN_BACKOFF_BASE_MS,
  DRAIN_BACKOFF_MAX_MS,
  backoffDelayMs,
  drainSearchReindexPending,
} from "../drain-search-reindex-pending";
import { runReindexAfterMutation } from "../reindex-after-mutation";
import { DEFAULT_DRAIN_MIN_DELAY_MS } from "../search-reindex-marks";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const clock = { now: () => NOW };

const id = (n: number) =>
  `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

/**
 * Events that no longer exist, so each successful pass is a document REMOVE
 * (the smallest real incremental reindex). `failIds` make `getById` throw for
 * those events: a PER-ID failure that `buildSearchIndex` resolves with.
 */
function setup(
  options: {
    failIds?: Set<string>;
    deleteDocuments?: (input: { ids?: string[] }) => Promise<unknown>;
    scheduler?: DelayedJobSchedulerPort;
  } = {},
) {
  const pending = createInMemorySearchReindexPending();
  const getById = vi.fn(async (eventId: string) => {
    if (options.failIds?.has(eventId)) throw new Error(`read blip ${eventId}`);
    return null;
  });
  const repos = withSearchIndexFence({
    events: { getById },
    searchReindexPending: pending,
  }) as unknown as Repos;
  const search = {
    ensureIndexes: vi.fn(async () => ({ ok: true as const })),
    upsertDocuments: vi.fn(async () => ({
      ok: true as const,
      value: { indexed: 0 },
    })),
    deleteDocuments: vi.fn<[{ ids?: string[] }], Promise<unknown>>(
      options.deleteDocuments ??
        (async () => ({ ok: true as const, value: undefined })),
    ),
  } as unknown as MultiSearchPort;
  const scheduler =
    options.scheduler ??
    ({
      scheduleOnce: vi.fn(async () => ({ status: "scheduled" as const })),
    } satisfies DelayedJobSchedulerPort);
  const reportError = vi.fn();
  const logger = {
    child: () => logger,
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
  const deps = {
    repos,
    search,
    clock,
    reportError,
    logger: logger as never,
    searchReindexDrain: { scheduler },
  };
  return { pending, deps, search, scheduler, reportError, getById };
}

async function markEvents(
  pending: ReturnType<typeof createInMemorySearchReindexPending>,
  ids: string[],
  at = NOW,
) {
  for (const eventId of ids) {
    await pending.mark([{ entityType: "event", entityId: eventId }], at);
  }
}

describe("drainSearchReindexPending", () => {
  it("reindexes every due row, clears them, and does NOT reschedule when the list is empty", async () => {
    const { pending, deps, scheduler, reportError } = setup();
    await markEvents(pending, [id(1), id(2), id(3)]);

    const out = await drainSearchReindexPending(deps, {});

    expect(out).toMatchObject({
      attempted: 3,
      cleared: 3,
      failed: 0,
      remaining: 0,
      reschedule: "not_needed",
    });
    expect(pending.rows.size).toBe(0);
    // The chain ends: nothing is scheduled, nothing will wake the database.
    expect(scheduler.scheduleOnce).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("an empty list is one read and nothing else", async () => {
    const { deps, scheduler, search } = setup();

    const out = await drainSearchReindexPending(deps, {});

    expect(out).toMatchObject({ attempted: 0, reschedule: "not_needed" });
    expect(search.ensureIndexes).not.toHaveBeenCalled();
    expect(scheduler.scheduleOnce).not.toHaveBeenCalled();
  });

  it("keeps failures (attempts + 1), clears the rest, REPORTS, and reschedules with backoff", async () => {
    const { pending, deps, scheduler, reportError } = setup({
      failIds: new Set([id(2)]),
    });
    await markEvents(pending, [id(1), id(2), id(3)]);

    const out = await drainSearchReindexPending(deps, {});

    expect(out).toMatchObject({
      attempted: 3,
      cleared: 2,
      failed: 1,
      remaining: 1,
    });
    expect([...pending.rows.keys()]).toEqual([`event:${id(2)}`]);
    const kept = pending.rows.get(`event:${id(2)}`)!;
    expect(kept.attempts).toBe(1);
    expect(kept.lastError).toContain("read blip");

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "drainSearchReindexPending", op: "drain" },
        extra: expect.objectContaining({ failed: 1 }),
      }),
    );
    expect(scheduler.scheduleOnce).toHaveBeenCalledTimes(1);
    expect(out.rescheduleDelayMs).toBe(DRAIN_BACKOFF_BASE_MS);
    const runAt = (scheduler.scheduleOnce as ReturnType<typeof vi.fn>).mock
      .calls[0]![0].runAt as Date;
    expect(runAt.getTime()).toBeGreaterThanOrEqual(
      NOW.getTime() + DRAIN_BACKOFF_BASE_MS,
    );
  });

  it("a row that keeps failing is PARKED at the attempt cap: no more runs, no more reschedules", async () => {
    const { pending, deps, scheduler } = setup({ failIds: new Set([id(1)]) });
    await markEvents(pending, [id(1)]);

    for (let i = 0; i < 3; i += 1) {
      await drainSearchReindexPending(deps, { maxAttempts: 3 });
    }
    const calls = (scheduler.scheduleOnce as ReturnType<typeof vi.fn>).mock
      .calls.length;
    const out = await drainSearchReindexPending(deps, { maxAttempts: 3 });

    expect(pending.rows.get(`event:${id(1)}`)?.attempts).toBe(3);
    expect(out).toMatchObject({ attempted: 0, reschedule: "not_needed" });
    // The third failing run found nothing due afterwards either.
    expect(calls).toBe(2);
  });

  it("a whole-batch failure is retried entity by entity: one poisoned entity cannot hold the others", async () => {
    const poisoned = id(2);
    const { pending, deps, reportError } = setup({
      deleteDocuments: async (input) => {
        if (input.ids?.includes(`event_${poisoned}`)) {
          throw new Error("backend rejected the batch");
        }
        return { ok: true as const, value: undefined };
      },
    });
    await markEvents(pending, [id(1), poisoned, id(3)]);

    const out = await drainSearchReindexPending(deps, {});

    expect(out).toMatchObject({ cleared: 2, failed: 1 });
    expect([...pending.rows.keys()]).toEqual([`event:${poisoned}`]);
    expect(reportError).toHaveBeenCalled();
  });

  it("pages past failures with its cursor and stops at the batch cap", async () => {
    const { pending, deps } = setup({ failIds: new Set([id(1), id(2)]) });
    await markEvents(pending, [id(1), id(2)], new Date(NOW.getTime() - 2000));
    await markEvents(pending, [id(3), id(4), id(5)]);

    const out = await drainSearchReindexPending(deps, {
      batchSize: 2,
      maxBatches: 2,
    });

    // Batch 1: the two failing rows. Batch 2: 3 and 4 — reached only because
    // the cursor moved past the failures instead of re-reading them.
    expect(out).toMatchObject({
      attempted: 4,
      cleared: 2,
      failed: 2,
      batchCapReached: true,
    });
    expect(pending.rows.has(`event:${id(5)}`)).toBe(true);
    expect(out.remaining).toBe(3);
    // A fresh (never-failed) row remains, so the next run uses the default
    // delay, not the backoff.
    expect(out.rescheduleDelayMs).toBeUndefined();
  });

  it("a mark made while the drain ran survives and triggers one more run", async () => {
    const { pending, deps, scheduler, search } = setup();
    await markEvents(pending, [id(1)]);
    (search.deleteDocuments as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        // An edit commits a new mark for the same entity mid-drain.
        await pending.mark([{ entityType: "event", entityId: id(1) }], NOW);
        return { ok: true as const, value: undefined };
      },
    );

    const out = await drainSearchReindexPending(deps, {});

    expect(out.cleared).toBe(0);
    expect(pending.rows.get(`event:${id(1)}`)?.generation).toBe(2);
    expect(scheduler.scheduleOnce).toHaveBeenCalledTimes(1);
  });

  it("stops starting batches once its wall-clock budget is spent, and reschedules the rest", async () => {
    const { pending, deps, scheduler } = setup();
    await markEvents(pending, [id(1), id(2), id(3), id(4)]);
    // Each clock read moves 70s: the second batch would start past 120s.
    let t = NOW.getTime();
    const clock = {
      now: () => {
        const at = new Date(t);
        t += 70_000;
        return at;
      },
    };

    const out = await drainSearchReindexPending(
      { ...deps, clock },
      { batchSize: 2, timeBudgetMs: 120_000 },
    );

    expect(out).toMatchObject({
      attempted: 2,
      cleared: 2,
      budgetExhausted: true,
      remaining: 2,
    });
    expect(scheduler.scheduleOnce).toHaveBeenCalledTimes(1);
  });

  it("without a scheduler the leftovers simply wait (nightly backstop)", async () => {
    const { pending, deps } = setup({ failIds: new Set([id(1)]) });
    await markEvents(pending, [id(1)]);

    const out = await drainSearchReindexPending(
      { ...deps, searchReindexDrain: undefined },
      {},
    );

    expect(out.reschedule).toBe("unavailable");
    expect(pending.rows.size).toBe(1);
  });

  it("rejects unknown input keys (strict schema)", async () => {
    const { deps } = setup();
    await expect(
      drainSearchReindexPending(deps, { batchSize: 10, bogus: true }),
    ).rejects.toBeTruthy();
  });
});

describe("the drain picks up what the immediate attempt could not (planted failure)", () => {
  it("post-commit reindex fails → mark stays → the drain clears it", async () => {
    // 1. The edit's post-commit reindex hits a search outage.
    let outage = true;
    const { pending, deps, reportError } = setup({
      deleteDocuments: async () =>
        outage
          ? { ok: false as const, error: new Error("search outage") }
          : { ok: true as const, value: undefined },
    });
    await markEvents(pending, [id(7)]);
    await runReindexAfterMutation(deps, "saveEvent", {
      kind: "event",
      id: id(7),
    });
    expect(pending.rows.has(`event:${id(7)}`)).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);

    // 2. Minutes later the scheduled drain runs against a healthy backend.
    outage = false;
    const out = await drainSearchReindexPending(deps, {});

    expect(out).toMatchObject({
      cleared: 1,
      failed: 0,
      reschedule: "not_needed",
    });
    expect(pending.rows.size).toBe(0);
  });
});

describe("backoffDelayMs", () => {
  it("fresh rows use the configured default; failed ones double, capped", () => {
    expect(backoffDelayMs([{ attempts: 0 }, { attempts: 4 }])).toBeUndefined();
    expect(backoffDelayMs([{ attempts: 1 }])).toBe(DRAIN_BACKOFF_BASE_MS);
    expect(backoffDelayMs([{ attempts: 3 }, { attempts: 2 }])).toBe(
      DRAIN_BACKOFF_BASE_MS * 2,
    );
    expect(backoffDelayMs([{ attempts: 30 }])).toBe(DRAIN_BACKOFF_MAX_MS);
    // Sanity: the default is the edit-triggered delay, a few minutes.
    expect(DEFAULT_DRAIN_MIN_DELAY_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});
