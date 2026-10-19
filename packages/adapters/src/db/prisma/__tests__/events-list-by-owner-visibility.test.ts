import { describe, expect, it, vi } from "vitest";

import { makeEventsRepo } from "../events";
import type { PrismaClientOrTx } from "../types";

/**
 * `listByOwner`'s `visibility` filter backs the ANONYMOUS org/human calendar
 * feeds: a PRIVATE event's title and time must never reach them, and the
 * filter must be in the query (count and page), not applied afterwards.
 */

function makePrisma() {
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  const prisma = { event: { findMany, count } } as unknown as PrismaClientOrTx;
  return { prisma, findMany, count };
}

describe("makeEventsRepo.listByOwner — visibility", () => {
  it("filters on visibility IN the query, for both the page and the count", async () => {
    const { prisma, findMany, count } = makePrisma();
    await makeEventsRepo(prisma).listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: "org-a",
      status: ["PUBLISHED"],
      visibility: ["PUBLIC"],
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where).toEqual({
      orgId: "org-a",
      status: { in: ["PUBLISHED"] },
      visibility: { in: ["PUBLIC"] },
    });
    expect(count).toHaveBeenCalledWith({ where });
  });

  it("absent or empty → no visibility filter (the owner-facing default, unchanged)", async () => {
    for (const visibility of [undefined, []]) {
      const { prisma, findMany } = makePrisma();
      await makeEventsRepo(prisma).listByOwner({
        ownerType: "HUMAN",
        ownerId: "human-a",
        ...(visibility ? { visibility } : {}),
      });
      expect((findMany.mock.calls[0]![0] as any).where).toEqual({
        humanId: "human-a",
      });
    }
  });
});
