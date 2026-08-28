import { describe, expect, it } from "vitest";

import {
  CAPACITY_WORD,
  capacityBand,
  planStatsStrip,
} from "@th/ui-native/stats-strip-plan";

/**
 * FR-005 — the strip's collapse ladder at 320 / 375 / 430.
 *
 * The design's own arithmetic puts the naive worst case at 456pt against a
 * 375pt screen, so "does it fit" is a real question with a designed answer.
 * These assertions pin the ORDER of the collapse, not just the outcome: which
 * thing gives way first is the whole decision.
 *
 * Lives in `apps/scanner` rather than `packages/ui-native` for the same reason
 * as `tone-contrast.test.ts` — no workflow runs the package's suite.
 */

const WIDTHS = [320, 375, 430] as const;

const base = {
  scanned: 128,
  total: 450,
  band: "normal" as const,
  offline: false,
  queueDepth: 0,
};

describe("capacityBand", () => {
  it("matches Home's 90% / 100% thresholds exactly", () => {
    expect(capacityBand(0, 450)).toBe("normal");
    expect(capacityBand(404, 450)).toBe("normal");
    expect(capacityBand(405, 450)).toBe("near"); // 90.0%
    expect(capacityBand(449, 450)).toBe("near");
    expect(capacityBand(450, 450)).toBe("at");
    expect(capacityBand(451, 450)).toBe("at");
  });

  it("does not divide by zero on an event with no tickets", () => {
    expect(capacityBand(0, 0)).toBe("normal");
  });
});

describe("planStatsStrip", () => {
  it("keeps the full counter label when nothing else is live", () => {
    for (const width of WIDTHS) {
      const plan = planStatsStrip({ ...base, width });
      expect(plan.counter.showWord, `${width}`).toBe(true);
      expect(plan.chips).toHaveLength(0);
      expect(plan.estimatedWidth).toBeLessThanOrEqual(width);
    }
  });

  it("never renders offline AND queue as two chips (rule 2)", () => {
    const plan = planStatsStrip({
      ...base,
      width: 430,
      offline: true,
      queueDepth: 3,
    });
    expect(plan.chips.filter((c) => c.id === "sync")).toHaveLength(1);
    expect(plan.chips).toHaveLength(1);
  });

  it("shows the sync chip for a queue backlog even when online", () => {
    const plan = planStatsStrip({ ...base, width: 430, queueDepth: 2 });
    expect(plan.chips[0]).toMatchObject({
      id: "sync",
      label: "QUEUED",
      count: 2,
    });
  });

  it("collapses the SYNC label before the counter word (priority order)", () => {
    // FAILED outranks everything: it is the only signal that means someone got
    // in and the server does not know.
    const plan = planStatsStrip({
      width: 375,
      scanned: 128,
      total: 450,
      band: "normal",
      offline: true,
      queueDepth: 3,
      failedCount: 2,
      expressEnabled: true,
    });
    const failed = plan.chips.find((c) => c.id === "failed");
    const sync = plan.chips.find((c) => c.id === "sync");
    expect(failed?.label).toBe("FAILED");
    expect(sync?.label).toBeNull();
    expect(sync?.count).toBe(3);
    expect(plan.estimatedWidth).toBeLessThanOrEqual(375);
  });

  it("drops the counter WORD as the second step, at 320", () => {
    const plan = planStatsStrip({
      width: 320,
      scanned: 128,
      total: 450,
      band: "normal",
      offline: true,
      queueDepth: 3,
      failedCount: 2,
      expressEnabled: true,
    });
    expect(plan.counter.showWord).toBe(false);
    // The numerals never go — they are the metric.
    expect(plan.counter.value).toBe("128 / 450");
    expect(plan.chips.find((c) => c.id === "failed")?.label).toBe("FAILED");
    expect(plan.estimatedWidth).toBeLessThanOrEqual(320);
  });

  it("fits at every tested width with every condition live", () => {
    for (const width of WIDTHS) {
      const plan = planStatsStrip({
        width,
        scanned: 450,
        total: 450,
        band: "at",
        offline: true,
        queueDepth: 12,
        failedCount: 4,
        expressEnabled: true,
      });
      expect(plan.estimatedWidth, `${width}`).toBeLessThanOrEqual(width);
      // FAILED keeps its glyph and count even at its most collapsed.
      expect(plan.chips.find((c) => c.id === "failed")?.count).toBe(4);
    }
  });

  it("uses the capacity band's word, so the strip and Home say the same thing", () => {
    expect(CAPACITY_WORD.normal).toBe("ADMITTED");
    expect(
      planStatsStrip({ ...base, width: 430, band: "near" }).counter.word,
    ).toBe("NEAR CAPACITY");
    expect(
      planStatsStrip({ ...base, width: 430, band: "at" }).counter.word,
    ).toBe("AT CAPACITY");
  });

  it("shows express as an icon only — it is a mode, not a metric", () => {
    const plan = planStatsStrip({ ...base, width: 375, expressEnabled: true });
    expect(plan.showExpress).toBe(true);
    // No chip is created for it at any width.
    expect(plan.chips.map((c) => c.id)).not.toContain("express");
  });
});
