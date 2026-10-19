import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventRsvpsRepo } from "../../src/db/prisma/event-rsvps";

describe("Prisma adapters integration – event-rsvps concurrency", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let humanId: string;
  let eventId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // The repo's Prisma client runs in driver-adapter ("client" engine)
      // mode, so a bare `new PrismaClient()` throws — construct it the way
      // packages/db/src/index.ts does, with a pg Pool adapter. (A bare client
      // would make these tests silently skip.)
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const human = await prisma.human.create({
        data: { name: "RSVP Tester", status: "ACTIVE" },
      });
      humanId = human.id;

      const event = await prisma.event.create({
        data: {
          title: "Concurrency Open Mic",
          startsAt: new Date("2026-08-01T20:00:00.000Z"),
          endsAt: new Date("2026-08-01T23:00:00.000Z"),
          status: "PUBLISHED",
          attendanceMode: "RSVP",
          humanId: human.id,
        },
      });
      eventId = event.id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("event-rsvps integration setup failed:", error);
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

  test("interleaved concurrent rsvp/cancel never throws and upsert always yields a row", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventRsvpsRepo(prisma);
    const key = { eventId, humanId };

    // Hammer the same (eventId, humanId) with many upsert↔delete pairs racing
    // in parallel. This is the exact live-QA interleaving that used to 500:
    // upsert would resolve to `undefined` (or throw P2002/P2025) mid-race.
    const ROUNDS = 40;
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      ops.push(
        repo.upsert(key).then(({ record, created }) => {
          // The contract: upsert ALWAYS returns a real, fully-shaped record
          // plus a boolean `created` flag (true only when OUR insert won).
          expect(record).toBeTruthy();
          expect(record.id).toEqual(expect.any(String));
          expect(record.eventId).toBe(eventId);
          expect(record.humanId).toBe(humanId);
          expect(record.createdAt).toBeInstanceOf(Date);
          expect(typeof created).toBe("boolean");
          return record;
        }),
      );
      ops.push(repo.delete(key));
    }

    // Not a single rejection across the whole interleaved storm.
    await expect(Promise.all(ops)).resolves.toBeDefined();

    // Data integrity: at most one row for the pair (the [eventId, humanId]
    // unique held throughout), and the final state is a clean boolean.
    const rows = await prisma.eventRsvp.findMany({ where: { eventId, humanId } });
    expect(rows.length).toBeLessThanOrEqual(1);

    // A final settle upsert must still produce a row and leave exactly one.
    const settled = await repo.upsert(key);
    expect(settled.record.eventId).toBe(eventId);
    expect(await repo.existsForUser(key)).toBe(true);
    const finalRows = await prisma.eventRsvp.findMany({
      where: { eventId, humanId },
    });
    expect(finalRows).toHaveLength(1);
  }, 120_000);
});
