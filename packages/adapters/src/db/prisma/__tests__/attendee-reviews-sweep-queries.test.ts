import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeAttendeeReviewsRepo } from "../attendee-reviews";

// ---------------------------------------------------------------------------
// Integration coverage for the attendee-review aggregation sweep query
// (recompute-review-aggregates FR-004). Sibling of
// place-reviews-sweep-queries.test.ts, and it exists for the same reason: the
// Prisma query SHAPE is the risk, and the core use case's tests run against
// in-memory fakes that happily accept a filter the real client rejects.
//
// The bug this pins: `listSubjectIdsWithReviews` applied `{ not: null }` to
// the group-by column for EVERY subject type. `eventId` is a REQUIRED column,
// so Prisma types it with the non-nullable StringFilter and REJECTS `not:
// null` ("Argument `not` must not be null") instead of no-op'ing it. That
// throw lands in the recompute's paging loop — OUTSIDE its per-subject
// try/catch — so the EVENT sweep failed the entire job and NO aggregate of any
// subject type was ever published.
//
// Standalone DDL (mirrors the migration) WITHOUT FKs/unrelated columns so the
// table is self-contained; only columns the query references exist.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TABLE "AttendeeReview" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "humanId" TEXT NOT NULL,
  "overallRating" INTEGER NOT NULL,
  "soundQuality" INTEGER,
  "venueComfort" INTEGER,
  "organization" INTEGER,
  "valueForMoney" INTEGER,
  "text" VARCHAR(2000),
  "placeId" TEXT,
  "ownerType" TEXT,
  "ownerId" TEXT,
  "seriesId" TEXT,
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "flagged" BOOLEAN NOT NULL DEFAULT false,
  "flagReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AttendeeReview_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AttendeeReview_eventId_humanId_key" ON "AttendeeReview"("eventId", "humanId");
`;

describe("attendee-reviews sweep queries (integration)", () => {
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
    await pool?.query(`TRUNCATE "AttendeeReview"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  async function insertReview(
    id: string,
    opts: {
      eventId: string;
      humanId?: string;
      placeId?: string | null;
      ownerId?: string | null;
      seriesId?: string | null;
      hidden?: boolean;
    },
  ) {
    await pool!.query(
      `INSERT INTO "AttendeeReview"
        ("id", "eventId", "humanId", "overallRating", "placeId", "ownerId", "seriesId", "hidden")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        opts.eventId,
        opts.humanId ?? `human-${id}`,
        5,
        opts.placeId ?? null,
        opts.ownerId ?? null,
        opts.seriesId ?? null,
        opts.hidden ?? false,
      ],
    );
  }

  describe("listSubjectIdsWithReviews", () => {
    // The regression: this threw PrismaClientValidationError before the fix,
    // failing the whole recompute job on its very first page.
    test("EVENT sweep runs against the REQUIRED eventId column (no `not: null`)", async () => {
      await insertReview("r1", { eventId: "event-a" });
      await insertReview("r2", { eventId: "event-b" });

      const repo = makeAttendeeReviewsRepo(prisma!);

      await expect(
        repo.listSubjectIdsWithReviews({ subjectType: "EVENT", limit: 10 }),
      ).resolves.toStrictEqual(["event-a", "event-b"]);
    });

    test("nullable targets still exclude the null bucket", async () => {
      // placeId/ownerId/seriesId ARE nullable — an unplaced/ownerless event's
      // reviews must never produce a `null` subject to recompute.
      await insertReview("r1", { eventId: "event-a", placeId: "place-a" });
      await insertReview("r2", { eventId: "event-b", placeId: null });
      await insertReview("r3", { eventId: "event-c", placeId: "place-b" });

      const repo = makeAttendeeReviewsRepo(prisma!);

      await expect(
        repo.listSubjectIdsWithReviews({ subjectType: "PLACE", limit: 10 }),
      ).resolves.toStrictEqual(["place-a", "place-b"]);
    });

    test("hidden reviews never surface a subject", async () => {
      await insertReview("r1", { eventId: "event-a" });
      await insertReview("r2", { eventId: "event-b", hidden: true });

      const repo = makeAttendeeReviewsRepo(prisma!);

      await expect(
        repo.listSubjectIdsWithReviews({ subjectType: "EVENT", limit: 10 }),
      ).resolves.toStrictEqual(["event-a"]);
    });

    test("take applies to DISTINCT subjectIds, not underlying rows", async () => {
      // place-a has MANY rows — under findMany({distinct, take}) a take of 2
      // could collapse to just [place-a]; groupBy must return 2 distinct ids.
      for (let i = 0; i < 5; i++) {
        await insertReview(`ra-${i}`, { eventId: `event-a-${i}`, placeId: "place-a" });
      }
      await insertReview("rb-0", { eventId: "event-b", placeId: "place-b" });
      await insertReview("rc-0", { eventId: "event-c", placeId: "place-c" });

      const repo = makeAttendeeReviewsRepo(prisma!);

      await expect(
        repo.listSubjectIdsWithReviews({ subjectType: "PLACE", limit: 2 }),
      ).resolves.toStrictEqual(["place-a", "place-b"]);
    });

    test("cursor pages through the full distinct set for every subject type", async () => {
      await insertReview("r1", {
        eventId: "event-a",
        placeId: "place-a",
        ownerId: "owner-a",
        seriesId: "series-a",
      });
      await insertReview("r2", {
        eventId: "event-b",
        placeId: "place-b",
        ownerId: "owner-b",
        seriesId: "series-b",
      });
      await insertReview("r3", {
        eventId: "event-c",
        placeId: "place-c",
        ownerId: "owner-c",
        seriesId: "series-c",
      });

      const repo = makeAttendeeReviewsRepo(prisma!);
      const subjects = [
        ["EVENT", ["event-a", "event-b", "event-c"]],
        ["PLACE", ["place-a", "place-b", "place-c"]],
        ["OWNER", ["owner-a", "owner-b", "owner-c"]],
        ["SERIES", ["series-a", "series-b", "series-c"]],
      ] as const;

      for (const [subjectType, expected] of subjects) {
        const all: string[] = [];
        let after: string | undefined;
        while (true) {
          const page = await repo.listSubjectIdsWithReviews({
            subjectType,
            limit: 2,
            afterSubjectId: after,
          });
          if (page.length === 0) break;
          all.push(...page);
          after = page[page.length - 1];
        }
        expect(all, `subjectType=${subjectType}`).toStrictEqual([...expected]);
      }
    });
  });
});
