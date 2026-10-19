/**
 * Real-Postgres coverage for `BookingRequest.billRecorded`
 * (lineup-booking-requests v3, L12; migration
 * 20261001130000_booking_request_bill_recorded).
 *
 * Pinned here, against the shipped migrations (`runPrismaMigrateDeploy` runs
 * every one, this included):
 *   - the column exists, NOT NULL, default false — an existing (pre-bill)
 *     row reads false;
 *   - the adapter writes the create input's flag and every read returns it;
 *   - the migration's backfill statement marks exactly the requests that have
 *     an act row (removed rows included) and nothing else.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeBookingRequestsRepo } from "../../src/db/prisma/booking-requests";

const FUTURE_EXPIRY = new Date("2027-01-01T00:00:00Z");
const MIGRATION_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../db/prisma/migrations/20261001130000_booking_request_bill_recorded/migration.sql",
  ),
  "utf8",
);

describe("Prisma adapters integration – BookingRequest.billRecorded", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;
  let placeId: string;

  beforeAll(async () => {
    try {
      pgContainer = await startPostgresContainer();
      await runPrismaMigrateDeploy(pgContainer.databaseUrl);
      process.env.DATABASE_URL = pgContainer.databaseUrl;
      pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      const place = await prisma.place.create({
        data: { name: "The Ember Room", address: "1 Fireside Ln" },
      });
      placeId = place.id;
    } catch (err) {
      runtimeError = err as Error;
      console.error("[booking-request-bill-recorded.test] setup failed:", err);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pgContainer) await pgContainer.stop();
  }, 60_000);

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  let ownerSeq = 0;
  const nextOwnerId = () => {
    ownerSeq += 1;
    return `11111111-1111-4111-8111-${String(ownerSeq).padStart(12, "0")}`;
  };
  const createInput = (billRecorded?: boolean) => ({
    placeId,
    performerOwnerType: "human" as const,
    performerOwnerId: nextOwnerId(),
    message: "We'd love to play your room.",
    preferredDates: ["2026-07-04"],
    expiresAt: FUTURE_EXPIRY,
    ...(billRecorded !== undefined ? { billRecorded } : {}),
  });

  test("the adapter writes the flag on create and every read returns it; omitted = false", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeBookingRequestsRepo(prisma);

    const recorded = await repo.create(createInput(true));
    const legacy = await repo.create(createInput());

    expect(recorded.billRecorded).toBe(true);
    expect(legacy.billRecorded).toBe(false);
    expect((await repo.getById(recorded.id))?.billRecorded).toBe(true);
    expect((await repo.getById(legacy.id))?.billRecorded).toBe(false);
  }, 60_000);

  test("the column is NOT NULL DEFAULT false", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const rows = await prisma.$queryRaw<
      Array<{ is_nullable: string; column_default: string | null }>
    >`SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'BookingRequest' AND column_name = 'billRecorded'`;
    expect(rows).toEqual([{ is_nullable: "NO", column_default: "false" }]);
  }, 60_000);

  test("the migration's backfill marks exactly the requests with an act row (removed rows included)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeBookingRequestsRepo(prisma);
    // Three rows as they stood before the migration: all false.
    const withLiveAct = await repo.create(createInput(false));
    const withRemovedAct = await repo.create(createInput(false));
    const withoutActs = await repo.create(createInput(false));
    await prisma.bookingRequestAct.create({
      data: {
        bookingRequestId: withLiveAct.id,
        source: "EXTERNAL",
        externalName: "The Openers",
        confirmation: "CONFIRMED",
      },
    });
    await prisma.bookingRequestAct.create({
      data: {
        bookingRequestId: withRemovedAct.id,
        source: "EXTERNAL",
        externalName: "Gone Act",
        confirmation: "CONFIRMED",
        removedAt: new Date("2026-06-01T00:00:00Z"),
      },
    });

    // The shipped statement, run as written (the ADD COLUMN already ran in
    // migrate deploy; only the UPDATE is re-run here).
    const update = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('UPDATE "BookingRequest"'));
    await prisma.$executeRawUnsafe(update);

    const flags = await prisma.bookingRequest.findMany({
      where: { id: { in: [withLiveAct.id, withRemovedAct.id, withoutActs.id] } },
      select: { id: true, billRecorded: true },
    });
    const byId = new Map(flags.map((row) => [row.id, row.billRecorded]));
    expect(byId.get(withLiveAct.id)).toBe(true);
    expect(byId.get(withRemovedAct.id)).toBe(true);
    expect(byId.get(withoutActs.id)).toBe(false);
  }, 60_000);
});
