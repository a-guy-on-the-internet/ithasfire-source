/**
 * `events.listCommunityListingsForPlatform` against a real Postgres: only
 * COMMUNITY rows, the status and title filters, newest-first cursor paging,
 * the place join, and the upcoming SCHEDULED `EventDate` fields.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventsRepo } from "../../src/db/prisma/events";

const NOW = new Date("2026-07-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY);

describe("Prisma adapters integration – events.listCommunityListingsForPlatform", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const place = await prisma.place.create({
        data: { name: "The Ember Room", address: "1 Fireside Ln", city: "Nashville" },
      });
      const owner = await prisma.human.create({
        data: { name: "Owner", status: "ACTIVE" },
      });

      const community = (
        title: string,
        status: "DRAFT" | "PUBLISHED" | "CANCELLED" | "ARCHIVED",
        createdAt: Date,
        extra: Record<string, unknown> = {},
      ) =>
        prisma!.event.create({
          data: {
            title,
            status,
            stewardship: "COMMUNITY",
            attendanceMode: "RSVP",
            startsAt: at(3),
            endsAt: at(3.1),
            createdAt,
            ...extra,
          },
        });

      // createdAt order (newest first): recurring, oneoff, draft, cancelled, archived.
      const recurring = await community("Weekly Open Mic", "PUBLISHED", at(-1), {
        placeId: place.id,
        recurrenceSchedule: { freq: "WEEKLY" },
      });
      const oneOff = await community("Poetry Slam", "PUBLISHED", at(-2), {
        locality: "Memphis",
      });
      const draft = await community("Draft Jam", "DRAFT", at(-3));
      const cancelled = await community("Cancelled Open Mic", "CANCELLED", at(-4));
      const archived = await community("Archived Open Mic", "ARCHIVED", at(-5));
      // An OWNED event with a matching title must never appear.
      const owned = await prisma.event.create({
        data: {
          title: "Owned Open Mic",
          status: "PUBLISHED",
          humanId: owner.id,
          startsAt: at(3),
          endsAt: at(3.1),
          createdAt: at(0),
        },
      });
      Object.assign(ids, {
        recurring: recurring.id,
        oneOff: oneOff.id,
        draft: draft.id,
        cancelled: cancelled.id,
        archived: archived.id,
        owned: owned.id,
      });

      // Recurring nights: one past, one called off, two upcoming.
      await prisma.eventDate.createMany({
        data: [
          { eventId: recurring.id, ordinal: 0, startsAt: at(-7), status: "SCHEDULED" },
          { eventId: recurring.id, ordinal: 1, startsAt: at(2), status: "CANCELLED" },
          { eventId: recurring.id, ordinal: 2, startsAt: at(9), status: "SCHEDULED" },
          { eventId: recurring.id, ordinal: 3, startsAt: at(16), status: "SCHEDULED" },
        ],
      });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("community-listings-platform-list setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  }, 60_000);

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("lists only COMMUNITY rows in the asked statuses, newest first, with the joined fields", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);

    const page = await repo.listCommunityListingsForPlatform({
      statuses: ["DRAFT", "PUBLISHED", "CANCELLED", "COMPLETED"],
      limit: 25,
      now: NOW,
    });

    expect(page.items.map((row) => row.id)).toEqual([
      ids.recurring,
      ids.oneOff,
      ids.draft,
      ids.cancelled,
    ]);
    expect(page.nextCursor).toBeNull();

    const [recurring, oneOff] = page.items;
    expect(recurring).toMatchObject({
      title: "Weekly Open Mic",
      recurring: true,
      placeName: "The Ember Room",
      placeCity: "Nashville",
      nextScheduledDateStartsAt: at(9),
      upcomingScheduledDateCount: 2,
    });
    expect(oneOff).toMatchObject({
      recurring: false,
      placeId: null,
      placeName: null,
      placeCity: null,
      locality: "Memphis",
      nextScheduledDateStartsAt: null,
      upcomingScheduledDateCount: 0,
    });
  }, 60_000);

  test("ARCHIVED only when asked; title filter is case-insensitive and never returns OWNED", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);

    const archived = await repo.listCommunityListingsForPlatform({
      statuses: ["ARCHIVED"],
      limit: 25,
      now: NOW,
    });
    expect(archived.items.map((row) => row.id)).toEqual([ids.archived]);

    const titled = await repo.listCommunityListingsForPlatform({
      statuses: ["DRAFT", "PUBLISHED", "CANCELLED", "COMPLETED", "ARCHIVED"],
      titleContains: "OPEN MIC",
      limit: 25,
      now: NOW,
    });
    expect(titled.items.map((row) => row.id)).toEqual([
      ids.recurring,
      ids.cancelled,
      ids.archived,
    ]);
  }, 60_000);

  test("cursor pages without skipping or repeating", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const statuses = ["DRAFT", "PUBLISHED", "CANCELLED", "COMPLETED"] as const;

    const first = await repo.listCommunityListingsForPlatform({
      statuses: [...statuses],
      limit: 2,
      now: NOW,
    });
    expect(first.items.map((row) => row.id)).toEqual([ids.recurring, ids.oneOff]);
    expect(first.nextCursor).toBe(ids.oneOff);

    const second = await repo.listCommunityListingsForPlatform({
      statuses: [...statuses],
      cursor: first.nextCursor,
      limit: 2,
      now: NOW,
    });
    expect(second.items.map((row) => row.id)).toEqual([ids.draft, ids.cancelled]);
    expect(second.nextCursor).toBeNull();
  }, 60_000);
  // Runs last: it adds rows, and the tests above assert exact id lists.
  test("rows with an identical createdAt split across a page boundary page by the (createdAt, id) tuple", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const tie = at(-10);
    const make = (title: string, createdAt: Date) =>
      prisma!.event.create({
        data: {
          title,
          status: "PUBLISHED",
          stewardship: "COMMUNITY",
          attendanceMode: "RSVP",
          startsAt: at(3),
          endsAt: at(3.1),
          createdAt,
        },
        select: { id: true },
      });
    const newer = await make("Tiebreak Newer", at(-9));
    const tiedA = await make("Tiebreak Tied A", tie);
    const tiedB = await make("Tiebreak Tied B", tie);
    const tiedC = await make("Tiebreak Tied C", tie);
    // Same createdAt: the order falls to id DESC.
    const tied = [tiedA.id, tiedB.id, tiedC.id].sort().reverse();
    const expected = [newer.id, ...tied];

    const input = {
      statuses: ["PUBLISHED" as const],
      titleContains: "tiebreak",
      limit: 2,
      now: NOW,
    };
    // Page 1 ends inside the tie (newer, tied[0]); page 2 starts inside it.
    const first = await repo.listCommunityListingsForPlatform(input);
    expect(first.items.map((row) => row.id)).toEqual(expected.slice(0, 2));
    expect(first.nextCursor).toBe(tied[0]);

    const second = await repo.listCommunityListingsForPlatform({
      ...input,
      cursor: first.nextCursor,
    });
    expect(second.items.map((row) => row.id)).toEqual(expected.slice(2, 4));
    expect(second.nextCursor).toBeNull();

    const seen = [...first.items, ...second.items].map((row) => row.id);
    expect(new Set(seen).size).toBe(4);
    expect(second.items.every((row) => row.createdAt.getTime() === tie.getTime())).toBe(true);
  }, 60_000);
});
