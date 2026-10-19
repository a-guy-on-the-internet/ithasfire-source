import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventDateRsvpsRepo } from "../../src/db/prisma/event-date-rsvps";

/**
 * `existsForUserOnEvent` against a real Postgres: the RSVP drain's
 * whole-listing take-down check ("does this person still hold ANY called-off
 * night of this listing?"). The relation filter (`eventDate: { eventId,
 * status }`) is the part a mock cannot prove.
 */
describe("Prisma adapters integration – eventDateRsvps.existsForUserOnEvent", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let listingId: string;
  let otherListingId: string;
  let anchorHolder: string;
  let laterNightHolder: string;
  let scheduledOnlyHolder: string;
  let otherListingHolder: string;
  let earlierNightHolder: string;
  let nobody: string;
  let anchorStartsAt: Date;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // Driver-adapter mode: a bare `new PrismaClient()` throws and the suite
      // would silently skip. Constructed the way packages/db/src/index.ts does.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const mkHuman = async (name: string) =>
        (await prisma!.human.create({ data: { name, status: "ACTIVE" } })).id;
      const hostId = await mkHuman("Listing Host");
      anchorHolder = await mkHuman("Anchor Holder");
      laterNightHolder = await mkHuman("Later Night Holder");
      scheduledOnlyHolder = await mkHuman("Scheduled Only Holder");
      otherListingHolder = await mkHuman("Other Listing Holder");
      earlierNightHolder = await mkHuman("Earlier Night Holder");
      nobody = await mkHuman("Nobody");

      const mkListing = async (title: string) =>
        (
          await prisma!.event.create({
            data: {
              title,
              startsAt: new Date("2026-08-01T20:00:00.000Z"),
              endsAt: new Date("2026-08-01T23:00:00.000Z"),
              status: "CANCELLED",
              attendanceMode: "RSVP",
              timezone: "America/Chicago",
              humanId: hostId,
            },
          })
        ).id;
      listingId = await mkListing("Weekly Open Mic");
      otherListingId = await mkListing("Other Weekly");

      const mkDate = async (
        eventId: string,
        ordinal: number,
        status: "SCHEDULED" | "CANCELLED",
      ) =>
        (
          await prisma!.eventDate.create({
            data: {
              eventId,
              ordinal,
              startsAt: new Date(Date.UTC(2026, 7, ordinal, 20)),
              status,
            },
          })
        ).id;
      const anchor = await mkDate(listingId, 1, "CANCELLED");
      const later = await mkDate(listingId, 2, "CANCELLED");
      const scheduled = await mkDate(listingId, 3, "SCHEDULED");
      const otherNight = await mkDate(otherListingId, 1, "CANCELLED");
      anchorStartsAt = new Date(Date.UTC(2026, 7, 1, 20));
      // A night called off BEFORE the take-down (a moderator, last month).
      const earlier = (
        await prisma.eventDate.create({
          data: {
            eventId: listingId,
            ordinal: 4,
            startsAt: new Date(Date.UTC(2026, 6, 15, 20)),
            status: "CANCELLED",
          },
        })
      ).id;

      await prisma.eventDateRsvp.createMany({
        data: [
          { eventDateId: anchor, humanId: anchorHolder },
          // Withdrew the anchor night, still holds a later one.
          { eventDateId: later, humanId: laterNightHolder },
          { eventDateId: scheduled, humanId: scheduledOnlyHolder },
          { eventDateId: otherNight, humanId: otherListingHolder },
          // Holds only the earlier called-off night; withdrew every night
          // the take-down called off.
          { eventDateId: earlier, humanId: earlierNightHolder },
        ],
      });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("event-date-rsvps integration setup failed:", error);
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

  test("true for any CANCELLED night of THIS listing; false otherwise", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventDateRsvpsRepo(prisma);
    const ask = (humanId: string) =>
      repo.existsForUserOnEvent({
        eventId: listingId,
        humanId,
        dateStatus: "CANCELLED",
      });

    expect(await ask(anchorHolder)).toBe(true);
    expect(await ask(laterNightHolder)).toBe(true);
    // Holds only a SCHEDULED night: not a called-off one.
    expect(await ask(scheduledOnlyHolder)).toBe(false);
    // Holds a night of a DIFFERENT listing.
    expect(await ask(otherListingHolder)).toBe(false);
    expect(await ask(nobody)).toBe(false);
  });

  test("without dateStatus, any night of the listing counts", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventDateRsvpsRepo(prisma);

    expect(
      await repo.existsForUserOnEvent({
        eventId: listingId,
        humanId: scheduledOnlyHolder,
      }),
    ).toBe(true);
    expect(
      await repo.existsForUserOnEvent({
        eventId: listingId,
        humanId: otherListingHolder,
      }),
    ).toBe(false);
  });

  test("startsAtFrom drops CANCELLED nights before the anchor (inclusive bound)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventDateRsvpsRepo(prisma);
    const ask = (humanId: string) =>
      repo.existsForUserOnEvent({
        eventId: listingId,
        humanId,
        dateStatus: "CANCELLED",
        startsAtFrom: anchorStartsAt,
      });

    // Unbounded, the earlier night matches: the over-match the bound fixes.
    expect(
      await repo.existsForUserOnEvent({
        eventId: listingId,
        humanId: earlierNightHolder,
        dateStatus: "CANCELLED",
      }),
    ).toBe(true);
    // Bounded at the anchor: the earlier night no longer counts.
    expect(await ask(earlierNightHolder)).toBe(false);
    // The anchor night itself counts (gte), and so does a later one.
    expect(await ask(anchorHolder)).toBe(true);
    expect(await ask(laterNightHolder)).toBe(true);
  });
});
