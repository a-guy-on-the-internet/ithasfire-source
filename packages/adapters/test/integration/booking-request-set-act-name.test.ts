/**
 * Real-Postgres coverage for `BookingRequestsRepo.setActName`
 * (lineup-booking-requests v3, FR-009 / NFR-002): the bill edit rewrites a
 * request's display `actName` when the sender goes on the bill and the name
 * had been defaulted from a by-name act.
 *
 * Pinned against the shipped migrations (`runPrismaMigrateDeploy`):
 *   - it writes the name, or clears it to null, and returns the full record;
 *   - it touches only that request;
 *   - a missing id throws `{ code: "not_found" }` (no Prisma P2025 leaks).
 */
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

describe("Prisma adapters integration – BookingRequest.setActName", () => {
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
      console.error("[booking-request-set-act-name.test] setup failed:", err);
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
  const createInput = (actName: string | null) => {
    ownerSeq += 1;
    return {
      placeId,
      performerOwnerType: "human" as const,
      performerOwnerId: `22222222-2222-4222-8222-${String(ownerSeq).padStart(12, "0")}`,
      message: "A three-band night.",
      preferredDates: ["2026-07-04"],
      expiresAt: FUTURE_EXPIRY,
      billRecorded: true,
      actName,
    };
  };

  test("writes and clears the name, scoped to the one request, returning the record", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeBookingRequestsRepo(prisma);
    const target = await repo.create(createInput("Junco"));
    const bystander = await repo.create(createInput("Junco"));

    const cleared = await repo.setActName({ id: target.id, actName: null });
    expect(cleared).toMatchObject({ id: target.id, actName: null, billRecorded: true });
    expect((await repo.getById(target.id))?.actName).toBeNull();
    expect((await repo.getById(bystander.id))?.actName).toBe("Junco");

    const renamed = await repo.setActName({ id: target.id, actName: "Paper Kite" });
    expect(renamed.actName).toBe("Paper Kite");
  }, 60_000);

  test("a missing request is a domain not_found, not a Prisma error", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeBookingRequestsRepo(prisma);
    await expect(
      repo.setActName({ id: "99999999-9999-4999-8999-999999999999", actName: null }),
    ).rejects.toMatchObject({ code: "not_found", message: "booking_request_not_found" });
  }, 60_000);
});
