import { describe, expect, it, vi } from "vitest";

import { makePushReceiptsRepo } from "../push-receipts";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-07-07T12:00:00.000Z");
const CHECK_AFTER = new Date("2026-07-07T12:15:00.000Z");

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "receipt-1",
    ticketId: "ticket-1",
    pushDeviceId: "device-1",
    attempts: 0,
    checkAfter: new Date("2026-07-07T11:45:00.000Z"),
    createdAt: new Date("2026-07-07T11:30:00.000Z"),
    ...overrides,
  };
}

function createPrisma() {
  const createMany = vi.fn();
  const findMany = vi.fn();
  const deleteMany = vi.fn();
  const updateMany = vi.fn();

  const prisma = {
    pushReceipt: {
      createMany,
      findMany,
      deleteMany,
      updateMany,
    },
  } as unknown as PrismaClientOrTx;

  return { prisma, createMany, findMany, deleteMany, updateMany };
}

describe("makePushReceiptsRepo", () => {
  it("createMany inserts pending receipts with skipDuplicates (and no-ops on empty)", async () => {
    const { prisma, createMany } = createPrisma();
    const repo = makePushReceiptsRepo(prisma);
    createMany.mockResolvedValue({ count: 2 });

    await repo.createMany({ items: [], checkAfter: CHECK_AFTER });
    expect(createMany).not.toHaveBeenCalled();

    await repo.createMany({
      items: [
        { ticketId: "ticket-1", pushDeviceId: "device-1" },
        { ticketId: "ticket-2", pushDeviceId: "device-2" },
      ],
      checkAfter: CHECK_AFTER,
    });

    // skipDuplicates is defensive: no known path re-inserts a ticketId, but
    // an unforeseen double-persistence must skip silently rather than throw
    // a P2002 into the send path.
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          ticketId: "ticket-1",
          pushDeviceId: "device-1",
          checkAfter: CHECK_AFTER,
        },
        {
          ticketId: "ticket-2",
          pushDeviceId: "device-2",
          checkAfter: CHECK_AFTER,
        },
      ],
      skipDuplicates: true,
    });
  });

  it("listDue selects rows past checkAfter, oldest first, bounded", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makePushReceiptsRepo(prisma);
    findMany.mockResolvedValue([receiptRow()]);

    const rows = await repo.listDue({ now: NOW, limit: 100 });

    expect(rows).toEqual([receiptRow()]);
    expect(findMany).toHaveBeenCalledWith({
      where: { checkAfter: { lte: NOW } },
      orderBy: { checkAfter: "asc" },
      take: 100,
      select: expect.any(Object),
    });
  });

  it("deleteByIds hard-deletes idempotently and returns the count (no-op on empty)", async () => {
    const { prisma, deleteMany } = createPrisma();
    const repo = makePushReceiptsRepo(prisma);
    deleteMany.mockResolvedValue({ count: 2 });

    expect(await repo.deleteByIds([])).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();

    const count = await repo.deleteByIds(["receipt-1", "receipt-2"]);
    expect(count).toBe(2);
    // deleteMany (not delete) so overlapping drain runs can't throw P2025.
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["receipt-1", "receipt-2"] } },
    });
  });

  it("reschedule bumps attempts and pushes checkAfter back (no-op on empty)", async () => {
    const { prisma, updateMany } = createPrisma();
    const repo = makePushReceiptsRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });

    await repo.reschedule({ ids: [], checkAfter: CHECK_AFTER });
    expect(updateMany).not.toHaveBeenCalled();

    await repo.reschedule({ ids: ["receipt-1"], checkAfter: CHECK_AFTER });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["receipt-1"] } },
      data: {
        attempts: { increment: 1 },
        checkAfter: CHECK_AFTER,
      },
    });
  });
});
