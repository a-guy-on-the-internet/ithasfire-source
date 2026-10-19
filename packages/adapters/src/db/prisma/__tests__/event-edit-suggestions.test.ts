import { describe, expect, it, vi } from "vitest";

import { makeEventEditSuggestionsRepo } from "../event-edit-suggestions";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-07-01T12:00:00.000Z");

function suggestionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "suggestion-1",
    eventId: "event-1",
    submitterHumanId: null,
    submitterIpHash: "a".repeat(64),
    fields: { title: "Better Title" },
    baseVersion: { title: "Old Title" },
    note: null,
    status: "PENDING",
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    appliedFields: null,
    conflictedFields: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPrisma() {
  const create = vi.fn();
  const findUnique = vi.fn();
  const findMany = vi.fn();
  const count = vi.fn();
  const updateMany = vi.fn();
  const update = vi.fn();

  const prisma = {
    eventEditSuggestion: {
      create,
      findUnique,
      findMany,
      count,
      updateMany,
      update,
    },
  } as unknown as PrismaClientOrTx;

  return { prisma, create, findUnique, findMany, count, updateMany, update };
}

describe("makeEventEditSuggestionsRepo", () => {
  it("claims a pending suggestion by stamping reviewer while status stays PENDING", async () => {
    const { prisma, updateMany, findUnique } = createPrisma();
    const repo = makeEventEditSuggestionsRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue(
      suggestionRow({ reviewedByHumanId: "reviewer-1", reviewedAt: NOW }),
    );

    const result = await repo.claimPendingForReview({
      id: "suggestion-1",
      reviewedByHumanId: "reviewer-1",
      reviewedAt: NOW,
    });

    expect(result?.reviewedByHumanId).toBe("reviewer-1");
    // Status is untouched by the claim — only markReviewed flips it.
    expect(result?.status).toBe("PENDING");
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "suggestion-1",
        status: "PENDING",
        reviewedByHumanId: null,
        reviewedAt: null,
      },
      data: { reviewedByHumanId: "reviewer-1", reviewedAt: NOW },
    });
  });

  it("returns null when the claim guard matches zero rows (double-review loser)", async () => {
    const { prisma, updateMany, findUnique } = createPrisma();
    const repo = makeEventEditSuggestionsRepo(prisma);
    updateMany.mockResolvedValue({ count: 0 });

    const result = await repo.claimPendingForReview({
      id: "suggestion-1",
      reviewedByHumanId: "reviewer-2",
      reviewedAt: NOW,
    });

    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("scopes the community queue to PENDING suggestions on COMMUNITY events", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventEditSuggestionsRepo(prisma);
    findMany.mockResolvedValue([suggestionRow()]);

    const result = await repo.listPending({
      scope: { kind: "community" },
      limit: 10,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PENDING",
          event: { stewardship: "COMMUNITY" },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 11,
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("scopes the org inbox to the org's events via the event relation", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventEditSuggestionsRepo(prisma);
    findMany.mockResolvedValue([]);

    await repo.listPending({ scope: { kind: "org", orgId: "org-1" } });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PENDING",
          event: { orgId: "org-1" },
        },
      }),
    );
  });

  it("scopes the event inbox to the eventId directly", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventEditSuggestionsRepo(prisma);
    findMany.mockResolvedValue([]);

    await repo.listPending({ scope: { kind: "event", eventId: "event-1" } });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PENDING",
          eventId: "event-1",
        },
      }),
    );
  });

  it("paginates with a keyset id cursor and reports nextCursor when more rows exist", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventEditSuggestionsRepo(prisma);
    findMany.mockResolvedValue([
      suggestionRow({ id: "suggestion-3" }),
      suggestionRow({ id: "suggestion-2" }),
      suggestionRow({ id: "suggestion-1" }),
    ]);

    const result = await repo.listPending({
      scope: { kind: "community" },
      cursor: "suggestion-4",
      limit: 2,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "suggestion-4" },
        skip: 1,
        take: 3,
      }),
    );
    expect(result.items.map((item) => item.id)).toEqual([
      "suggestion-3",
      "suggestion-2",
    ]);
    expect(result.nextCursor).toBe("suggestion-2");
  });

  it("counts PENDING suggestions per submitter IP since an instant (NFR-001 soft cap)", async () => {
    const { prisma, count } = createPrisma();
    const repo = makeEventEditSuggestionsRepo(prisma);
    count.mockResolvedValue(3);

    const since = new Date("2026-07-01T00:00:00.000Z");
    await expect(
      repo.countPendingByIp({ submitterIpHash: "a".repeat(64), since }),
    ).resolves.toBe(3);

    expect(count).toHaveBeenCalledWith({
      where: {
        status: "PENDING",
        submitterIpHash: "a".repeat(64),
        createdAt: { gte: since },
      },
    });
  });

  it("counts PENDING suggestions per event", async () => {
    const { prisma, count } = createPrisma();
    const repo = makeEventEditSuggestionsRepo(prisma);
    count.mockResolvedValue(2);

    await expect(repo.countPendingByEvent("event-1")).resolves.toBe(2);

    expect(count).toHaveBeenCalledWith({
      where: { eventId: "event-1", status: "PENDING" },
    });
  });

  it("counts a submitter's suggestions across every status", async () => {
    // Counting twin of listBySubmitter: SAME where clause (no status filter),
    // so `count > 0` can never disagree with "that list renders rows".
    const { prisma, count } = createPrisma();
    const repo = makeEventEditSuggestionsRepo(prisma);
    count.mockResolvedValue(7);

    await expect(repo.countBySubmitter("human-1")).resolves.toBe(7);

    expect(count).toHaveBeenCalledWith({
      where: { submitterHumanId: "human-1" },
    });
  });

  it("markReviewed flips status and records applied/conflicted fields", async () => {
    const { prisma, update } = createPrisma();
    const repo = makeEventEditSuggestionsRepo(prisma);
    update.mockResolvedValue(
      suggestionRow({
        status: "APPROVED",
        reviewedByHumanId: "reviewer-1",
        reviewedAt: NOW,
        appliedFields: { title: "Better Title" },
        conflictedFields: ["startsAt"],
      }),
    );

    const result = await repo.markReviewed({
      id: "suggestion-1",
      status: "APPROVED",
      reviewedByHumanId: "reviewer-1",
      reviewedAt: NOW,
      appliedFields: { title: "Better Title" },
      conflictedFields: ["startsAt"],
    });

    expect(result.status).toBe("APPROVED");
    expect(result.appliedFields).toEqual({ title: "Better Title" });
    expect(result.conflictedFields).toEqual(["startsAt"]);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "suggestion-1" },
        data: expect.objectContaining({
          status: "APPROVED",
          reviewedByHumanId: "reviewer-1",
          reviewedAt: NOW,
          appliedFields: { title: "Better Title" },
          conflictedFields: ["startsAt"],
        }),
      }),
    );
  });
});
