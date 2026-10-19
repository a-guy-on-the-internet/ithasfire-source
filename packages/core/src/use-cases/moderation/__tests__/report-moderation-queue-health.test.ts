import { describe, expect, it, vi } from "vitest";

import type { ModerationQueueHealth } from "@th/ports/repos/image-moderation-records";

import {
  reportModerationQueueHealth,
  type ReportModerationQueueHealthDeps,
} from "../report-moderation-queue-health";

const NOW = new Date("2026-08-20T18:00:00.000Z");

const HEALTHY: ModerationQueueHealth = {
  pendingOverdue: 0,
  awaitingReview: 0,
  degradedRecent: 0,
  degradedExhausted: 0,
  orphanedRecent: 0,
};

function makeDeps(counts: Partial<ModerationQueueHealth> = {}): {
  deps: ReportModerationQueueHealthDeps;
  countQueueHealth: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const countQueueHealth = vi.fn(async () => ({ ...HEALTHY, ...counts }));
  const warn = vi.fn();
  const child = {
    child: vi.fn(function (this: unknown) {
      return this;
    }),
    withTime: vi.fn(async (_n: string, f: () => Promise<unknown>) => f()),
    log: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  // Edge-trigger state store. These tests are about the COUNTING and the
  // problem copy, so each one starts from an empty store — meaning every
  // unhealthy run here is a first sighting and always alerts. The gating
  // itself is pinned in report-moderation-queue-health-alert-gating.test.ts.
  const settings = new Map<string, string>();
  const platformSettings = {
    get: vi.fn(async (key: string) =>
      settings.has(key)
        ? {
            key,
            value: settings.get(key)!,
            updatedAt: NOW,
            createdAt: NOW,
          }
        : null,
    ),
    getAll: vi.fn(async () => []),
    upsert: vi.fn(async (key: string, value: string) => {
      settings.set(key, value);
      return { key, value, updatedAt: NOW, createdAt: NOW };
    }),
  };
  const deps: ReportModerationQueueHealthDeps = {
    repos: { imageModerationRecords: { countQueueHealth }, platformSettings } as any,
    clock: { now: () => NOW } as any,
    logger: { ...child, child: () => child } as any,
  };
  return { deps, countQueueHealth, warn };
}

describe("reportModerationQueueHealth", () => {
  it("is silent when every count is zero", async () => {
    // No heartbeat, by design: an hourly job that reports a clean bill of health
    // forever trains everyone to ignore it, which is how the August 2026
    // provider outage stayed invisible for two weeks.
    const { deps, warn } = makeDeps();

    const out = await reportModerationQueueHealth(deps);

    expect(out.unhealthy).toBe(false);
    expect(out.problems).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("flags a dead drain when images are overdue for scanning", async () => {
    const { deps, warn } = makeDeps({ pendingOverdue: 7 });

    const out = await reportModerationQueueHealth(deps);

    expect(out.unhealthy).toBe(true);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toMatch(/drain job may not be running/);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("flags a failing provider separately from a rotting review queue", async () => {
    // The two must never collapse into one number — a dead scanner and an
    // unattended moderator queue call for completely different responses.
    const { deps } = makeDeps({ degradedRecent: 3, awaitingReview: 2 });

    const out = await reportModerationQueueHealth(deps);

    expect(out.problems).toHaveLength(2);
    expect(out.problems.join(" ")).toMatch(/provider is failing/);
    expect(out.problems.join(" ")).toMatch(/awaiting human review/);
  });

  it("names the uploader-silence consequence in the review-backlog message", async () => {
    // Under silence-unless-removal this alert is the ONLY thing standing
    // between a held image and an indefinite wait. If someone later softens
    // this copy, they should have to delete that sentence deliberately.
    const { deps } = makeDeps({ awaitingReview: 1 });

    const out = await reportModerationQueueHealth(deps);

    expect(out.problems[0]).toMatch(/NOT\s+emailed/);
  });

  it("derives every cutoff from the injected clock, not wall time", async () => {
    const { deps, countQueueHealth } = makeDeps();

    await reportModerationQueueHealth(deps, {
      pendingOverdueMinutes: 60,
      awaitingReviewHours: 24,
      degradedWindowMinutes: 120,
      maxRequeues: 3,
    });

    expect(countQueueHealth).toHaveBeenCalledWith({
      pendingDueBefore: new Date("2026-08-20T17:00:00.000Z"),
      moderatedBefore: new Date("2026-08-19T18:00:00.000Z"),
      degradedSince: new Date("2026-08-20T16:00:00.000Z"),
      maxRequeues: 3,
    });
  });

  it("holds no alerting transport — it returns problems and a verdict for the caller to send", async () => {
    // Keeps the webhook out of core. Core decides WHETHER to page (it owns the
    // suppression state); the job layer decides what a page looks like. This
    // stays testable without a transport.
    const { deps } = makeDeps({ pendingOverdue: 1 });

    const out = await reportModerationQueueHealth(deps);

    expect(Object.keys(out).sort()).toEqual([
      "alertReason",
      "counts",
      "fingerprint",
      "problems",
      "shouldAlert",
      "unhealthy",
    ]);
  });

  it("flags objects vanishing from storage, naming the terminal consequence", async () => {
    // ORPHANED appears on NO other surface — not the review queue, not the
    // requeue job — so this count is its only operational signal. Without it,
    // a storage fault that terminally hides images is visible in Sentry alone,
    // which is precisely the channel that went unread for two weeks.
    const { deps, warn } = makeDeps({ orphanedRecent: 12 });

    const out = await reportModerationQueueHealth(deps);

    expect(out.unhealthy).toBe(true);
    expect(out.counts.orphanedRecent).toBe(12);
    const line = out.problems.find((p) => p.includes("ORPHANED"));
    expect(line).toBeDefined();
    expect(line).toContain("12 image(s)");
    // The message must tell the operator what to check, not just report a number.
    expect(line).toMatch(/terminal and hidden/i);
    expect(line).toMatch(/bucket configuration/i);
    expect(warn).toHaveBeenCalled();
  });

  it("keeps the orphan count separate from the degraded counts", async () => {
    // Different causes, different fixes: degraded means "we could not SCAN
    // bytes that exist" (chase the vendor); orphaned means "the bytes are
    // gone" (check storage). Collapsing them would send operators to the wrong
    // system.
    const { deps } = makeDeps({ degradedRecent: 3, orphanedRecent: 4 });

    const out = await reportModerationQueueHealth(deps);

    expect(out.counts).toMatchObject({ degradedRecent: 3, orphanedRecent: 4 });
    expect(out.problems).toHaveLength(2);
    expect(out.problems.filter((p) => p.includes("ORPHANED"))).toHaveLength(1);
  });
});
