import { describe, expect, it, vi } from "vitest";

import { makeRsvpNoticesRepo } from "../rsvp-notices";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-07-06T12:00:00.000Z");

function noticeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "notice-1",
    eventId: "event-1",
    eventDateId: null,
    humanId: "human-1",
    kind: "CONFIRMATION" as const,
    createdAt: NOW,
    dispatchedAt: null,
    attempts: 0,
    ...overrides,
  };
}

function createPrisma() {
  const create = vi.fn();
  const createMany = vi.fn();
  const updateMany = vi.fn();
  const deleteMany = vi.fn();
  const $queryRaw = vi.fn();

  const prisma = {
    rsvpNotice: {
      create,
      createMany,
      updateMany,
      deleteMany,
    },
    $queryRaw,
  } as unknown as PrismaClientOrTx;

  return { prisma, create, createMany, updateMany, deleteMany, $queryRaw };
}

describe("makeRsvpNoticesRepo", () => {
  it("create inserts one undispatched event-level notice (eventDateId stored NULL when omitted)", async () => {
    const { prisma, create } = createPrisma();
    const repo = makeRsvpNoticesRepo(prisma);
    create.mockResolvedValue(noticeRow());

    const result = await repo.create({
      eventId: "event-1",
      humanId: "human-1",
    });

    expect(result).toEqual(noticeRow());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          eventId: "event-1",
          eventDateId: null,
          humanId: "human-1",
          kind: "CONFIRMATION",
        },
      }),
    );
  });

  it("create round-trips a per-date notice's eventDateId", async () => {
    const { prisma, create } = createPrisma();
    const repo = makeRsvpNoticesRepo(prisma);
    create.mockResolvedValue(noticeRow({ eventDateId: "date-1" }));

    const result = await repo.create({
      eventId: "event-1",
      eventDateId: "date-1",
      humanId: "human-1",
    });

    expect(result.eventDateId).toBe("date-1");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          eventId: "event-1",
          eventDateId: "date-1",
          humanId: "human-1",
          kind: "CONFIRMATION",
        },
      }),
    );
  });

  it("listUndispatched runs the SKIP LOCKED claim scan and maps rows", async () => {
    const { prisma, $queryRaw } = createPrisma();
    const repo = makeRsvpNoticesRepo(prisma);
    $queryRaw.mockResolvedValue([noticeRow(), noticeRow({ id: "notice-2" })]);

    const rows = await repo.listUndispatched({ limit: 10 });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(noticeRow());
    // The claim MUST be a FOR UPDATE SKIP LOCKED scan over undispatched rows
    // so two overlapping drain runs never double-process a notice.
    const sqlArg = $queryRaw.mock.calls[0]![0] as { sql?: string };
    const sqlText =
      typeof sqlArg === "string" ? sqlArg : (sqlArg.sql ?? String(sqlArg));
    expect(sqlText).toContain('"dispatchedAt" IS NULL');
    expect(sqlText).toContain("FOR UPDATE SKIP LOCKED");
    expect(sqlText).toContain('ORDER BY "createdAt" ASC, "id" ASC');
    // The claim must project eventDateId so per-date notices dispatch with
    // the occurrence's times instead of the parent event's.
    expect(sqlText).toContain('"eventDateId"');
    // ...and `kind`, or the drain cannot tell a confirmation from a call-off
    // and would mail "you're going" for a night that is off.
    expect(sqlText).toContain('"kind"');
  });

  it("listUndispatched({ freshOnly }) adds the never-attempted filter; without it, retries stay in", async () => {
    const sqlOf = (call: unknown[]) => {
      const arg = call[0] as { sql?: string; strings?: string[] };
      return typeof arg === "string" ? arg : (arg.sql ?? String(arg));
    };
    const { prisma, $queryRaw } = createPrisma();
    const repo = makeRsvpNoticesRepo(prisma);
    $queryRaw.mockResolvedValue([]);

    await repo.listUndispatched({ limit: 10, freshOnly: true });
    await repo.listUndispatched({ limit: 10 });

    // The write-triggered drain must never pick up a failing notice (the
    // scheduled run retries it at its own cadence).
    expect(sqlOf($queryRaw.mock.calls[0]!)).toContain('AND "attempts" = 0');
    expect(sqlOf($queryRaw.mock.calls[1]!)).not.toContain('"attempts" = 0');
  });

  describe("call-off notices", () => {
    it("createDateCancelled writes one DATE_CANCELLED row per human in ONE insert", async () => {
      const { prisma, createMany } = createPrisma();
      const repo = makeRsvpNoticesRepo(prisma);
      createMany.mockResolvedValue({ count: 2 });

      const count = await repo.createDateCancelled({
        eventId: "event-1",
        eventDateId: "date-1",
        humanIds: ["human-1", "human-2"],
      });

      expect(count).toBe(2);
      // One statement, not N round trips — this runs inside the transaction
      // that flips the occurrence, so it must not hold that lock open per row.
      expect(createMany).toHaveBeenCalledTimes(1);
      expect(createMany).toHaveBeenCalledWith({
        data: [
          {
            eventId: "event-1",
            eventDateId: "date-1",
            humanId: "human-1",
            kind: "DATE_CANCELLED",
          },
          {
            eventId: "event-1",
            eventDateId: "date-1",
            humanId: "human-2",
            kind: "DATE_CANCELLED",
          },
        ],
      });
    });

    it("createDateCancelled no-ops on an empty recipient list", async () => {
      const { prisma, createMany } = createPrisma();
      const repo = makeRsvpNoticesRepo(prisma);

      await expect(
        repo.createDateCancelled({
          eventId: "event-1",
          eventDateId: "date-1",
          humanIds: [],
        }),
      ).resolves.toBe(0);
      expect(createMany).not.toHaveBeenCalled();
    });

    it("deletePendingDateCancelledForDate retracts ONLY undispatched call-off rows", async () => {
      const { prisma, deleteMany } = createPrisma();
      const repo = makeRsvpNoticesRepo(prisma);
      deleteMany.mockResolvedValue({ count: 3 });

      const count = await repo.deletePendingDateCancelledForDate("date-1");

      expect(count).toBe(3);
      // `dispatchedAt: null` is load-bearing: an already-sent cancellation is
      // history the retention purge owns, and a CONFIRMATION row for the same
      // date must not be collateral damage of a restore.
      expect(deleteMany).toHaveBeenCalledWith({
        where: {
          eventDateId: "date-1",
          kind: "DATE_CANCELLED",
          dispatchedAt: null,
        },
      });
    });
  });

  it("markDispatched flips the given ids (and no-ops on empty)", async () => {
    const { prisma, updateMany } = createPrisma();
    const repo = makeRsvpNoticesRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });

    await repo.markDispatched([], NOW);
    expect(updateMany).not.toHaveBeenCalled();

    await repo.markDispatched(["notice-1"], NOW);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["notice-1"] } },
      data: { dispatchedAt: NOW },
    });
  });

  it("incrementAttempts bumps the counter (and no-ops on empty)", async () => {
    const { prisma, updateMany } = createPrisma();
    const repo = makeRsvpNoticesRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });

    await repo.incrementAttempts([]);
    expect(updateMany).not.toHaveBeenCalled();

    await repo.incrementAttempts(["notice-1"]);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["notice-1"] } },
      data: { attempts: { increment: 1 } },
    });
  });

  it("deleteDispatchedBefore only targets dispatched rows older than the cutoff", async () => {
    const { prisma, deleteMany } = createPrisma();
    const repo = makeRsvpNoticesRepo(prisma);
    deleteMany.mockResolvedValue({ count: 3 });

    const cutoff = new Date("2026-06-06T00:00:00.000Z");
    const deleted = await repo.deleteDispatchedBefore(cutoff);

    expect(deleted).toBe(3);
    // `not: null` guarantees undispatched/in-flight rows are never purged.
    expect(deleteMany).toHaveBeenCalledWith({
      where: { dispatchedAt: { not: null, lt: cutoff } },
    });
  });
});
