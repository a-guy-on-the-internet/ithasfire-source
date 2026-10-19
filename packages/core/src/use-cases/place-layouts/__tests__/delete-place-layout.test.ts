import { describe, expect, it, vi } from "vitest";

import { deletePlaceLayout } from "../delete-place-layout";
import type { DeletePlaceLayoutDeps } from "../delete-place-layout";
import type { TxRepos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const BASE_DATE = new Date("2024-01-02T00:00:00.000Z");

function buildDeps(overrides: Partial<DeletePlaceLayoutDeps> = {}) {
  const placeLayoutsRepo = {
    getByPlace: vi.fn(async () => ({
      placeId: "place-1",
      checksum: "checksum-1",
      seatCount: 10,
      sectionCount: 2,
      seatIndexBounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
      sections: [],
      stage: null,
      updatedAt: BASE_DATE,
      seatIds: ["seat-1"],
      createdByHumanId: "human-1",
    })),
    deleteForPlace: vi.fn(async () => ({ deleted: true })),
  };

  const placeLayoutBlobsRepo = {
    deleteForPlace: vi.fn(async () => undefined),
  };

  const placeLayoutStatusesRepo = {
    deleteByPlace: vi.fn(async () => undefined),
  };

  const auditRepo = {
    log: vi.fn(async () => undefined),
  };

  const resourceQuotasRepo = {
    incrementUsage: vi.fn(async () => undefined),
  };

  const placesRepo = {
    getById: vi.fn(async () => ({
      id: "place-1",
      orgIdsWithAccess: ["org-1"],
    })),
  };

  const txRepos = {
    placeLayouts: placeLayoutsRepo,
    placeLayoutBlobs: placeLayoutBlobsRepo,
    placeLayoutStatuses: placeLayoutStatusesRepo,
    audit: auditRepo,
    resourceQuotas: resourceQuotasRepo,
  } as unknown as TxRepos;

  const repos = {
    placeLayouts: placeLayoutsRepo,
    placeLayoutBlobs: placeLayoutBlobsRepo,
    placeLayoutStatuses: placeLayoutStatusesRepo,
    audit: auditRepo,
    places: placesRepo,
    resourceQuotas: resourceQuotasRepo,
    tx: vi.fn(async (fn: (tx: typeof txRepos) => Promise<any>) => fn(txRepos)),
  } as unknown as DeletePlaceLayoutDeps["repos"];

  const streaming = {
    publishPlaceLayoutReplaced: vi.fn(async () => undefined),
  } as unknown as DeletePlaceLayoutDeps["streaming"];

  const clock = {
    now: vi.fn(() => BASE_DATE),
  } as unknown as DeletePlaceLayoutDeps["clock"];

  const logger = createTestLogger();

  const authz = {
    canManagePlace: vi.fn(async () => ({ allowed: true })),
  } as unknown as DeletePlaceLayoutDeps["authz"];

  return {
    repos,
    authz,
    streaming,
    clock,
    logger,
    placesRepo,
    resourceQuotasRepo,
    ...overrides,
  } satisfies DeletePlaceLayoutDeps & {
    placesRepo: typeof placesRepo;
    resourceQuotasRepo: typeof resourceQuotasRepo;
  };
}

describe("deletePlaceLayout", () => {
  it("deletes place layout and publishes notification", async () => {
    const deps = buildDeps();

    const result = await deletePlaceLayout(deps, {
      placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
      actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
      reason: "cleanup",
    });

    expect(result.deleted).toBe(true);
    expect(result.deletedChecksum).toBe("checksum-1");
    expect(deps.repos.tx).toHaveBeenCalledTimes(1);
    expect(deps.streaming.publishPlaceLayoutReplaced).toHaveBeenCalledWith({
      placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
      checksum: null,
    });
  });

  it("is idempotent when place layout is missing", async () => {
    const placeLayoutsRepo = {
      getByPlace: vi.fn(async () => null),
      deleteForPlace: vi.fn(async () => ({ deleted: false })),
    };

    const deps = buildDeps({
      repos: {
        placeLayouts: placeLayoutsRepo,
        placeLayoutBlobs: {
          deleteForPlace: vi.fn(),
        },
        placeLayoutStatuses: {
          deleteByPlace: vi.fn(),
        },
        audit: {
          log: vi.fn(),
        },
        tx: vi.fn(async () => undefined),
      } as unknown as DeletePlaceLayoutDeps["repos"],
    });

    const result = await deletePlaceLayout(deps, {
      placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
      actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
    });

    expect(result.deleted).toBe(false);
    expect(result.deletedChecksum).toBeNull();
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect(deps.streaming.publishPlaceLayoutReplaced).not.toHaveBeenCalled();
  });

  describe("raw CSV storage reclamation", () => {
    it("deletes raw CSV objects and decrements STORAGE_BYTES_ORG", async () => {
      const storage = {
        listObjects: vi.fn(async () => ({
          keys: [
            { key: "place-layouts/raw/place-1/aaa.csv", size: 1024 },
            { key: "place-layouts/raw/place-1/bbb.csv", size: 2048 },
          ],
          nextCursor: undefined,
        })),
        deleteObject: vi.fn(async () => undefined),
      };

      const deps = buildDeps({ storage });

      await deletePlaceLayout(deps, {
        placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
        reason: "cleanup",
      });

      expect(storage.listObjects).toHaveBeenCalledWith(
        expect.objectContaining({
          prefix: "place-layouts/raw/15324f4d-ec0e-46d5-9ae3-27f1150cf802/",
        }),
      );
      expect(storage.deleteObject).toHaveBeenCalledTimes(2);
      expect(deps.resourceQuotasRepo.incrementUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectType: "ORG",
          subjectId: "org-1",
          kind: "STORAGE_BYTES_ORG",
          delta: -3072n,
        }),
      );
    });

    it("skips reclamation when storage dep is not provided", async () => {
      const deps = buildDeps();

      await deletePlaceLayout(deps, {
        placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
        reason: "cleanup",
      });

      // No storage dep → no quota decrement
      expect(deps.resourceQuotasRepo.incrementUsage).not.toHaveBeenCalled();
    });

    it("does not decrement quota when no CSV objects exist", async () => {
      const storage = {
        listObjects: vi.fn(async () => ({
          keys: [],
          nextCursor: undefined,
        })),
        deleteObject: vi.fn(async () => undefined),
      };

      const deps = buildDeps({ storage });

      await deletePlaceLayout(deps, {
        placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
      });

      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(deps.resourceQuotasRepo.incrementUsage).not.toHaveBeenCalled();
    });

    it("gracefully handles storage errors without failing the delete", async () => {
      const storage = {
        listObjects: vi.fn(async () => {
          throw new Error("R2 unavailable");
        }),
        deleteObject: vi.fn(),
      };

      const deps = buildDeps({ storage });

      const result = await deletePlaceLayout(deps, {
        placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
      });

      // The delete itself should still succeed.
      expect(result.deleted).toBe(true);
    });
  });

  // Security review F2 (2026-09-29): any signed-in user could wipe any venue's
  // seat map and seat-status rows.
  describe("authorization", () => {
    it("rejects an actor who cannot manage the place and deletes nothing", async () => {
      const storage = {
        listObjects: vi.fn(),
        deleteObject: vi.fn(),
      };
      const deps = buildDeps({
        storage,
        authz: {
          canManagePlace: vi.fn(async () => ({ allowed: false })),
        } as unknown as DeletePlaceLayoutDeps["authz"],
      });

      await expect(
        deletePlaceLayout(deps, {
          placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
          actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

      expect(deps.authz.canManagePlace).toHaveBeenCalledWith({
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
        placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
      });
      expect(deps.repos.placeLayouts.getByPlace).not.toHaveBeenCalled();
      expect(deps.repos.tx).not.toHaveBeenCalled();
      expect(deps.streaming.publishPlaceLayoutReplaced).not.toHaveBeenCalled();
      expect(storage.listObjects).not.toHaveBeenCalled();
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it("lets a manager delete", async () => {
      const deps = buildDeps();

      const result = await deletePlaceLayout(deps, {
        placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
      });

      expect(result.deleted).toBe(true);
      expect(deps.authz.canManagePlace).toHaveBeenCalledTimes(1);
    });
  });

  // CLAUDE.md error-reporting convention: the best-effort CSV cleanup swallows,
  // so it must report.
  describe("reportError on the swallowed CSV cleanup", () => {
    it("reports the cleanup failure and still succeeds", async () => {
      const reportError = vi.fn();
      const boom = new Error("R2 unavailable");
      const deps = buildDeps({
        storage: {
          listObjects: vi.fn(async () => {
            throw boom;
          }),
          deleteObject: vi.fn(),
        },
        reportError,
      });

      const result = await deletePlaceLayout(deps, {
        placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
      });

      expect(result.deleted).toBe(true);
      expect(reportError).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({
          tags: { useCase: "deletePlaceLayout", site: "csv_cleanup" },
        }),
      );
    });

    it("a throwing reporter does not fail the operation", async () => {
      const deps = buildDeps({
        storage: {
          listObjects: vi.fn(async () => {
            throw new Error("R2 unavailable");
          }),
          deleteObject: vi.fn(),
        },
        reportError: vi.fn(() => {
          throw new Error("reporter down");
        }),
      });

      const result = await deletePlaceLayout(deps, {
        placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
      });
      expect(result.deleted).toBe(true);
    });
  });
});
