import { describe, expect, it, vi } from "vitest";

import {
  MARK_CHUNK_SIZE,
  makeSearchReindexPendingRepo,
} from "../search-reindex-pending";
import type { PrismaClientOrTx } from "../types";

const AT = new Date("2026-10-16T12:00:00.000Z");

function createPrisma() {
  const createMany = vi.fn(async (_args: { data: unknown[] }) => ({
    count: 0,
  }));
  const updateMany = vi.fn(
    async (_args: { where: { OR: unknown[] } }) => ({ count: 0 }),
  );
  const prisma = {
    searchReindexPending: { createMany, updateMany },
  } as unknown as PrismaClientOrTx;
  return { prisma, createMany, updateMany };
}

const events = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    entityType: "event" as const,
    entityId: `ev-${String(i).padStart(6, "0")}`,
  }));

describe("makeSearchReindexPendingRepo.mark chunking", () => {
  it("does nothing for no targets", async () => {
    const { prisma, createMany, updateMany } = createPrisma();

    await makeSearchReindexPendingRepo(prisma).mark([], AT);

    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("writes one statement pair up to the chunk size", async () => {
    const { prisma, createMany, updateMany } = createPrisma();

    await makeSearchReindexPendingRepo(prisma).mark(
      events(MARK_CHUNK_SIZE),
      AT,
    );

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0]?.[0].where.OR).toHaveLength(
      MARK_CHUNK_SIZE,
    );
  });

  it("splits a large mark into bounded statements that together cover every target once", async () => {
    const { prisma, createMany, updateMany } = createPrisma();
    const total = MARK_CHUNK_SIZE * 2 + 5;
    // Duplicates collapse before chunking.
    const targets = [...events(total), ...events(10)];

    await makeSearchReindexPendingRepo(prisma).mark(targets, AT);

    expect(createMany).toHaveBeenCalledTimes(3);
    expect(updateMany).toHaveBeenCalledTimes(3);
    const sizes = updateMany.mock.calls.map(
      ([args]) => args.where.OR.length,
    );
    expect(sizes).toEqual([MARK_CHUNK_SIZE, MARK_CHUNK_SIZE, 5]);
    const covered = updateMany.mock.calls.flatMap(([args]) =>
      (args.where.OR as Array<{ entityId: string }>).map((t) => t.entityId),
    );
    expect(new Set(covered).size).toBe(total);
    expect(covered).toHaveLength(total);
    // Each chunk inserts exactly the rows it then bumps.
    createMany.mock.calls.forEach(([args], i) => {
      expect(args.data).toHaveLength(sizes[i] ?? -1);
    });
  });
});
