import { describe, expect, it, vi } from "vitest";

import {
  getModerationQueueBreakdown,
  type ModerationQueueBreakdownDeps,
} from "../get-moderation-queue-breakdown";
import {
  getModerationSeverityHistogram,
  MODERATION_SEVERITY_WINDOW_MAX_DAYS,
  type ModerationSeverityHistogramDeps,
} from "../get-moderation-severity-histogram";

const ZERO = {
  pendingOverdue: 0,
  awaitingReview: 0,
  degradedRecent: 0,
  degradedExhausted: 0,
  orphanedRecent: 0,
};

const WINDOW = {
  pendingDueBefore: new Date("2026-09-12T11:00:00.000Z"),
  moderatedBefore: new Date("2026-09-11T12:00:00.000Z"),
  degradedSince: new Date("2026-09-12T10:00:00.000Z"),
  maxRequeues: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind breakdown
// ─────────────────────────────────────────────────────────────────────────────

function makeBreakdownDeps(
  result: {
    byKind?: Partial<Record<string, typeof ZERO>>;
    unrecognizedKinds?: typeof ZERO;
  } = {},
) {
  const countQueueHealthByKind = vi.fn(async () => ({
    byKind: {
      EVENT_HERO: ZERO,
      AVATAR: ZERO,
      BANNER: ZERO,
      PAGE_MEDIA: ZERO,
      ...result.byKind,
    },
    unrecognizedKinds: result.unrecognizedKinds ?? ZERO,
  }));
  const deps = {
    repos: { imageModerationRecords: { countQueueHealthByKind } },
  } as unknown as ModerationQueueBreakdownDeps;
  return { deps, countQueueHealthByKind };
}

describe("getModerationQueueBreakdown", () => {
  it("passes the caller's ABSOLUTE cutoffs straight through — no clock", async () => {
    // Same rule as the drill-down and for the same reason: a breakdown
    // re-derived from a fresh `now` could total 37 under a tile that says 40,
    // and neither surface could say which is right. There is no clock in these
    // deps at all, which is what makes that impossible rather than unlikely.
    const { deps, countQueueHealthByKind } = makeBreakdownDeps();

    const out = await getModerationQueueBreakdown(deps, WINDOW);

    expect(countQueueHealthByKind).toHaveBeenCalledWith(WINDOW);
    // And echoed back verbatim so the page can assert the columns belong to
    // the tiles it is showing.
    expect(out.cutoffs).toEqual({
      pendingDueBefore: WINDOW.pendingDueBefore,
      moderatedBefore: WINDOW.moderatedBefore,
      degradedSince: WINDOW.degradedSince,
    });
    expect(out.maxRequeues).toBe(3);
  });

  it("returns a DENSE map over all four kinds", async () => {
    const { deps } = makeBreakdownDeps({
      byKind: { EVENT_HERO: { ...ZERO, degradedRecent: 12 } },
    });

    const out = await getModerationQueueBreakdown(deps, WINDOW);

    expect(Object.keys(out.byKind).sort()).toEqual([
      "AVATAR",
      "BANNER",
      "EVENT_HERO",
      "PAGE_MEDIA",
    ]);
    expect(out.byKind.EVENT_HERO.degradedRecent).toBe(12);
    expect(out.byKind.AVATAR).toEqual(ZERO);
  });

  it("surfaces unrecognized kinds rather than dropping them", async () => {
    // `kind` is an app-validated String, not a Prisma enum, so a retired value
    // is representable. Dropped, the columns would quietly fail to sum to the
    // tile and the discrepancy would read as a counting bug in the dashboard
    // rather than the data-quality finding it is.
    const { deps } = makeBreakdownDeps({
      unrecognizedKinds: { ...ZERO, degradedExhausted: 3 },
    });

    const out = await getModerationQueueBreakdown(deps, WINDOW);

    expect(out.unrecognizedKinds.degradedExhausted).toBe(3);
  });

  it("rejects a missing cutoff rather than defaulting one", async () => {
    const { deps } = makeBreakdownDeps();

    await expect(
      getModerationQueueBreakdown(deps, {
        pendingDueBefore: WINDOW.pendingDueBefore,
        moderatedBefore: WINDOW.moderatedBefore,
        maxRequeues: 3,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("accepts ISO strings as well as Dates (the JSON-only path)", async () => {
    const { deps, countQueueHealthByKind } = makeBreakdownDeps();

    await getModerationQueueBreakdown(deps, {
      pendingDueBefore: WINDOW.pendingDueBefore.toISOString(),
      moderatedBefore: WINDOW.moderatedBefore.toISOString(),
      degradedSince: WINDOW.degradedSince.toISOString(),
      maxRequeues: 3,
    });

    expect(countQueueHealthByKind).toHaveBeenCalledWith(WINDOW);
  });

  it("rejects unknown input keys", async () => {
    const { deps } = makeBreakdownDeps();

    await expect(
      getModerationQueueBreakdown(deps, { ...WINDOW, kind: "EVENT_HERO" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("propagates a repo failure instead of rendering an all-green breakdown", async () => {
    const { deps } = makeBreakdownDeps();
    (
      deps.repos.imageModerationRecords as unknown as {
        countQueueHealthByKind: ReturnType<typeof vi.fn>;
      }
    ).countQueueHealthByKind.mockRejectedValueOnce(new Error("db down"));

    await expect(getModerationQueueBreakdown(deps, WINDOW)).rejects.toThrow(
      "db down",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Severity histogram
// ─────────────────────────────────────────────────────────────────────────────

const SINCE = new Date("2026-08-13T12:00:00.000Z");
const UNTIL = new Date("2026-09-12T12:00:00.000Z");

function makeHistogramDeps(rows: { severity: number; count: number }[]) {
  const countSeverityHistogram = vi.fn(async () => rows);
  const deps = {
    repos: { imageModerationRecords: { countSeverityHistogram } },
  } as unknown as ModerationSeverityHistogramDeps;
  return { deps, countSeverityHistogram };
}

describe("getModerationSeverityHistogram", () => {
  it("densifies 0–6 so the chart's x-axis never rescales on a quiet day", async () => {
    const { deps } = makeHistogramDeps([
      { severity: 0, count: 900 },
      { severity: 4, count: 12 },
      { severity: 6, count: 3 },
    ]);

    const out = await getModerationSeverityHistogram(deps, {
      since: SINCE,
      until: UNTIL,
    });

    expect(out.buckets).toEqual([
      { severity: 0, count: 900 },
      { severity: 1, count: 0 },
      { severity: 2, count: 0 },
      { severity: 3, count: 0 },
      { severity: 4, count: 12 },
      { severity: 5, count: 0 },
      { severity: 6, count: 3 },
    ]);
    expect(out.scanned).toBe(915);
    expect(out.outOfRange).toEqual([]);
    expect(out.window).toEqual({ since: SINCE, until: UNTIL });
  });

  it("separates out-of-range severities rather than folding or dropping them", async () => {
    // `max_severity` is a plain INTEGER with no check constraint. Folding into
    // the nearest bucket would corrupt the very distribution this exists to
    // show; dropping would make `scanned` disagree with the sum of `buckets`.
    const { deps } = makeHistogramDeps([
      { severity: -1, count: 2 },
      { severity: 2, count: 5 },
      { severity: 9, count: 1 },
    ]);

    const out = await getModerationSeverityHistogram(deps, {
      since: SINCE,
      until: UNTIL,
    });

    expect(out.outOfRange).toEqual([
      { severity: -1, count: 2 },
      { severity: 9, count: 1 },
    ]);
    expect(out.buckets.find((b) => b.severity === 2)?.count).toBe(5);
    // Still adds up.
    expect(out.scanned).toBe(8);
  });

  it("reports zeroes, not an empty array, when nothing was scored", async () => {
    // A page must never have to decide whether a flat histogram means "nothing
    // scored" or "everything scored 0". `scanned` says which.
    const { deps } = makeHistogramDeps([]);

    const out = await getModerationSeverityHistogram(deps, {
      since: SINCE,
      until: UNTIL,
    });

    expect(out.buckets).toHaveLength(7);
    expect(out.scanned).toBe(0);
  });

  it("hands the repo absolute instants and reads no clock", async () => {
    const { deps, countSeverityHistogram } = makeHistogramDeps([]);

    await getModerationSeverityHistogram(deps, { since: SINCE, until: UNTIL });

    expect(countSeverityHistogram).toHaveBeenCalledWith({
      moderatedSince: SINCE,
      moderatedBefore: UNTIL,
    });
  });

  it("REFUSES an inverted or empty window", async () => {
    // An inverted window is a caller bug, not an empty result, and it would
    // otherwise render as a confident permanent "0 scans" that reads as "the
    // provider is doing nothing".
    const { deps } = makeHistogramDeps([]);

    await expect(
      getModerationSeverityHistogram(deps, { since: UNTIL, until: SINCE }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      getModerationSeverityHistogram(deps, { since: UNTIL, until: UNTIL }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("REFUSES a window wider than the scan cap", async () => {
    // `countSeverityHistogram` filters on `moderated_at`, which leads no index,
    // so this is a sequential scan whose cost grows with the whole table.
    // Unbounded, the page an operator opens DURING an incident becomes the
    // heaviest query of the incident — a self-inflicted load spike on top of
    // whatever is already wrong.
    const { deps, countSeverityHistogram } = makeHistogramDeps([]);
    const until = new Date("2026-09-12T12:00:00.000Z");
    const tooFarBack = new Date(until.getTime() - 91 * 24 * 60 * 60 * 1000);

    await expect(
      getModerationSeverityHistogram(deps, { since: tooFarBack, until }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // Refused at the boundary — the query is never issued.
    expect(countSeverityHistogram).not.toHaveBeenCalled();
  });

  it("ACCEPTS a window right up to the cap", async () => {
    // 90 days answers every question this exists for: is the threshold in the
    // right place, and did a recent provider/threshold change move the shape.
    const { deps, countSeverityHistogram } = makeHistogramDeps([]);
    const until = new Date("2026-09-12T12:00:00.000Z");
    const exactlyTheCap = new Date(
      until.getTime() - MODERATION_SEVERITY_WINDOW_MAX_DAYS * 24 * 60 * 60 * 1000,
    );

    await expect(
      getModerationSeverityHistogram(deps, { since: exactlyTheCap, until }),
    ).resolves.toMatchObject({ scanned: 0 });
    expect(countSeverityHistogram).toHaveBeenCalledOnce();
  });

  it("reports an INVERTED window as inverted, not as too wide", async () => {
    // Two different caller bugs. Reporting both would send someone chasing the
    // wrong one, so the span check returns early on a non-positive span.
    const { deps } = makeHistogramDeps([]);

    // `parseInput` flattens every zod failure to `message: "invalid_input"` and
    // carries the detail on `issues`, so that is where the distinction lives.
    await expect(
      getModerationSeverityHistogram(deps, { since: UNTIL, until: SINCE }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ message: expect.stringContaining("strictly before") })],
    });

    // Exactly ONE issue — the early return is what keeps a caller from being
    // told their window is both backwards and too wide.
    await getModerationSeverityHistogram(deps, {
      since: UNTIL,
      until: SINCE,
    }).catch((err: { issues: unknown[] }) => {
      expect(err.issues).toHaveLength(1);
    });
  });

  it("returns NO row identity — aggregate counts only", async () => {
    const { deps } = makeHistogramDeps([{ severity: 6, count: 4 }]);

    const out = await getModerationSeverityHistogram(deps, {
      since: SINCE,
      until: UNTIL,
    });

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("recordId");
    expect(serialized).not.toContain("publicUrl");
    expect(Object.keys(out).sort()).toEqual([
      "buckets",
      "outOfRange",
      "scanned",
      "window",
    ]);
  });

  it("rejects unknown input keys", async () => {
    const { deps } = makeHistogramDeps([]);

    await expect(
      getModerationSeverityHistogram(deps, {
        since: SINCE,
        until: UNTIL,
        kind: "EVENT_HERO",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
