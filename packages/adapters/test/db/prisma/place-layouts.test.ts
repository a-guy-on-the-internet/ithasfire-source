import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

import {
  makePlaceLayoutsRepo,
  makePlaceLayoutStatusesRepo,
} from "../../../src/db/prisma/place-layouts";
import type { PrismaClientOrTx } from "../../../src/db/prisma/types";

function basePrisma() {
  return {
    placeLayout: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
  };
}

describe("makePlaceLayoutsRepo", () => {
  function createSampleMetadata() {
    return {
      version: 1,
      seatIds: ["seat-1", "seat-2"],
      seatCount: 2,
      sectionCount: 1,
      seatIndexBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      sections: [
        {
          sectionId: "sec-1",
          label: "Floor",
          capacity: 2,
          metadata: { color: "red" },
        },
      ],
    };
  }

  it("returns null when no layout is found", async () => {
    const prisma = basePrisma();
    (prisma as any).placeLayout.findFirst.mockResolvedValue(null);

    const repo = makePlaceLayoutsRepo(prisma as unknown as PrismaClientOrTx);
    const result = await repo.getByPlace("place-123");

    expect(result).toBeNull();
  });

  it("maps the stored layout into a record", async () => {
    const prisma = basePrisma();
    const sampleMetadata = createSampleMetadata();
    (prisma as any).placeLayout.findFirst.mockResolvedValue({
      id: "layout-1",
      placeId: "place-123",
      name: "Default",
      checksum: "checksum-abc",
      metadata: sampleMetadata,
      stage: {
        kind: "rectangle",
        bounds: sampleMetadata.seatIndexBounds,
        label: "Main Stage",
      },
      createdByHumanId: "human-1",
      updatedAt: new Date("2024-01-02T00:00:00Z"),
    });

    const repo = makePlaceLayoutsRepo(prisma as unknown as PrismaClientOrTx);
    const record = await repo.getByPlace("place-123");

    expect(prisma.placeLayout.findFirst).toHaveBeenCalledWith({
      where: { placeId: "place-123" },
      select: expect.any(Object),
    });

    expect(record).toMatchObject({
      placeId: "place-123",
      checksum: "checksum-abc",
      seatIds: ["seat-1", "seat-2"],
      seatCount: 2,
      sectionCount: 1,
      createdByHumanId: "human-1",
    });
    expect(record?.stage).toMatchObject({
      kind: "rectangle",
      label: "Main Stage",
    });
  });

  it("upserts snapshots with normalized metadata", async () => {
    const prisma = basePrisma();
    const sampleMetadata = createSampleMetadata();
    (prisma as any).placeLayout.upsert.mockResolvedValue({
      id: "layout-1",
      placeId: "place-123",
      name: "Default",
      checksum: "checksum-abc",
      metadata: sampleMetadata,
      stage: Prisma.JsonNull,
      createdByHumanId: "human-1",
      updatedAt: new Date("2024-01-02T00:00:00Z"),
    });

    const repo = makePlaceLayoutsRepo(prisma as unknown as PrismaClientOrTx);
    const result = await repo.replaceWithSnapshot({
      placeId: "place-123",
      checksum: "checksum-abc",
      createdByHumanId: "human-1",
      seatIds: ["seat-1", "seat-2"],
      seatIndexBounds: sampleMetadata.seatIndexBounds,
      sections: sampleMetadata.sections,
      stage: null,
    });

    expect(prisma.placeLayout.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { placeId_name: { placeId: "place-123", name: "Default" } },
        update: expect.objectContaining({
          metadata: expect.objectContaining({
            seatIds: ["seat-1", "seat-2"],
            seatCount: 2,
            sectionCount: 1,
          }),
        }),
      }),
    );

    expect(result).toMatchObject({
      placeId: "place-123",
      checksum: "checksum-abc",
      seatIds: ["seat-1", "seat-2"],
      createdByHumanId: "human-1",
    });
  });

  it("deletes snapshots when present", async () => {
    const prisma = basePrisma();
    (prisma as any).placeLayout.findMany.mockResolvedValue([
      { id: "layout-1", checksum: "chk" },
    ]);
    const repo = makePlaceLayoutsRepo(prisma as unknown as PrismaClientOrTx);

    const result = await repo.deleteForPlace("place-123");

    expect(prisma.placeLayout.deleteMany).toHaveBeenCalledWith({
      where: { placeId: "place-123" },
    });
    expect(result).toEqual({ deleted: true, checksum: "chk" });
  });

  it("returns deleted:false when no snapshot exists", async () => {
    const prisma = basePrisma();
    (prisma as any).placeLayout.findMany.mockResolvedValue([]);
    const repo = makePlaceLayoutsRepo(prisma as unknown as PrismaClientOrTx);

    const result = await repo.deleteForPlace("place-123");

    expect(result).toEqual({ deleted: false, checksum: null });
    expect(prisma.placeLayout.deleteMany).not.toHaveBeenCalled();
  });
});

describe("makePlaceLayoutStatusesRepo", () => {
  function createBaseMetadata() {
    return {
      version: 1,
      seatIds: ["seat-1", "seat-2"],
      seatCount: 2,
      sectionCount: 1,
      seatIndexBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      sections: [],
    };
  }

  it("stores a status snapshot without mutating canonical seats", async () => {
    const prisma = basePrisma();
    (prisma as any).placeLayout.findFirst.mockResolvedValue({
      id: "layout-1",
      metadata: createBaseMetadata(),
    });

    const repo = makePlaceLayoutStatusesRepo(
      prisma as unknown as PrismaClientOrTx,
    );
    await repo.upsertStatuses({
      placeId: "place-123",
      seatIds: ["seat-2", "seat-2", "seat-3"],
    });

    const updateCall = (prisma.placeLayout.update as any).mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: "layout-1" });
    const metadata = updateCall.data.metadata as Record<string, unknown>;
    expect(metadata.seatIds).toEqual(["seat-1", "seat-2"]);
    expect(metadata.seatCount).toBe(2);
    expect(
      (metadata.statusSnapshot as { seatIds: string[]; updatedAt: string })
        .seatIds,
    ).toEqual(["seat-2", "seat-3"]);
  });

  it("removes the status snapshot on delete", async () => {
    const prisma = basePrisma();
    (prisma as any).placeLayout.findFirst.mockResolvedValue({
      id: "layout-1",
      metadata: {
        ...createBaseMetadata(),
        statusSnapshot: { seatIds: ["seat-1"], updatedAt: "2024-01-01" },
      },
    });

    const repo = makePlaceLayoutStatusesRepo(
      prisma as unknown as PrismaClientOrTx,
    );
    await repo.deleteByPlace("place-123");

    const updateCall = (prisma.placeLayout.update as any).mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: "layout-1" });
    const metadata = updateCall.data.metadata as Record<string, unknown>;
    expect(metadata.seatIds).toEqual(["seat-1", "seat-2"]);
    expect((metadata as any).statusSnapshot).toBeUndefined();
  });
});
