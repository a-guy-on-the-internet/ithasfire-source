import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { expireBookingRequests } from "@th/core/use-cases/booking-requests/expire-booking-requests";
import type { Repos } from "@th/ports/repos";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { createPrismaRepos } from "../index";

// ---------------------------------------------------------------------------
// booking-the-night P2c, review round 3 (B1) + P2d-2 (carry a) on REAL
// Postgres: the expiry sweep never expires an open request whose night is
// BOOKED (a CONFIRMED hold — an event-first request a venue confirm booked
// before anyone answered it). Expiry only releases LIVE holds, so sweeping
// such a request would strand its CONFIRMED hold on an EXPIRED request that
// Cancel booking refuses and Withdraw / Decline no longer reach. It stays
// open until Cancel booking (W5).
//
// The filter is a RELATION filter (`holds: { none: { status: "CONFIRMED" } }`)
// on the candidate read (`listExpiryCandidates`) and on the guarded per-request
// flip (`expireIfDue`) — pinned here THROUGH THE PORT on the real planner.
// On its own it is not enough under READ COMMITTED: it cannot see a confirm
// still in flight. The sweep therefore flips each request under its booking
// lock (`lockRequestBooking`), the lock every booking path takes before
// writing a CONFIRMED hold — the race test below holds a confirm open and
// watches the sweep wait for it, then leave the request open.
//
// FK triggers on BookingRequest and BookingHold are disabled so fixtures need
// no Place / Calendar graph.
// ---------------------------------------------------------------------------

const STAFF = "e1e1e1e1-0000-4000-8000-000000000001";
const PLACE = "e1e1e1e1-0000-4000-8000-0000000000f1";
const CALENDAR = "e1e1e1e1-0000-4000-8000-0000000000ca";
/** One CONFIRMED hold per (calendar, date) — `BookingHold_confirmed_line_key` — so each request books its own night. */
let nextNight = 20;
const freshNight = () => `2026-11-${String(nextNight++).padStart(2, "0")}`;
const PAST = "2026-10-01T00:00:00.000Z";
const FUTURE = "2026-12-01T00:00:00.000Z";
const CUTOFF = new Date("2026-11-01T12:00:00.000Z");

describe("expiry sweep vs a booked night — the CONFIRMED-hold filter (integration)", () => {
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
      `INSERT INTO "Human" ("id", "updatedAt") VALUES ($1, '2026-11-01T00:00:00.000Z')
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
    nextNight = 20;
  });

  /** An open request in `status` whose TTL ended at `expiresAt`, with holds in the given statuses on its own night. */
  async function request(opts: {
    status: "PENDING" | "VIEWED" | "ACCEPTED";
    expiresAt: string;
    holds: ReadonlyArray<"ACTIVE" | "CHALLENGED" | "CONFIRMED" | "RELEASED">;
  }) {
    const id = crypto.randomUUID();
    const night = freshNight();
    await pool!.query(
      `INSERT INTO "BookingRequest"
         ("id", "placeId", "calendarId", "performerOwnerType", "performerOwnerId",
          "message", "status", "expiresAt", "updatedAt")
       VALUES ($1, $2, $3, 'human', $4, 'pitch', $5::"BookingRequestStatus", $6, '2026-10-01T00:00:00.000Z')`,
      [id, PLACE, CALENDAR, crypto.randomUUID(), opts.status, opts.expiresAt],
    );
    const holdIds: string[] = [];
    let position = 1;
    for (const status of opts.holds) {
      const holdId = crypto.randomUUID();
      holdIds.push(holdId);
      await pool!.query(
        `INSERT INTO "BookingHold"
           ("id", "bookingRequestId", "calendarId", "date", "position", "status",
            "placedByHumanId", "confirmedAt", "releasedAt", "releasedReason", "updatedAt")
         VALUES ($1, $2, $3, $4::date, $5, $6::"BookingHoldStatus", $7, $8, $9, $10, '2026-10-01T00:00:00.000Z')`,
        [
          holdId,
          id,
          CALENDAR,
          night,
          position,
          status,
          STAFF,
          status === "CONFIRMED" ? "2026-10-15T09:30:00.000Z" : null,
          status === "RELEASED" ? "2026-10-16T09:30:00.000Z" : null,
          status === "RELEASED" ? "BOOKING_CANCELLED" : null,
        ],
      );
      position += 1;
    }
    return { id, holdIds };
  }

  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, opened };
  }

  /** Backends in this database waiting on a lock right now: advisory, and any kind. */
  async function lockWaits(): Promise<{ advisory: number; any: number }> {
    const { rows } = await pool!.query<{ advisory: number; any: number }>(
      `SELECT COUNT(*) FILTER (WHERE wait_event = 'advisory')::int AS advisory,
              COUNT(*)::int AS any
         FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    return rows[0]!;
  }

  async function waitUntil(check: () => Promise<boolean>, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timed out waiting for the sweep to block on a lock (or finish)");
  }

  const statusOf = async (id: string) =>
    (await pool!.query(`SELECT "status" FROM "BookingRequest" WHERE "id" = $1`, [id])).rows[0]
      ?.status as string;
  const holdStatusOf = async (id: string) =>
    (await pool!.query(`SELECT "status", "releasedReason" FROM "BookingHold" WHERE "id" = $1`, [id]))
      .rows[0] as { status: string; releasedReason: string | null };

  /** The sweep's per-request write, as the use case runs it: booking lock, then the guarded flip. */
  const expireUnderLock = (id: string) =>
    repos.tx(async (tx) => {
      await tx.bookingHolds.lockRequestBooking(id);
      return tx.bookingRequests.expireIfDue({ id, cutoff: CUTOFF });
    });

  test("adapter: candidates are the past-TTL open requests with no CONFIRMED hold; the guarded flip expires exactly those", async () => {
    const booked = await request({ status: "PENDING", expiresAt: PAST, holds: ["CONFIRMED"] });
    const bookedViewed = await request({ status: "VIEWED", expiresAt: PAST, holds: ["ACTIVE", "CONFIRMED"] });
    const unbooked = await request({ status: "PENDING", expiresAt: PAST, holds: ["ACTIVE"] });
    const noHolds = await request({ status: "VIEWED", expiresAt: PAST, holds: [] });
    const cancelled = await request({ status: "PENDING", expiresAt: PAST, holds: ["RELEASED"] });
    const future = await request({ status: "PENDING", expiresAt: FUTURE, holds: ["CONFIRMED"] });
    const accepted = await request({ status: "ACCEPTED", expiresAt: PAST, holds: ["CONFIRMED"] });

    const candidates = await repos.bookingRequests.listExpiryCandidates({ cutoff: CUTOFF, limit: 500 });
    expect([...candidates].sort()).toEqual([unbooked.id, noHolds.id, cancelled.id].sort());

    // The flip, run on EVERY row (not just the candidates): only those three move.
    const flipped: string[] = [];
    for (const row of [booked, bookedViewed, unbooked, noHolds, cancelled, future, accepted]) {
      const result = await expireUnderLock(row.id);
      if (result) {
        expect(result).toMatchObject({ id: row.id, status: "EXPIRED" });
        flipped.push(row.id);
      }
    }
    expect(flipped.sort()).toEqual([unbooked.id, noHolds.id, cancelled.id].sort());
    // The booked nights stay open, their CONFIRMED holds untouched.
    expect(await statusOf(booked.id)).toBe("PENDING");
    expect(await holdStatusOf(booked.holdIds[0]!)).toMatchObject({ status: "CONFIRMED" });
    expect(await statusOf(bookedViewed.id)).toBe("VIEWED");
    expect(await holdStatusOf(bookedViewed.holdIds[1]!)).toMatchObject({ status: "CONFIRMED" });
    // The rest: as before.
    expect(await statusOf(unbooked.id)).toBe("EXPIRED");
    expect(await statusOf(noHolds.id)).toBe("EXPIRED");
    // A RELEASED (cancelled-booking) hold is not a booked night: the open
    // request it left behind expires like any other.
    expect(await statusOf(cancelled.id)).toBe("EXPIRED");
    expect(await statusOf(future.id)).toBe("PENDING");
    expect(await statusOf(accepted.id)).toBe("ACCEPTED");
  }, 120_000);

  test("adapter: a night booked (committed) between the candidate read and the guarded flip is not clobbered — through the port", async () => {
    const racing = await request({ status: "PENDING", expiresAt: PAST, holds: ["ACTIVE"] });
    const candidates = await repos.bookingRequests.listExpiryCandidates({ cutoff: CUTOFF, limit: 500 });
    expect(candidates).toContain(racing.id);
    // The venue confirm lands after the candidate read.
    await pool!.query(
      `UPDATE "BookingHold" SET "status" = 'CONFIRMED', "confirmedAt" = '2026-10-15T09:30:00.000Z' WHERE "id" = $1`,
      [racing.holdIds[0]],
    );

    expect(await expireUnderLock(racing.id)).toBeNull();
    expect(await statusOf(racing.id)).toBe("PENDING");
  }, 120_000);

  // P2d-2 review nit: one run takes a bounded slice, OLDEST deadline first;
  // the rest drains on the next runs.
  test("adapter: candidates are capped by `limit`, oldest deadline first — a backlog drains over runs", async () => {
    const newest = await request({ status: "PENDING", expiresAt: "2026-10-20T00:00:00.000Z", holds: [] });
    const oldest = await request({ status: "PENDING", expiresAt: "2026-10-01T00:00:00.000Z", holds: [] });
    const middle = await request({ status: "VIEWED", expiresAt: "2026-10-10T00:00:00.000Z", holds: [] });

    const firstRun = await repos.bookingRequests.listExpiryCandidates({ cutoff: CUTOFF, limit: 2 });
    expect(firstRun).toEqual([oldest.id, middle.id]);
    for (const id of firstRun) await expireUnderLock(id);
    const secondRun = await repos.bookingRequests.listExpiryCandidates({ cutoff: CUTOFF, limit: 2 });
    expect(secondRun).toEqual([newest.id]);
  }, 120_000);

  test("adapter: the flip re-checks status and TTL too — answered, or not yet due, is never expired", async () => {
    const answered = await request({ status: "ACCEPTED", expiresAt: PAST, holds: [] });
    const notDue = await request({ status: "PENDING", expiresAt: FUTURE, holds: [] });
    expect(await expireUnderLock(answered.id)).toBeNull();
    expect(await expireUnderLock(notDue.id)).toBeNull();
    expect(await statusOf(answered.id)).toBe("ACCEPTED");
    expect(await statusOf(notDue.id)).toBe("PENDING");
  }, 120_000);

  // ── P2d-2 carry a: expiry vs a confirm still IN FLIGHT ──────────────────
  test("race: a venue confirm holds the request's booking lock with its CONFIRMED hold uncommitted → the sweep waits, then sees it and leaves the request open", async () => {
    const racing = await request({ status: "PENDING", expiresAt: PAST, holds: ["ACTIVE"] });

    const locked = gate();
    const commit = gate();
    // The confirm, as every booking path does it: booking lock FIRST, then
    // the CONFIRMED write — and it is still uncommitted while the sweep runs.
    const confirm = repos.tx(
      async (tx) => {
        await tx.bookingHolds.lockRequestBooking(racing.id);
        await tx.bookingHolds.updateStatus({
          id: racing.holdIds[0]!,
          status: "CONFIRMED",
          expectedFrom: ["ACTIVE"],
          confirmedAt: CUTOFF,
        });
        locked.open();
        await commit.opened;
      },
      { timeout: 30_000 },
    );
    await locked.opened;

    let sweepSettled = false;
    const sweep = expireBookingRequests({ repos, clock: { now: () => CUTOFF } }, {}).finally(() => {
      sweepSettled = true;
    });
    let waitedOnBookingLock = false;
    try {
      // The sweep must park on the confirm's BOOKING lock (an advisory wait).
      // Without that lock it would race ahead — flip the request, then park
      // on the hold's ROW lock in the release — so wait for either, and
      // record which.
      await waitUntil(async () => {
        const waits = await lockWaits();
        waitedOnBookingLock ||= waits.advisory > 0;
        return sweepSettled || waits.any > 0;
      });
    } finally {
      // Never leave the confirm open, whatever happened above.
      commit.open();
    }
    await confirm;
    const out = await sweep;

    // The outcome first (the bug this pins: an EXPIRED request stranding a
    // CONFIRMED hold), then how it was reached (the sweep waited on the
    // confirm's booking lock).
    expect(await statusOf(racing.id)).toBe("PENDING");
    expect(out.expiredCount).toBe(0);
    expect(await holdStatusOf(racing.holdIds[0]!)).toMatchObject({ status: "CONFIRMED", releasedReason: null });
    expect(waitedOnBookingLock).toBe(true);
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "BookingRequestMessage" WHERE "bookingRequestId" = $1`,
      [racing.id],
    );
    expect(rows[0]!.n).toBe(0);
  }, 120_000);

  test("use case: the sweep on real repos leaves the booked request open with its CONFIRMED hold, expires its unbooked twin and releases that twin's live hold", async () => {
    const booked = await request({ status: "PENDING", expiresAt: PAST, holds: ["CONFIRMED"] });
    const unbooked = await request({ status: "PENDING", expiresAt: PAST, holds: ["ACTIVE"] });

    const out = await expireBookingRequests(
      { repos, clock: { now: () => CUTOFF } },
      {},
    );

    expect(out.expiredCount).toBe(1);
    expect(await statusOf(booked.id)).toBe("PENDING");
    expect(await holdStatusOf(booked.holdIds[0]!)).toMatchObject({ status: "CONFIRMED", releasedReason: null });
    expect(await statusOf(unbooked.id)).toBe("EXPIRED");
    expect(await holdStatusOf(unbooked.holdIds[0]!)).toMatchObject({ status: "RELEASED", releasedReason: "REQUEST_CLOSED" });
  }, 120_000);
});
