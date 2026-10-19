import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

/**
 * Runs the `place_address_withholding` migration SQL against a REAL Postgres.
 *
 * Prisma's `validate` checks the schema files; it does not execute the
 * migration, and this one does three things `validate` cannot see:
 *
 *   1. adds a NOT NULL enum column to a populated table (the `DEFAULT 'EXACT'`
 *      is what makes that safe, and it is also the promise that EXISTING
 *      VENUES ARE UNCHANGED — pinned here against a row inserted BEFORE the
 *      migration ran, which is the only way to actually observe it);
 *   2. adds a CHECK constraint, which Prisma does not model at all and which
 *      therefore has no other test anywhere;
 *   3. `ALTER TYPE … ADD VALUE`, which has real transactional restrictions.
 *
 * The pre-migration DDL below is a MINIMAL mirror of only what the migration
 * touches — same approach as `places-count-directory.test.ts`.
 */

const PRE_MIGRATION_SQL = `
CREATE TYPE "EventLocationMode" AS ENUM ('EXACT', 'OBSCURED');
CREATE TYPE "AddressRevealPreset" AS ENUM (
  'IMMEDIATELY', 'ONE_HOUR_BEFORE', 'DAY_BEFORE', 'WEEK_BEFORE', 'CUSTOM'
);
CREATE TABLE "Place" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);
`;

const MIGRATION_SQL = readFileSync(
  path.join(
    __dirname,
    "../../../../../db/prisma/migrations/20260917120000_place_address_withholding/migration.sql",
  ),
  "utf8",
);

describe("migration: place address withholding", () => {
  let container: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    container = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: container.databaseUrl });
    await pool.query(PRE_MIGRATION_SQL);
    // A venue that existed BEFORE the migration. Everything below asks what
    // happened to IT.
    await pool.query(
      `INSERT INTO "Place" ("id", "name", "address")
       VALUES ('pre-existing', 'The Basement East', '917 Woodland St')`,
    );
    await pool.query(MIGRATION_SQL);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  test("leaves every pre-existing venue EXACT, with no backfill", async () => {
    const { rows } = await pool!.query(
      `SELECT "location_mode", "location_radius_meters", "location_label"
         FROM "Place" WHERE "id" = 'pre-existing'`,
    );
    expect(rows[0]).toEqual({
      location_mode: "EXACT",
      location_radius_meters: null,
      location_label: null,
    });
  });

  test("accepts a NULL radius — the fully-hidden sentinel", async () => {
    await expect(
      pool!.query(
        `INSERT INTO "Place" ("id","name","address","location_mode","location_radius_meters")
         VALUES ('house','The Shelby House','1417 Shelby Ave','OBSCURED',NULL)`,
      ),
    ).resolves.toBeDefined();
  });

  test("accepts an in-range circle radius", async () => {
    await expect(
      pool!.query(
        `INSERT INTO "Place" ("id","name","address","location_mode","location_radius_meters")
         VALUES ('circled','Circled','x','OBSCURED',1200)`,
      ),
    ).resolves.toBeDefined();
  });

  test.each([
    ["below the floor", 12],
    ["above the ceiling", 999_999],
  ])("REFUSES a radius %s at the DATA layer", async (_label, radius) => {
    // The zod bound in `upsertPlace` is the friendly gate; this is the one no
    // future writer can route around.
    await expect(
      pool!.query(
        `INSERT INTO "Place" ("id","name","address","location_radius_meters")
         VALUES ('bad-${radius}','Bad','x',${radius})`,
      ),
    ).rejects.toMatchObject({
      constraint: "place_location_radius_meters_range_check",
    });
  });

  test("adds NEVER to AddressRevealPreset without disturbing the existing members", async () => {
    const { rows } = await pool!.query(
      `SELECT enum_range(NULL::"AddressRevealPreset")::text AS members`,
    );
    expect(rows[0].members).toBe(
      "{IMMEDIATELY,ONE_HOUR_BEFORE,DAY_BEFORE,WEEK_BEFORE,CUSTOM,NEVER}",
    );
    await expect(
      pool!.query(`SELECT 'NEVER'::"AddressRevealPreset" AS v`),
    ).resolves.toBeDefined();
  });
});
