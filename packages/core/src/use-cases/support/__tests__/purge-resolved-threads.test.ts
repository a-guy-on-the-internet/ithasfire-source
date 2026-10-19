import { describe, expect, it, vi } from "vitest";

import { purgeResolvedSupportThreads } from "../purge-resolved-threads";
import type { PurgeResolvedSupportThreadsDeps } from "../purge-resolved-threads";

const NOW = new Date("2026-06-25T00:00:00.000Z");

type FakeThread = {
  id: string;
  status: "OPEN" | "AWAITING_HUMAN" | "RESOLVED";
  resolvedAt: Date | null;
};

// Fixture spanning every eligibility branch relative to a 30-day window from
// NOW (cutoff = 2026-05-26T00:00:00Z):
//   - old-resolved     → resolvedAt 60 days ago → DELETE
//   - recent-resolved  → resolvedAt 5 days ago  → keep (inside window)
//   - open             → never touched
//   - awaiting         → never touched
function makeFixture(): FakeThread[] {
  const daysAgo = (n: number) =>
    new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
  return [
    { id: "old-resolved", status: "RESOLVED", resolvedAt: daysAgo(60) },
    { id: "recent-resolved", status: "RESOLVED", resolvedAt: daysAgo(5) },
    { id: "open", status: "OPEN", resolvedAt: null },
    { id: "awaiting", status: "AWAITING_HUMAN", resolvedAt: null },
  ];
}

function makeDeps(rows: FakeThread[]): {
  deps: PurgeResolvedSupportThreadsDeps;
  deleteSpy: ReturnType<typeof vi.fn>;
} {
  const deleteSpy = vi.fn(
    async ({ before, limit }: { before: Date; limit: number }) => {
      const eligible = rows
        .filter(
          (t) =>
            t.status === "RESOLVED" &&
            t.resolvedAt !== null &&
            t.resolvedAt < before,
        )
        .slice(0, limit);
      // Mutate the fixture so a second run sees them gone.
      for (const t of eligible) {
        const idx = rows.indexOf(t);
        if (idx >= 0) rows.splice(idx, 1);
      }
      return { deleted: eligible.length };
    },
  );

  return {
    deleteSpy,
    deps: {
      repos: {
        supportThreads: {
          deleteResolvedThreadsBefore: deleteSpy,
        },
      } as any,
      clock: { now: () => NOW },
    },
  };
}

// Build N RESOLVED threads all resolved 60 days ago (eligible under a 30-day
// window) so we can exercise multi-batch draining.
function makeEligibleBatch(n: number): FakeThread[] {
  const sixtyDaysAgo = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000);
  return Array.from({ length: n }, (_, i) => ({
    id: `old-${i}`,
    status: "RESOLVED" as const,
    resolvedAt: sixtyDaysAgo,
  }));
}

describe("purgeResolvedSupportThreads", () => {
  it("deletes only RESOLVED threads resolved before (now - retentionDays)", async () => {
    const rows = makeFixture();
    const { deps, deleteSpy } = makeDeps(rows);

    const result = await purgeResolvedSupportThreads(deps, {
      retentionDays: 30,
    });

    // Only the 60-days-ago resolved thread is past the 30-day window. A single
    // short pass drains it (1 < default limit) so the loop runs exactly once.
    expect(result.deleted).toBe(1);
    expect(result.batches).toBe(1);
    expect(rows.map((t) => t.id)).toEqual([
      "recent-resolved",
      "open",
      "awaiting",
    ]);

    // Cutoff passed to the repo = NOW - 30d.
    const expectedCutoff = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(deleteSpy).toHaveBeenCalledWith({
      before: expectedCutoff,
      limit: 1000, // default
    });
    expect(result.cutoff).toEqual(expectedCutoff);
  });

  it("drains a backlog across multiple bounded passes (eligible > limit)", async () => {
    // 3 eligible threads, limit 2 → pass 1 deletes 2 (== limit, keep going),
    // pass 2 deletes 1 (< limit, drained). Two passes, three deleted total.
    const rows = makeEligibleBatch(3);
    const { deps, deleteSpy } = makeDeps(rows);

    const result = await purgeResolvedSupportThreads(deps, {
      retentionDays: 30,
      limit: 2,
    });

    expect(result.deleted).toBe(3);
    expect(result.batches).toBe(2);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(0);
  });

  it("drains in a single pass when eligible < limit", async () => {
    const rows = makeEligibleBatch(2);
    const { deps, deleteSpy } = makeDeps(rows);

    const result = await purgeResolvedSupportThreads(deps, {
      retentionDays: 30,
      limit: 5,
    });

    expect(result.deleted).toBe(2);
    expect(result.batches).toBe(1);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it("stops at maxBatches and warns when the backlog exceeds the cap", async () => {
    // 6 eligible, limit 2, maxBatches 2 → two full passes (4 deleted) then the
    // cap halts the loop with rows still eligible. Warn must fire.
    const rows = makeEligibleBatch(6);
    const { deps, deleteSpy } = makeDeps(rows);
    const warn = vi.fn();
    deps.logger = { info: vi.fn(), warn } as any;

    const result = await purgeResolvedSupportThreads(deps, {
      retentionDays: 30,
      limit: 2,
      maxBatches: 2,
    });

    expect(result.deleted).toBe(4);
    expect(result.batches).toBe(2);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2); // remainder left for the next run
    expect(warn).toHaveBeenCalledWith(
      "support.purge-resolved-threads.batch_cap_reached",
      expect.objectContaining({ deleted: 4, batches: 2, maxBatches: 2 }),
    );
  });

  it("leaves OPEN / AWAITING_HUMAN and recently-resolved threads untouched", async () => {
    const rows = makeFixture();
    const { deps } = makeDeps(rows);

    await purgeResolvedSupportThreads(deps, { retentionDays: 30 });

    expect(rows.some((t) => t.id === "recent-resolved")).toBe(true);
    expect(rows.some((t) => t.id === "open")).toBe(true);
    expect(rows.some((t) => t.id === "awaiting")).toBe(true);
  });

  it("returns deleted 0 when nothing is eligible", async () => {
    // A very long window means even the 60-day-old thread is still inside it.
    const rows = makeFixture();
    const { deps } = makeDeps(rows);

    const result = await purgeResolvedSupportThreads(deps, {
      retentionDays: 365,
    });

    // One pass deletes 0 (< limit) → loop stops immediately.
    expect(result.deleted).toBe(0);
    expect(result.batches).toBe(1);
    expect(rows).toHaveLength(4);
  });

  it("forwards an explicit limit to the repo", async () => {
    const rows = makeFixture();
    const { deps, deleteSpy } = makeDeps(rows);

    await purgeResolvedSupportThreads(deps, { retentionDays: 30, limit: 50 });

    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });
});
