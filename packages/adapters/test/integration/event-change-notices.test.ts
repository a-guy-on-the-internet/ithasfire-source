import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventChangeNoticesRepo } from "../../src/db/prisma/event-change-notices";
import { makeEventRsvpsRepo } from "../../src/db/prisma/event-rsvps";

describe("Prisma adapters integration – event-change-notices", () => {
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
        data: { name: "Change Host", status: "ACTIVE" },
      });

      const event = await prisma.event.create({
        data: {
          title: "Changing Event",
          startsAt: new Date("2026-08-01T20:00:00.000Z"),
          endsAt: new Date("2026-08-01T23:00:00.000Z"),
          status: "PUBLISHED",
          humanId: host.id,
        },
      });
      eventId = event.id;

      // Two RSVP-ers, deterministic humanId order for keyset assertions.
      const a = await prisma.human.create({
        data: { name: "RSVP A", status: "ACTIVE" },
      });
      const b = await prisma.human.create({
        data: { name: "RSVP B", status: "ACTIVE" },
      });
      humanA = a.id;
      humanB = b.id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("event-change-notices integration setup failed:", error);
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

  test("create writes an undispatched notice with the given payload", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventChangeNoticesRepo(prisma);
    const notice = await repo.create({
      eventId,
      changeType: "RESCHEDULED",
      payload: { startsAt: { before: "2026-08-01", after: "2026-08-02" } },
    });

    expect(notice.id).toBeTruthy();
    expect(notice.eventId).toBe(eventId);
    expect(notice.changeType).toBe("RESCHEDULED");
    expect(notice.dispatchedAt).toBeNull();
    expect(notice.attempts).toBe(0);
    expect(notice.payload).toEqual({
      startsAt: { before: "2026-08-01", after: "2026-08-02" },
    });
  }, 60_000);

  test("listUndispatched returns oldest-first and excludes dispatched rows", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventChangeNoticesRepo(prisma);
    // Two more notices (sequential writes => distinct, increasing createdAt).
    const older = await repo.create({
      eventId,
      changeType: "VENUE_CHANGED",
      payload: { venue: "A" },
    });
    const newer = await repo.create({
      eventId,
      changeType: "CANCELLED",
      payload: { reason: "weather" },
    });

    const before = await repo.listUndispatched({ limit: 50 });
    // Oldest-first ordering: the first-created undispatched notice leads.
    expect(before[0]!.createdAt.getTime()).toBeLessThanOrEqual(
      before[before.length - 1]!.createdAt.getTime(),
    );
    const beforeIds = before.map((n) => n.id);
    expect(beforeIds).toContain(older.id);
    expect(beforeIds).toContain(newer.id);

    // Dispatch the older one; it must drop out of the undispatched window.
    const at = new Date("2026-07-04T00:00:00.000Z");
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

    const repo = makeEventChangeNoticesRepo(prisma);
    const notice = await repo.create({
      eventId,
      changeType: "ARCHIVED",
      payload: null,
    });

    await repo.incrementAttempts([]); // no-op
    await repo.incrementAttempts([notice.id]);
    await repo.incrementAttempts([notice.id]);

    const rows = await repo.listUndispatched({ limit: 50 });
    const reloaded = rows.find((n) => n.id === notice.id);
    expect(reloaded?.attempts).toBe(2);
    // null payload round-trips as JSON null.
    expect(reloaded?.payload).toBeNull();
    // notifiedHumanIds defaults to an empty array.
    expect(reloaded?.notifiedHumanIds).toEqual([]);
  }, 60_000);

  test("markNotified appends humanIds deduped + idempotent (and no-ops on empty)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventChangeNoticesRepo(prisma);
    const notice = await repo.create({
      eventId,
      changeType: "RESCHEDULED",
      payload: { v: 1 },
    });

    await repo.markNotified(notice.id, []); // no-op
    await repo.markNotified(notice.id, [humanA, humanB]);
    // Overlapping re-append must dedupe, not grow the array.
    await repo.markNotified(notice.id, [humanA]);

    const rows = await repo.listUndispatched({ limit: 100 });
    const reloaded = rows.find((n) => n.id === notice.id);
    expect(reloaded?.notifiedHumanIds?.slice().sort()).toEqual(
      [humanA, humanB].sort(),
    );
  }, 60_000);

  test("create enrolls in an outer transaction (rolls back with it)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const client = prisma;
    let createdId: string | undefined;
    await expect(
      client.$transaction(async (tx) => {
        const repo = makeEventChangeNoticesRepo(tx);
        const notice = await repo.create({
          eventId,
          changeType: "UNPUBLISHED",
          payload: { reason: "rollback" },
        });
        createdId = notice.id;
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    expect(createdId).toBeTruthy();
    const outside = makeEventChangeNoticesRepo(client);
    const rows = await outside.listUndispatched({ limit: 100 });
    expect(rows.map((n) => n.id)).not.toContain(createdId);
  }, 60_000);

  test("deleteDispatchedBefore purges only dispatched rows older than the cutoff", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventChangeNoticesRepo(prisma);
    const cutoff = new Date("2026-07-01T00:00:00.000Z");

    // dispatched-old:    dispatchedAt BEFORE the cutoff → eligible for deletion.
    // dispatched-recent: dispatchedAt AFTER the cutoff  → kept (inside window).
    // undispatched:      dispatchedAt IS NULL           → never touched.
    const dispatchedOld = await repo.create({
      eventId,
      changeType: "CANCELLED",
      payload: {
        buyers: [{ humanId: humanA, refundedCents: 4500, currency: "usd" }],
      },
    });
    const dispatchedRecent = await repo.create({
      eventId,
      changeType: "RESCHEDULED",
      payload: { v: "recent" },
    });
    const undispatched = await repo.create({
      eventId,
      changeType: "ARCHIVED",
      payload: { v: "in-flight" },
    });

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

    // Only the old dispatched row is gone. The recent dispatched row still
    // exists (queryable directly since it's outside the undispatched window),
    // and the in-flight row remains in the undispatched claim set.
    const oldRow = await prisma.eventChangeNotice.findUnique({
      where: { id: dispatchedOld.id },
    });
    expect(oldRow).toBeNull();

    const recentRow = await prisma.eventChangeNotice.findUnique({
      where: { id: dispatchedRecent.id },
    });
    expect(recentRow).not.toBeNull();

    const undispatchedRows = await repo.listUndispatched({ limit: 100 });
    expect(undispatchedRows.map((n) => n.id)).toContain(undispatched.id);

    // A second purge with the same cutoff removes nothing more (idempotent).
    const deletedAgain = await repo.deleteDispatchedBefore(cutoff);
    expect(deletedAgain).toBe(0);
  }, 60_000);

  test("event-rsvps listHumanIdsForEvent pages the watcher set by humanId keyset", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventRsvpsRepo(prisma);
    await repo.upsert({ eventId, humanId: humanA });
    await repo.upsert({ eventId, humanId: humanB });

    const page1 = await repo.listHumanIdsForEvent({ eventId, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBe(page1.items[0]!);

    const page2 = await repo.listHumanIdsForEvent({
      eventId,
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const all = [...page1.items, ...page2.items].sort();
    expect(all).toEqual([humanA, humanB].sort());

    // Empty audience for an unknown event.
    const none = await repo.listHumanIdsForEvent({
      eventId: "00000000-0000-0000-0000-000000000000",
      limit: 10,
    });
    expect(none.items).toHaveLength(0);
    expect(none.nextCursor).toBeNull();
  }, 60_000);
});
