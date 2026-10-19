import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import {
  encodeSavedEventsCursor,
  makeEventSavesRepo,
} from "../../src/db/prisma/event-saves";

const NOW = new Date("2026-07-01T12:00:00.000Z");
const HERO_IMAGE_URL = "https://img.test/saved-hero.jpg";

describe("Prisma adapters integration – event-saves", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let humanId: string;
  let otherHumanId: string;
  const eventIds: string[] = [];

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

      const human = await prisma.human.create({
        data: { name: "Save Tester", status: "ACTIVE" },
      });
      humanId = human.id;

      const other = await prisma.human.create({
        data: { name: "Other Saver", status: "ACTIVE" },
      });
      otherHumanId = other.id;

      // Three upcoming published events for pagination.
      for (let i = 0; i < 3; i += 1) {
        const event = await prisma.event.create({
          data: {
            title: `Saveable Event ${i + 1}`,
            startsAt: new Date("2026-08-01T20:00:00.000Z"),
            endsAt: new Date("2026-08-01T23:00:00.000Z"),
            status: "PUBLISHED",
            humanId: human.id,
          },
        });
        eventIds.push(event.id);
      }

      // Hero image on the FIRST event only — listForHuman must resolve its
      // stored publicUrl (same join mechanism as the events adapter).
      const heroImage = await prisma.image.create({
        data: {
          ownerType: "EVENT",
          ownerId: eventIds[0]!,
          eventId: eventIds[0]!,
          key: "events/hero-test.jpg",
          publicUrl: HERO_IMAGE_URL,
          uploadedAt: new Date(),
          attached: true,
          createdByHumanId: human.id,
        },
      });
      await prisma.event.update({
        where: { id: eventIds[0]! },
        data: { heroImageId: heroImage.id },
      });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("event-saves integration setup failed:", error);
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

  test("upsert is idempotent and delete is a no-op when absent", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventSavesRepo(prisma);
    const key = { eventId: eventIds[0]!, humanId };

    const first = await repo.upsert(key);
    const second = await repo.upsert(key);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.save.id).toBe(first.save.id);
    expect(await repo.existsForUser(key)).toBe(true);

    const deleted = await repo.delete(key);
    expect(deleted).toEqual({ deleted: true, saveId: first.save.id });
    const again = await repo.delete(key);
    expect(again).toEqual({ deleted: false, saveId: null });
    expect(await repo.existsForUser(key)).toBe(false);
  }, 60_000);

  test("listForHuman paginates and survives the boundary row being unsaved", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventSavesRepo(prisma);
    // Save in order 1, 2, 3 (distinct createdAt via sequential writes).
    for (const eventId of eventIds) {
      await repo.upsert({ eventId, humanId });
    }

    const page1 = await repo.listForHuman({
      humanId,
      scope: "upcoming",
      limit: 2,
      now: NOW,
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    // Unsave the boundary row between page fetches, then keep paging.
    const boundary = page1.items[1]!;
    await repo.delete({ eventId: boundary.eventId, humanId });

    const page2 = await repo.listForHuman({
      humanId,
      scope: "upcoming",
      limit: 2,
      cursor: page1.nextCursor,
      now: NOW,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const seenEventIds = [
      ...page1.items.map((item) => item.eventId),
      ...page2.items.map((item) => item.eventId),
    ];
    expect(new Set(seenEventIds).size).toBe(3);

    // Malformed cursor → first page, not a throw.
    const recovered = await repo.listForHuman({
      humanId,
      scope: "upcoming",
      limit: 10,
      cursor: "not|a-real-timestamp",
      now: NOW,
    });
    expect(recovered.items.length).toBeGreaterThan(0);

    // Scope split: nothing here is in the past.
    const past = await repo.listForHuman({
      humanId,
      scope: "past",
      limit: 10,
      now: NOW,
    });
    expect(past.items).toHaveLength(0);

    // Restore the unsaved row for the fan-out test below.
    await repo.upsert({ eventId: boundary.eventId, humanId });
  }, 60_000);

  test("listForHuman joins the event summary shape", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventSavesRepo(prisma);
    const page = await repo.listForHuman({
      humanId,
      scope: "upcoming",
      limit: 10,
      now: NOW,
    });

    const item = page.items[0];
    expect(item).toBeTruthy();
    expect(item!.event.title).toMatch(/^Saveable Event /);
    expect(item!.event.status).toBe("PUBLISHED");
    expect(item!.event.visibility).toBe("PUBLIC");
    expect(item!.event.startsAt).toBeInstanceOf(Date);
    expect(item!.event.timezone).toBeTruthy();

    // Hero URL resolved from the joined Image row for the event that has
    // one; null for events without.
    const withHero = page.items.find((i) => i.eventId === eventIds[0]);
    const withoutHero = page.items.find((i) => i.eventId === eventIds[1]);
    expect(withHero?.event.heroImageId).toBeTruthy();
    expect(withHero?.event.heroImageUrl).toBe(HERO_IMAGE_URL);
    expect(withoutHero?.event.heroImageUrl).toBeNull();
  }, 60_000);

  test("getSavedStateForEvents flags every requested id per user", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventSavesRepo(prisma);
    await repo.upsert({ eventId: eventIds[0]!, humanId: otherHumanId });

    const state = await repo.getSavedStateForEvents({
      humanId: otherHumanId,
      eventIds: [eventIds[0]!, eventIds[1]!],
    });
    expect(state).toEqual({
      [eventIds[0]!]: true,
      [eventIds[1]!]: false,
    });
  }, 60_000);

  test("listHumanIdsForEvent pages the watcher set by humanId keyset", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEventSavesRepo(prisma);
    // Both humans have a save on eventIds[0] by this point.
    const page1 = await repo.listHumanIdsForEvent({
      eventId: eventIds[0]!,
      limit: 1,
    });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBe(page1.items[0]!);

    const page2 = await repo.listHumanIdsForEvent({
      eventId: eventIds[0]!,
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const all = [...page1.items, ...page2.items].sort();
    expect(all).toEqual([humanId, otherHumanId].sort());

    // Cursor encoding sanity for the list cursor helper (value-based).
    const encoded = encodeSavedEventsCursor(NOW, "abc");
    expect(encoded).toContain("|abc");
  }, 60_000);
});
