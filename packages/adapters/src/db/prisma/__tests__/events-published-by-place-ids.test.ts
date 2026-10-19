import { describe, expect, it, vi } from "vitest";

import { makeEventsRepo } from "../events";
import type { PrismaClientOrTx } from "../types";

/**
 * `listPublishedByPlaceIds` is the BATCHED sibling of `listPublishedByPlace`,
 * added so the org/human embed's `scope: "venues"` doesn't N+1 the single-place
 * lister once per owned venue.
 *
 * It must mirror the single-place lister's gate exactly: PUBLISHED + PUBLIC +
 * the `startsAt` window, in the same chronological order. The PUBLIC clause in
 * particular is load-bearing — a venue calendar must never surface a private
 * or unlisted event to the open internet.
 */

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-12-31T00:00:00.000Z");

function makePrisma(rows: unknown[] = []) {
  const findMany = vi.fn(async () => rows);
  const prisma = {
    event: { findMany, count: vi.fn(async () => rows.length) },
  } as unknown as PrismaClientOrTx;
  return { prisma, findMany };
}

const baseInput = {
  placeIds: ["place-a", "place-b"],
  from: FROM,
  to: TO,
  status: "upcoming" as const,
};

describe("makeEventsRepo.listPublishedByPlaceIds", () => {
  it("filters to PUBLISHED + PUBLIC events inside the startsAt window", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makeEventsRepo(prisma);

    await repo.listPublishedByPlaceIds(baseInput);

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where).toMatchObject({
      status: "PUBLISHED",
      visibility: "PUBLIC",
      placeId: { in: ["place-a", "place-b"] },
      startsAt: { gte: FROM, lte: TO },
    });
  });

  it("orders upcoming events chronologically, like listPublishedByPlace", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makeEventsRepo(prisma);

    await repo.listPublishedByPlaceIds(baseInput);

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.orderBy).toEqual([{ startsAt: "asc" }, { createdAt: "asc" }]);
  });

  it("orders past events newest-first, like listPublishedByPlace", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makeEventsRepo(prisma);

    await repo.listPublishedByPlaceIds({ ...baseInput, status: "past" });

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.orderBy).toEqual([{ startsAt: "desc" }, { createdAt: "desc" }]);
  });

  it("short-circuits on an empty placeIds without querying at all", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makeEventsRepo(prisma);

    const result = await repo.listPublishedByPlaceIds({
      ...baseInput,
      placeIds: [],
    });

    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("dedupes and trims placeIds before querying", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makeEventsRepo(prisma);

    await repo.listPublishedByPlaceIds({
      ...baseInput,
      placeIds: ["place-a", " place-a ".trim(), "place-b", "", "  "],
    });

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where.placeId.in).toEqual(["place-a", "place-b"]);
  });

  it("clamps the limit so a many-venue subject can't fan out unbounded", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makeEventsRepo(prisma);

    await repo.listPublishedByPlaceIds({ ...baseInput, limit: 10_000 });

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.take).toBe(200);
  });

  it("applies a default limit when none is given", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makeEventsRepo(prisma);

    await repo.listPublishedByPlaceIds(baseInput);

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.take).toBe(50);
  });
});
