import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makePlaceReviewsRepo, makePlaceStatsRepo } from "../place-reviews";

// ---------------------------------------------------------------------------
// Integration coverage for the place-review-anonymization sweep/serving
// queries — these exist because the Prisma query SHAPES are the risk:
//   - listPlaceIdsWithVisibleReviews moved to groupBy (findMany+distinct
//     applied `take` BEFORE the in-memory distinct, silently shrinking pages)
//   - listPlaceIdsWithPublishedSnapshot / listPublishedSnapshotsByCity filter
//     Json columns with Prisma.DbNull
// Standalone DDL (mirrors the migrations) WITHOUT the FKs/unrelated columns
// so the tables are self-contained; only columns the queries reference exist.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "PlaceStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

CREATE TABLE "Place" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "city" TEXT,
  "region" TEXT,
  "status" "PlaceStatus" NOT NULL DEFAULT 'ACTIVE',
  "community_reviews_enabled" BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlaceReview" (
  "id" TEXT NOT NULL,
  "placeId" TEXT NOT NULL,
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "flagged" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "PlaceReview_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlaceStats" (
  "id" TEXT NOT NULL,
  "placeId" TEXT NOT NULL,
  "publicSnapshot" JSONB,
  "publicSnapshotAt" TIMESTAMP(3),

  CONSTRAINT "PlaceStats_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlaceStats_placeId_key" ON "PlaceStats"("placeId");
`;

describe("place-reviews sweep/serving queries (integration)", () => {
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
    await pool?.query(`TRUNCATE "Place", "PlaceReview", "PlaceStats"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  async function insertReview(
    id: string,
    placeId: string,
    opts: { hidden?: boolean; flagged?: boolean } = {},
  ) {
    await pool!.query(
      `INSERT INTO "PlaceReview" ("id", "placeId", "hidden", "flagged") VALUES ($1, $2, $3, $4)`,
      [id, placeId, opts.hidden ?? false, opts.flagged ?? false],
    );
  }

  async function insertPlace(
    id: string,
    name: string,
    opts: {
      city?: string;
      region?: string;
      status?: string;
      communityReviewsEnabled?: boolean;
    } = {},
  ) {
    await pool!.query(
      `INSERT INTO "Place" ("id", "name", "city", "region", "status", "community_reviews_enabled") VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        name,
        opts.city ?? "Nashville",
        opts.region ?? "TN",
        opts.status ?? "ACTIVE",
        opts.communityReviewsEnabled ?? true,
      ],
    );
  }

  async function insertStats(id: string, placeId: string, snapshot: unknown) {
    await pool!.query(
      `INSERT INTO "PlaceStats" ("id", "placeId", "publicSnapshot") VALUES ($1, $2, $3)`,
      [id, placeId, snapshot === null ? null : JSON.stringify(snapshot)],
    );
  }

  describe("listPlaceIdsWithVisibleReviews (groupBy)", () => {
    test("take applies to DISTINCT placeIds, not underlying rows", async () => {
      // place-a has MANY visible rows — under findMany({distinct, take}) a
      // take of 2 could collapse to just [place-a]; groupBy must return the
      // first 2 distinct placeIds.
      for (let i = 0; i < 5; i++) await insertReview(`ra-${i}`, "place-a");
      await insertReview("rb-0", "place-b", { hidden: true }); // invisible
      await insertReview("rc-0", "place-c");
      await insertReview("rd-0", "place-d");

      const repo = makePlaceReviewsRepo(prisma!);
      const page = await repo.listPlaceIdsWithVisibleReviews({ limit: 2 });

      expect(page).toStrictEqual(["place-a", "place-c"]);
    });

    test("cursor pages through the full distinct set", async () => {
      await insertReview("r1", "place-a");
      await insertReview("r2", "place-b");
      await insertReview("r3", "place-c", { flagged: true }); // invisible
      await insertReview("r4", "place-d");

      const repo = makePlaceReviewsRepo(prisma!);
      const all: string[] = [];
      let after: string | undefined;
      while (true) {
        const page = await repo.listPlaceIdsWithVisibleReviews({
          limit: 2,
          afterPlaceId: after,
        });
        if (page.length === 0) break;
        all.push(...page);
        after = page[page.length - 1];
      }

      expect(all).toStrictEqual(["place-a", "place-b", "place-d"]);
    });
  });

  describe("listPlaceIdsWithPublishedSnapshot (Json DbNull filter)", () => {
    test("returns only placeIds with a non-null snapshot, cursor-paginated", async () => {
      await insertStats("s1", "place-a", { version: 1 });
      await insertStats("s2", "place-b", null);
      await insertStats("s3", "place-c", { version: 1 });
      await insertStats("s4", "place-d", { version: 1 });

      const repo = makePlaceStatsRepo(prisma!);

      expect(
        await repo.listPlaceIdsWithPublishedSnapshot({ limit: 10 }),
      ).toStrictEqual(["place-a", "place-c", "place-d"]);
      expect(
        await repo.listPlaceIdsWithPublishedSnapshot({
          limit: 10,
          afterPlaceId: "place-a",
        }),
      ).toStrictEqual(["place-c", "place-d"]);
    });
  });

  describe("listPublishedSnapshotsByCity", () => {
    test("returns only ACTIVE, in-city, snapshot-carrying places — snapshot verbatim, no live columns", async () => {
      const snapshot = {
        version: 1,
        headline: { reviewCountBand: "20+", wouldPlayAgainPct: 85 },
      };
      await insertPlace("place-a", "Has Snapshot");
      await insertStats("s1", "place-a", snapshot);
      await insertPlace("place-b", "No Snapshot");
      await insertStats("s2", "place-b", null);
      await insertPlace("place-c", "Suspended", { status: "SUSPENDED" });
      await insertStats("s3", "place-c", snapshot);
      await insertPlace("place-d", "Wrong City", { city: "Memphis" });
      await insertStats("s4", "place-d", snapshot);
      await insertPlace("place-e", "Excluded Self");
      await insertStats("s5", "place-e", snapshot);
      // venue-track-record-and-review-switch FR-003: performer reviews OFF —
      // a published snapshot does not make it a candidate.
      await insertPlace("place-f", "Reviews Off", {
        communityReviewsEnabled: false,
      });
      await insertStats("s6", "place-f", snapshot);

      const repo = makePlaceStatsRepo(prisma!);
      const rows = await repo.listPublishedSnapshotsByCity({
        city: "Nashville",
        region: "TN",
        excludePlaceId: "place-e",
        limit: 10,
      });

      expect(rows).toStrictEqual([
        { placeId: "place-a", placeName: "Has Snapshot", publicSnapshot: snapshot },
      ]);
      // The DTO must not smuggle live stats columns.
      expect(Object.keys(rows[0]!).sort()).toStrictEqual([
        "placeId",
        "placeName",
        "publicSnapshot",
      ]);
    });
  });
});
