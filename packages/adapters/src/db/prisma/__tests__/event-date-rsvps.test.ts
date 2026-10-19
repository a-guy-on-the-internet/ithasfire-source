import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { makeEventDateRsvpsRepo } from "../event-date-rsvps";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-07-01T12:00:00.000Z");

function rsvpRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rsvp-1",
    eventDateId: "date-1",
    humanId: "human-1",
    createdAt: NOW,
    ...overrides,
  };
}

/** A Prisma unique-constraint violation on the [eventDateId, humanId] index. */
function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

function createPrisma() {
  const create = vi.fn();
  const deleteMany = vi.fn();
  const findUnique = vi.fn();
  const findMany = vi.fn();
  const findFirst = vi.fn();

  const prisma = {
    eventDateRsvp: {
      create,
      deleteMany,
      findUnique,
      findMany,
      findFirst,
    },
  } as unknown as PrismaClientOrTx;

  return { prisma, create, deleteMany, findUnique, findMany, findFirst };
}

describe("makeEventDateRsvpsRepo", () => {
  it("inserts a new per-date RSVP row via create and reports created: true", async () => {
    const { prisma, create } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);
    create.mockResolvedValue(rsvpRow());

    const result = await repo.upsert({
      eventDateId: "date-1",
      humanId: "human-1",
    });

    // `created: true` ONLY on the successful insert branch — this is what
    // gates the per-date RSVP-confirmation enqueue upstream.
    expect(result).toEqual({ record: rsvpRow(), created: true });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { eventDateId: "date-1", humanId: "human-1" },
      }),
    );
  });

  it("is idempotent: a concurrent RSVP's unique conflict reads the existing row back (created: false)", async () => {
    const { prisma, create, findUnique } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);

    // create loses the race to a concurrent insert (P2002); the row exists.
    create.mockRejectedValueOnce(uniqueViolation());
    findUnique.mockResolvedValueOnce(rsvpRow());

    const result = await repo.upsert({
      eventDateId: "date-1",
      humanId: "human-1",
    });

    // Read-back of a pre-existing row must NOT report created — a re-RSVP
    // (or a lost insert race) never triggers a duplicate confirmation.
    expect(result).toEqual({ record: rsvpRow(), created: false });
    expect(create).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          eventDateId_humanId: { eventDateId: "date-1", humanId: "human-1" },
        },
      }),
    );
  });

  it("tolerates the insert-vs-delete race: conflict → row already deleted → retries create", async () => {
    const { prisma, create, findUnique } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);

    // Attempt 1: a concurrent insert won (P2002), but by the time we read it
    // back a concurrent cancel had deleted it → findUnique is null.
    create.mockRejectedValueOnce(uniqueViolation());
    findUnique.mockResolvedValueOnce(null);
    // Attempt 2: the row is gone, so our create now succeeds.
    create.mockResolvedValueOnce(rsvpRow());

    const result = await repo.upsert({
      eventDateId: "date-1",
      humanId: "human-1",
    });

    // The retry loop ended on a successful INSERT → created: true.
    expect(result).toEqual({ record: rsvpRow(), created: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("throws a plain Error (never returns undefined) if the race never settles", async () => {
    const { prisma, create, findUnique } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);

    // Every attempt: conflict then deleted-before-readback, forever.
    create.mockRejectedValue(uniqueViolation());
    findUnique.mockResolvedValue(null);

    await expect(
      repo.upsert({ eventDateId: "date-1", humanId: "human-1" }),
    ).rejects.toThrow(/could not settle/i);
  });

  it("rethrows non-P2002 errors from create unchanged", async () => {
    const { prisma, create } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);
    const boom = new Error("connection reset");
    create.mockRejectedValueOnce(boom);

    await expect(
      repo.upsert({ eventDateId: "date-1", humanId: "human-1" }),
    ).rejects.toBe(boom);
  });

  it("delete is a no-op for a missing row (deleteMany, no throw)", async () => {
    const { prisma, deleteMany } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);
    deleteMany.mockResolvedValue({ count: 0 });

    await expect(
      repo.delete({ eventDateId: "date-1", humanId: "human-1" }),
    ).resolves.toBeUndefined();

    expect(deleteMany).toHaveBeenCalledWith({
      where: { eventDateId: "date-1", humanId: "human-1" },
    });
  });

  it("existsForUser reads the compound unique", async () => {
    const { prisma, findUnique } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);
    findUnique.mockResolvedValueOnce({ id: "rsvp-1" });
    findUnique.mockResolvedValueOnce(null);

    await expect(
      repo.existsForUser({ eventDateId: "date-1", humanId: "human-1" }),
    ).resolves.toBe(true);
    await expect(
      repo.existsForUser({ eventDateId: "date-1", humanId: "human-2" }),
    ).resolves.toBe(false);
  });

  it("existsForUserOnEvent asks for ONE row of the person's on the event's nights, filtered by status when given", async () => {
    const { prisma, findFirst } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);
    findFirst.mockResolvedValueOnce({ id: "rsvp-1" });
    findFirst.mockResolvedValueOnce(null);

    await expect(
      repo.existsForUserOnEvent({
        eventId: "event-1",
        humanId: "human-1",
        dateStatus: "CANCELLED",
      }),
    ).resolves.toBe(true);
    await expect(
      repo.existsForUserOnEvent({ eventId: "event-1", humanId: "human-2" }),
    ).resolves.toBe(false);

    expect(findFirst.mock.calls[0]![0]).toEqual({
      where: {
        humanId: "human-1",
        eventDate: { eventId: "event-1", status: "CANCELLED" },
      },
      select: { id: true },
    });
    expect(findFirst.mock.calls[1]![0]).toEqual({
      where: { humanId: "human-2", eventDate: { eventId: "event-1" } },
      select: { id: true },
    });
  });

  it("existsForUserOnEvent bounds the nights by start when startsAtFrom is given (inclusive)", async () => {
    const { prisma, findFirst } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);
    findFirst.mockResolvedValueOnce(null);
    const from = new Date("2026-11-01T02:00:00.000Z");

    await expect(
      repo.existsForUserOnEvent({
        eventId: "event-1",
        humanId: "human-1",
        dateStatus: "CANCELLED",
        startsAtFrom: from,
      }),
    ).resolves.toBe(false);

    expect(findFirst.mock.calls[0]![0]).toEqual({
      where: {
        humanId: "human-1",
        eventDate: {
          eventId: "event-1",
          status: "CANCELLED",
          startsAt: { gte: from },
        },
      },
      select: { id: true },
    });
  });

  it("listDateIdsForHuman batches the viewer's RSVP'd subset (empty input short-circuits)", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);
    findMany.mockResolvedValue([
      { eventDateId: "date-1" },
      { eventDateId: "date-3" },
    ]);

    const result = await repo.listDateIdsForHuman({
      humanId: "human-1",
      eventDateIds: ["date-1", "date-2", "date-3"],
    });

    expect(result).toEqual(["date-1", "date-3"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          humanId: "human-1",
          eventDateId: { in: ["date-1", "date-2", "date-3"] },
        },
        select: { eventDateId: true },
      }),
    );

    // Empty input never hits the DB.
    findMany.mockClear();
    await expect(
      repo.listDateIdsForHuman({ humanId: "human-1", eventDateIds: [] }),
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("listDateIdsWithAnyRsvp answers PRESENCE per date — distinct ids, never a count", async () => {
    // The moderator's "which of the nights I am about to drop has anyone
    // RSVP'd to" read. `distinct` collapses forty RSVPs on one night to one
    // id, which is the whole point: nothing here can be summed into the
    // going-count FR-004 forbids.
    const { prisma, findMany } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);
    findMany.mockResolvedValue([{ eventDateId: "date-2" }]);

    const result = await repo.listDateIdsWithAnyRsvp(["date-1", "date-2", "date-3"]);

    expect(result).toEqual(["date-2"]);
    expect(findMany).toHaveBeenCalledWith({
      where: { eventDateId: { in: ["date-1", "date-2", "date-3"] } },
      select: { eventDateId: true },
      distinct: ["eventDateId"],
    });

    // Empty input never hits the DB.
    findMany.mockClear();
    await expect(repo.listDateIdsWithAnyRsvp([])).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("listHumanIdsForDate returns the call-off fan-out's recipients — ids, never a count", async () => {
    // The one read on this repo that is not scoped to the asking viewer. It
    // exists so `cancelEventDate` can address the people it is about to
    // disappoint; FR-004 still forbids a going-count, so it selects `humanId`
    // and nothing else, and no `count` sibling may be added next to it.
    const { prisma, findMany } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);
    findMany.mockResolvedValue([
      { humanId: "human-1" },
      { humanId: "human-2" },
    ]);

    const result = await repo.listHumanIdsForDate("date-1");

    expect(result).toEqual(["human-1", "human-2"]);
    expect(findMany).toHaveBeenCalledWith({
      where: { eventDateId: "date-1" },
      select: { humanId: true },
      orderBy: { createdAt: "asc" },
    });
    // NOT paged: everyone who said they were coming has to be told, so a
    // `take` here would be a silently-truncated notification list.
    expect(findMany.mock.calls[0]![0]).not.toHaveProperty("take");
  });

  it("listHumanIdsForDate returns an empty list for a date nobody RSVP'd", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventDateRsvpsRepo(prisma);
    findMany.mockResolvedValue([]);

    await expect(repo.listHumanIdsForDate("date-9")).resolves.toEqual([]);
  });
});
