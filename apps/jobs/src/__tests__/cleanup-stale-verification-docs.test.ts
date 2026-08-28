/**
 * Cleanup Stale Verification Docs Job Tests
 *
 * Verifies the places.cleanup-stale-verification-docs scheduled task is
 * correctly wired:
 * - Job registration and schedule configuration
 * - Input validation (maxAgeDays)
 * - Handler delegates to the use case with the right deps
 * - R2 deletion flows through fileStorage
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";

import { placeJobs } from "../jobs/places";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildStaleDocs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${i + 1}`,
    requestId: `req-${i + 1}`,
    storageKey: `place-verification/p${i + 1}/doc.pdf`,
    fileName: `doc-${i + 1}.pdf`,
    contentType: "application/pdf",
    sizeBytes: 1024,
    deletedAt: null,
    createdAt: new Date("2025-12-01T00:00:00.000Z"),
  }));
}

function buildMockContext(staleDocs: ReturnType<typeof buildStaleDocs> = []) {
  const placeVerificationDocuments = {
    listStale: vi.fn(async () => staleDocs),
    markDeleted: vi.fn(async () => 1),
  };

  const fileStorage = {
    deleteObject: vi.fn(async () => ({ ok: true as const })),
    upload: vi.fn(),
    download: vi.fn(),
    getSignedUrl: vi.fn(),
  };

  const clock = { now: () => new Date("2026-02-01T00:00:00.000Z") };

  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withTime: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
  };

  return {
    ctx: {
      repos: {
        placeVerificationDocuments: placeVerificationDocuments as any,
      } as any,
      payments: {} as any,
      clock,
      logger: logger as any,
      idempotency: {} as any,
      fileStorage: fileStorage as any,
      searchIndex: {} as any,
      multiSearch: null,
      enqueue: vi.fn(),
    },
    mocks: { placeVerificationDocuments, fileStorage, logger },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("cleanup-stale-verification-docs job", () => {
  const job = placeJobs.find(
    (j) => j.name === "places.cleanup-stale-verification-docs",
  )!;

  it("is registered in placeJobs", () => {
    expect(job).toBeDefined();
  });

  it("is a scheduled task running daily at 03:00 UTC", () => {
    expect(job).toHaveProperty("schedule");
    const schedule = (job as any).schedule;
    expect(schedule.cron).toBe("0 3 * * *");
    expect(schedule.timezone).toBe("Etc/UTC");
  });

  describe("input validation", () => {
    it("accepts empty input", () => {
      const parsed = job.input.parse({});
      expect(parsed).toEqual({});
    });

    it("accepts valid maxAgeDays", () => {
      const parsed = job.input.parse({ maxAgeDays: 7 });
      expect(parsed).toEqual({ maxAgeDays: 7 });
    });

    it("rejects non-positive maxAgeDays", () => {
      expect(() => job.input.parse({ maxAgeDays: 0 })).toThrow(ZodError);
      expect(() => job.input.parse({ maxAgeDays: -1 })).toThrow(ZodError);
    });
  });

  describe("handler", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("returns zeros when no stale docs found", async () => {
      const { ctx } = buildMockContext([]);

      const result = await job.handler({ input: {} as any, ctx: ctx as any });

      expect(result).toEqual(
        expect.objectContaining({ scanned: 0, deleted: 0, failed: 0 }),
      );
    });

    it("deletes stale docs from R2 and marks them deleted", async () => {
      const docs = buildStaleDocs(2);
      const { ctx, mocks } = buildMockContext(docs);

      const result = await job.handler({ input: {} as any, ctx: ctx as any });

      expect(result).toEqual(
        expect.objectContaining({ scanned: 2, deleted: 2, failed: 0 }),
      );
      expect(mocks.fileStorage.deleteObject).toHaveBeenCalledTimes(2);
      expect(mocks.fileStorage.deleteObject).toHaveBeenCalledWith({
        key: docs[0]!.storageKey,
      });
      expect(mocks.fileStorage.deleteObject).toHaveBeenCalledWith({
        key: docs[1]!.storageKey,
      });
      expect(
        mocks.placeVerificationDocuments.markDeleted,
      ).toHaveBeenCalledTimes(2);
    });

    it("counts failures when R2 delete throws", async () => {
      const docs = buildStaleDocs(1);
      const { ctx, mocks } = buildMockContext(docs);
      mocks.fileStorage.deleteObject.mockRejectedValueOnce(
        new Error("R2 timeout"),
      );

      const result = await job.handler({ input: {} as any, ctx: ctx as any });

      expect(result).toEqual(
        expect.objectContaining({ scanned: 1, deleted: 0, failed: 1 }),
      );
    });

    it("continues processing when one doc fails", async () => {
      const docs = buildStaleDocs(2);
      const { ctx, mocks } = buildMockContext(docs);

      mocks.fileStorage.deleteObject
        .mockRejectedValueOnce(new Error("R2 down"))
        .mockResolvedValueOnce({ ok: true });

      const result = await job.handler({ input: {} as any, ctx: ctx as any });

      expect(result).toEqual(
        expect.objectContaining({ scanned: 2, deleted: 1, failed: 1 }),
      );
    });

    it("passes maxAgeDays through to the use case", async () => {
      const { ctx, mocks } = buildMockContext([]);

      await job.handler({
        input: { maxAgeDays: 7 } as any,
        ctx: ctx as any,
      });

      expect(mocks.placeVerificationDocuments.listStale).toHaveBeenCalledWith(
        expect.objectContaining({ maxAgeDays: 7 }),
      );
    });

    it("logs completion info", async () => {
      const { ctx, mocks } = buildMockContext([]);

      await job.handler({ input: {} as any, ctx: ctx as any });

      expect(mocks.logger.info).toHaveBeenCalledWith(
        "places.cleanup-stale-verification-docs.completed",
        expect.objectContaining({ scanned: 0, deleted: 0, failed: 0 }),
      );
    });
  });
});
