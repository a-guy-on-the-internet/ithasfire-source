import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import { TRACK_RECORD_EVENT_STATUSES } from "@th/types/repos/events";

import { makeEventsRepo } from "../../src/db/prisma/events";

/**
 * `EventsRepo.listPublishedByPlace` `statuses` (venue-track-record R10): the
 * default stays PUBLISHED-only so every existing caller's rows are unchanged;
 * the track-record reads pass PUBLISHED + COMPLETED and get the show
 * `completeEvent` closed out. CANCELLED is never admitted by either.
 */
describe("Prisma adapters integration – listPublishedByPlace statuses", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const NOW = new Date("2026-09-01T12:00:00.000Z");
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const place = await prisma.place.create({
        data: { name: "The Room", address: "1 Room St", status: "ACTIVE" },
      });
      ids.place = place.id;

      const make = async (
        title: string,
        status: "PUBLISHED" | "COMPLETED" | "CANCELLED" | "DRAFT",
        day: number,
      ) => {
        const startsAt = new Date(
          `2026-06-${String(day).padStart(2, "0")}T20:00:00.000Z`,
        );
        const ev = await prisma!.event.create({
          data: {
            title,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
            status,
            visibility: "PUBLIC",
            placeId: ids.place!,
          },
        });
        return ev.id;
      };
      ids.published = await make("Published", "PUBLISHED", 1);
      ids.completed = await make("Completed", "COMPLETED", 2);
      ids.cancelled = await make("Cancelled", "CANCELLED", 3);
      ids.draft = await make("Draft", "DRAFT", 4);
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("listPublishedByPlace statuses setup failed:", error);
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

  test("omitted → PUBLISHED only (existing callers unchanged)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const page = await repo.listPublishedByPlace({
      placeId: ids.place!,
      from: new Date(0),
      to: NOW,
      status: "past",
    });
    expect(page.items.map((e) => e.id)).toStrictEqual([ids.published]);
    expect(page.pageInfo.total).toBe(1);
  }, 60_000);

  test("TRACK_RECORD_EVENT_STATUSES → PUBLISHED and COMPLETED; CANCELLED and DRAFT never", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const page = await repo.listPublishedByPlace({
      placeId: ids.place!,
      from: new Date(0),
      to: NOW,
      status: "past",
      statuses: TRACK_RECORD_EVENT_STATUSES,
    });
    // `status: "past"` orders most recent first.
    expect(page.items.map((e) => e.id)).toStrictEqual([
      ids.completed,
      ids.published,
    ]);
    expect(page.pageInfo.total).toBe(2);
    expect(page.items.map((e) => e.status)).toStrictEqual([
      "COMPLETED",
      "PUBLISHED",
    ]);
  }, 60_000);

  test("an empty statuses list means the default, not 'nothing'", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const page = await repo.listPublishedByPlace({
      placeId: ids.place!,
      from: new Date(0),
      to: NOW,
      status: "past",
      statuses: [],
    });
    expect(page.items.map((e) => e.id)).toStrictEqual([ids.published]);
  }, 60_000);
});
