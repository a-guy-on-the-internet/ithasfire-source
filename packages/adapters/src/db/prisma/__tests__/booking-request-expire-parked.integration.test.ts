import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { expireParkedBookingRequests } from "@th/core/use-cases/booking-requests/expire-parked-booking-requests";
import type { Repos } from "@th/ports/repos";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { createPrismaRepos } from "../index";

// ---------------------------------------------------------------------------
// The 2026-09-25 amendment's cleanup on REAL Postgres (venue-confirmation
// spec, "no requests to unclaimed venues", step 3): `listOpenParked` reads
// only OPEN, stamped, TO_VENUE rows; `expireParked` flips one to EXPIRED and
// clears the stamp in ONE guarded statement (still open, still parked, no
// CONFIRMED hold), so a second run is a no-op. Driven through the use case so
// the ledger note and the audit row land on the real tables too.
//
// FK triggers on BookingRequest / BookingHold are disabled so fixtures need no
// Place / Calendar graph (same posture as booking-request-expiry).
// ---------------------------------------------------------------------------

const STAFF = "e2e2e2e2-0000-4000-8000-000000000001";
const PLACE = "e2e2e2e2-0000-4000-8000-0000000000f1";
const CALENDAR = "e2e2e2e2-0000-4000-8000-0000000000ca";
const PARKED_AT = "2026-09-20T12:00:00.000Z";

describe("expireParked / listOpenParked (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let repos: Repos;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.connectionUri });
    await pool.query(`ALTER TABLE "BookingRequest" DISABLE TRIGGER ALL`);
    await pool.query(`ALTER TABLE "BookingHold" DISABLE TRIGGER ALL`);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    repos = createPrismaRepos(prisma);
    await pool.query(
      `INSERT INTO "Human" ("id", "updatedAt") VALUES ($1, '2026-09-01T00:00:00.000Z')
       ON CONFLICT ("id") DO NOTHING`,
      [STAFF],
    );
  }, 600_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  beforeEach(async () => {
    await pool!.query(`TRUNCATE "BookingHold", "BookingRequestMessage" CASCADE`);
    await pool!.query(`DELETE FROM "BookingRequest"`);
  });

  /** A TO_VENUE request; `parkedAt: null` = never parked. */
  async function request(opts: {
    status: "PENDING" | "VIEWED" | "WITHDRAWN" | "EXPIRED";
    parkedAt: string | null;
    hold?: "ACTIVE" | "CONFIRMED";
  }) {
    const id = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO "BookingRequest"
         ("id", "placeId", "calendarId", "performerOwnerType", "performerOwnerId",
          "message", "status", "parkedUnclaimedAt", "updatedAt")
       VALUES ($1, $2, $3, 'human', $4, 'pitch', $5::"BookingRequestStatus", $6, '2026-09-20T12:00:00.000Z')`,
      [id, PLACE, CALENDAR, crypto.randomUUID(), opts.status, opts.parkedAt],
    );
    if (opts.hold) {
      await pool!.query(
        `INSERT INTO "BookingHold"
           ("id", "bookingRequestId", "calendarId", "date", "position", "status",
            "placedByHumanId", "confirmedAt", "updatedAt")
         VALUES ($1, $2, $3, '2026-11-20'::date, 1, $4::"BookingHoldStatus", $5, $6, '2026-09-20T12:00:00.000Z')`,
        [
          crypto.randomUUID(),
          id,
          CALENDAR,
          opts.hold,
          STAFF,
          opts.hold === "CONFIRMED" ? "2026-09-21T09:30:00.000Z" : null,
        ],
      );
    }
    return id;
  }

  async function row(id: string) {
    const { rows } = await pool!.query<{
      status: string;
      parkedUnclaimedAt: Date | null;
    }>(`SELECT "status", "parkedUnclaimedAt" FROM "BookingRequest" WHERE "id" = $1`, [id]);
    return rows[0]!;
  }

  test("listOpenParked returns OPEN stamped rows only, oldest first", async () => {
    const pending = await request({ status: "PENDING", parkedAt: PARKED_AT });
    const viewed = await request({ status: "VIEWED", parkedAt: PARKED_AT });
    await request({ status: "WITHDRAWN", parkedAt: PARKED_AT });
    await request({ status: "PENDING", parkedAt: null });

    const listed = await repos.bookingRequests.listOpenParked({ limit: 10 });

    expect(listed.map((r) => r.id).sort()).toEqual([pending, viewed].sort());
    expect(listed.every((r) => r.parkedUnclaimedAt !== null)).toBe(true);
    expect(await repos.bookingRequests.listOpenParked({ limit: 1 })).toHaveLength(1);
  });

  test("expireParked flips + clears the stamp in one statement; a second call is a no-op", async () => {
    const id = await request({ status: "PENDING", parkedAt: PARKED_AT });

    const expired = await repos.tx(async (tx) => {
      await tx.bookingHolds.lockRequestBooking(id);
      return tx.bookingRequests.expireParked({ id });
    });

    expect(expired).toMatchObject({ id, status: "EXPIRED", parkedUnclaimedAt: null });
    expect(await row(id)).toEqual({ status: "EXPIRED", parkedUnclaimedAt: null });
    expect(await repos.bookingRequests.expireParked({ id })).toBeNull();
  });

  test("expireParked refuses a never-parked, a closed, and a BOOKED request", async () => {
    const neverParked = await request({ status: "PENDING", parkedAt: null });
    const closed = await request({ status: "WITHDRAWN", parkedAt: PARKED_AT });
    const booked = await request({ status: "PENDING", parkedAt: PARKED_AT, hold: "CONFIRMED" });

    for (const id of [neverParked, closed, booked]) {
      expect(await repos.bookingRequests.expireParked({ id })).toBeNull();
    }
    expect(await row(booked)).toMatchObject({ status: "PENDING" });
    expect((await row(closed)).parkedUnclaimedAt).not.toBeNull();
  });

  test("the use case end to end: EXPIRED, stamp gone, live hold released, ONE note, audited; idempotent", async () => {
    const id = await request({ status: "PENDING", parkedAt: PARKED_AT, hold: "ACTIVE" });
    const deps = { repos, clock: { now: () => new Date("2026-10-02T12:00:00.000Z") } };

    const dry = await expireParkedBookingRequests(deps, { dryRun: true });
    expect(dry.candidates.map((c) => [c.bookingRequestId, c.outcome])).toEqual([
      [id, "would_expire"],
    ]);
    expect(await row(id)).toMatchObject({ status: "PENDING" });

    const first = await expireParkedBookingRequests(deps, { dryRun: false });
    expect(first.expiredCount).toBe(1);
    expect(await row(id)).toEqual({ status: "EXPIRED", parkedUnclaimedAt: null });

    const { rows: holds } = await pool!.query<{ status: string }>(
      `SELECT "status" FROM "BookingHold" WHERE "bookingRequestId" = $1`,
      [id],
    );
    expect(holds.map((h) => h.status)).toEqual(["RELEASED"]);

    const { rows: notes } = await pool!.query<{
      systemKind: string;
      systemData: unknown;
      authorSide: string;
    }>(
      `SELECT "systemKind", "systemData", "authorSide" FROM "BookingRequestMessage"
        WHERE "bookingRequestId" = $1 AND "systemKind" IS NOT NULL`,
      [id],
    );
    // The hold release writes its own `booking_hold.released`; the request
    // gets exactly ONE expiry note, the amendment's.
    expect(notes.filter((n) => n.systemKind.startsWith("booking_request."))).toEqual([
      {
        systemKind: "booking_request.expired_unclaimed",
        systemData: { placeName: null },
        authorSide: "SYSTEM",
      },
    ]);

    const { rows: audits } = await pool!.query<{ action: string }>(
      `SELECT "action" FROM "AuditLog" WHERE "entityId" = $1 AND "action" = 'booking_request.expired_unclaimed'`,
      [id],
    );
    expect(audits).toHaveLength(1);

    const second = await expireParkedBookingRequests(deps, { dryRun: false });
    expect(second).toMatchObject({ candidates: [], expiredCount: 0 });
  });
});
