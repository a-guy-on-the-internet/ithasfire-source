import { describe, expect, it, vi } from "vitest";

import { makeEventsRepo } from "../events";
import type { PrismaClientOrTx } from "../types";

vi.mock("@th/core/lib/geo", () => ({
  encodeGeohash: vi.fn(),
}));

const NOW = new Date("2026-09-01T12:00:00.000Z");
const OCT_1 = new Date("2026-10-01T20:00:00.000Z");
const NOV_5 = new Date("2026-11-05T20:00:00.000Z");

function createPrisma() {
  const groupBy = vi.fn();
  const prisma = { event: { groupBy } } as unknown as PrismaClientOrTx;
  return { prisma, groupBy };
}

describe("makeEventsRepo.getUpcomingStatsForOwners", () => {
  it("returns [] without querying for no owners", async () => {
    const { prisma, groupBy } = createPrisma();
    const repo = makeEventsRepo(prisma);
    await expect(
      repo.getUpcomingStatsForOwners({ owners: [], now: NOW }),
    ).resolves.toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("issues one grouped query per owner arm — PUBLISHED, TICKETED, startsAt > now — and maps count + soonest start", async () => {
    const { prisma, groupBy } = createPrisma();
    const repo = makeEventsRepo(prisma);
    groupBy
      .mockResolvedValueOnce([
        { orgId: "org-1", _count: { _all: 2 }, _min: { startsAt: OCT_1 } },
      ])
      .mockResolvedValueOnce([
        { humanId: "human-1", _count: { _all: 1 }, _min: { startsAt: NOV_5 } },
        // Defensive: a group with no min start cannot be "upcoming" — dropped.
        { humanId: "human-2", _count: { _all: 0 }, _min: { startsAt: null } },
      ]);

    const rows = await repo.getUpcomingStatsForOwners({
      owners: [
        { ownerType: "ORGANIZATION", ownerId: "org-1" },
        { ownerType: "HUMAN", ownerId: "human-1" },
        { ownerType: "HUMAN", ownerId: "human-2" },
      ],
      now: NOW,
    });

    expect(groupBy).toHaveBeenNthCalledWith(1, {
      by: ["orgId"],
      where: {
        status: "PUBLISHED",
        attendanceMode: "TICKETED",
        startsAt: { gt: NOW },
        orgId: { in: ["org-1"] },
      },
      _count: { _all: true },
      _min: { startsAt: true },
    });
    expect(groupBy).toHaveBeenNthCalledWith(2, {
      by: ["humanId"],
      where: {
        status: "PUBLISHED",
        attendanceMode: "TICKETED",
        startsAt: { gt: NOW },
        humanId: { in: ["human-1", "human-2"] },
      },
      _count: { _all: true },
      _min: { startsAt: true },
    });
    expect(rows).toEqual([
      {
        ownerType: "ORGANIZATION",
        ownerId: "org-1",
        upcomingCount: 2,
        nextEventAt: OCT_1,
      },
      {
        ownerType: "HUMAN",
        ownerId: "human-1",
        upcomingCount: 1,
        nextEventAt: NOV_5,
      },
    ]);
  });

  it("excludes RSVP listings: every arm's predicate pins attendanceMode TICKETED, so an RSVP-only owner reports nothing", async () => {
    const { prisma, groupBy } = createPrisma();
    const repo = makeEventsRepo(prisma);
    // The database answers the TICKETED predicate; an owner whose only
    // upcoming listing is RSVP has no group and is therefore absent.
    groupBy.mockResolvedValueOnce([]);
    const rows = await repo.getUpcomingStatsForOwners({
      owners: [{ ownerType: "ORGANIZATION", ownerId: "org-rsvp-only" }],
      now: NOW,
    });
    expect(rows).toEqual([]);
    const call = groupBy.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(call.where).toMatchObject({ attendanceMode: "TICKETED" });
    expect(call.where).not.toHaveProperty("attendanceMode", "RSVP");
  });

  it("skips the human arm entirely when only organisations are asked for", async () => {
    const { prisma, groupBy } = createPrisma();
    const repo = makeEventsRepo(prisma);
    groupBy.mockResolvedValueOnce([]);
    await repo.getUpcomingStatsForOwners({
      owners: [{ ownerType: "ORGANIZATION", ownerId: "org-1" }],
      now: NOW,
    });
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ["orgId"] }),
    );
  });
});
