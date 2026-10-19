import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { PendingObjectDeletionRecord } from "@th/ports/repos/pending-object-deletions";

// The constant discardPageDraft writes (re-exported there), so the test
// pins the writer's value, not a copy.
import { PAGE_DRAFT_DISCARD_DELETION_SOURCE } from "../../entity-pages/page-draft-shared";
import {
  drainPendingDeletions,
  type DrainPendingDeletionsDeps,
} from "../drain-pending-deletions";

const NOW = new Date("2026-06-30T12:00:00.000Z");

function buildRecord(
  overrides: Partial<PendingObjectDeletionRecord> = {},
): PendingObjectDeletionRecord {
  return {
    id: "pod-1",
    targetKey: "events/evt-1/images/img-1.jpg",
    targetKind: "KEY",
    status: "PENDING",
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date("2026-06-30T11:00:00.000Z"),
    source: "event_delete",
    sourceId: "evt-1",
    createdAt: new Date("2026-06-30T10:00:00.000Z"),
    updatedAt: new Date("2026-06-30T10:00:00.000Z"),
    ...overrides,
  };
}

function createDeps(due: PendingObjectDeletionRecord[]) {
  const pendingObjectDeletions = {
    enqueueMany: vi.fn(async () => undefined),
    listDue: vi.fn(async () => due),
    // markDeleted returns the affected-row count: 1 = this run drained it.
    markDeleted: vi.fn(async () => 1),
    markFailed: vi.fn(async () => undefined),
    markDead: vi.fn(async () => undefined),
  };
  const fileStorage = {
    deleteObject: vi.fn(async () => ({ ok: true as const })),
    listObjects: vi.fn(async () => ({ keys: [], nextCursor: undefined })),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const clock: ClockPort = { now: vi.fn(() => NOW) };

  const deps: DrainPendingDeletionsDeps = {
    repos: {
      pendingObjectDeletions,
    } as unknown as DrainPendingDeletionsDeps["repos"],
    fileStorage: fileStorage as unknown as DrainPendingDeletionsDeps["fileStorage"],
    logger: logger as unknown as DrainPendingDeletionsDeps["logger"],
    clock,
  };

  return { deps, mocks: { pendingObjectDeletions, fileStorage, logger } };
}

describe("drainPendingDeletions", () => {
  it("no-ops on an empty due list", async () => {
    const { deps, mocks } = createDeps([]);

    const result = await drainPendingDeletions(deps, {});

    expect(result).toEqual({
      processed: 0,
      deleted: 0,
      retried: 0,
      deadLettered: 0,
      unhandled: 0,
      skippedStillReferenced: 0,
      passes: 1,
      hasMore: false,
    });
    expect(mocks.fileStorage.deleteObject).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markDeleted).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith("drain.completed", result);
  });

  it("KEY happy path: deletes the object and removes the outbox row", async () => {
    const record = buildRecord({
      id: "pod-key",
      targetKind: "KEY",
      targetKey: "uploads/audio/aud-1.mp3",
    });
    const { deps, mocks } = createDeps([record]);

    const result = await drainPendingDeletions(deps, {});

    expect(mocks.fileStorage.deleteObject).toHaveBeenCalledTimes(1);
    expect(mocks.fileStorage.deleteObject).toHaveBeenCalledWith({
      key: "uploads/audio/aud-1.mp3",
    });
    expect(mocks.fileStorage.listObjects).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markDeleted).toHaveBeenCalledWith(
      "pod-key",
    );
    expect(result).toEqual({
      processed: 1,
      deleted: 1,
      retried: 0,
      deadLettered: 0,
      unhandled: 0,
      skippedStillReferenced: 0,
      passes: 1,
      hasMore: false,
    });
  });

  it("PREFIX happy path: paginates listObjects and deletes every key", async () => {
    const record = buildRecord({
      id: "pod-prefix",
      targetKind: "PREFIX",
      targetKey: "events/evt-1/audio/aud-1/",
    });
    const { deps, mocks } = createDeps([record]);
    mocks.fileStorage.listObjects
      .mockResolvedValueOnce({
        keys: [
          { key: "events/evt-1/audio/aud-1/audio.m3u8" },
          { key: "events/evt-1/audio/aud-1/segment0.ts" },
        ],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        keys: [{ key: "events/evt-1/audio/aud-1/segment1.ts" }],
        nextCursor: undefined,
      });

    const result = await drainPendingDeletions(deps, {});

    // Two list pages, scoped to the prefix with the port's max page size.
    expect(mocks.fileStorage.listObjects).toHaveBeenCalledTimes(2);
    expect(mocks.fileStorage.listObjects).toHaveBeenNthCalledWith(1, {
      prefix: "events/evt-1/audio/aud-1/",
      cursor: undefined,
      limit: 1000,
    });
    expect(mocks.fileStorage.listObjects).toHaveBeenNthCalledWith(2, {
      prefix: "events/evt-1/audio/aud-1/",
      cursor: "page-2",
      limit: 1000,
    });

    const deletedKeys = mocks.fileStorage.deleteObject.mock.calls.map(
      (c) => (c[0] as { key: string }).key,
    );
    expect(deletedKeys).toEqual([
      "events/evt-1/audio/aud-1/audio.m3u8",
      "events/evt-1/audio/aud-1/segment0.ts",
      "events/evt-1/audio/aud-1/segment1.ts",
    ]);
    expect(mocks.pendingObjectDeletions.markDeleted).toHaveBeenCalledWith(
      "pod-prefix",
    );
    expect(result).toEqual({
      processed: 1,
      deleted: 1,
      retried: 0,
      deadLettered: 0,
      unhandled: 0,
      skippedStillReferenced: 0,
      passes: 1,
      hasMore: false,
    });
  });

  it("failure → markFailed with exponential backoff nextAttemptAt", async () => {
    // attempts = 2 already; this failure makes attempts = 3, so backoff is
    // baseBackoffSeconds * 2^(3-1) = 60 * 4 = 240s.
    const record = buildRecord({ id: "pod-fail", attempts: 2 });
    const { deps, mocks } = createDeps([record]);
    mocks.fileStorage.deleteObject.mockRejectedValueOnce(new Error("R2 down"));

    const result = await drainPendingDeletions(deps, {
      baseBackoffSeconds: 60,
      maxAttempts: 8,
      maxBackoffSeconds: 21_600,
    });

    expect(mocks.pendingObjectDeletions.markDead).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markDeleted).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markFailed).toHaveBeenCalledTimes(1);
    const failArg = mocks.pendingObjectDeletions.markFailed.mock.calls[0][0] as {
      id: string;
      lastError: string;
      nextAttemptAt: Date;
    };
    expect(failArg.id).toBe("pod-fail");
    expect(failArg.lastError).toContain("R2 down");
    expect(failArg.nextAttemptAt.getTime()).toBe(NOW.getTime() + 240 * 1000);
    expect(result).toEqual({
      processed: 1,
      deleted: 0,
      retried: 1,
      deadLettered: 0,
      unhandled: 0,
      skippedStillReferenced: 0,
      passes: 1,
      hasMore: false,
    });
  });

  it("caps the backoff at maxBackoffSeconds", async () => {
    // attempts becomes 7; 60 * 2^6 = 3840s, still under the 6h cap, so cap with
    // a small max to force clamping: maxBackoffSeconds = 100 → expect 100s.
    const record = buildRecord({ id: "pod-cap", attempts: 6 });
    const { deps, mocks } = createDeps([record]);
    mocks.fileStorage.deleteObject.mockRejectedValueOnce(new Error("boom"));

    await drainPendingDeletions(deps, {
      baseBackoffSeconds: 60,
      maxAttempts: 8,
      maxBackoffSeconds: 100,
    });

    const failArg = mocks.pendingObjectDeletions.markFailed.mock.calls[0][0] as {
      nextAttemptAt: Date;
    };
    expect(failArg.nextAttemptAt.getTime()).toBe(NOW.getTime() + 100 * 1000);
  });

  it("reaching maxAttempts → markDead + error log", async () => {
    // attempts = 7; this failure makes attempts = 8 === maxAttempts → dead.
    const record = buildRecord({ id: "pod-dead", attempts: 7 });
    const { deps, mocks } = createDeps([record]);
    mocks.fileStorage.deleteObject.mockRejectedValueOnce(new Error("gone"));

    const result = await drainPendingDeletions(deps, { maxAttempts: 8 });

    expect(mocks.pendingObjectDeletions.markFailed).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markDead).toHaveBeenCalledTimes(1);
    const deadArg = mocks.pendingObjectDeletions.markDead.mock.calls[0][0] as {
      id: string;
      lastError: string;
    };
    expect(deadArg.id).toBe("pod-dead");
    expect(deadArg.lastError).toContain("gone");
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "drain.dead_letter",
      expect.objectContaining({ id: "pod-dead", attempts: 8 }),
    );
    expect(result).toEqual({
      processed: 1,
      deleted: 0,
      retried: 0,
      deadLettered: 1,
      unhandled: 0,
      skippedStillReferenced: 0,
      passes: 1,
      hasMore: false,
    });
  });

  it("a dead letter is reported (terminal: nothing retries it)", async () => {
    const record = buildRecord({
      id: "pod-dead",
      attempts: 7,
      source: "event_image_upload_original",
      sourceId: "image-1",
    });
    const { deps, mocks } = createDeps([record]);
    const boom = new Error("gone");
    mocks.fileStorage.deleteObject.mockRejectedValueOnce(boom);
    const reportError = vi.fn();

    await drainPendingDeletions({ ...deps, reportError }, { maxAttempts: 8 });

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: {
        job: "storage.drain-pending-deletions",
        step: "dead_letter",
        source: "event_image_upload_original",
      },
      extra: expect.objectContaining({
        id: "pod-dead",
        targetKey: record.targetKey,
        attempts: 8,
        sourceId: "image-1",
      }),
    });
  });

  it("a retried failure is not reported, and a throwing reporter changes nothing", async () => {
    const retried = buildRecord({ id: "pod-retry", attempts: 0 });
    const dead = buildRecord({ id: "pod-dead", attempts: 7 });
    const { deps, mocks } = createDeps([retried, dead]);
    mocks.fileStorage.deleteObject.mockRejectedValue(new Error("down"));
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    const result = await drainPendingDeletions({ ...deps, reportError }, { maxAttempts: 8 });

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ retried: 1, deadLettered: 1 });
  });

  it("one failing item does not abort the batch", async () => {
    const failing = buildRecord({
      id: "pod-bad",
      targetKey: "uploads/audio/bad.mp3",
    });
    const ok = buildRecord({
      id: "pod-good",
      targetKey: "uploads/audio/good.mp3",
    });
    const { deps, mocks } = createDeps([failing, ok]);
    mocks.fileStorage.deleteObject
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ ok: true as const });

    const result = await drainPendingDeletions(deps, {});

    // Both rows examined; the good one still deleted despite the bad one failing.
    expect(result).toEqual({
      processed: 2,
      deleted: 1,
      retried: 1,
      deadLettered: 0,
      unhandled: 0,
      skippedStillReferenced: 0,
      passes: 1,
      hasMore: false,
    });
    expect(mocks.pendingObjectDeletions.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pod-bad" }),
    );
    expect(mocks.pendingObjectDeletions.markDeleted).toHaveBeenCalledWith(
      "pod-good",
    );
  });

  // ── Concurrency / idempotent-bookkeeping regressions ──────────────────────
  // Without a lease, two overlapping runs (e.g. Cloud Scheduler at-least-once
  // retry overlapping a slow PREFIX drain) can claim the same row. The
  // bookkeeping must be idempotent and a single row must never abort the batch.

  /** Builds an error shaped like Prisma's "record not found" (P2025). */
  function p2025(): Error {
    return Object.assign(new Error("Record to delete does not exist."), {
      code: "P2025",
    });
  }

  it("treats markDeleted's 0-row result (peer already drained) as already-handled — no failure path, no double-count", async () => {
    const drainedByPeer = buildRecord({
      id: "pod-peer",
      targetKey: "uploads/audio/peer.mp3",
    });
    const mine = buildRecord({
      id: "pod-mine",
      targetKey: "uploads/audio/mine.mp3",
    });
    const { deps, mocks } = createDeps([drainedByPeer, mine]);
    // First row: a peer already removed the outbox row → deleteMany affects 0.
    // Second row: this run drains it → affects 1.
    mocks.pendingObjectDeletions.markDeleted
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);

    const result = await drainPendingDeletions(deps, {});

    // The 0-row row is NOT counted as deleted and does NOT enter the failure
    // path; the second row still processes normally.
    expect(result).toEqual({
      processed: 2,
      deleted: 1,
      retried: 0,
      deadLettered: 0,
      unhandled: 0,
      skippedStillReferenced: 0,
      passes: 1,
      hasMore: false,
    });
    expect(mocks.pendingObjectDeletions.markFailed).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markDead).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "drain.already_drained",
      expect.objectContaining({ id: "pod-peer" }),
    );
  });

  it("does NOT abort the batch when a bookkeeping call rejects (P2025) — remaining items still process", async () => {
    // This is the regression test for the original bug: a P2025 from the
    // success-path markDeleted (row drained by a peer between listDue and the
    // delete) must not propagate out of the per-item loop and kill the batch.
    const racy = buildRecord({
      id: "pod-racy",
      targetKey: "uploads/audio/racy.mp3",
    });
    const next = buildRecord({
      id: "pod-next",
      targetKey: "uploads/audio/next.mp3",
    });
    const { deps, mocks } = createDeps([racy, next]);
    // deleteObject succeeds for both rows; the FIRST markDeleted throws P2025.
    mocks.pendingObjectDeletions.markDeleted
      .mockRejectedValueOnce(p2025())
      .mockResolvedValueOnce(1);

    const result = await drainPendingDeletions(deps, {});

    // Batch did NOT abort: the second row was still examined and drained.
    expect(result.processed).toBe(2);
    expect(result.deleted).toBe(1); // only the second row counted
    // The racy row's bookkeeping throw must NOT be misclassified as a delete
    // failure → no retry / dead-letter for it.
    expect(mocks.pendingObjectDeletions.markFailed).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markDead).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "drain.item_unhandled_error",
      expect.objectContaining({ id: "pod-racy" }),
    );
    expect(result.unhandled).toBe(1);
    // The second row drained normally.
    expect(mocks.pendingObjectDeletions.markDeleted).toHaveBeenNthCalledWith(
      2,
      "pod-next",
    );
  });

  it("does NOT abort the batch when the failure-path bookkeeping (markFailed) rejects", async () => {
    // deleteObject fails → failure path → markFailed throws (e.g. the row was
    // dead-lettered/drained by a peer). The throw must be contained, not abort
    // the batch, and the next row must still process.
    const failing = buildRecord({
      id: "pod-bookkeep-fail",
      targetKey: "uploads/audio/bad.mp3",
    });
    const next = buildRecord({
      id: "pod-after",
      targetKey: "uploads/audio/after.mp3",
    });
    const { deps, mocks } = createDeps([failing, next]);
    mocks.fileStorage.deleteObject
      .mockRejectedValueOnce(new Error("R2 down"))
      .mockResolvedValueOnce({ ok: true as const });
    mocks.pendingObjectDeletions.markFailed.mockRejectedValueOnce(p2025());

    const result = await drainPendingDeletions(deps, {});

    expect(result.processed).toBe(2);
    // First row's markFailed threw before the counter bumped, so retried stays
    // 0; the second row drained normally.
    expect(result.retried).toBe(0);
    expect(result.deleted).toBe(1);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "drain.item_unhandled_error",
      expect.objectContaining({ id: "pod-bookkeep-fail" }),
    );
    expect(mocks.pendingObjectDeletions.markDeleted).toHaveBeenCalledWith(
      "pod-after",
    );
  });

  it("passes clock.now() + limit to listDue", async () => {
    const { deps, mocks } = createDeps([]);

    await drainPendingDeletions(deps, { limit: 25 });

    expect(mocks.pendingObjectDeletions.listDue).toHaveBeenCalledWith({
      now: NOW,
      limit: 25,
    });
  });

  it("an unhandled row is logged at error AND reported (CLAUDE.md swallow rule)", async () => {
    const racy = buildRecord({ id: "pod-racy", source: "event_delete" });
    const { deps, mocks } = createDeps([racy]);
    mocks.pendingObjectDeletions.markDeleted.mockRejectedValueOnce(p2025());
    const reportError = vi.fn();

    await drainPendingDeletions({ ...deps, reportError }, {});

    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.anything(), {
      tags: {
        job: "storage.drain-pending-deletions",
        step: "item_unhandled",
        source: "event_delete",
      },
      extra: { id: "pod-racy", targetKey: racy.targetKey },
    });
  });

  it("a throwing markDead does not skip the dead-letter report", async () => {
    const record = buildRecord({ id: "pod-dead", attempts: 7 });
    const { deps, mocks } = createDeps([record]);
    const boom = new Error("gone");
    mocks.fileStorage.deleteObject.mockRejectedValueOnce(boom);
    mocks.pendingObjectDeletions.markDead.mockRejectedValueOnce(p2025());
    const reportError = vi.fn();

    const result = await drainPendingDeletions({ ...deps, reportError }, { maxAttempts: 8 });

    // Both: the dead letter (the object is still there), then the
    // bookkeeping throw from the outer guard.
    expect(reportError.mock.calls.map((c) => (c[1] as any).tags.step)).toEqual([
      "dead_letter",
      "item_unhandled",
    ]);
    expect(reportError.mock.calls[0]![0]).toBe(boom);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "drain.dead_letter",
      expect.objectContaining({ id: "pod-dead" }),
    );
    expect(result).toMatchObject({ deadLettered: 0, unhandled: 1 });
  });

  it("wraps a plain storage error before reporting it", async () => {
    const record = buildRecord({ id: "pod-dead", attempts: 7 });
    const { deps, mocks } = createDeps([record]);
    const plain = { code: "dependency_failed", message: "bucket missing" };
    mocks.fileStorage.deleteObject.mockRejectedValueOnce(plain);
    const reportError = vi.fn();

    await drainPendingDeletions({ ...deps, reportError }, { maxAttempts: 8 });

    const reported = reportError.mock.calls[0]![0] as Error;
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe("dependency_failed: bucket missing");
    expect(reported.cause).toBe(plain);
  });

  describe("passes (security N2: one 50-row pass per tick could not keep up)", () => {
    const rows = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => buildRecord({ id: `${prefix}-${i}` }));

    it("takes passes until a pass comes back short", async () => {
      const { deps, mocks } = createDeps([]);
      mocks.pendingObjectDeletions.listDue
        .mockResolvedValueOnce(rows(3, "a"))
        .mockResolvedValueOnce(rows(3, "b"))
        .mockResolvedValueOnce(rows(1, "c"));

      const result = await drainPendingDeletions(deps, { limit: 3 });

      expect(mocks.pendingObjectDeletions.listDue).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ processed: 7, deleted: 7, passes: 3, hasMore: false });
    });

    it("stops after a pass with trouble (a retry), leaving the rest for the next run", async () => {
      const { deps, mocks } = createDeps([]);
      mocks.pendingObjectDeletions.listDue
        .mockResolvedValueOnce(rows(2, "a"))
        .mockResolvedValueOnce(rows(2, "b"));
      mocks.fileStorage.deleteObject.mockRejectedValueOnce(new Error("blip"));

      const result = await drainPendingDeletions(deps, { limit: 2 });

      expect(mocks.pendingObjectDeletions.listDue).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ processed: 2, retried: 1, passes: 1, hasMore: false });
    });

    it("hands off with hasMore at maxPasses", async () => {
      const { deps, mocks } = createDeps([]);
      mocks.pendingObjectDeletions.listDue.mockImplementation(async () => rows(2, "x"));

      const result = await drainPendingDeletions(deps, { limit: 2, maxPasses: 4 });

      expect(mocks.pendingObjectDeletions.listDue).toHaveBeenCalledTimes(4);
      expect(result).toMatchObject({ processed: 8, passes: 4, hasMore: true });
    });

    it("stops mid-pass once the time budget is spent", async () => {
      const { deps, mocks } = createDeps([]);
      let t = NOW.getTime();
      (deps.clock.now as any).mockImplementation(() => new Date(t));
      mocks.pendingObjectDeletions.listDue.mockResolvedValueOnce(rows(5, "a"));
      mocks.fileStorage.deleteObject.mockImplementation(async () => {
        t += 600;
        return { ok: true as const };
      });

      const result = await drainPendingDeletions(deps, { limit: 5, timeBudgetMs: 1_000 });

      expect(result.processed).toBe(2);
      expect(result.hasMore).toBe(true);
    });
  });
});

const PAGE_KEY =
  "entity-pages/place/place-1/2026-10-14/0123456789abcdef0123456789abcdef.jpg";

/** Deps whose repos hold page-1 (a PLACE page) with the given strings. */
function withPage(
  due: PendingObjectDeletionRecord[],
  pageStrings: { avatarUrl?: string | null; blockData?: unknown } = {},
) {
  const built = createDeps(due);
  const entityPages = {
    getById: vi.fn(async (id: string) =>
      id === "page-1"
        ? {
            id: "page-1",
            ownerType: "PLACE",
            ownerId: "place-1",
            avatarUrl: pageStrings.avatarUrl ?? null,
          }
        : null,
    ),
    getTheme: vi.fn(async () => null),
    listBlocks: vi.fn(async () =>
      pageStrings.blockData === undefined
        ? []
        : [{ id: "b1", data: pageStrings.blockData }],
    ),
    getDraft: vi.fn(async () => null),
  };
  const places = { getById: vi.fn(async () => ({ id: "place-1" })) };
  built.deps.repos = {
    ...built.deps.repos,
    entityPages,
    places,
  } as unknown as DrainPendingDeletionsDeps["repos"];
  return { ...built, entityPages };
}

describe("drainPendingDeletions — handover Clear rows re-check live references", () => {
  const KEY = PAGE_KEY;

  const clearRow = (overrides: Partial<PendingObjectDeletionRecord> = {}) =>
    buildRecord({
      targetKey: KEY,
      source: "community_handover_clear",
      sourceId: "page-1",
      ...overrides,
    });

  it("removes the row WITHOUT deleting the object when a block uses the key again", async () => {
    const { deps, mocks } = withPage([clearRow()], {
      blockData: { photos: [{ url: `https://cdn.test/${KEY}` }] },
    });
    const result = await drainPendingDeletions(deps, {});
    expect(mocks.fileStorage.deleteObject).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markDeleted).toHaveBeenCalledWith("pod-1");
    expect(result).toMatchObject({ deleted: 0, skippedStillReferenced: 1 });
  });

  it("keeps the object when the page avatar uses the key again", async () => {
    const { deps, mocks } = withPage([clearRow()], {
      avatarUrl: `https://cdn.test/${KEY}`,
    });
    await drainPendingDeletions(deps, {});
    expect(mocks.fileStorage.deleteObject).not.toHaveBeenCalled();
  });

  it("deletes when nothing on the page uses the key (and when the page is gone)", async () => {
    for (const sourceId of ["page-1", "page-gone"]) {
      const { deps, mocks } = withPage([clearRow({ sourceId })]);
      const result = await drainPendingDeletions(deps, {});
      expect(mocks.fileStorage.deleteObject).toHaveBeenCalledWith({ key: KEY });
      expect(result).toMatchObject({ deleted: 1, skippedStillReferenced: 0 });
    }
  });

  it("a failed re-check keeps the object and BACKS OFF the row (markFailed), reported", async () => {
    const { deps, mocks, entityPages } = withPage([clearRow({ attempts: 0 })]);
    entityPages.getById.mockRejectedValueOnce(new Error("db down"));
    const reportError = vi.fn();
    const result = await drainPendingDeletions({ ...deps, reportError }, {});
    expect(mocks.fileStorage.deleteObject).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markDeleted).not.toHaveBeenCalled();
    // The row leaves the front of the queue: first backoff (60 s).
    expect(mocks.pendingObjectDeletions.markFailed).toHaveBeenCalledWith({
      id: "pod-1",
      lastError: "Error: db down",
      nextAttemptAt: new Date(NOW.getTime() + 60_000),
    });
    expect(result).toMatchObject({ retried: 1, unhandled: 0, deleted: 0 });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "reference_recheck" }),
      }),
    );
  });

  it("a PERSISTENT re-check failure dead-letters the row without ever deleting the object", async () => {
    const { deps, mocks, entityPages } = withPage([clearRow({ attempts: 7 })]);
    entityPages.getById.mockRejectedValue(new Error("db down"));
    const reportError = vi.fn();
    const result = await drainPendingDeletions(
      { ...deps, reportError },
      { maxAttempts: 8 },
    );
    expect(mocks.fileStorage.deleteObject).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markDeleted).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markFailed).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markDead).toHaveBeenCalledWith({
      id: "pod-1",
      lastError: "Error: db down",
    });
    expect(result).toMatchObject({ deadLettered: 1, unhandled: 0 });
    // This attempt's re-check report, then the dead letter's.
    expect(
      reportError.mock.calls.map(
        ([, context]) => (context as { tags: { step: string } }).tags.step,
      ),
    ).toEqual(["reference_recheck", "dead_letter"]);
  });

  it("other sources are deleted without the re-check", async () => {
    const { deps, mocks, entityPages } = withPage(
      [clearRow({ source: "image_upload_original" })],
      { blockData: { url: `https://cdn.test/${KEY}` } },
    );
    await drainPendingDeletions(deps, {});
    expect(entityPages.getById).not.toHaveBeenCalled();
    expect(mocks.fileStorage.deleteObject).toHaveBeenCalledWith({ key: KEY });
  });
});

describe("drainPendingDeletions — draft Discard rows re-check live references", () => {
  // discardPageDraft queues draft-only images with sourceId = the page id.
  // Draft saves and publishes cancel the row; a live editor (updatePage,
  // managePageBlocks, updatePageTheme) putting the key on the page does not,
  // so the drain re-checks before deleting, exactly as for a Clear row.
  const discardRow = (overrides: Partial<PendingObjectDeletionRecord> = {}) =>
    buildRecord({
      targetKey: PAGE_KEY,
      source: PAGE_DRAFT_DISCARD_DELETION_SOURCE,
      sourceId: "page-1",
      ...overrides,
    });

  it("keeps the object and drops the row when the live page uses the key", async () => {
    for (const pageStrings of [
      { blockData: { photos: [{ url: `https://cdn.test/${PAGE_KEY}` }] } },
      { avatarUrl: `https://cdn.test/${PAGE_KEY}` },
    ]) {
      const { deps, mocks, entityPages } = withPage([discardRow()], pageStrings);
      const result = await drainPendingDeletions(deps, {});
      expect(entityPages.getById).toHaveBeenCalledWith("page-1");
      expect(mocks.fileStorage.deleteObject).not.toHaveBeenCalled();
      expect(mocks.pendingObjectDeletions.markDeleted).toHaveBeenCalledWith("pod-1");
      expect(result).toMatchObject({ deleted: 0, skippedStillReferenced: 1 });
    }
  });

  it("deletes when nothing on the page uses the key (and when the page is gone)", async () => {
    for (const sourceId of ["page-1", "page-gone"]) {
      const { deps, mocks } = withPage([discardRow({ sourceId })]);
      const result = await drainPendingDeletions(deps, {});
      expect(mocks.fileStorage.deleteObject).toHaveBeenCalledWith({ key: PAGE_KEY });
      expect(result).toMatchObject({ deleted: 1, skippedStillReferenced: 0 });
    }
  });

  it("a failed re-check keeps the object and backs off the row, reported", async () => {
    const { deps, mocks, entityPages } = withPage([discardRow({ attempts: 0 })]);
    entityPages.listBlocks.mockRejectedValueOnce(new Error("db down"));
    const reportError = vi.fn();
    const result = await drainPendingDeletions({ ...deps, reportError }, {});
    expect(mocks.fileStorage.deleteObject).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markDeleted).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.markFailed).toHaveBeenCalledWith({
      id: "pod-1",
      lastError: "Error: db down",
      nextAttemptAt: new Date(NOW.getTime() + 60_000),
    });
    expect(result).toMatchObject({ retried: 1, unhandled: 0, deleted: 0 });
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: expect.objectContaining({
          step: "reference_recheck",
          source: PAGE_DRAFT_DISCARD_DELETION_SOURCE,
        }),
      }),
    );
  });

  it("a row the re-check cannot resolve (no page id, or a PREFIX) fails closed", async () => {
    for (const overrides of [
      { sourceId: null },
      { targetKind: "PREFIX" as const },
    ]) {
      const { deps, mocks, entityPages } = withPage([discardRow(overrides)]);
      const reportError = vi.fn();
      const result = await drainPendingDeletions({ ...deps, reportError }, {});
      expect(entityPages.getById).not.toHaveBeenCalled();
      expect(mocks.fileStorage.deleteObject).not.toHaveBeenCalled();
      expect(mocks.fileStorage.listObjects).not.toHaveBeenCalled();
      expect(mocks.pendingObjectDeletions.markFailed).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ retried: 1, deleted: 0 });
      expect(reportError).toHaveBeenCalledTimes(1);
    }
  });
});
