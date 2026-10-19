import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeRsvpNoticesRepo } from "../../src/db/prisma/rsvp-notices";
import { makeEventRsvpsRepo } from "../../src/db/prisma/event-rsvps";
import { makeEventDateRsvpsRepo } from "../../src/db/prisma/event-date-rsvps";

describe("Prisma adapters integration – rsvp-notices", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let eventId: string;
  let humanA: string;
  let humanB: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // The repo's Prisma client runs in driver-adapter ("client" engine)
      // mode, so a bare `new PrismaClient()` throws — construct it the way
      // packages/db/src/index.ts does, with a pg Pool adapter.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const host = await prisma.human.create({
        data: { name: "RSVP Notice Host", status: "ACTIVE" },
      });

      const event = await prisma.event.create({
        data: {
          title: "Confirmable Open Mic",
          startsAt: new Date("2026-08-01T20:00:00.000Z"),
          endsAt: new Date("2026-08-01T23:00:00.000Z"),
          status: "PUBLISHED",
          attendanceMode: "RSVP",
          humanId: host.id,
        },
      });
      eventId = event.id;

      const a = await prisma.human.create({
        data: { name: "RSVPer A", status: "ACTIVE" },
      });
      const b = await prisma.human.create({
        data: { name: "RSVPer B", status: "ACTIVE" },
      });
      humanA = a.id;
      humanB = b.id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("rsvp-notices integration setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("create writes an undispatched single-recipient notice", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeRsvpNoticesRepo(prisma);
    const notice = await repo.create({ eventId, humanId: humanA });

    expect(notice.id).toBeTruthy();
    expect(notice.eventId).toBe(eventId);
    expect(notice.humanId).toBe(humanA);
    expect(notice.dispatchedAt).toBeNull();
    expect(notice.attempts).toBe(0);
  }, 60_000);

  test("listUndispatched returns oldest-first and excludes dispatched rows", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeRsvpNoticesRepo(prisma);
    // Two more notices (sequential writes => distinct, increasing createdAt).
    const older = await repo.create({ eventId, humanId: humanB });
    const newer = await repo.create({ eventId, humanId: humanA });

    const before = await repo.listUndispatched({ limit: 50 });
    // Oldest-first ordering: the first-created undispatched notice leads.
    expect(before[0]!.createdAt.getTime()).toBeLessThanOrEqual(
      before[before.length - 1]!.createdAt.getTime(),
    );
    const beforeIds = before.map((n) => n.id);
    expect(beforeIds).toContain(older.id);
    expect(beforeIds).toContain(newer.id);

    // Dispatch the older one; it must drop out of the undispatched window.
    const at = new Date("2026-07-06T00:00:00.000Z");
    await repo.markDispatched([older.id], at);

    const after = await repo.listUndispatched({ limit: 50 });
    const afterIds = after.map((n) => n.id);
    expect(afterIds).not.toContain(older.id);
    expect(afterIds).toContain(newer.id);

    // markDispatched with an empty array is a no-op (does not throw / touch).
    await repo.markDispatched([], at);
    const stillNewer = await repo.listUndispatched({ limit: 50 });
    expect(stillNewer.map((n) => n.id)).toContain(newer.id);

    // limit is respected.
    const capped = await repo.listUndispatched({ limit: 1 });
    expect(capped).toHaveLength(1);
  }, 60_000);

  test("incrementAttempts bumps the counter (and no-ops on empty)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeRsvpNoticesRepo(prisma);
    const notice = await repo.create({ eventId, humanId: humanB });

    await repo.incrementAttempts([]); // no-op
    await repo.incrementAttempts([notice.id]);
    await repo.incrementAttempts([notice.id]);

    const rows = await repo.listUndispatched({ limit: 100 });
    const reloaded = rows.find((n) => n.id === notice.id);
    expect(reloaded?.attempts).toBe(2);
  }, 60_000);

  test("deleteDispatchedBefore purges only dispatched rows older than the cutoff", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeRsvpNoticesRepo(prisma);
    const cutoff = new Date("2026-07-01T00:00:00.000Z");

    // dispatched-old:    dispatchedAt BEFORE the cutoff → eligible for deletion.
    // dispatched-recent: dispatchedAt AFTER the cutoff  → kept (inside window).
    // undispatched:      dispatchedAt IS NULL           → never touched.
    const dispatchedOld = await repo.create({ eventId, humanId: humanA });
    const dispatchedRecent = await repo.create({ eventId, humanId: humanB });
    const undispatched = await repo.create({ eventId, humanId: humanA });

    await repo.markDispatched(
      [dispatchedOld.id],
      new Date("2026-06-01T00:00:00.000Z"), // before cutoff
    );
    await repo.markDispatched(
      [dispatchedRecent.id],
      new Date("2026-07-15T00:00:00.000Z"), // after cutoff
    );
    // undispatched intentionally left with dispatchedAt = null.

    const deleted = await repo.deleteDispatchedBefore(cutoff);
    expect(deleted).toBe(1);

    const oldRow = await prisma.rsvpNotice.findUnique({
      where: { id: dispatchedOld.id },
    });
    expect(oldRow).toBeNull();

    const recentRow = await prisma.rsvpNotice.findUnique({
      where: { id: dispatchedRecent.id },
    });
    expect(recentRow).not.toBeNull();

    const undispatchedRows = await repo.listUndispatched({ limit: 100 });
    expect(undispatchedRows.map((n) => n.id)).toContain(undispatched.id);

    // A second purge with the same cutoff removes nothing more (idempotent).
    const deletedAgain = await repo.deleteDispatchedBefore(cutoff);
    expect(deletedAgain).toBe(0);
  }, 60_000);

  test("cascades away when the event is hard-deleted", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeRsvpNoticesRepo(prisma);
    const host = await prisma.human.create({
      data: { name: "Doomed Host", status: "ACTIVE" },
    });
    const doomed = await prisma.event.create({
      data: {
        title: "Doomed Event",
        startsAt: new Date("2026-09-01T20:00:00.000Z"),
        endsAt: new Date("2026-09-01T23:00:00.000Z"),
        status: "PUBLISHED",
        attendanceMode: "RSVP",
        humanId: host.id,
      },
    });
    const notice = await repo.create({
      eventId: doomed.id,
      humanId: humanA,
    });

    await prisma.event.delete({ where: { id: doomed.id } });

    const row = await prisma.rsvpNotice.findUnique({
      where: { id: notice.id },
    });
    expect(row).toBeNull();
  }, 60_000);

  test("event-rsvps upsert round-trips the created flag against a real DB", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventRsvpsRepo(prisma);
    const key = { eventId, humanId: humanB };

    // Fresh insert → created: true.
    const first = await repo.upsert(key);
    expect(first.created).toBe(true);
    expect(first.record.eventId).toBe(eventId);

    // Idempotent re-RSVP → same row, created: false. This is the flag the
    // use case gates the confirmation enqueue on.
    const second = await repo.upsert(key);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
  }, 60_000);

  test("event-date-rsvps upsert round-trips the created flag against a real DB", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const date = await prisma.eventDate.create({
      data: {
        eventId,
        ordinal: 1,
        startsAt: new Date("2026-08-04T20:00:00.000Z"),
        endsAt: new Date("2026-08-04T23:00:00.000Z"),
      },
    });

    const repo = makeEventDateRsvpsRepo(prisma);
    const key = { eventDateId: date.id, humanId: humanA };

    // Fresh insert → created: true.
    const first = await repo.upsert(key);
    expect(first.created).toBe(true);
    expect(first.record.eventDateId).toBe(date.id);

    // Idempotent re-RSVP → same row, created: false — the flag that gates
    // the per-date confirmation enqueue.
    const second = await repo.upsert(key);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
  }, 60_000);

  test("per-date notices round-trip eventDateId and cascade with the EventDate", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeRsvpNoticesRepo(prisma);
    const date = await prisma.eventDate.create({
      data: {
        eventId,
        ordinal: 2,
        startsAt: new Date("2026-08-11T20:00:00.000Z"),
        endsAt: new Date("2026-08-11T23:00:00.000Z"),
      },
    });

    // Event-level create (eventDateId omitted) stores NULL.
    const eventLevel = await repo.create({ eventId, humanId: humanB });
    expect(eventLevel.eventDateId).toBeNull();

    // Per-date create round-trips the date id, both on create and through
    // the raw listUndispatched claim scan.
    const perDate = await repo.create({
      eventId,
      eventDateId: date.id,
      humanId: humanA,
    });
    expect(perDate.eventDateId).toBe(date.id);

    const undispatched = await repo.listUndispatched({ limit: 100 });
    const reloaded = undispatched.find((n) => n.id === perDate.id);
    expect(reloaded?.eventDateId).toBe(date.id);

    // Deleting the occurrence cascades the per-date notice away (an outbox
    // row must not outlive its date) but leaves event-level notices alone.
    await prisma.eventDate.delete({ where: { id: date.id } });

    const perDateRow = await prisma.rsvpNotice.findUnique({
      where: { id: perDate.id },
    });
    expect(perDateRow).toBeNull();

    const eventLevelRow = await prisma.rsvpNotice.findUnique({
      where: { id: eventLevel.id },
    });
    expect(eventLevelRow).not.toBeNull();
  }, 60_000);
});
