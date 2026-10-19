import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";

import {
  purgeDispatchedChangeNotices,
  type PurgeDispatchedChangeNoticesDeps,
} from "../purge-dispatched-change-notices";

const NOW = new Date("2026-07-04T00:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type FakeNotice = {
  id: string;
  dispatchedAt: Date | null;
};

// Fixture spanning every eligibility branch relative to a 30-day window from
// NOW (cutoff = 2026-06-04T00:00:00Z):
//   - dispatched-old    → dispatchedAt 60 days ago → DELETE
//   - dispatched-recent → dispatchedAt 5 days ago  → keep (inside window)
//   - undispatched      → dispatchedAt null        → never touched (in-flight)
function makeFixture(): FakeNotice[] {
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * MS_PER_DAY);
  return [
    { id: "dispatched-old", dispatchedAt: daysAgo(60) },
    { id: "dispatched-recent", dispatchedAt: daysAgo(5) },
    { id: "undispatched", dispatchedAt: null },
  ];
}

function makeDeps(rows: FakeNotice[]): {
  deps: PurgeDispatchedChangeNoticesDeps;
  deleteSpy: ReturnType<typeof vi.fn>;
} {
  // Mirrors the adapter's `dispatchedAt IS NOT NULL AND dispatchedAt < cutoff`.
  const deleteSpy = vi.fn(async (cutoff: Date) => {
    const eligible = rows.filter(
      (n) => n.dispatchedAt !== null && n.dispatchedAt < cutoff,
    );
    for (const n of eligible) {
      const idx = rows.indexOf(n);
      if (idx >= 0) rows.splice(idx, 1);
    }
    return eligible.length;
  });

  const clock: ClockPort = { now: () => NOW };

  return {
    deleteSpy,
    deps: {
      repos: {
        eventChangeNotices: {
          deleteDispatchedBefore: deleteSpy,
        },
      } as unknown as PurgeDispatchedChangeNoticesDeps["repos"],
      clock,
    },
  };
}

describe("purgeDispatchedChangeNotices", () => {
  it("deletes only DISPATCHED notices dispatched before (now - retentionDays)", async () => {
    const rows = makeFixture();
    const { deps, deleteSpy } = makeDeps(rows);

    const result = await purgeDispatchedChangeNotices(deps, {
      retentionDays: 30,
    });

    // Only the 60-day-old dispatched notice is past the 30-day window. The
    // recently-dispatched and the undispatched (in-flight) rows survive.
    expect(result.deleted).toBe(1);
    expect(rows.map((n) => n.id)).toEqual([
      "dispatched-recent",
      "undispatched",
    ]);

    // Cutoff passed to the repo = NOW - 30d.
    const expectedCutoff = new Date(NOW.getTime() - 30 * MS_PER_DAY);
    expect(deleteSpy).toHaveBeenCalledWith(expectedCutoff);
    expect(result.cutoff).toEqual(expectedCutoff);
  });

  it("never deletes undispatched/in-flight notices", async () => {
    const rows = makeFixture();
    const { deps } = makeDeps(rows);

    await purgeDispatchedChangeNotices(deps, { retentionDays: 30 });

    expect(rows.some((n) => n.id === "undispatched")).toBe(true);
  });

  it("respects a custom retentionDays window", async () => {
    // A 90-day window means even the 60-day-old dispatched notice is still
    // inside the window → nothing eligible.
    const rows = makeFixture();
    const { deps, deleteSpy } = makeDeps(rows);

    const result = await purgeDispatchedChangeNotices(deps, {
      retentionDays: 90,
    });

    expect(result.deleted).toBe(0);
    expect(rows).toHaveLength(3);
    const expectedCutoff = new Date(NOW.getTime() - 90 * MS_PER_DAY);
    expect(deleteSpy).toHaveBeenCalledWith(expectedCutoff);
  });

  it("defaults retentionDays to 30 when omitted", async () => {
    const rows = makeFixture();
    const { deps, deleteSpy } = makeDeps(rows);

    const result = await purgeDispatchedChangeNotices(deps, {});

    // Default 30d window → only the 60-day-old dispatched notice is purged.
    expect(result.deleted).toBe(1);
    const expectedCutoff = new Date(NOW.getTime() - 30 * MS_PER_DAY);
    expect(result.cutoff).toEqual(expectedCutoff);
    expect(deleteSpy).toHaveBeenCalledWith(expectedCutoff);
  });

  it("rejects retentionDays below 1", async () => {
    const rows = makeFixture();
    const { deps } = makeDeps(rows);

    await expect(
      purgeDispatchedChangeNotices(deps, { retentionDays: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
