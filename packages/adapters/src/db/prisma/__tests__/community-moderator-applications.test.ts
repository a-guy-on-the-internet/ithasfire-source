import { describe, expect, it, vi } from "vitest";

import { makeCommunityModeratorApplicationsRepo } from "../community-moderator-applications";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-07-01T12:00:00.000Z");

function applicationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "application-1",
    applicantHumanId: "human-1",
    statement: "I love my scene",
    status: "PENDING",
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPrisma() {
  const create = vi.fn();
  const findUnique = vi.fn();
  const findFirst = vi.fn();
  const findMany = vi.fn();
  const updateMany = vi.fn();
  const update = vi.fn();

  const prisma = {
    communityModeratorApplication: {
      create,
      findUnique,
      findFirst,
      findMany,
      updateMany,
      update,
    },
  } as unknown as PrismaClientOrTx;

  return { prisma, create, findUnique, findFirst, findMany, updateMany, update };
}

describe("makeCommunityModeratorApplicationsRepo", () => {
  it("claims a pending application by stamping reviewer while status stays PENDING", async () => {
    const { prisma, updateMany, findUnique } = createPrisma();
    const repo = makeCommunityModeratorApplicationsRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue(
      applicationRow({ reviewedByHumanId: "admin-1", reviewedAt: NOW }),
    );

    const result = await repo.claimPendingForReview({
      id: "application-1",
      reviewedByHumanId: "admin-1",
      reviewedAt: NOW,
    });

    expect(result?.reviewedByHumanId).toBe("admin-1");
    expect(result?.status).toBe("PENDING");
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "application-1",
        status: "PENDING",
        reviewedByHumanId: null,
        reviewedAt: null,
      },
      data: { reviewedByHumanId: "admin-1", reviewedAt: NOW },
    });
  });

  it("returns null when the claim guard matches zero rows (double-review loser)", async () => {
    const { prisma, updateMany, findUnique } = createPrisma();
    const repo = makeCommunityModeratorApplicationsRepo(prisma);
    updateMany.mockResolvedValue({ count: 0 });

    const result = await repo.claimPendingForReview({
      id: "application-1",
      reviewedByHumanId: "admin-2",
      reviewedAt: NOW,
    });

    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("finds the applicant's open PENDING application (one-open-at-a-time guard)", async () => {
    const { prisma, findFirst } = createPrisma();
    const repo = makeCommunityModeratorApplicationsRepo(prisma);
    findFirst.mockResolvedValue(applicationRow());

    const result = await repo.findPendingByApplicant("human-1");

    expect(result?.id).toBe("application-1");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicantHumanId: "human-1", status: "PENDING" },
        orderBy: { createdAt: "asc" },
      }),
    );
  });

  it("lists the PENDING queue newest first with a keyset id cursor", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeCommunityModeratorApplicationsRepo(prisma);
    findMany.mockResolvedValue([
      applicationRow({ id: "application-2" }),
      applicationRow({ id: "application-1" }),
    ]);

    const result = await repo.listPending({ cursor: "application-3", limit: 1 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "PENDING" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        cursor: { id: "application-3" },
        skip: 1,
        take: 2,
      }),
    );
    expect(result.items.map((item) => item.id)).toEqual(["application-2"]);
    expect(result.nextCursor).toBe("application-2");
  });

  it("markReviewed flips status and records the decision", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeCommunityModeratorApplicationsRepo(prisma);
    update.mockResolvedValue(
      applicationRow({
        status: "REJECTED",
        reviewedByHumanId: "admin-1",
        reviewedAt: NOW,
        reviewNote: "not yet",
      }),
    );

    const result = await repo.markReviewed({
      id: "application-1",
      status: "REJECTED",
      reviewedByHumanId: "admin-1",
      reviewedAt: NOW,
      reviewNote: "not yet",
    });

    expect(result.status).toBe("REJECTED");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "application-1" },
        data: {
          status: "REJECTED",
          reviewedByHumanId: "admin-1",
          reviewedAt: NOW,
          reviewNote: "not yet",
        },
      }),
    );
  });
});
