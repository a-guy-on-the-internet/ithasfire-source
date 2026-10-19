/**
 * Real-Postgres coverage for `bookingRequests.countOpenByPlace`
 * (booking-inbox-placement FR-006).
 *
 * The mocked-Prisma test (src/db/prisma/__tests__/booking-requests-open-counts
 * .test.ts) pins the query SHAPE; this one proves the SQL actually behaves:
 *
 *   - `groupBy` genuinely aggregates per place and emits NO group for a place
 *     with zero open rows (the reason the use case must zero-fill — an
 *     absent group would otherwise silently become "no badge" vs "0"),
 *   - the open-status set really excludes terminal rows
 *     (EXPIRED/DECLINED/WITHDRAWN/ACCEPTED never inflate a badge),
 *   - the `direction: "TO_VENUE"` scope holds against a real TO_PERFORMER row
 *     (which carries a NULL placeId by CHECK constraint — the null group must
 *     never leak into the response),
 *   - counts AGREE with `listForPlace` over the same status set, which is the
 *     whole point of the endpoint (spec risk: "countOpen and the list views
 *     disagree").
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import { OPEN_BOOKING_REQUEST_STATUSES } from "@th/ports/repos/booking-requests";
import type { BookingRequestStatus } from "@th/ports/repos/booking-requests";

import { makeBookingRequestsRepo } from "../../src/db/prisma/booking-requests";

const FUTURE_EXPIRY = new Date("2027-01-01T00:00:00Z");

describe("Prisma adapters integration – booking-request open counts", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  /** Venue with open + terminal rows. */
  let busyPlaceId: string;
  /** Owned venue with NO open rows — the zero-fill case. */
  let quietPlaceId: string;
  /** Venue the org does NOT own — must never be counted when unrequested. */
  let foreignPlaceId: string;
  let organizerOrgId: string;

  beforeAll(async () => {
    try {
      pgContainer = await startPostgresContainer();
      await runPrismaMigrateDeploy(pgContainer.databaseUrl);
      process.env.DATABASE_URL = pgContainer.databaseUrl;
      // Driver-adapter ("client" engine) mode — a bare `new PrismaClient()`
      // throws; construct it the way packages/db/src/index.ts does.
      pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const [busy, quiet, foreign] = await Promise.all([
        prisma.place.create({
          data: { name: "The Ember Room", address: "1 Fireside Ln" },
        }),
        prisma.place.create({
          data: { name: "The Quiet Corner", address: "2 Fireside Ln" },
        }),
        prisma.place.create({
          data: { name: "Someone Else's Bar", address: "3 Fireside Ln" },
        }),
      ]);
      busyPlaceId = busy.id;
      quietPlaceId = quiet.id;
      foreignPlaceId = foreign.id;

      const org = await prisma.organization.create({
        data: { name: "Corner Booking Collective", slug: "corner-booking" },
      });
      organizerOrgId = org.id;
    } catch (err) {
      runtimeError = err as Error;
      console.error("[booking-requests-open-counts.test] setup failed:", err);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pgContainer) await pgContainer.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await prisma.bookingRequest.deleteMany({});
  }, 60_000);

  // A broken setup must never silently green the pipeline. The per-test
  // `skip()` guards below only soften LOCAL runs without Docker; in CI (where
  // a DB is guaranteed) a setup failure is real breakage and fails loudly
  // here. Without this the whole file reports "1 passed / 3 skipped" with zero
  // assertions run — which is exactly what happened on this file's first run,
  // when a missing `slug` broke seeding. Precedent:
  // community-blast-radius.test.ts:222-224.
  test("setup completed (loud-fail in CI)", () => {
    if (runtimeError && process.env.CI) throw runtimeError;
  });

  /** Fresh performer pair per row so the open-pair partial unique never trips. */
  let ownerSeq = 0;
  function nextOwnerId(): string {
    ownerSeq += 1;
    return `11111111-1111-4111-8111-${String(ownerSeq).padStart(12, "0")}`;
  }

  async function seedVenueRequest(
    placeId: string,
    status: BookingRequestStatus,
  ): Promise<void> {
    await prisma!.bookingRequest.create({
      data: {
        placeId,
        direction: "TO_VENUE",
        performerOwnerType: "human",
        performerOwnerId: nextOwnerId(),
        message: "We'd love to play your room.",
        preferredDates: ["2026-07-04"],
        expiresAt: FUTURE_EXPIRY,
        status,
      },
    });
  }

  test("groups open TO_VENUE rows per place, omitting places with none", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeBookingRequestsRepo(prisma);

    // 3 open at the busy place (mixed PENDING/VIEWED) + one of every terminal
    // status, which must NOT be counted.
    await seedVenueRequest(busyPlaceId, "PENDING");
    await seedVenueRequest(busyPlaceId, "PENDING");
    await seedVenueRequest(busyPlaceId, "VIEWED");
    for (const terminal of [
      "ACCEPTED",
      "DECLINED",
      "WITHDRAWN",
      "EXPIRED",
    ] as const) {
      await seedVenueRequest(busyPlaceId, terminal);
    }
    // The quiet place has only a terminal row — still zero OPEN.
    await seedVenueRequest(quietPlaceId, "DECLINED");
    // A foreign place with opens: not requested, so never returned.
    await seedVenueRequest(foreignPlaceId, "PENDING");

    const counts = await repo.countOpenByPlace({
      placeIds: [busyPlaceId, quietPlaceId],
      statuses: [...OPEN_BOOKING_REQUEST_STATUSES],
    });

    // groupBy emits NO group for the quiet place — the zero-fill contract.
    expect(counts).toEqual([{ placeId: busyPlaceId, openCount: 3 }]);

    // …and the count agrees with the list the badge summarizes.
    const listed = await repo.listForPlace({
      placeId: busyPlaceId,
      statuses: [...OPEN_BOOKING_REQUEST_STATUSES],
    });
    expect(listed).toHaveLength(3);
  });

  test("defaults to the open set and never counts a TO_PERFORMER row", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeBookingRequestsRepo(prisma);

    await seedVenueRequest(busyPlaceId, "PENDING");
    await seedVenueRequest(busyPlaceId, "ACCEPTED");
    // TO_PERFORMER row: placeId is NULL by CHECK constraint, so it forms the
    // null group the adapter drops.
    await prisma.bookingRequest.create({
      data: {
        direction: "TO_PERFORMER",
        placeId: null,
        organizerOrgId,
        performerOwnerType: "organization",
        performerOwnerId: nextOwnerId(),
        message: "Headline our Friday showcase?",
        preferredDates: ["2026-07-10"],
        expiresAt: FUTURE_EXPIRY,
        status: "PENDING",
      },
    });

    // No `statuses` argument — the adapter must fall back to PENDING|VIEWED.
    const counts = await repo.countOpenByPlace({ placeIds: [busyPlaceId] });

    expect(counts).toEqual([{ placeId: busyPlaceId, openCount: 1 }]);
  });

  test("an empty placeIds set resolves to [] without querying", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeBookingRequestsRepo(prisma);
    await expect(repo.countOpenByPlace({ placeIds: [] })).resolves.toEqual([]);
  });
});
