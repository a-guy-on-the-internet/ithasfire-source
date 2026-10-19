import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MIN_RESOLVABLE_REQUEUES,
  MODERATION_KINDS,
  QUEUE_SIGNALS,
  breakdownRows,
  canRescanRow,
  canResolveSignal,
  canResolveWithThreshold,
  canWriteOps,
  describeAlertState,
  describeDeletionOutbox,
  describeLookup,
  describeOutOfRange,
  describeRescanOutcome,
  describeResolveOutcome,
  describeSeveritySummary,
  firingSignalLabel,
  formatCount,
  normalizeStorageKeyInput,
  opsWriteLockReason,
  resolveOpsWriteAccess,
  severityAriaLabel,
  severityBars,
  severityHeldCount,
  severityThresholdIndex,
  severityWindow,
  signalShowsRowActions,
  signalTotal,
  signalTotalLabel,
  storageKeyInputProblem,
  type LookupResult,
  type ModerationRecordStatus,
  type QueueCounts,
  type QueueSignal,
  type QueueTotals,
} from "../image-moderation-ops.helpers";

const NOTHING_WITHHELD = {
  storageKey: false,
  lastError: false,
  status: false,
  subjectType: false,
  subjectId: false,
  degraded: false,
  moderatedAt: false,
  nextAttemptAt: false,
};

const ALL_WITHHELD = {
  storageKey: true,
  lastError: true,
  status: true,
  subjectType: true,
  subjectId: true,
  degraded: true,
  moderatedAt: true,
  nextAttemptAt: true,
};

const zeroCounts = (): QueueCounts => ({
  pendingOverdue: 0,
  awaitingReview: 0,
  degradedRecent: 0,
  degradedExhausted: 0,
  orphanedRecent: 0,
});

// ─────────────────────────────────────────────────────────────────────────────
// Totals beside the windowed tiles
// ─────────────────────────────────────────────────────────────────────────────

describe("formatCount", () => {
  it("groups thousands with a PINNED locale, not the ambient one", () => {
    // Server-rendered and client-rendered halves must agree; `en-US` is what
    // makes that true by construction rather than by luck.
    expect(formatCount(1204)).toBe("1,204");
    expect(formatCount(0)).toBe("0");
  });

  it("never renders a non-finite value as a number", () => {
    expect(formatCount(Number.NaN)).toBe("—");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("signalTotal", () => {
  const totals: QueueTotals = { awaitingReviewAll: 6, orphanedAll: 1204 };

  it("only the two WINDOWED tiles have an all-time counterpart", () => {
    expect(signalTotal("awaitingReview", totals)).toBe(6);
    expect(signalTotal("orphanedRecent", totals)).toBe(1204);
    expect(signalTotal("pendingOverdue", totals)).toBeNull();
    expect(signalTotal("degradedRecent", totals)).toBeNull();
    expect(signalTotal("degradedExhausted", totals)).toBeNull();
  });

  it("is null with no totals in hand", () => {
    expect(signalTotal("awaitingReview", undefined)).toBeNull();
  });
});

describe("signalTotalLabel", () => {
  const totals: QueueTotals = { awaitingReviewAll: 6, orphanedAll: 1204 };

  it("says what a zero tile is hiding", () => {
    // The case this whole feature exists for: six images flagged this morning,
    // none of them yet 24h old, so the tile reads 0.
    expect(signalTotalLabel("awaitingReview", 0, totals)).toBe(
      "6 waiting in total",
    );
    expect(signalTotalLabel("orphanedRecent", 0, totals)).toBe("1,204 all time");
  });

  it("prints NOTHING when the total and the window agree", () => {
    expect(
      signalTotalLabel("awaitingReview", 6, totals),
    ).toBeNull();
    expect(signalTotalLabel("orphanedRecent", 1204, totals)).toBeNull();
  });

  it("prints nothing when the total is somehow SMALLER than the window", () => {
    // The backend guarantees `>=`, so this can only be a skew between two
    // reads — and "3 in total" under a tile reading 5 looks like a counting bug.
    expect(signalTotalLabel("awaitingReview", 9, totals)).toBeNull();
  });

  it("is null for the three tiles that have no all-time counterpart", () => {
    for (const signal of [
      "pendingOverdue",
      "degradedRecent",
      "degradedExhausted",
    ] as QueueSignal[]) {
      expect(signalTotalLabel(signal, 0, totals)).toBeNull();
    }
  });

  it("is null before the counts have loaded", () => {
    expect(signalTotalLabel("awaitingReview", undefined, totals)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Deletion outbox
// ─────────────────────────────────────────────────────────────────────────────

describe("describeDeletionOutbox", () => {
  it("is calm when nothing is stuck", () => {
    const copy = describeDeletionOutbox({
      dead: 0,
      overdue: 0,
      overdueMinutes: 60,
    });
    expect(copy.tone).toBe("calm");
    expect(copy.headline).toMatch(/being deleted/i);
  });

  it("says the bytes are still public when rows are overdue", () => {
    const copy = describeDeletionOutbox({
      dead: 0,
      overdue: 3,
      overdueMinutes: 60,
    });
    expect(copy.tone).toBe("warning");
    expect(copy.headline).toContain("3");
    expect(copy.headline).toMatch(/public CDN/i);
    expect(copy.detail).toContain("1h");
  });

  it("uses the singular for one row", () => {
    const copy = describeDeletionOutbox({
      dead: 0,
      overdue: 1,
      overdueMinutes: 60,
    });
    expect(copy.headline).toBe("1 rejected image is still on the public CDN");
  });

  it("lets DEAD outrank overdue and names both", () => {
    // An exhausted row is never retried by anything, so it is the one that
    // needs a human today.
    const copy = describeDeletionOutbox({
      dead: 2,
      overdue: 5,
      overdueMinutes: 60,
    });
    expect(copy.tone).toBe("danger");
    expect(copy.headline).toMatch(/without a human/i);
    expect(copy.detail).toContain("2");
    expect(copy.detail).toContain("5");
  });

  it("states the consequence, not the mechanism", () => {
    const copy = describeDeletionOutbox({
      dead: 1,
      overdue: 0,
      overdueMinutes: 60,
    });
    expect(copy.detail).toMatch(/told they were removed/i);
    expect(copy.detail).toMatch(/still served publicly/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Discord alert state
// ─────────────────────────────────────────────────────────────────────────────

describe("describeAlertState", () => {
  const now = new Date("2026-09-12T12:00:00Z");

  it("renders all four states DISTINCTLY", () => {
    const seen = new Set<string>();
    for (const state of [
      "never_paged",
      "cleared",
      "paged",
      "unreadable",
    ] as const) {
      const copy = describeAlertState({
        state,
        firingSignals: state === "paged" ? ["awaitingReview"] : [],
        lastPagedAt: state === "paged" ? new Date("2026-09-12T10:00:00Z") : null,
        now,
      });
      seen.add(`${copy.tone}|${copy.headline}|${copy.detail}`);
    }
    expect(seen.size).toBe(4);
  });

  it("never lets `unreadable` read like `cleared`", () => {
    // Both carry a null fingerprint. Only one of them means nothing is wrong.
    const cleared = describeAlertState({
      state: "cleared",
      firingSignals: [],
      lastPagedAt: null,
      now,
    });
    const unreadable = describeAlertState({
      state: "unreadable",
      firingSignals: [],
      lastPagedAt: null,
      now,
    });
    expect(cleared.tone).toBe("calm");
    expect(unreadable.tone).toBe("unknown");
    expect(unreadable.headline).not.toBe(cleared.headline);
  });

  it("puts the paged age in the headline", () => {
    const copy = describeAlertState({
      state: "paged",
      firingSignals: ["degradedRecent"],
      lastPagedAt: new Date("2026-09-12T10:00:00Z"),
      now,
    });
    expect(copy.tone).toBe("warning");
    expect(copy.headline).toBe("Discord was paged 2h ago");
    expect(copy.signals).toEqual(["Failed to scan"]);
  });

  it("still reads as paged when the stored row has no timestamp", () => {
    const copy = describeAlertState({
      state: "paged",
      firingSignals: [],
      lastPagedAt: null,
      now,
    });
    expect(copy.tone).toBe("warning");
    expect(copy.headline).toBe("Discord has been paged");
    expect(copy.detail).toMatch(/named no signals/i);
  });

  it("carries signals only for `paged`", () => {
    for (const state of ["never_paged", "cleared", "unreadable"] as const) {
      const copy = describeAlertState({
        state,
        firingSignals: ["awaitingReview"],
        lastPagedAt: now,
        now,
      });
      expect(copy.signals).toEqual([]);
    }
  });
});

describe("firingSignalLabel", () => {
  it("renames a signal it recognises", () => {
    expect(firingSignalLabel("awaitingReview")).toBe("Awaiting review");
  });

  it("passes an UNRECOGNISED name through verbatim", () => {
    // A stored fingerprint is a historical record written by an older deploy;
    // a signal that has since been renamed is exactly what an operator needs
    // to see rather than have silently dropped.
    expect(firingSignalLabel("someRetiredSignal")).toBe("someRetiredSignal");
  });

  it("never renders an empty segment as blank", () => {
    expect(firingSignalLabel("   ")).toBe("—");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Severity histogram
// ─────────────────────────────────────────────────────────────────────────────

describe("severityWindow", () => {
  it("is seven days, well inside the backend's 90-day cap", () => {
    const until = new Date("2026-09-12T12:00:00Z");
    const window = severityWindow(until);
    expect(window.until).toBe(until);
    expect(until.getTime() - window.since.getTime()).toBe(7 * 86_400_000);
  });
});

describe("severityThresholdIndex", () => {
  it("is null when the threshold is unknown — the chart then draws no rule", () => {
    expect(severityThresholdIndex(null)).toBeNull();
    expect(severityThresholdIndex(undefined)).toBeNull();
    expect(severityThresholdIndex(Number.NaN)).toBeNull();
  });

  it("CEILS, because the rule marks `at or above`", () => {
    expect(severityThresholdIndex(4)).toBe(4);
    expect(severityThresholdIndex(3.5)).toBe(4);
  });

  it("clamps a threshold outside the scale to an edge rather than dropping it", () => {
    expect(severityThresholdIndex(-2)).toBe(0);
    expect(severityThresholdIndex(99)).toBe(7);
  });

  it("passes the two EXACT edges through untouched", () => {
    // 0 and 7 are the two the chart treats specially — 0 puts the rule before
    // the first bar, and 7 is the ONLY value that reaches the `rule-end`
    // branch. Both are legal inputs, not clamps.
    expect(severityThresholdIndex(0)).toBe(0);
    expect(severityThresholdIndex(7)).toBe(7);
  });
});

describe("severityBars", () => {
  const buckets = [
    { severity: 0, count: 1200 },
    { severity: 1, count: 0 },
    { severity: 2, count: 30 },
    { severity: 3, count: 12 },
    { severity: 4, count: 1 },
    { severity: 5, count: 0 },
    { severity: 6, count: 0 },
  ];

  it("is always seven bars, even from a short payload", () => {
    expect(severityBars([{ severity: 2, count: 5 }], null)).toHaveLength(7);
  });

  it("never rounds a real row to an invisible bar", () => {
    // 1 beside 1,200 is 0.08% of the height, which paints nothing — and "is
    // anything sitting just under the line" is the one question this answers.
    const bars = severityBars(buckets, 4);
    expect(bars[4]?.count).toBe(1);
    expect(bars[4]?.heightPct).toBe(2);
  });

  it("leaves a zero bucket at zero height", () => {
    const bars = severityBars(buckets, 4);
    expect(bars[1]?.heightPct).toBe(0);
  });

  it("marks at-or-above the threshold as held", () => {
    const bars = severityBars(buckets, 4);
    expect(bars.filter((bar) => bar.held).map((bar) => bar.severity)).toEqual([
      4, 5, 6,
    ]);
    expect(severityHeldCount(bars)).toBe(1);
  });

  it("holds nothing when the threshold is unknown", () => {
    expect(severityBars(buckets, null).some((bar) => bar.held)).toBe(false);
  });

  it("survives an all-zero window without dividing by zero", () => {
    const bars = severityBars([], 4);
    expect(bars.every((bar) => bar.heightPct === 0)).toBe(true);
  });

  it("holds EVERY bucket at a threshold of 0", () => {
    // Nothing auto-approves: the whole distribution is on the held side.
    const bars = severityBars(buckets, 0);
    expect(bars.every((bar) => bar.held)).toBe(true);
    expect(severityHeldCount(bars)).toBe(1243);
  });

  it("holds NOTHING at a threshold of 7", () => {
    // A threshold above the scale. Every scan auto-approves, and the rule
    // parks past the last column rather than disappearing.
    const bars = severityBars(buckets, 7);
    expect(bars.some((bar) => bar.held)).toBe(false);
    expect(severityHeldCount(bars)).toBe(0);
  });
});

describe("describeSeveritySummary", () => {
  const bars = severityBars(
    [
      { severity: 0, count: 1000 },
      { severity: 4, count: 18 },
    ],
    4,
  );

  it("carries the exact numbers the bars deliberately do not", () => {
    expect(
      describeSeveritySummary({ scanned: 1018, bars, threshold: 4 }),
    ).toBe("1,018 scanned in the last 7 days · 18 at or above 4 (1.8%)");
  });

  it("omits the threshold clause when the threshold is unknown", () => {
    expect(
      describeSeveritySummary({ scanned: 1018, bars, threshold: null }),
    ).toBe("1,018 scanned in the last 7 days");
  });

  it("takes the share of the IN-RANGE total, not of `scanned`", () => {
    // `scanned` counts `outOfRange` rows, which no bar can contain — dividing
    // by it understated the held share whenever a provider wrote a severity
    // outside 0–6. The bars hold 1,018 in-range scans; the window scanned
    // 2,000. The share is 18/1,018 = 1.8%, NOT 18/2,000 = 0.9% — chosen far
    // enough apart that the two cannot round to the same string.
    expect(
      describeSeveritySummary({ scanned: 2000, bars, threshold: 4 }),
    ).toBe("2,000 scanned in the last 7 days · 18 at or above 4 (1.8%)");
  });

  it("never divides by a zero scan count", () => {
    expect(
      describeSeveritySummary({ scanned: 0, bars: severityBars([], 4), threshold: 4 }),
    ).toBe("0 scanned in the last 7 days");
  });
});

describe("describeOutOfRange", () => {
  it("is null in the expected state", () => {
    expect(describeOutOfRange([])).toBeNull();
    expect(describeOutOfRange([{ severity: 9, count: 0 }])).toBeNull();
  });

  it("says the chart's seven columns do NOT sum to `scanned`", () => {
    // Hiding these would read as a counting bug in the dashboard while the
    // real defect (a provider writing an out-of-range severity) goes unlooked-at.
    const line = describeOutOfRange([
      { severity: 9, count: 1 },
      { severity: 12, count: 1 },
    ]);
    expect(line).toBe(
      "2 scans scored outside 0–6 (severity 9, 12) and are not in the chart.",
    );
  });
});

describe("severityAriaLabel", () => {
  it("reads the whole distribution, since the bars carry no numbers", () => {
    const bars = severityBars([{ severity: 0, count: 2 }], 4);
    const label = severityAriaLabel({ scanned: 2, bars, threshold: 4 });
    expect(label).toContain("severity 0, 2");
    expect(label).toContain("severity 6, 0");
    expect(label).toContain("Review threshold 4");
  });

  it("says so plainly when nothing was scored", () => {
    expect(
      severityAriaLabel({ scanned: 0, bars: severityBars([], 4), threshold: 4 }),
    ).toMatch(/nothing was scored/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind breakdown
// ─────────────────────────────────────────────────────────────────────────────

describe("breakdownRows", () => {
  const byKind = {
    EVENT_HERO: { ...zeroCounts(), degradedRecent: 4 },
    AVATAR: zeroCounts(),
    BANNER: zeroCounts(),
    PAGE_MEDIA: zeroCounts(),
  };

  it("keeps all four kinds, including ones with five zeros", () => {
    const rows = breakdownRows({ byKind, unrecognizedKinds: zeroCounts() });
    expect(rows.map((row) => row.id)).toEqual([...MODERATION_KINDS]);
  });

  it("HIDES the unrecognized row only when it is genuinely empty", () => {
    const rows = breakdownRows({ byKind, unrecognizedKinds: zeroCounts() });
    expect(rows.some((row) => row.unrecognized)).toBe(false);
  });

  it("shows the unrecognized row when non-zero, or the columns would not add up", () => {
    const rows = breakdownRows({
      byKind,
      unrecognizedKinds: { ...zeroCounts(), orphanedRecent: 2 },
    });
    const last = rows.at(-1);
    expect(last?.id).toBe("UNRECOGNIZED");
    expect(last?.unrecognized).toBe(true);
    expect(last?.counts.orphanedRecent).toBe(2);
  });

  it("sums to the tiles, signal by signal", () => {
    const rows = breakdownRows({
      byKind,
      unrecognizedKinds: { ...zeroCounts(), degradedRecent: 1 },
    });
    for (const signal of QUEUE_SIGNALS) {
      const sum = rows.reduce((acc, row) => acc + row.counts[signal], 0);
      expect(sum).toBe(signal === "degradedRecent" ? 5 : 0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Key lookup
// ─────────────────────────────────────────────────────────────────────────────

describe("describeLookup", () => {
  it("treats a MISS as a finding, not an error", () => {
    const view = describeLookup({
      storageKey: "events/a/hero.jpg",
      found: false,
      item: null,
      withheld: NOTHING_WITHHELD,
    });
    expect(view).toEqual({ kind: "miss", storageKey: "events/a/hero.jpg" });
  });

  it("reports an un-reviewed content hold as WITHHELD, with the four safe fields", () => {
    const result: LookupResult = {
      storageKey: "events/a/hero.jpg",
      found: true,
      // Withheld fields are ABSENT, never null — that is the whole contract.
      item: {
        recordId: "rec-1",
        kind: "EVENT_HERO",
        requeues: 0,
        attempts: 1,
      },
      withheld: ALL_WITHHELD,
    };
    const view = describeLookup(result);
    expect(view.kind).toBe("withheld");
    if (view.kind !== "withheld") throw new Error("unreachable");
    expect(view.recordId).toBe("rec-1");
    expect(view.imageKind).toBe("Event hero");
    expect(view.requeues).toBe(0);
    expect(view.attempts).toBe(1);
  });

  it("NEVER stringifies an absent optional field", () => {
    // `String(undefined)` is the failure this contract exists to make
    // unreachable: an absent field must not render as the word "undefined".
    const view = describeLookup({
      storageKey: "k",
      found: true,
      item: { recordId: "rec-2", kind: "AVATAR", requeues: 0, attempts: 0 },
      withheld: NOTHING_WITHHELD,
    });
    expect(view.kind).toBe("detail");
    if (view.kind !== "detail") throw new Error("unreachable");
    expect(view.status).toBeNull();
    expect(view.degraded).toBeNull();
    expect(view.subjectType).toBeNull();
    expect(view.subjectId).toBeNull();
    expect(view.recordStorageKey).toBeNull();
    expect(view.lastError).toBeNull();
    expect(view.moderatedAt).toBeNull();
    expect(view.nextAttemptAt).toBeNull();
    expect(JSON.stringify(view)).not.toContain("undefined");
  });

  it("passes a full operational row through", () => {
    const moderatedAt = new Date("2026-09-12T10:00:00Z");
    const view = describeLookup({
      storageKey: "k",
      found: true,
      item: {
        recordId: "rec-3",
        kind: "BANNER",
        requeues: 2,
        attempts: 3,
        storageKey: "k",
        lastError: "boom",
        status: "ORPHANED",
        subjectType: "EVENT",
        subjectId: "evt-1",
        degraded: true,
        moderatedAt,
        nextAttemptAt: moderatedAt,
      },
      withheld: NOTHING_WITHHELD,
    });
    if (view.kind !== "detail") throw new Error("unreachable");
    expect(view.status).toBe("ORPHANED");
    expect(view.lastError).toBe("boom");
    expect(view.degraded).toBe(true);
    expect(view.moderatedAt).toBe(moderatedAt);
  });

  it("distinguishes a legitimately NULL lastError from a withheld one", () => {
    const view = describeLookup({
      storageKey: "k",
      found: true,
      item: {
        recordId: "rec-4",
        kind: "PAGE_MEDIA",
        requeues: 0,
        attempts: 1,
        status: "APPROVED",
        lastError: null,
      },
      withheld: NOTHING_WITHHELD,
    });
    if (view.kind !== "detail") throw new Error("unreachable");
    expect(view.lastError).toBeNull();
    expect(view.status).toBe("APPROVED");
  });
});

describe("normalizeStorageKeyInput / storageKeyInputProblem", () => {
  it("trims, and refuses nothing-at-all", () => {
    expect(normalizeStorageKeyInput("  a/b.jpg ")).toBe("a/b.jpg");
    expect(normalizeStorageKeyInput("   ")).toBeNull();
  });

  it("refuses a paste longer than R2's own key limit, with a sentence", () => {
    const tooLong = "x".repeat(1025);
    expect(normalizeStorageKeyInput(tooLong)).toBeNull();
    expect(storageKeyInputProblem(tooLong)).toMatch(/1024/);
  });

  it("says nothing about an empty or valid field", () => {
    expect(storageKeyInputProblem("")).toBeNull();
    expect(storageKeyInputProblem("a/b.jpg")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN gating of the two write actions
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveOpsWriteAccess", () => {
  it("allows only ADMIN", () => {
    expect(
      resolveOpsWriteAccess({ roles: ["ADMIN"], isError: false }),
    ).toBe("allowed");
  });

  it("DENIES a DEVELOPER — the persona that can read this page", () => {
    // The read gate is ADMIN or DEVELOPER; both mutations are ADMIN only.
    expect(
      resolveOpsWriteAccess({ roles: ["DEVELOPER"], isError: false }),
    ).toBe("denied");
    expect(
      resolveOpsWriteAccess({ roles: ["SUPPORT", "REVIEWER"], isError: false }),
    ).toBe("denied");
  });

  it("ERRS CLOSED while the role check is still in flight", () => {
    // An enabled button that 403s on press teaches an operator that the
    // console lies; a button that unlocks a moment later is harmless.
    expect(resolveOpsWriteAccess({ roles: undefined, isError: false })).toBe(
      "pending",
    );
    expect(canWriteOps("pending")).toBe(false);
  });

  it("ERRS CLOSED when the role check failed", () => {
    expect(resolveOpsWriteAccess({ roles: ["ADMIN"], isError: true })).toBe(
      "unknown",
    );
    expect(canWriteOps("unknown")).toBe(false);
  });

  it("only `allowed` can write", () => {
    expect(canWriteOps("allowed")).toBe(true);
    expect(canWriteOps("denied")).toBe(false);
  });

  it("gives every locked state a reason, and the allowed state none", () => {
    expect(opsWriteLockReason("allowed")).toBeNull();
    for (const access of ["pending", "denied", "unknown"] as const) {
      expect(opsWriteLockReason(access)).toBeTruthy();
    }
    // Denied and unknown are different facts and must not read the same.
    expect(opsWriteLockReason("denied")).not.toBe(
      opsWriteLockReason("unknown"),
    );
  });
});

describe("canRescanRow", () => {
  it("allows MACHINE states only", () => {
    expect(canRescanRow({ status: "PENDING", degraded: false })).toBe(true);
    expect(canRescanRow({ status: "ORPHANED", degraded: false })).toBe(true);
    // The scanner FAILED — exactly what a post-outage re-scan is for.
    expect(canRescanRow({ status: "FLAGGED", degraded: true })).toBe(true);
  });

  it("refuses anything a PERSON decided", () => {
    // Re-scanning would discard a moderator's decision and could put the image
    // back into circulation.
    expect(canRescanRow({ status: "APPROVED", degraded: false })).toBe(false);
    expect(canRescanRow({ status: "REJECTED", degraded: false })).toBe(false);
    // A real content hold awaiting a moderator.
    expect(canRescanRow({ status: "FLAGGED", degraded: false })).toBe(false);
  });
});

describe("signalShowsRowActions / canResolveSignal", () => {
  it("gives `awaitingReview` no actions at all", () => {
    // Its rows are FLAGGED and not degraded: `canRescanRow` refuses every one
    // of them and resolving does not apply, so the column would be dashes.
    expect(signalShowsRowActions("awaitingReview")).toBe(false);
    expect(canResolveSignal("awaitingReview")).toBe(false);
  });

  it("only `degradedExhausted` can be terminally resolved", () => {
    for (const signal of QUEUE_SIGNALS) {
      expect(canResolveSignal(signal)).toBe(signal === "degradedExhausted");
    }
  });

  it("every other bucket gets the column", () => {
    for (const signal of QUEUE_SIGNALS) {
      expect(signalShowsRowActions(signal)).toBe(signal !== "awaitingReview");
    }
  });
});

describe("canResolveWithThreshold", () => {
  it("refuses a cap below the automation's own", () => {
    // A client that could pass 1 would terminally resolve rows the requeue job
    // had not finished trying — what "exhausted" exists to rule out.
    expect(canResolveWithThreshold(2)).toBe(false);
    expect(canResolveWithThreshold(3)).toBe(true);
    expect(canResolveWithThreshold(10)).toBe(true);
  });

  it("refuses a non-integer cap", () => {
    expect(canResolveWithThreshold(3.5)).toBe(false);
  });
});

describe("describeResolveOutcome", () => {
  it("confirms a genuine transition and names the new status", () => {
    const copy = describeResolveOutcome({
      resolved: true,
      status: "ORPHANED",
      reason: "resolved",
    });
    expect(copy.tone).toBe("success");
    expect(copy.message).toContain("ORPHANED");
  });

  it("renders `not_eligible` as INFORMATION, never an error", () => {
    // Someone else resolved it first, or it no longer matches. Normal.
    const copy = describeResolveOutcome({
      resolved: false,
      status: "APPROVED",
      reason: "not_eligible",
    });
    expect(copy.tone).toBe("info");
    expect(copy.message).toContain("APPROVED");
    expect(copy.message).not.toMatch(/error|failed/i);
  });
});

describe("describeRescanOutcome", () => {
  it("confirms a requeue", () => {
    const copy = describeRescanOutcome({
      requeued: true,
      status: "PENDING",
      reason: "requeued",
    });
    expect(copy.tone).toBe("success");
    expect(copy.message).toMatch(/PENDING/);
  });

  it("words `human_decided` as a DELIBERATE REFUSAL, not a failure", () => {
    const copy = describeRescanOutcome({
      requeued: false,
      status: "REJECTED",
      reason: "human_decided",
    });
    expect(copy.tone).toBe("info");
    expect(copy.message).toMatch(/refused on purpose/i);
    expect(copy.message).toContain("REJECTED");
  });

  it("covers every status the refusal can come back with", () => {
    const statuses: ModerationRecordStatus[] = [
      "PENDING",
      "APPROVED",
      "FLAGGED",
      "REJECTED",
      "ORPHANED",
    ];
    for (const status of statuses) {
      const copy = describeRescanOutcome({
        requeued: false,
        status,
        reason: "human_decided",
      });
      expect(copy.message).toContain(status);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Drift pin: the requeue floor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk up from the vitest cwd to the repo root and read a core source file.
 *
 * `readFileSync` rather than an import, for the same reason the jobs-manifest
 * check in the sibling test file does it: `packages/core` is outside the web
 * tsconfig's program, and pulling it through the module graph would drag
 * another package into this app's typecheck for a fixture. Same walker shape.
 */
function readRepoFile(...segments: string[]): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, ...segments);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`${segments.join("/")} not found from ${process.cwd()}`);
}

describe("MIN_RESOLVABLE_REQUEUES — pinned to the server floor", () => {
  /**
   * A LITERAL ASSERTED AGAINST ITSELF CANNOT CATCH DRIFT, which is the only
   * failure this constant has. The server went out of its way NOT to copy the
   * number — it parses it out of the shared window shape so it cannot diverge
   * from the requeue job's cap — and then `apps/web` copies it anyway, because
   * this app does not import core. These two reads are what make that copy
   * safe: move either side and this fails.
   */
  it("equals the default the shared window shape declares", () => {
    const shape = readRepoFile(
      "packages",
      "core",
      "src",
      "use-cases",
      "moderation",
      "_shared",
      "queue-health-window.ts",
    );
    const match = shape.match(
      /maxRequeues:\s*z\.number\(\)\.int\(\)\.positive\(\)\.default\((\d+)\)/,
    );
    expect(match, "maxRequeues default not found in queue-health-window.ts")
      .not.toBeNull();
    expect(Number(match?.[1])).toBe(MIN_RESOLVABLE_REQUEUES);
  });

  it("is still DERIVED server-side, not hard-coded there too", () => {
    // If someone replaces the parse with a literal, the server's own
    // anti-drift guarantee is gone and this mirror is no longer safe to keep.
    const useCase = readRepoFile(
      "packages",
      "core",
      "src",
      "use-cases",
      "moderation",
      "resolve-unscannable-image.ts",
    );
    expect(useCase).toContain(
      "moderationQueueHealthWindowShape.maxRequeues.parse(undefined)",
    );
    expect(useCase).toContain("z.number().int().min(MIN_RESOLVABLE_REQUEUES)");
  });
});
