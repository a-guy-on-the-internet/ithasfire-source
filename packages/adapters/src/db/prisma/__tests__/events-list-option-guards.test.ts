import { describe, expect, it, vi } from "vitest";

import { makeEventsRepo } from "../events";
import type { PrismaClientOrTx } from "../types";

/**
 * Two list-read options only mean something next to a prerequisite:
 *
 *  - `matchDateOccurrencesOnly` narrows the FR-003 EventDate arm, which
 *    exists only with `includeDateOccurrences` (and, for `listByOwner`, a
 *    bounded `dateRange`). Without it the flag used to fall back silently to
 *    the plain pinned `startsAt` read: a WIDER result than the caller asked
 *    for. It now throws before any query.
 *  - `withheldOwners` is a pre-resolved ban set for `excludeBannedOwners`.
 *    Passed with it, the adapter filters on that set and does not resolve its
 *    own (one resolve per feed request, not one per read). Passed without it,
 *    the set would filter nothing, so that throws too.
 */

function makePrisma() {
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  // `resolveWithheldOwners` is the only raw query these reads make.
  const queryRaw = vi.fn(async () => [{ kind: "HUMAN", id: "resolved-human" }]);
  const prisma = {
    event: { findMany, count },
    $queryRaw: queryRaw,
  } as unknown as PrismaClientOrTx;
  return { prisma, findMany, count, queryRaw };
}

const FROM = new Date("2026-10-18T00:00:00Z");
const TO = new Date("2027-01-16T00:00:00Z");

const placeBase = {
  placeId: "place-a",
  from: FROM,
  to: TO,
  status: "upcoming" as const,
};

const ownerBase = {
  ownerType: "ORGANIZATION" as const,
  ownerId: "org-a",
  status: ["PUBLISHED" as const],
};

const WITHHELD = { humanIds: ["banned-human"], orgIds: ["banned-org"] };
const WITHHELD_WHERE = {
  AND: [
    { OR: [{ humanId: null }, { humanId: { notIn: ["banned-human"] } }] },
    { OR: [{ orgId: null }, { orgId: { notIn: ["banned-org"] } }] },
  ],
};

const whereOf = (findMany: ReturnType<typeof vi.fn>) =>
  (findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;

describe("listPublishedByPlace — option prerequisites", () => {
  it("matchDateOccurrencesOnly without includeDateOccurrences throws before any query", async () => {
    for (const includeDateOccurrences of [undefined, false]) {
      const { prisma, findMany, count, queryRaw } = makePrisma();
      await expect(
        makeEventsRepo(prisma).listPublishedByPlace({
          ...placeBase,
          matchDateOccurrencesOnly: true,
          ...(includeDateOccurrences === undefined ? {} : { includeDateOccurrences }),
        }),
      ).rejects.toThrow(/matchDateOccurrencesOnly requires includeDateOccurrences/);
      expect(findMany).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
      expect(queryRaw).not.toHaveBeenCalled();
    }
  });

  it("with includeDateOccurrences it matches on the EventDate arm only (no pinned startsAt arm)", async () => {
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listPublishedByPlace({
      ...placeBase,
      includeDateOccurrences: true,
      matchDateOccurrencesOnly: true,
      dateOccurrenceStatuses: ["CANCELLED"],
    });
    expect(whereOf(findMany).OR).toEqual([
      {
        dates: {
          some: {
            status: { in: ["CANCELLED"] },
            startsAt: { gte: FROM, lte: TO },
          },
        },
      },
    ]);
    expect(whereOf(findMany).startsAt).toBeUndefined();
  });

  it("withheldOwners without excludeBannedOwners throws before any query", async () => {
    const { prisma, findMany, queryRaw } = makePrisma();
    await expect(
      makeEventsRepo(prisma).listPublishedByPlace({
        ...placeBase,
        withheldOwners: WITHHELD,
      }),
    ).rejects.toThrow(/withheldOwners requires excludeBannedOwners/);
    expect(findMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("a pre-resolved withheldOwners set is filtered on and NOT resolved again", async () => {
    const { prisma, findMany, count, queryRaw } = makePrisma();
    await makeEventsRepo(prisma).listPublishedByPlace({
      ...placeBase,
      excludeBannedOwners: true,
      withheldOwners: WITHHELD,
    });
    expect(queryRaw).not.toHaveBeenCalled();
    const where = whereOf(findMany);
    expect(where.AND).toEqual([WITHHELD_WHERE]);
    expect(count).toHaveBeenCalledWith({ where });
  });

  it("excludeBannedOwners alone still resolves the set itself (every other caller unchanged)", async () => {
    const { prisma, findMany, queryRaw } = makePrisma();
    await makeEventsRepo(prisma).listPublishedByPlace({
      ...placeBase,
      excludeBannedOwners: true,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(whereOf(findMany).AND).toEqual([
      {
        AND: [
          { OR: [{ humanId: null }, { humanId: { notIn: ["resolved-human"] } }] },
        ],
      },
    ]);
  });
});

describe("listByOwner — option prerequisites", () => {
  it("matchDateOccurrencesOnly without includeDateOccurrences throws before any query", async () => {
    const { prisma, findMany, count } = makePrisma();
    await expect(
      makeEventsRepo(prisma).listByOwner({
        ...ownerBase,
        dateRange: { from: FROM },
        matchDateOccurrencesOnly: true,
      }),
    ).rejects.toThrow(/matchDateOccurrencesOnly requires includeDateOccurrences and a bounded dateRange/);
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("matchDateOccurrencesOnly without a bounded dateRange throws before any query", async () => {
    for (const dateRange of [undefined, {}]) {
      const { prisma, findMany } = makePrisma();
      await expect(
        makeEventsRepo(prisma).listByOwner({
          ...ownerBase,
          includeDateOccurrences: true,
          matchDateOccurrencesOnly: true,
          ...(dateRange ? { dateRange } : {}),
        }),
      ).rejects.toThrow(/matchDateOccurrencesOnly requires/);
      expect(findMany).not.toHaveBeenCalled();
    }
  });

  it("with both prerequisites it matches on the EventDate arm only (no pinned startsAt arm)", async () => {
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listByOwner({
      ...ownerBase,
      includeDateOccurrences: true,
      matchDateOccurrencesOnly: true,
      dateOccurrenceStatuses: ["CANCELLED"],
      dateRange: { from: FROM },
    });
    expect(whereOf(findMany).AND).toEqual([
      {
        OR: [
          {
            dates: {
              some: { status: { in: ["CANCELLED"] }, startsAt: { gte: FROM } },
            },
          },
        ],
      },
    ]);
  });

  it("withheldOwners without excludeBannedOwners throws before any query", async () => {
    const { prisma, findMany, queryRaw } = makePrisma();
    await expect(
      makeEventsRepo(prisma).listByOwner({ ...ownerBase, withheldOwners: WITHHELD }),
    ).rejects.toThrow(/withheldOwners requires excludeBannedOwners/);
    expect(findMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("a pre-resolved withheldOwners set is filtered on and NOT resolved again", async () => {
    const { prisma, findMany, count, queryRaw } = makePrisma();
    await makeEventsRepo(prisma).listByOwner({
      ...ownerBase,
      excludeBannedOwners: true,
      withheldOwners: WITHHELD,
    });
    expect(queryRaw).not.toHaveBeenCalled();
    const where = whereOf(findMany);
    expect(where.AND).toEqual([WITHHELD_WHERE]);
    expect(count).toHaveBeenCalledWith({ where });
  });

  it("excludeBannedOwners alone still resolves the set itself (every other caller unchanged)", async () => {
    const { prisma, queryRaw } = makePrisma();
    await makeEventsRepo(prisma).listByOwner({
      ...ownerBase,
      excludeBannedOwners: true,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
