import { describe, expect, it, vi } from "vitest";

import { makeTicketsRepo } from "../../../src/db/prisma/tickets";
import type { PrismaClientOrTx } from "../../../src/db/prisma/types";

function basePrisma() {
  return {
    ticket: {
      findMany: vi.fn(),
    },
  };
}

describe("makeTicketsRepo.findByEventAndHuman", () => {
  it("returns mapped rows ordered most-recent-first", async () => {
    const prisma = basePrisma();
    const scannedAt = new Date("2026-04-25T18:00:00.000Z");
    (prisma as any).ticket.findMany.mockResolvedValue([
      {
        id: "t-2",
        code: "AAA222",
        status: "SCANNED",
        scannedAt,
      },
      {
        id: "t-1",
        code: "AAA111",
        status: "VALID",
        scannedAt: null,
      },
    ]);

    const repo = makeTicketsRepo(prisma as unknown as PrismaClientOrTx);
    const result = await repo.findByEventAndHuman("event-1", "human-1");

    expect(prisma.ticket.findMany).toHaveBeenCalledWith({
      where: { eventId: "event-1", ownerHumanId: "human-1" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        code: true,
        status: true,
        scannedAt: true,
      },
    });
    expect(result).toEqual([
      { ticketId: "t-2", ticketCode: "AAA222", status: "SCANNED", scannedAt },
      {
        ticketId: "t-1",
        ticketCode: "AAA111",
        status: "VALID",
        scannedAt: null,
      },
    ]);
  });

  it("returns an empty array when no rows match", async () => {
    const prisma = basePrisma();
    (prisma as any).ticket.findMany.mockResolvedValue([]);

    const repo = makeTicketsRepo(prisma as unknown as PrismaClientOrTx);
    const result = await repo.findByEventAndHuman("event-1", "human-x");

    expect(result).toEqual([]);
  });

  it("preserves the underlying row order returned by Prisma (orderBy createdAt desc)", async () => {
    const prisma = basePrisma();
    (prisma as any).ticket.findMany.mockResolvedValue([
      { id: "t-newer", code: "NEW111", status: "VALID", scannedAt: null },
      { id: "t-older", code: "OLD111", status: "VALID", scannedAt: null },
    ]);

    const repo = makeTicketsRepo(prisma as unknown as PrismaClientOrTx);
    const result = await repo.findByEventAndHuman("event-1", "human-1");

    expect(result.map((r) => r.ticketId)).toEqual(["t-newer", "t-older"]);
  });
});
