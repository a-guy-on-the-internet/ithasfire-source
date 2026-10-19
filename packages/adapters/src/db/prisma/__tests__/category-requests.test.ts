import { describe, expect, it, vi } from "vitest";

import { makeCategoryRequestsRepo } from "../category-requests";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-05-11T12:00:00.000Z");

function categoryRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "request-1",
    kind: "CATEGORY",
    status: "PENDING",
    name: "Experimental Jazz",
    slug: "experimental-jazz",
    categoryId: null,
    categorySlug: null,
    categoryName: null,
    eventId: "event-1",
    requesterHumanId: "human-1",
    reviewedByHumanId: null,
    reviewNote: null,
    resolvedCategoryId: null,
    createdAt: NOW,
    updatedAt: NOW,
    reviewedAt: null,
    ...overrides,
  };
}

function createPrisma() {
  const createMany = vi.fn();
  const findFirst = vi.fn();
  const findUnique = vi.fn();
  const findMany = vi.fn();
  const count = vi.fn();
  const updateMany = vi.fn();
  const update = vi.fn();

  const prisma = {
    eventCategoryRequest: {
      createMany,
      findFirst,
      findUnique,
      findMany,
      count,
      updateMany,
      update,
    },
  } as unknown as PrismaClientOrTx;

  return {
    prisma,
    createMany,
    findFirst,
    findUnique,
    findMany,
    count,
    updateMany,
    update,
  };
}

describe("makeCategoryRequestsRepo", () => {
  it("creates via createMany skipDuplicates and returns the pending row", async () => {
    const { prisma, createMany, findFirst } = createPrisma();
    const repo = makeCategoryRequestsRepo(prisma);
    createMany.mockResolvedValue({ count: 1 });
    findFirst.mockResolvedValue(categoryRequestRow());

    const result = await repo.create({
      kind: "CATEGORY",
      name: "Experimental Jazz",
      slug: "experimental-jazz",
      categoryId: null,
      eventId: "event-1",
      requesterHumanId: "human-1",
    });

    expect(result.id).toBe("request-1");
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          kind: "CATEGORY",
          name: "Experimental Jazz",
          slug: "experimental-jazz",
          categoryId: null,
          categorySlug: null,
          categoryName: null,
          eventId: "event-1",
          requesterHumanId: "human-1",
          reviewNote: null,
          locale: null,
        },
      ],
      skipDuplicates: true,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PENDING",
          kind: "CATEGORY",
          slug: "experimental-jazz",
          categoryId: null,
        },
        orderBy: { createdAt: "asc" },
      }),
    );
  });

  it("lists the pending root request for a slug, never a scoped one", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeCategoryRequestsRepo(prisma);
    findMany.mockResolvedValue([categoryRequestRow()]);

    const result = await repo.listPendingBySlug("experimental-jazz");

    expect(result.map((request) => request.id)).toEqual(["request-1"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PENDING",
          kind: "CATEGORY",
          categoryId: null,
          slug: "experimental-jazz",
        },
        orderBy: { createdAt: "asc" },
      }),
    );
  });

  it("claims a pending request with an atomic id/status update", async () => {
    const { prisma, updateMany, findUnique } = createPrisma();
    const repo = makeCategoryRequestsRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue(
      categoryRequestRow({
        reviewedByHumanId: "reviewer-1",
        reviewedAt: NOW,
      }),
    );

    const result = await repo.claimPendingForReview({
      id: "request-1",
      reviewedByHumanId: "reviewer-1",
      reviewedAt: NOW,
    });

    expect(result?.reviewedByHumanId).toBe("reviewer-1");
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "request-1",
        status: "PENDING",
        reviewedByHumanId: null,
        reviewedAt: null,
      },
      data: { reviewedByHumanId: "reviewer-1", reviewedAt: NOW },
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "request-1" },
      }),
    );
  });

  it("does not claim an already-claimed pending request", async () => {
    const { prisma, updateMany, findUnique } = createPrisma();
    const repo = makeCategoryRequestsRepo(prisma);
    updateMany.mockResolvedValue({ count: 0 });

    const result = await repo.claimPendingForReview({
      id: "request-1",
      reviewedByHumanId: "reviewer-2",
      reviewedAt: NOW,
    });

    expect(result).toBeNull();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "request-1",
        status: "PENDING",
        reviewedByHumanId: null,
        reviewedAt: null,
      },
      data: { reviewedByHumanId: "reviewer-2", reviewedAt: NOW },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns null when a pending claim does not transition a row", async () => {
    const { prisma, updateMany, findUnique } = createPrisma();
    const repo = makeCategoryRequestsRepo(prisma);
    updateMany.mockResolvedValue({ count: 0 });

    const result = await repo.claimPendingForReview({
      id: "request-1",
      reviewedByHumanId: "reviewer-1",
      reviewedAt: NOW,
    });

    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
