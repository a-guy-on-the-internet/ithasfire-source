import { describe, expect, it, vi } from "vitest";

import type { ImageModerationRecord } from "@th/ports/repos/image-moderation-records";

import {
  drainImageModerations,
  type DrainImageModerationsDeps,
} from "../drain-image-moderations";
import type { ModerateImageOutput } from "../moderate-image";

/**
 * Drain-loop behaviour of the image-moderation drain. The fake `claimDue`
 * behaves like the SQL: PENDING rows whose `nextAttemptAt <= now`, oldest
 * first, capped at `limit`, and the bookkeeping writes move rows out of that
 * set.
 */

const NOW = new Date("2026-09-30T12:00:00.000Z");

function record(i: number): ImageModerationRecord {
  return {
    id: `rec-${i}`,
    storageKey: `events/e/images/${i}.png`,
    kind: "EVENT_HERO",
    status: "PENDING",
    subjectType: "EVENT",
    subjectId: "e",
    publicUrl: null,
    contentType: "image/png",
    createdByHumanId: null,
    maxSeverity: null,
    categories: null,
    provider: null,
    degraded: false,
    moderatedAt: null,
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date(NOW.getTime() - 1000),
    createdAt: NOW,
    updatedAt: NOW,
  } as ImageModerationRecord;
}

function makeDeps(rows: ImageModerationRecord[], moderateImage: (key: string) => Promise<ModerateImageOutput>) {
  const byKey = new Map(rows.map((r) => [r.storageKey, r]));
  const claimDue = vi.fn(async ({ now, limit }: { now: Date; limit: number }) =>
    rows
      .filter((r) => r.status === "PENDING" && r.nextAttemptAt <= now)
      .slice(0, limit)
      .map((r) => ({ ...r })),
  );
  const markResult = vi.fn(async (input: { storageKey: string; status: string }) => {
    const r = byKey.get(input.storageKey);
    if (r) r.status = input.status as ImageModerationRecord["status"];
  });
  const markFailed = vi.fn(async (input: { id: string; nextAttemptAt: Date }) => {
    const r = rows.find((x) => x.id === input.id);
    if (r) {
      r.attempts += 1;
      r.nextAttemptAt = input.nextAttemptAt;
    }
  });
  const logger: any = {
    child: vi.fn(() => logger),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    withTime: vi.fn(),
  };
  const deps: DrainImageModerationsDeps = {
    repos: {
      imageModerationRecords: { claimDue, markResult, markFailed },
      events: { getById: vi.fn(async () => null) },
    } as any,
    moderateImage: async (key) => {
      const out = await moderateImage(key);
      // moderate-image writes the verdict itself in production.
      const r = byKey.get(key);
      if (r && !out.noop && out.status !== "PENDING") r.status = out.status;
      return out;
    },
    clock: { now: () => NOW },
    logger,
  };
  return { deps, claimDue, markFailed };
}

const APPROVED = async (): Promise<ModerateImageOutput> => ({
  status: "APPROVED",
  maxSeverity: 0,
  degraded: false,
  noop: false,
});

describe("drainImageModerations — drain loop", () => {
  it("moderates a backlog bigger than one batch in ONE run", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => record(i));
    const { deps, claimDue } = makeDeps(rows, APPROVED);

    const out = await drainImageModerations(deps, { limit: 2 });

    expect(out).toMatchObject({ processed: 5, moderated: 5, passes: 3, hasMore: false });
    expect(claimDue).toHaveBeenCalledTimes(3);
  });

  it("stops after a pass in which the provider failed (retry scheduled, not hammered)", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => record(i));
    const moderate = vi.fn(async (key: string) => {
      if (key.endsWith("/1.png")) throw new Error("azure 503");
      return APPROVED();
    });
    const { deps, markFailed } = makeDeps(rows, moderate);

    const out = await drainImageModerations(deps, { limit: 2 });

    expect(out).toMatchObject({ passes: 1, retried: 1, moderated: 1, hasMore: false });
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(moderate).toHaveBeenCalledTimes(2);
  });

  it("hands off (hasMore) when maxPasses stops it with rows still due", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => record(i));
    const { deps } = makeDeps(rows, APPROVED);

    const out = await drainImageModerations(deps, { limit: 2, maxPasses: 1 });

    expect(out).toMatchObject({ passes: 1, hasMore: true, moderated: 2 });
  });
});

describe("drainImageModerations — a row that throws outside the moderate call", () => {
  it("is charged an attempt with backoff and reported, so it no longer heads every run", async () => {
    const rows = [record(0)];
    const { deps, markFailed } = makeDeps(rows, async () => {
      throw new Error("azure 503");
    });
    const reportError = vi.fn();
    deps.reportError = reportError;
    // The ordinary retry bookkeeping throws once, so the error escapes
    // processRecord into the outer guard.
    markFailed.mockRejectedValueOnce(new Error("db blip"));

    await drainImageModerations(deps, {});

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db blip" }),
      expect.objectContaining({
        tags: { area: "image-moderation", reason: "row-unhandled" },
      }),
    );
    // Charged on the second try: the row is pushed out of claimDue.
    expect(markFailed).toHaveBeenCalledTimes(2);
    expect(rows[0]!.nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("drainImageModerations — scheduled origin marker", () => {
  it("accepts the safety net's { origin: 'schedule' } body under the strict input schema", async () => {
    const { deps } = makeDeps([record(0)], APPROVED);
    const out = await drainImageModerations(deps, { origin: "schedule" });
    expect(out.moderated).toBe(1);
  });
});
