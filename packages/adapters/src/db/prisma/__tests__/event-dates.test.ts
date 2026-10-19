import { describe, expect, it, vi } from "vitest";

import { makeEventDatesRepo } from "../event-dates";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-07-01T00:00:00.000Z");

type Row = {
  id: string;
  eventId: string;
  ordinal: number;
  startsAt: Date;
  endsAt: Date | null;
  status: "SCHEDULED" | "CANCELLED";
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Minimal in-memory `eventDate` delegate implementing just the operations the
 * repo issues (findMany with where/select/orderBy, deleteMany by id-in,
 * create, update). Lets us exercise the real `bulkReplaceForEvent`
 * reconciliation algorithm without a database.
 */
function createPrisma(seed: Row[] = [], rsvpSeed: string[] = []) {
  let store: Row[] = seed.map((r) => ({ ...r }));
  let seq = seed.length;
  // Write-call counters so tests can assert the refresh path doesn't issue
  // pointless UPDATEs for rows whose endsAt is unchanged (write-amplification
  // guard for the daily rolling refresh job).
  const calls = {
    update: 0,
    updateMany: 0,
    updateManyAndReturn: 0,
    create: 0,
    deleteMany: 0,
  };
  // Per-date RSVP store — only the (eventDateId) matters for the guard.
  const rsvps: Array<{ eventDateId: string }> = rsvpSeed.map((eventDateId) => ({
    eventDateId,
  }));

  const matches = (row: Row, where: any): boolean => {
    if (where.eventId?.in) {
      if (!where.eventId.in.includes(row.eventId)) return false;
    } else if (where.eventId && row.eventId !== where.eventId) return false;
    if (where.status) {
      if (typeof where.status === "string" && row.status !== where.status)
        return false;
      if (where.status.in && !where.status.in.includes(row.status)) return false;
    }
    if (where.startsAt?.gte && row.startsAt.getTime() < where.startsAt.gte.getTime())
      return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.id && typeof where.id === "string" && row.id !== where.id)
      return false;
    return true;
  };

  const eventDate = {
    findMany: async ({ where = {}, orderBy, take }: any) => {
      let rows = store.filter((r) => matches(r, where));
      if (Array.isArray(orderBy)) {
        // Composite order (listByEventIds): eventId asc, then startsAt asc.
        rows = rows.sort(
          (a, b) =>
            a.eventId.localeCompare(b.eventId) ||
            a.startsAt.getTime() - b.startsAt.getTime(),
        );
      } else if (orderBy?.startsAt === "asc") {
        rows = rows.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      } else if (orderBy?.ordinal === "asc") {
        rows = rows.sort((a, b) => a.ordinal - b.ordinal);
      }
      if (take != null) rows = rows.slice(0, take);
      return rows.map((r) => ({ ...r }));
    },
    deleteMany: async ({ where }: any) => {
      calls.deleteMany += 1;
      const before = store.length;
      store = store.filter((r) => !matches(r, where));
      return { count: before - store.length };
    },
    updateMany: async ({ where, data }: any) => {
      calls.updateMany += 1;
      let count = 0;
      for (const r of store) {
        if (matches(r, where)) {
          Object.assign(r, data);
          count += 1;
        }
      }
      return { count };
    },
    // Same matcher as updateMany — `matches` already honours `where.status`,
    // which is the compare-and-set half of the guarded cancel.
    updateManyAndReturn: async ({ where, data }: any) => {
      calls.updateManyAndReturn += 1;
      const changed: Row[] = [];
      for (const r of store) {
        if (matches(r, where)) {
          Object.assign(r, data);
          changed.push(r);
        }
      }
      return changed.map((r) => ({ ...r }));
    },
    create: async ({ data }: any) => {
      calls.create += 1;
      seq += 1;
      const row: Row = {
        id: `row-${seq}`,
        eventId: data.eventId,
        ordinal: data.ordinal,
        startsAt: data.startsAt,
        endsAt: data.endsAt ?? null,
        status: data.status ?? "SCHEDULED",
        createdAt: NOW,
        updatedAt: NOW,
      };
      store.push(row);
      return { ...row };
    },
    update: async ({ where, data }: any) => {
      calls.update += 1;
      const row = store.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return { ...row };
    },
    findUnique: async ({ where }: any) =>
      store.find((r) => r.id === where.id) ?? null,
  };

  const eventDateRsvp = {
    // Supports the guard's shape (where.eventDateId.in + distinct) and the
    // call-off fan-out's (a plain where.eventDateId).
    findMany: async ({ where = {}, distinct }: any) => {
      let rows = rsvps.filter((r) => {
        if (where.eventDateId?.in) {
          return where.eventDateId.in.includes(r.eventDateId);
        }
        if (typeof where.eventDateId === "string") {
          return r.eventDateId === where.eventDateId;
        }
        return true;
      });
      if (distinct?.includes("eventDateId")) {
        const seen = new Set<string>();
        rows = rows.filter((r) => {
          if (seen.has(r.eventDateId)) return false;
          seen.add(r.eventDateId);
          return true;
        });
      }
      return rows.map((r) => ({ eventDateId: r.eventDateId }));
    },
  };

  return {
    prisma: { eventDate, eventDateRsvp } as unknown as PrismaClientOrTx,
    getStore: () => store,
    calls,
  };
}

function row(overrides: Partial<Row>): Row {
  return {
    id: "seed",
    eventId: "event-1",
    ordinal: 1,
    startsAt: new Date("2026-08-01T20:00:00.000Z"),
    endsAt: null,
    status: "SCHEDULED",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("makeEventDatesRepo.bulkReplaceForEvent", () => {
  it("inserts the desired future set on a fresh event with ascending ordinals", async () => {
    const { prisma, getStore } = createPrisma();
    const repo = makeEventDatesRepo(prisma);

    const result = await repo.bulkReplaceForEvent({
      eventId: "event-1",
      now: NOW,
      dates: [
        { startsAt: new Date("2026-08-11T20:00:00.000Z"), endsAt: new Date("2026-08-11T22:00:00.000Z") },
        { startsAt: new Date("2026-08-04T20:00:00.000Z"), endsAt: new Date("2026-08-04T22:00:00.000Z") },
      ],
    });

    // Returned SCHEDULED rows are ascending by startsAt.
    expect(result.scheduled.map((r) => r.startsAt.toISOString())).toEqual([
      "2026-08-04T20:00:00.000Z",
      "2026-08-11T20:00:00.000Z",
    ]);
    // Nothing was dropped, so nothing was cancelled.
    expect(result.cancelledDateIds).toEqual([]);
    // Ordinals are unique.
    expect(new Set(getStore().map((r) => r.ordinal)).size).toBe(2);
  });

  it("preserves PAST and CANCELLED rows while replacing the dropped future SCHEDULED set", async () => {
    const past = row({
      id: "past",
      ordinal: 1,
      startsAt: new Date("2026-06-01T20:00:00.000Z"), // before NOW
    });
    const cancelled = row({
      id: "cancelled",
      ordinal: 2,
      startsAt: new Date("2026-09-01T20:00:00.000Z"),
      status: "CANCELLED",
    });
    const staleFuture = row({
      id: "stale",
      ordinal: 3,
      startsAt: new Date("2026-08-20T20:00:00.000Z"), // future, SCHEDULED, dropped
    });
    const keptFuture = row({
      id: "kept",
      ordinal: 4,
      startsAt: new Date("2026-08-04T20:00:00.000Z"), // future, still desired
    });

    const { prisma, getStore } = createPrisma([past, cancelled, staleFuture, keptFuture]);
    const repo = makeEventDatesRepo(prisma);

    await repo.bulkReplaceForEvent({
      eventId: "event-1",
      now: NOW,
      dates: [
        { startsAt: new Date("2026-08-04T20:00:00.000Z") }, // matches keptFuture
        { startsAt: new Date("2026-08-25T20:00:00.000Z") }, // new
      ],
    });

    const store = getStore();
    const ids = store.map((r) => r.id).sort();
    // past + cancelled + kept survive; stale is gone; one new row added.
    expect(ids).toContain("past");
    expect(ids).toContain("cancelled");
    expect(ids).toContain("kept");
    expect(ids).not.toContain("stale");

    // The new row got a non-colliding ordinal (> max existing = 4).
    const created = store.find((r) => r.startsAt.toISOString() === "2026-08-25T20:00:00.000Z");
    expect(created?.ordinal).toBeGreaterThan(4);

    // A desired date coinciding with the CANCELLED instant would stay cancelled;
    // here the cancelled date (Sep 1) is not in the desired set, so it is simply
    // left intact.
    expect(store.find((r) => r.id === "cancelled")?.status).toBe("CANCELLED");
  });

  it("is idempotent: re-running the same expansion neither inserts nor deletes", async () => {
    const { prisma, getStore } = createPrisma();
    const repo = makeEventDatesRepo(prisma);

    const dates = [
      { startsAt: new Date("2026-08-04T20:00:00.000Z"), endsAt: new Date("2026-08-04T22:00:00.000Z") },
      { startsAt: new Date("2026-08-11T20:00:00.000Z"), endsAt: new Date("2026-08-11T22:00:00.000Z") },
    ];

    await repo.bulkReplaceForEvent({ eventId: "event-1", now: NOW, dates });
    const afterFirst = getStore().map((r) => r.id).sort();

    await repo.bulkReplaceForEvent({ eventId: "event-1", now: NOW, dates });
    const afterSecond = getStore().map((r) => r.id).sort();

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond).toHaveLength(2);
  });

  it("issues ZERO update calls when the desired set is identical to the stored set (no endsAt churn)", async () => {
    // The daily rolling refresh job re-runs this for every recurring listing;
    // an unchanged re-run must not touch a single row (no updatedAt churn / no
    // O(occurrences) pointless UPDATEs per listing per day).
    const dates = [
      {
        startsAt: new Date("2026-08-04T20:00:00.000Z"),
        endsAt: new Date("2026-08-04T22:00:00.000Z"),
      },
      {
        startsAt: new Date("2026-08-11T20:00:00.000Z"),
        endsAt: new Date("2026-08-11T22:00:00.000Z"),
      },
      // A live SCHEDULED occurrence with a NULL endsAt — the null-vs-null
      // comparison must also register as "unchanged".
      { startsAt: new Date("2026-08-18T20:00:00.000Z"), endsAt: null },
    ];

    const { prisma, calls } = createPrisma();
    const repo = makeEventDatesRepo(prisma);

    // First run materialises the three occurrences (creates only).
    await repo.bulkReplaceForEvent({ eventId: "event-1", now: NOW, dates });
    expect(calls.create).toBe(3);

    // Re-run with the identical set: no update, no updateMany, no delete, no
    // create — a pure no-op reconciliation.
    calls.update = 0;
    calls.updateMany = 0;
    calls.updateManyAndReturn = 0;
    calls.create = 0;
    calls.deleteMany = 0;
    await repo.bulkReplaceForEvent({ eventId: "event-1", now: NOW, dates });

    expect(calls.update).toBe(0);
    expect(calls.updateMany).toBe(0);
    expect(calls.updateManyAndReturn).toBe(0);
    expect(calls.create).toBe(0);
    expect(calls.deleteMany).toBe(0);
  });

  it("still issues exactly one update for a live SCHEDULED row whose endsAt actually changed", async () => {
    const existing = row({
      id: "kept",
      ordinal: 1,
      startsAt: new Date("2026-08-04T20:00:00.000Z"),
      endsAt: new Date("2026-08-04T22:00:00.000Z"),
    });
    const { prisma, calls, getStore } = createPrisma([existing]);
    const repo = makeEventDatesRepo(prisma);

    await repo.bulkReplaceForEvent({
      eventId: "event-1",
      now: NOW,
      dates: [
        {
          startsAt: new Date("2026-08-04T20:00:00.000Z"),
          // Same instant, DIFFERENT endsAt → must refresh.
          endsAt: new Date("2026-08-04T23:00:00.000Z"),
        },
      ],
    });

    expect(calls.update).toBe(1);
    expect(
      getStore().find((r) => r.id === "kept")?.endsAt?.toISOString(),
    ).toBe("2026-08-04T23:00:00.000Z");
  });

  describe("delete-vs-cancel guard (dropped future dates with RSVPs)", () => {
    it("CANCELS a dropped future date that has ≥1 RSVP (row preserved) and HARD-DELETES one with none", async () => {
      const droppedWithRsvp = row({
        id: "with-rsvp",
        ordinal: 1,
        startsAt: new Date("2026-08-20T20:00:00.000Z"), // future, SCHEDULED, dropped
      });
      const droppedNoRsvp = row({
        id: "no-rsvp",
        ordinal: 2,
        startsAt: new Date("2026-08-27T20:00:00.000Z"), // future, SCHEDULED, dropped
      });

      const { prisma, getStore } = createPrisma(
        [droppedWithRsvp, droppedNoRsvp],
        ["with-rsvp"], // only the first date has an attendee
      );
      const repo = makeEventDatesRepo(prisma);

      const result = await repo.bulkReplaceForEvent({
        eventId: "event-1",
        now: NOW,
        dates: [], // drop everything future
      });

      // The cancelled id is REPORTED to the caller — that is what lets
      // `applyRecurrenceForEvent` mail the people who RSVP'd. The deleted one
      // is absent by design: nobody booked it, so there is nobody to tell.
      expect(result.cancelledDateIds).toEqual(["with-rsvp"]);

      const store = getStore();
      // The RSVP'd date survives as CANCELLED (preserves the row + its RSVPs).
      const survivor = store.find((r) => r.id === "with-rsvp");
      expect(survivor).toBeDefined();
      expect(survivor?.status).toBe("CANCELLED");
      // The empty date is hard-deleted.
      expect(store.find((r) => r.id === "no-rsvp")).toBeUndefined();
    });

    it("leaves PAST and already-CANCELLED rows untouched even when they carry RSVPs", async () => {
      const pastWithRsvp = row({
        id: "past",
        ordinal: 1,
        startsAt: new Date("2026-06-01T20:00:00.000Z"), // before NOW
      });
      const alreadyCancelled = row({
        id: "cancelled",
        ordinal: 2,
        startsAt: new Date("2026-09-01T20:00:00.000Z"),
        status: "CANCELLED",
      });

      const { prisma, getStore } = createPrisma(
        [pastWithRsvp, alreadyCancelled],
        ["past", "cancelled"],
      );
      const repo = makeEventDatesRepo(prisma);

      await repo.bulkReplaceForEvent({ eventId: "event-1", now: NOW, dates: [] });

      const store = getStore();
      // Neither is in the dropped-future-SCHEDULED filter, so both are intact.
      expect(store.find((r) => r.id === "past")?.status).toBe("SCHEDULED");
      expect(store.find((r) => r.id === "cancelled")?.status).toBe("CANCELLED");
    });

    it("is idempotent: re-running after a cancel neither re-cancels nor deletes", async () => {
      const dropped = row({
        id: "with-rsvp",
        ordinal: 1,
        startsAt: new Date("2026-08-20T20:00:00.000Z"),
      });

      const { prisma, getStore } = createPrisma([dropped], ["with-rsvp"]);
      const repo = makeEventDatesRepo(prisma);

      const first = await repo.bulkReplaceForEvent({
        eventId: "event-1",
        now: NOW,
        dates: [],
      });
      const afterFirst = getStore().map((r) => ({ id: r.id, status: r.status }));

      const second = await repo.bulkReplaceForEvent({
        eventId: "event-1",
        now: NOW,
        dates: [],
      });
      const afterSecond = getStore().map((r) => ({ id: r.id, status: r.status }));

      expect(afterSecond).toEqual(afterFirst);
      expect(afterSecond).toEqual([{ id: "with-rsvp", status: "CANCELLED" }]);

      // AND the re-run reports NO cancellation, so the caller's fan-out has
      // nothing to re-send. This is the whole double-notify guard: the row is
      // already CANCELLED, so the SCHEDULED filter excludes it from `dropped`.
      expect(first.cancelledDateIds).toEqual(["with-rsvp"]);
      expect(second.cancelledDateIds).toEqual([]);
    });

    it("the cancel is a COMPARE-AND-SET: a row another tx already flipped is not reported as cancelled by this one", async () => {
      // The read-then-write window `bulkReplaceForEvent` runs in is wide enough
      // for a concurrent moderator (or a `cancelEventDate` racing a rule
      // change) to flip the same night first. Simulate that by letting the
      // reconciliation see SCHEDULED and having the row turn CANCELLED before
      // the guarded update lands. Without `status: "SCHEDULED"` in the WHERE,
      // the loser re-matches on id alone and fans out a second set of emails.
      const contested = row({
        id: "contested",
        ordinal: 1,
        startsAt: new Date("2026-08-20T20:00:00.000Z"),
      });
      const { prisma, getStore } = createPrisma([contested], ["contested"]);

      const rsvpRepo = (prisma as any).eventDateRsvp;
      const originalFindMany = rsvpRepo.findMany;
      rsvpRepo.findMany = async (args: any) => {
        const out = await originalFindMany(args);
        // The other transaction commits right here.
        const target = getStore().find((r) => r.id === "contested");
        if (target) target.status = "CANCELLED";
        return out;
      };

      const repo = makeEventDatesRepo(prisma);
      const result = await repo.bulkReplaceForEvent({
        eventId: "event-1",
        now: NOW,
        dates: [],
      });

      expect(result.cancelledDateIds).toEqual([]);
      // The row is still CANCELLED — the winner's write stands, untouched.
      expect(getStore().find((r) => r.id === "contested")?.status).toBe(
        "CANCELLED",
      );
    });
  });
});

// event-calendar-redesign FR-003: the calendar reads' batched occurrence read.
describe("makeEventDatesRepo.listByEventIds", () => {
  const seed = [
    row({ id: "a-2", eventId: "event-a", ordinal: 2, startsAt: new Date("2026-08-08T20:00:00.000Z") }),
    row({ id: "a-1", eventId: "event-a", ordinal: 1, startsAt: new Date("2026-08-01T20:00:00.000Z") }),
    row({ id: "a-x", eventId: "event-a", ordinal: 3, startsAt: new Date("2026-08-15T20:00:00.000Z"), status: "CANCELLED" }),
    row({ id: "b-1", eventId: "event-b", ordinal: 1, startsAt: new Date("2026-08-03T20:00:00.000Z") }),
    row({ id: "c-1", eventId: "event-c", ordinal: 1, startsAt: new Date("2026-08-04T20:00:00.000Z") }),
  ];

  it("returns every row of the requested events, eventId asc then startsAt asc, any status by default", async () => {
    const { prisma } = createPrisma(seed);
    const rows = await makeEventDatesRepo(prisma).listByEventIds({
      eventIds: ["event-b", "event-a"],
    });
    expect(rows.map((r) => r.id)).toEqual(["a-1", "a-2", "a-x", "b-1"]);
  });

  it("narrows to the requested statuses (the calendar asks for SCHEDULED only)", async () => {
    const { prisma } = createPrisma(seed);
    const rows = await makeEventDatesRepo(prisma).listByEventIds({
      eventIds: ["event-a"],
      statuses: ["SCHEDULED"],
    });
    expect(rows.map((r) => r.id)).toEqual(["a-1", "a-2"]);
  });

  it("short-circuits on an empty id set without touching the DB", async () => {
    const { prisma } = createPrisma(seed);
    const findMany = vi.spyOn((prisma as any).eventDate, "findMany");
    expect(await makeEventDatesRepo(prisma).listByEventIds({ eventIds: [] })).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("makeEventDatesRepo.listUpcoming", () => {
  const upcomingSeed = [
    row({
      id: "past",
      ordinal: 1,
      startsAt: new Date("2026-06-01T20:00:00.000Z"),
    }),
    row({
      id: "next-off",
      ordinal: 2,
      startsAt: new Date("2026-08-04T20:00:00.000Z"),
      status: "CANCELLED",
    }),
    row({
      id: "next-on",
      ordinal: 3,
      startsAt: new Date("2026-08-11T20:00:00.000Z"),
    }),
  ];

  it("returns CANCELLED occurrences alongside SCHEDULED ones", async () => {
    // The SCHEDULED filter that used to live here made a called-off night
    // vanish from the public schedule, which reads as "that date was never on
    // the schedule" rather than "that date is off".
    const { prisma } = createPrisma(upcomingSeed);

    const rows = await makeEventDatesRepo(prisma).listUpcoming({
      eventId: "event-1",
      now: NOW,
    });

    expect(rows.map((r) => r.id)).toEqual(["next-off", "next-on"]);
    expect(rows.map((r) => r.status)).toEqual(["CANCELLED", "SCHEDULED"]);
  });

  it("still excludes occurrences in the past", async () => {
    const { prisma } = createPrisma(upcomingSeed);

    const rows = await makeEventDatesRepo(prisma).listUpcoming({
      eventId: "event-1",
      now: NOW,
    });

    expect(rows.map((r) => r.id)).not.toContain("past");
  });

  it("caps at the requested limit, ascending", async () => {
    const { prisma } = createPrisma(upcomingSeed);

    const rows = await makeEventDatesRepo(prisma).listUpcoming({
      eventId: "event-1",
      now: NOW,
      limit: 1,
    });

    expect(rows.map((r) => r.id)).toEqual(["next-off"]);
  });
});

describe("makeEventDatesRepo.markStatusIf", () => {
  const target = row({ id: "d1", startsAt: new Date("2026-08-04T20:00:00.000Z") });

  it("transitions when the row still holds the expected status", async () => {
    const { prisma, getStore } = createPrisma([target]);

    const result = await makeEventDatesRepo(prisma).markStatusIf({
      id: "d1",
      expectStatus: "SCHEDULED",
      status: "CANCELLED",
    });

    expect(result).toEqual({ updated: true });
    expect(getStore().find((r) => r.id === "d1")!.status).toBe("CANCELLED");
  });

  it("refuses when the row has already moved — the caller must not fan out twice", async () => {
    // Two moderators press "Call off" at once. The expectation rides in the
    // WHERE clause, so exactly one UPDATE matches and only that caller owes
    // the notifications.
    const { prisma } = createPrisma([{ ...target, status: "CANCELLED" }]);

    const result = await makeEventDatesRepo(prisma).markStatusIf({
      id: "d1",
      expectStatus: "SCHEDULED",
      status: "CANCELLED",
    });

    expect(result).toEqual({ updated: false });
  });

  it("refuses a row that does not exist", async () => {
    const { prisma } = createPrisma([]);

    expect(
      await makeEventDatesRepo(prisma).markStatusIf({
        id: "gone",
        expectStatus: "SCHEDULED",
        status: "CANCELLED",
      }),
    ).toEqual({ updated: false });
  });

  it("restores in the other direction too", async () => {
    const { prisma, getStore } = createPrisma([
      { ...target, status: "CANCELLED" },
    ]);

    const result = await makeEventDatesRepo(prisma).markStatusIf({
      id: "d1",
      expectStatus: "CANCELLED",
      status: "SCHEDULED",
    });

    expect(result).toEqual({ updated: true });
    expect(getStore().find((r) => r.id === "d1")!.status).toBe("SCHEDULED");
  });
});
