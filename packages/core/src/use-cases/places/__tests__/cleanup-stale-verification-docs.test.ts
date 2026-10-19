import { describe, expect, it, vi } from "vitest";

import { cleanupStaleVerificationDocs } from "../cleanup-stale-verification-docs";
import type { CleanupStaleVerificationDocsDeps } from "../cleanup-stale-verification-docs";
import type { PlaceVerificationDocumentRecord } from "@th/types/repos/place-verification";

const BASE_DATE = new Date("2024-02-01T00:00:00.000Z");

function buildDoc(
  overrides: Partial<PlaceVerificationDocumentRecord> = {},
): PlaceVerificationDocumentRecord {
  return {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    requestId: "rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr",
    storageKey: "place-verification/place1/doc1.pdf",
    fileName: "lease.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    deletedAt: null,
    createdAt: BASE_DATE,
    ...overrides,
  };
}

function buildDeps(staleDocs: PlaceVerificationDocumentRecord[] = []) {
  const documentsRepo = {
    listStale: vi.fn(async () => staleDocs),
    markDeleted: vi.fn(async () => 1),
  };

  const requestsRepo = {
    getById: vi.fn(async (id: string) => ({
      id,
      orgId: "org-1111-1111-1111-111111111111",
      placeId: "place-1",
      submittedById: "human-1",
      status: "APPROVED" as const,
      reviewerNotes: null,
      reviewerHumanId: null,
      reviewedAt: null,
      createdAt: BASE_DATE,
      updatedAt: BASE_DATE,
    })),
  };

  const quotasRepo = {
    incrementUsage: vi.fn(async (input: any) => ({
      id: "usage-1",
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
      currentUsage: input.delta,
      updatedAt: BASE_DATE,
      createdAt: BASE_DATE,
    })),
  };

  const storage = {
    deleteObject: vi.fn(async () => ({ ok: true as const })),
  };

  const clock = {
    now: () => BASE_DATE,
  };

  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withTime: vi.fn(async (_label: string, fn: () => Promise<any>) => fn()),
  };

  const deps: CleanupStaleVerificationDocsDeps = {
    repos: {
      placeVerificationDocuments: documentsRepo,
      placeVerificationRequests: requestsRepo,
      resourceQuotas: quotasRepo,
    } as any,
    storage: storage as any,
    clock,
    logger: logger as any,
  };

  return { deps, documentsRepo, requestsRepo, quotasRepo, storage, logger };
}

describe("cleanupStaleVerificationDocs", () => {
  it("returns zeros when no stale docs found", async () => {
    const { deps } = buildDeps([]);

    const result = await cleanupStaleVerificationDocs(deps, {});

    expect(result).toEqual({ scanned: 0, deleted: 0, failed: 0 });
  });

  it("deletes stale docs from R2 and marks them deleted", async () => {
    const doc1 = buildDoc({
      id: "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1",
      storageKey: "place-verification/p1/d1.pdf",
    });
    const doc2 = buildDoc({
      id: "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2",
      storageKey: "place-verification/p1/d2.jpg",
    });
    const { deps, documentsRepo, storage } = buildDeps([doc1, doc2]);

    const result = await cleanupStaleVerificationDocs(deps, {});

    expect(result).toEqual({ scanned: 2, deleted: 2, failed: 0 });
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
    expect(storage.deleteObject).toHaveBeenCalledWith({ key: doc1.storageKey });
    expect(storage.deleteObject).toHaveBeenCalledWith({ key: doc2.storageKey });
    expect(documentsRepo.markDeleted).toHaveBeenCalledTimes(2);
  });

  it("counts failures when R2 delete throws", async () => {
    const doc = buildDoc();
    const { deps, storage } = buildDeps([doc]);
    storage.deleteObject.mockRejectedValueOnce(new Error("R2 timeout"));

    const result = await cleanupStaleVerificationDocs(deps, {});

    expect(result).toEqual({ scanned: 1, deleted: 0, failed: 1 });
  });

  it("passes maxAgeDays and includeDecided to listStale", async () => {
    const { deps, documentsRepo } = buildDeps([]);

    await cleanupStaleVerificationDocs(deps, { maxAgeDays: 7 });

    expect(documentsRepo.listStale).toHaveBeenCalledWith({
      maxAgeDays: 7,
      includeDecided: true,
    });
  });

  it("defaults maxAgeDays to 30", async () => {
    const { deps, documentsRepo } = buildDeps([]);

    await cleanupStaleVerificationDocs(deps);

    expect(documentsRepo.listStale).toHaveBeenCalledWith({
      maxAgeDays: 30,
      includeDecided: true,
    });
  });

  it("continues processing remaining docs when one fails", async () => {
    const doc1 = buildDoc({
      id: "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1",
      storageKey: "place-verification/p1/d1.pdf",
    });
    const doc2 = buildDoc({
      id: "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2",
      storageKey: "place-verification/p1/d2.jpg",
    });
    const { deps, storage } = buildDeps([doc1, doc2]);

    storage.deleteObject
      .mockRejectedValueOnce(new Error("R2 down"))
      .mockResolvedValueOnce({ ok: true });

    const result = await cleanupStaleVerificationDocs(deps, {});

    expect(result).toEqual({ scanned: 2, deleted: 1, failed: 1 });
  });

  it("decrements STORAGE_BYTES_ORG after deleting docs", async () => {
    const doc1 = buildDoc({
      id: "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1",
      storageKey: "place-verification/p1/d1.pdf",
      sizeBytes: 2048,
    });
    const doc2 = buildDoc({
      id: "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2",
      storageKey: "place-verification/p1/d2.jpg",
      sizeBytes: 4096,
    });
    const { deps, quotasRepo, requestsRepo } = buildDeps([doc1, doc2]);

    await cleanupStaleVerificationDocs(deps, {});

    // Both docs share the same requestId, so one getById call is expected.
    expect(requestsRepo.getById).toHaveBeenCalledWith(doc1.requestId);
    expect(quotasRepo.incrementUsage).toHaveBeenCalledWith({
      subjectType: "ORG",
      subjectId: "org-1111-1111-1111-111111111111",
      kind: "STORAGE_BYTES_ORG",
      delta: -BigInt(2048 + 4096),
    });
  });

  it("does not decrement quota when all deletes fail", async () => {
    const doc = buildDoc({ sizeBytes: 1024 });
    const { deps, quotasRepo, storage } = buildDeps([doc]);
    storage.deleteObject.mockRejectedValueOnce(new Error("R2 down"));

    await cleanupStaleVerificationDocs(deps, {});

    expect(quotasRepo.incrementUsage).not.toHaveBeenCalled();
  });
});
