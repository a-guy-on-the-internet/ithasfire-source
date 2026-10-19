import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventsRepo } from "../events";

// ---------------------------------------------------------------------------
// Integration coverage for the two reads behind the community-moderator
// place guard: `hasOwnedLiveEventsAtPlace` (an organiser's LIVE event uses
// the place) and `countLiveCommunityListingsAtPlace` (archive is refused while
// live listings use it). Standalone DDL mirrors only the "Event" columns the
// queries touch.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "EventStewardship" AS ENUM ('OWNED', 'COMMUNITY');

CREATE TABLE "Event" (
  "id" TEXT NOT NULL,
  "placeId" TEXT,
  "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
  "stewardship" "EventStewardship" NOT NULL DEFAULT 'OWNED',
  "endsAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);
`;

const PLACE = "place-1";
const OTHER = "place-2";
const NOW = new Date("2026-10-14T12:00:00.000Z");
const LATER = new Date("2026-10-20T12:00:00.000Z");
const EARLIER = new Date("2026-10-01T12:00:00.000Z");

describe("EventsRepo place-moderation reads (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool?.query(`TRUNCATE "Event"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  let seq = 0;
  async function insert(row: {
    placeId?: string | null;
    status: string;
    stewardship: string;
    endsAt?: Date;
  }) {
    seq += 1;
    await pool!.query(
      `INSERT INTO "Event" ("id", "placeId", "status", "stewardship", "endsAt") VALUES ($1, $2, $3, $4, $5)`,
      [
        `event-${seq}`,
        row.placeId === undefined ? PLACE : row.placeId,
        row.status,
        row.stewardship,
        row.endsAt ?? LATER,
      ],
    );
  }

  const repo = () => makeEventsRepo(prisma!);

  const live = () =>
    repo().hasOwnedLiveEventsAtPlace({ placeId: PLACE, now: NOW });

  test("hasOwnedLiveEventsAtPlace: false with no events", async () => {
    expect(await live()).toBe(false);
  });

  test("hasOwnedLiveEventsAtPlace: a PUBLISHED owned event that has not ended blocks", async () => {
    await insert({ status: "PUBLISHED", stewardship: "OWNED", endsAt: LATER });
    expect(await live()).toBe(true);
  });

  test.each([
    ["a DRAFT (even one ending later)", "DRAFT", LATER],
    ["a past PUBLISHED event", "PUBLISHED", EARLIER],
    ["a PUBLISHED event ending exactly now", "PUBLISHED", NOW],
    ["a COMPLETED event", "COMPLETED", LATER],
    ["an ARCHIVED event", "ARCHIVED", LATER],
    ["a CANCELLED event", "CANCELLED", LATER],
  ] as const)(
    "hasOwnedLiveEventsAtPlace: %s does not block",
    async (_label, status, endsAt) => {
      await insert({ status, stewardship: "OWNED", endsAt });
      expect(await live()).toBe(false);
    },
  );

  test("hasOwnedLiveEventsAtPlace: community listings and other places do not block", async () => {
    await insert({ status: "PUBLISHED", stewardship: "COMMUNITY" });
    await insert({ status: "PUBLISHED", stewardship: "OWNED", placeId: OTHER });
    await insert({ status: "PUBLISHED", stewardship: "OWNED", placeId: null });

    expect(await live()).toBe(false);
  });

  test("countLiveCommunityListingsAtPlace: only PUBLISHED community listings at the place that have not ended", async () => {
    await insert({ status: "PUBLISHED", stewardship: "COMMUNITY" }); // counts
    await insert({ status: "PUBLISHED", stewardship: "COMMUNITY" }); // counts
    await insert({ status: "PUBLISHED", stewardship: "COMMUNITY", endsAt: EARLIER }); // ended
    await insert({ status: "PUBLISHED", stewardship: "COMMUNITY", endsAt: NOW }); // ends now: ended
    await insert({ status: "DRAFT", stewardship: "COMMUNITY" });
    await insert({ status: "CANCELLED", stewardship: "COMMUNITY" });
    await insert({ status: "PUBLISHED", stewardship: "OWNED" });
    await insert({ status: "PUBLISHED", stewardship: "COMMUNITY", placeId: OTHER });

    expect(
      await repo().countLiveCommunityListingsAtPlace({ placeId: PLACE, now: NOW }),
    ).toBe(2);
  });
});
