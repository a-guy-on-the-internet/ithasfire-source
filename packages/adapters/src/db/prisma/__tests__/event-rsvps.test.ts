import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { makeEventRsvpsRepo } from "../event-rsvps";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-07-01T12:00:00.000Z");

function rsvpRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rsvp-1",
    eventId: "event-1",
    humanId: "human-1",
    createdAt: NOW,
    ...overrides,
  };
}

/** A Prisma unique-constraint violation on the [eventId, humanId] index. */
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

  const prisma = {
    eventRsvp: {
      create,
      deleteMany,
      findUnique,
      findMany,
    },
  } as unknown as PrismaClientOrTx;

  return { prisma, create, deleteMany, findUnique, findMany };
}

describe("makeEventRsvpsRepo", () => {
  it("inserts a new RSVP row via create and reports created: true", async () => {
    const { prisma, create } = createPrisma();
    const repo = makeEventRsvpsRepo(prisma);
    create.mockResolvedValue(rsvpRow());

    const result = await repo.upsert({
      eventId: "event-1",
      humanId: "human-1",
    });

    // `created: true` ONLY on the successful insert branch — this is what
    // gates the RSVP-confirmation enqueue upstream.
    expect(result).toEqual({ record: rsvpRow(), created: true });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { eventId: "event-1", humanId: "human-1" },
      }),
    );
  });

  it("is idempotent: a concurrent RSVP's unique conflict reads the existing row back (created: false)", async () => {
    const { prisma, create, findUnique } = createPrisma();
    const repo = makeEventRsvpsRepo(prisma);

    // create loses the race to a concurrent insert (P2002); the row exists.
    create.mockRejectedValueOnce(uniqueViolation());
    findUnique.mockResolvedValueOnce(rsvpRow());

    const result = await repo.upsert({
      eventId: "event-1",
      humanId: "human-1",
    });

    // Read-back of a pre-existing row must NOT report created — a re-RSVP
    // (or a lost insert race) never triggers a duplicate confirmation.
    expect(result).toEqual({ record: rsvpRow(), created: false });
    expect(create).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          eventId_humanId: { eventId: "event-1", humanId: "human-1" },
        },
      }),
    );
  });

  it("tolerates the insert-vs-delete race: conflict → row already deleted → retries create", async () => {
    const { prisma, create, findUnique } = createPrisma();
    const repo = makeEventRsvpsRepo(prisma);

    // Attempt 1: a concurrent insert won (P2002), but by the time we read it
    // back a concurrent cancel had deleted it → findUnique is null.
    create.mockRejectedValueOnce(uniqueViolation());
    findUnique.mockResolvedValueOnce(null);
    // Attempt 2: the row is gone, so our create now succeeds.
    create.mockResolvedValueOnce(rsvpRow());

    const result = await repo.upsert({
      eventId: "event-1",
      humanId: "human-1",
    });

    // The retry loop ended on a successful INSERT → created: true.
    expect(result).toEqual({ record: rsvpRow(), created: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("throws a plain Error (never returns undefined) if the race never settles", async () => {
    const { prisma, create, findUnique } = createPrisma();
    const repo = makeEventRsvpsRepo(prisma);

    // Every attempt: conflict then deleted-before-readback, forever.
    create.mockRejectedValue(uniqueViolation());
    findUnique.mockResolvedValue(null);

    await expect(
      repo.upsert({ eventId: "event-1", humanId: "human-1" }),
    ).rejects.toThrow(/could not settle/i);
  });

  it("rethrows non-P2002 errors from create unchanged", async () => {
    const { prisma, create } = createPrisma();
    const repo = makeEventRsvpsRepo(prisma);
    const boom = new Error("connection reset");
    create.mockRejectedValueOnce(boom);

    await expect(
      repo.upsert({ eventId: "event-1", humanId: "human-1" }),
    ).rejects.toBe(boom);
  });

  it("delete is a no-op for a missing row (deleteMany, no throw)", async () => {
    const { prisma, deleteMany } = createPrisma();
    const repo = makeEventRsvpsRepo(prisma);
    deleteMany.mockResolvedValue({ count: 0 });

    await expect(
      repo.delete({ eventId: "event-1", humanId: "human-1" }),
    ).resolves.toBeUndefined();

    expect(deleteMany).toHaveBeenCalledWith({
      where: { eventId: "event-1", humanId: "human-1" },
    });
  });

  it("existsForUser reads the compound unique", async () => {
    const { prisma, findUnique } = createPrisma();
    const repo = makeEventRsvpsRepo(prisma);
    findUnique.mockResolvedValueOnce({ id: "rsvp-1" });
    findUnique.mockResolvedValueOnce(null);

    await expect(
      repo.existsForUser({ eventId: "event-1", humanId: "human-1" }),
    ).resolves.toBe(true);
    await expect(
      repo.existsForUser({ eventId: "event-1", humanId: "human-2" }),
    ).resolves.toBe(false);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          eventId_humanId: { eventId: "event-1", humanId: "human-1" },
        },
      }),
    );
  });

  it("lists the user's RSVPs newest first with a keyset id cursor and eventIds for hydration", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeEventRsvpsRepo(prisma);
    findMany.mockResolvedValue([
      rsvpRow({ id: "rsvp-3", eventId: "event-3" }),
      rsvpRow({ id: "rsvp-2", eventId: "event-2" }),
      rsvpRow({ id: "rsvp-1", eventId: "event-1" }),
    ]);

    const result = await repo.listForUser({
      humanId: "human-1",
      cursor: "rsvp-4",
      limit: 2,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { humanId: "human-1" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        cursor: { id: "rsvp-4" },
        skip: 1,
        take: 3,
      }),
    );
    expect(result.items.map((item) => item.eventId)).toEqual([
      "event-3",
      "event-2",
    ]);
    expect(result.nextCursor).toBe("rsvp-2");
  });
});
