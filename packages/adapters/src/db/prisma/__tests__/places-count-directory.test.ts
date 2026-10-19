import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makePlacesRepo } from "../places";

// ---------------------------------------------------------------------------
// Integration coverage for PlacesRepo.countDirectory — the home hero's "N
// rooms" number. The risk is the SQL itself: the raw `earth_box`/
// `earth_distance` predicate, the `listed_in_directory` @map and the enum
// comparison can't be exercised by a mocked Prisma client. This hits Postgres
// (postgis image ships the `cube`/`earthdistance` contrib modules).
//
// Standalone DDL mirrors only the "Place" columns the two queries touch.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;
CREATE TYPE "PlaceStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
CREATE TYPE "EventLocationMode" AS ENUM ('EXACT', 'OBSCURED');

CREATE TABLE "Place" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "status" "PlaceStatus" NOT NULL DEFAULT 'ACTIVE',
  "listed_in_directory" BOOLEAN NOT NULL DEFAULT false,
  "location_mode" "EventLocationMode" NOT NULL DEFAULT 'EXACT',
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,

  CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);
`;

// Downtown Nashville. The two "near" rows sit ~1–3 km away; the far row is
// Memphis, ~300 km west.
const ORIGIN = { lat: 36.1627, lng: -86.7816 };
const NEAR_A = { lat: 36.17, lng: -86.79 };
const NEAR_B = { lat: 36.15, lng: -86.76 };
const FAR = { lat: 35.1495, lng: -90.049 };

describe("PlacesRepo.countDirectory (integration)", () => {
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
    await pool?.query(`TRUNCATE "Place"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  let seq = 0;
  async function insertPlace(opts: {
    status?: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
    listed?: boolean;
    coords?: { lat: number; lng: number } | null;
    locationMode?: "EXACT" | "OBSCURED";
  }) {
    const id = `place-${seq++}`;
    await pool!.query(
      `INSERT INTO "Place" ("id", "name", "address", "status", "listed_in_directory", "lat", "lng", "location_mode")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        `Place ${id}`,
        "1 Main St",
        opts.status ?? "ACTIVE",
        opts.listed ?? true,
        opts.coords === null ? null : (opts.coords ?? ORIGIN).lat,
        opts.coords === null ? null : (opts.coords ?? ORIGIN).lng,
        opts.locationMode ?? "EXACT",
      ],
    );
  }

  async function seedFixture() {
    // 3 ACTIVE + listed with coords: two within 5 km, one ~300 km away.
    await insertPlace({ coords: NEAR_A });
    await insertPlace({ coords: NEAR_B });
    await insertPlace({ coords: FAR });
    // ACTIVE but unlisted — never a directory place.
    await insertPlace({ listed: false, coords: NEAR_A });
    // Listed but not ACTIVE — never a directory place.
    await insertPlace({ status: "SUSPENDED", coords: NEAR_A });
    // Listed + ACTIVE with no coords — counts unscoped, never within a radius.
    await insertPlace({ coords: null });
  }

  test("unscoped: counts ACTIVE + listed places regardless of coordinates", async () => {
    await seedFixture();

    const repo = makePlacesRepo(prisma!);
    await expect(repo.countDirectory()).resolves.toBe(4);
    await expect(repo.countDirectory(undefined)).resolves.toBe(4);
    await expect(repo.countDirectory({})).resolves.toBe(4);
  });

  test("scoped: counts only ACTIVE + listed places with coords inside the radius", async () => {
    await seedFixture();

    const repo = makePlacesRepo(prisma!);
    await expect(
      repo.countDirectory({ near: { ...ORIGIN, radiusKm: 10 } }),
    ).resolves.toBe(2);
  });

  test("scoped: a wide radius reaches the far row but still never the unlisted / non-ACTIVE / null-coord ones", async () => {
    await seedFixture();

    const repo = makePlacesRepo(prisma!);
    await expect(
      repo.countDirectory({ near: { ...ORIGIN, radiusKm: 500 } }),
    ).resolves.toBe(3);
  });

  test("scoped: a venue that WITHHOLDS its address is never counted near anything (no presence oracle)", async () => {
    // A withheld house right at the probe point. The radius has no floor, so
    // counting it by its TRUE point would let a shrinking probe find it.
    await insertPlace({ coords: ORIGIN, locationMode: "OBSCURED" });
    await insertPlace({ coords: NEAR_A });

    const repo = makePlacesRepo(prisma!);
    await expect(
      repo.countDirectory({ near: { ...ORIGIN, radiusKm: 0.001 } }),
    ).resolves.toBe(0);
    await expect(
      repo.countDirectory({ near: { ...ORIGIN, radiusKm: 10 } }),
    ).resolves.toBe(1);
    // It is still a directory place — just not a pin.
    await expect(repo.countDirectory()).resolves.toBe(2);
  });

  test("returns a plain 0 (not a bigint or null) on an empty table", async () => {
    const repo = makePlacesRepo(prisma!);
    const unscoped = await repo.countDirectory();
    const scoped = await repo.countDirectory({
      near: { ...ORIGIN, radiusKm: 10 },
    });
    expect(unscoped).toBe(0);
    expect(scoped).toBe(0);
    expect(typeof scoped).toBe("number");
  });
});
