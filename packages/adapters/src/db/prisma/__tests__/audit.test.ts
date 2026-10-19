import { describe, expect, it, vi } from "vitest";

import { makeAuditRepo } from "../audit";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-07-06T12:00:00.000Z");

function createPrisma(rows: unknown[] = [], total = rows.length) {
  const findMany = vi.fn(async () => rows);
  const count = vi.fn(async () => total);
  const create = vi.fn(async () => undefined);

  const prisma = {
    auditLog: { findMany, count, create },
  } as unknown as PrismaClientOrTx;

  return { prisma, findMany, count, create };
}

describe("makeAuditRepo.log", () => {
  it("creates a row with entity/action/data/at, defaulting entityId and data", async () => {
    const { prisma, create } = createPrisma();
    const repo = makeAuditRepo(prisma);

    await repo.log({ entity: "event", action: "created" });

    expect(create).toHaveBeenCalledWith({
      data: {
        entity: "event",
        entityId: null,
        action: "created",
        data: {},
        at: expect.any(Date),
      },
    });
  });
});

describe("makeAuditRepo.list", () => {
  it("sorts by `at` descending and paginates by default", async () => {
    const { prisma, findMany, count } = createPrisma([], 0);
    const repo = makeAuditRepo(prisma);

    await repo.list({});

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
        orderBy: { at: "desc" },
        skip: 0,
        take: 25,
      }),
    );
    expect(count).toHaveBeenCalledWith({ where: {} });
  });

  it("honors sort=at_asc and custom limit/offset", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeAuditRepo(prisma);

    await repo.list({ sort: "at_asc", limit: 10, offset: 20 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { at: "asc" },
        skip: 20,
        take: 10,
      }),
    );
  });

  it("builds a contains-mode where clause for entity/action filters", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeAuditRepo(prisma);

    await repo.list({ entity: "event", action: "created" });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entity: { contains: "event", mode: "insensitive" },
          action: { contains: "created", mode: "insensitive" },
        },
      }),
    );
  });

  it("applies an exact-match entityId filter", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeAuditRepo(prisma);

    await repo.list({ entityId: "event-1" });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entityId: "event-1" } }),
    );
  });

  it("applies an inclusive `at` date range", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeAuditRepo(prisma);
    const atGte = new Date("2026-07-01T00:00:00.000Z");
    const atLte = new Date("2026-07-07T00:00:00.000Z");

    await repo.list({ atGte, atLte });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { at: { gte: atGte, lte: atLte } } }),
    );
  });

  it("filters on data.actorHumanId via a JSON path filter", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeAuditRepo(prisma);

    await repo.list({ actorHumanId: "human-1" });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { data: { path: ["actorHumanId"], equals: "human-1" } },
      }),
    );
  });

  it("best-effort extracts actorHumanId from the data blob, tolerating absence/malformed shapes", async () => {
    const rows = [
      { id: "1", entity: "event", entityId: null, action: "created", data: { actorHumanId: "human-1" }, at: NOW },
      { id: "2", entity: "event", entityId: null, action: "created", data: {}, at: NOW },
      { id: "3", entity: "event", entityId: null, action: "created", data: null, at: NOW },
      { id: "4", entity: "event", entityId: null, action: "created", data: [1, 2, 3], at: NOW },
      { id: "5", entity: "event", entityId: null, action: "created", data: { actorHumanId: 42 }, at: NOW },
    ];
    const { prisma } = createPrisma(rows, rows.length);
    const repo = makeAuditRepo(prisma);

    const result = await repo.list({});

    expect(result.items.map((i) => i.actorHumanId)).toEqual([
      "human-1",
      null,
      null,
      null,
      null,
    ]);
    expect(result.total).toBe(5);
  });
});

describe("makeAuditRepo.listForEntity", () => {
  it("filters EXACTLY on entity, entityId and actions, newest first, no count", async () => {
    const rows = [
      {
        id: "a2",
        entity: "entity_page",
        entityId: "page-1",
        action: "entity_page.community_updated",
        data: { actorHumanId: "human-mod" },
        at: NOW,
      },
    ];
    const { prisma, findMany, count } = createPrisma(rows);
    const repo = makeAuditRepo(prisma);

    const result = await repo.listForEntity({
      entity: "entity_page",
      entityId: "page-1",
      actions: ["entity_page.community_updated"],
      limit: 1,
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        entity: "entity_page",
        entityId: "page-1",
        action: { in: ["entity_page.community_updated"] },
      },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: 1,
    });
    expect(count).not.toHaveBeenCalled();
    expect(result).toEqual([
      { ...rows[0], actorHumanId: "human-mod" },
    ]);
  });

  it("bounds by `after` (strictly newer) and clamps the limit", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeAuditRepo(prisma);

    await repo.listForEntity({
      entity: "entity_page",
      entityId: "page-1",
      actions: ["a", "b"],
      after: NOW,
      limit: 10_000,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: { in: ["a", "b"] },
          at: { gt: NOW },
        }),
        take: 500,
      }),
    );
  });

  it("reads ONE row for a non-finite limit (NaN / Infinity), never all", async () => {
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const { prisma, findMany } = createPrisma();
      const repo = makeAuditRepo(prisma);
      await repo.listForEntity({
        entity: "entity_page",
        entityId: "page-1",
        actions: ["a"],
        limit,
      });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1 }),
      );
    }
  });

  it("reads nothing for an empty action list", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeAuditRepo(prisma);

    await expect(
      repo.listForEntity({
        entity: "entity_page",
        entityId: "page-1",
        actions: [],
        limit: 5,
      }),
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
