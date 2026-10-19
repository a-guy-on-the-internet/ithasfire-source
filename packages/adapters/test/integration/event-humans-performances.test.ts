import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventHumansRepo } from "../../src/db/prisma/event-humans";

const NOW = new Date("2026-07-01T12:00:00.000Z");
const PERFORMER_ROLES = ["PERFORMER", "DJ", "SPEAKER", "INSTRUCTOR"] as const;

async function makeEvent(
  prisma: PrismaClient,
  overrides: {
    title: string;
    startsAt: Date;
    status?: string;
    visibility?: string;
    placeId?: string | null;
    slug?: string | null;
    locationLabel?: string | null;
  },
): Promise<string> {
  const event = await prisma.event.create({
    data: {
      title: overrides.title,
      startsAt: overrides.startsAt,
      endsAt: new Date(overrides.startsAt.getTime() + 3 * 60 * 60 * 1000),
      status: (overrides.status ?? "PUBLISHED") as any,
      visibility: (overrides.visibility ?? "PUBLIC") as any,
      placeId: overrides.placeId ?? null,
      slug: overrides.slug ?? null,
      locationLabel: overrides.locationLabel ?? null,
    },
  });
  return event.id;
}

describe("Prisma adapters integration – event-humans performances", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let humanId: string;
  let placeId: string;

  // Named event ids for assertions.
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const human = await prisma.human.create({
        data: { name: "Performer", status: "ACTIVE" },
      });
      humanId = human.id;

      const place = await prisma.place.create({
        data: { name: "The Basement", address: "1 Basement St", status: "ACTIVE" },
      });
      placeId = place.id;

      // Upcoming, published, public, PERFORMER at a place.
      ids.upcomingA = await makeEvent(prisma, {
        title: "Upcoming A",
        startsAt: new Date("2026-08-01T20:00:00.000Z"),
        placeId,
        slug: "upcoming-a",
      });
      // Upcoming, later — asserts ascending order.
      ids.upcomingB = await makeEvent(prisma, {
        title: "Upcoming B",
        startsAt: new Date("2026-09-01T20:00:00.000Z"),
        locationLabel: "Backyard",
      });
      // Past, PUBLISHED.
      ids.pastA = await makeEvent(prisma, {
        title: "Past A",
        startsAt: new Date("2026-06-01T20:00:00.000Z"),
        placeId,
      });
      // Past, COMPLETED (still a public credit).
      ids.pastCompleted = await makeEvent(prisma, {
        title: "Past Completed",
        startsAt: new Date("2026-05-01T20:00:00.000Z"),
        status: "COMPLETED",
      });
      // Excluded: DRAFT.
      ids.draft = await makeEvent(prisma, {
        title: "Draft",
        startsAt: new Date("2026-08-15T20:00:00.000Z"),
        status: "DRAFT",
      });
      // Excluded: non-public visibility.
      ids.hidden = await makeEvent(prisma, {
        title: "Hidden",
        startsAt: new Date("2026-08-16T20:00:00.000Z"),
        visibility: "PRIVATE",
      });
      // Excluded: CANCELLED.
      ids.cancelled = await makeEvent(prisma, {
        title: "Cancelled",
        startsAt: new Date("2026-05-15T20:00:00.000Z"),
        status: "CANCELLED",
      });
      // A second upcoming performer credit (single row — EventHuman is
      // @@unique on (eventId, humanId), so a registered human cannot hold two
      // rows on one event; the adapter's dedupe is defensive belt-and-braces).
      ids.doubleCredit = await makeEvent(prisma, {
        title: "Second Upcoming",
        startsAt: new Date("2026-08-20T20:00:00.000Z"),
      });
      // Excluded: VOLUNTEER-only attachment is not a performance credit.
      ids.volunteerOnly = await makeEvent(prisma, {
        title: "Volunteer Only",
        startsAt: new Date("2026-08-25T20:00:00.000Z"),
      });

      const attach = (eventId: string, role: string, sortOrder = 0) =>
        prisma!.eventHuman.create({
          data: { eventId, humanId, role: role as any, sortOrder },
        });

      await attach(ids.upcomingA, "PERFORMER");
      await attach(ids.upcomingB, "DJ");
      await attach(ids.pastA, "PERFORMER");
      await attach(ids.pastCompleted, "SPEAKER");
      await attach(ids.draft, "PERFORMER");
      await attach(ids.hidden, "PERFORMER");
      await attach(ids.cancelled, "PERFORMER");
      await attach(ids.doubleCredit, "PERFORMER", 0);
      await attach(ids.volunteerOnly, "VOLUNTEER");
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("event-humans performances setup failed:", error);
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

  test("upcoming: published+public+performer only, ascending", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventHumansRepo(prisma);
    const result = await repo.listPerformancesByHuman({
      humanId,
      roles: PERFORMER_ROLES,
      when: "upcoming",
      now: NOW,
    });

    const returnedIds = result.map((r) => r.eventId);
    // Only upcoming, public, published performer credits — deduped.
    expect(returnedIds).toEqual([
      ids.upcomingA,
      ids.doubleCredit,
      ids.upcomingB,
    ]);
    // Excludes DRAFT, PRIVATE, CANCELLED (past), VOLUNTEER-only.
    expect(returnedIds).not.toContain(ids.draft);
    expect(returnedIds).not.toContain(ids.hidden);
    expect(returnedIds).not.toContain(ids.volunteerOnly);
    // venueName resolves place name, falls back to locationLabel.
    const a = result.find((r) => r.eventId === ids.upcomingA);
    expect(a?.venueName).toBe("The Basement");
    expect(a?.slug).toBe("upcoming-a");
    const b = result.find((r) => r.eventId === ids.upcomingB);
    expect(b?.venueName).toBe("Backyard");
    expect(b?.slug).toBeNull();
  }, 60_000);

  test("past: includes COMPLETED, descending, excludes cancelled/upcoming", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventHumansRepo(prisma);
    const result = await repo.listPerformancesByHuman({
      humanId,
      roles: PERFORMER_ROLES,
      when: "past",
      now: NOW,
    });

    const returnedIds = result.map((r) => r.eventId);
    // Past PUBLISHED then COMPLETED, most-recent first.
    expect(returnedIds).toEqual([ids.pastA, ids.pastCompleted]);
    expect(returnedIds).not.toContain(ids.cancelled);
  }, 60_000);

  test("past cap limits distinct events", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventHumansRepo(prisma);
    const result = await repo.listPerformancesByHuman({
      humanId,
      roles: PERFORMER_ROLES,
      when: "past",
      now: NOW,
      limit: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.eventId).toBe(ids.pastA);
  }, 60_000);
});
