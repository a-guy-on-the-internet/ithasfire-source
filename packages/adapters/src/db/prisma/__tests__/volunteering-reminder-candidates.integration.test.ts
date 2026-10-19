import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeVolunteeringRepo } from "../volunteering";

// findShiftsNeedingReminder and findEventIdsStillOn must only return events
// that are still on. Real Postgres, because the rule is a relation filter on Event.

const BANNED = "10000000-0000-4000-8000-000000000001";
const SHIFT_START = new Date("2026-10-20T18:00:00.000Z");
const WINDOW = {
  windowStart: new Date("2026-10-20T17:30:00.000Z"),
  windowEnd: new Date("2026-10-20T18:30:00.000Z"),
};

const EVENTS = {
  live: { id: "30000000-0000-4000-8000-000000000001", status: "PUBLISHED" },
  cancelled: {
    id: "30000000-0000-4000-8000-000000000002",
    status: "CANCELLED",
  },
  draft: { id: "30000000-0000-4000-8000-000000000003", status: "DRAFT" },
  archived: {
    id: "30000000-0000-4000-8000-000000000004",
    status: "ARCHIVED",
  },
  completed: {
    id: "30000000-0000-4000-8000-000000000006",
    status: "COMPLETED",
  },
  banned: { id: "30000000-0000-4000-8000-000000000005", status: "PUBLISHED" },
} as const;

describe("volunteer reminder event gate (real Postgres)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    await prisma.human.create({
      data: { id: BANNED, name: "Banned", status: "BANNED" },
    });
    const startsAt = new Date("2026-10-21T00:00:00.000Z");
    for (const [name, ev] of Object.entries(EVENTS)) {
      await prisma.event.create({
        data: {
          id: ev.id,
          title: `Event ${name}`,
          status: ev.status,
          publishedAt: ev.status === "DRAFT" ? null : new Date(),
          visibility: "PUBLIC",
          countryCode: "US",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3600_000),
          ...(name === "banned" ? { humanId: BANNED } : {}),
        },
      });
      const role = await prisma.eventVolunteerRole.create({
        data: { eventId: ev.id, name: "Door" },
      });
      const shift = await prisma.eventVolunteerShift.create({
        data: {
          roleId: role.id,
          startsAt: SHIFT_START,
          endsAt: new Date(SHIFT_START.getTime() + 3600_000),
        },
      });
      await prisma.volunteerSignup.create({
        data: {
          eventId: ev.id,
          roleId: role.id,
          shiftId: shift.id,
          contactEmail: `${name}@test.dev`,
          status: "APPROVED",
        },
      });
    }
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  it("returns the approved signup of a live event", async () => {
    const rows = await makeVolunteeringRepo(prisma).findShiftsNeedingReminder({
      kind: "REMINDER_1H",
      ...WINDOW,
    });
    // Cancelled, archived, draft, completed and banned-owner events are out.
    expect(rows.map((r) => r.eventId)).toEqual([EVENTS.live.id]);
  });

  it("findEventIdsStillOn keeps only the published, un-withheld events (not cancelled, archived, draft, completed)", async () => {
    const ids = await makeVolunteeringRepo(prisma).findEventIdsStillOn(
      Object.values(EVENTS).map((e) => e.id),
    );
    expect(ids).toEqual([EVENTS.live.id]);
    expect(await makeVolunteeringRepo(prisma).findEventIdsStillOn([])).toEqual(
      [],
    );
  });
});
