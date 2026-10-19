/**
 * Integration coverage for `countAcceptedOccupancy` in the volunteering
 * Prisma repo, against real Postgres.
 *
 * The capacity gate in volunteer-signups.ts (Gap 1 of the 2026-06-10
 * volunteer-system-gaps spec) relies on this method doing two things the
 * unit tests can't verify with a stubbed repo:
 *
 *  - The raw `SELECT id FROM "EventVolunteerShift" / "EventVolunteerRole"
 *    ... FOR UPDATE` actually targets the physical table (a typo or a
 *    future `@@map` would only blow up in production), and
 *  - the row lock genuinely serializes concurrent approval transactions,
 *    so two racing approvals can't both read a stale count and overshoot
 *    capacity.
 *
 * Serialization is proven two ways:
 *
 *  1. A true two-transaction race: tx A counts (taking the lock) and
 *     holds; tx B (on a second client with a distinct application_name)
 *     starts its count. We poll pg_stat_activity until B is observably
 *     blocked on a Lock wait — no sleeps, fully deterministic — assert B
 *     hasn't counted yet, release A, and assert B's count resolves only
 *     after A's insert committed and the role never exceeds capacity.
 *  2. A `FOR UPDATE NOWAIT` probe from a raw pg connection, asserting
 *     Postgres error 55P03 (lock_not_available) while the repo holds the
 *     lock — taken through BOTH lock targets (shift row and role row).
 *
 * Harness: same pattern as checkout-repos / settlement-claim — an
 * ephemeral database per suite (Testcontainers, or a throwaway database
 * created on a host Postgres when TESTCONTAINERS_REUSE_DATABASE_URL is
 * set), migrated via `prisma migrate deploy` and dropped in afterAll.
 * Fixtures never touch seeded dev data, and every test seeds its own
 * org/event/role/shift chain with unique ids, so reruns are safe. When
 * no database is reachable, setup fails and every test skips cleanly.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeVolunteeringRepo } from "../../src/db/prisma/volunteering";

const B_APP_NAME = "vol-occupancy-tx-b";

// ── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function databaseUrlWithApplicationName(
  databaseUrl: string,
  applicationName: string,
): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const uniqueEmail = () => `vol-${randomUUID()}@example.test`;

/**
 * Polls pg_stat_activity until the connection identified by
 * `applicationName` is blocked on a heavyweight Lock wait. Returns
 * "settled" if the watched promise finished first (i.e. it never blocked),
 * which the caller treats as a failed serialization guarantee.
 */
async function waitForLockWait(
  prisma: PrismaClient,
  applicationName: string,
  isSettled: () => boolean,
): Promise<"waiting" | "settled" | "timed_out"> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (isSettled()) return "settled";

    const rows = await prisma.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = ${applicationName}
          AND wait_event_type = 'Lock'
      ) AS waiting
    `;
    if (rows[0]?.waiting) return "waiting";

    await delay(10);
  }
  return isSettled() ? "settled" : "timed_out";
}

/**
 * Attempts `SELECT ... FOR UPDATE NOWAIT` on a single row from a raw pg
 * connection. Resolves to "acquired" when the lock was free, or the
 * Postgres SQLSTATE (e.g. "55P03" lock_not_available) when it wasn't.
 * The statement runs in its own implicit transaction, so any lock it
 * takes is released immediately.
 */
async function probeRowLockNowait(
  pool: pg.Pool,
  table: "EventVolunteerShift" | "EventVolunteerRole",
  id: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query(
      `SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE NOWAIT`,
      [id],
    );
    return "acquired";
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown_error";
  } finally {
    client.release();
  }
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Prisma volunteering repo integration – countAcceptedOccupancy", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let poolB: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  /** Second client with a distinct application_name so pg_stat_activity can see its lock waits. */
  let prismaB: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pgContainer = await startPostgresContainer();
      await runPrismaMigrateDeploy(pgContainer.databaseUrl);
      process.env.DATABASE_URL = pgContainer.databaseUrl;

      pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      poolB = new pg.Pool({
        connectionString: databaseUrlWithApplicationName(
          pgContainer.databaseUrl,
          B_APP_NAME,
        ),
      });
      prismaB = new PrismaClient({ adapter: new PrismaPg(poolB) });
    } catch (err) {
      runtimeError = err as Error;
      console.error("[volunteering-occupancy.test] setup failed:", err);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (prismaB) await prismaB.$disconnect();
    if (pool) await pool.end();
    if (poolB) await poolB.end();
    // Drops the ephemeral database (or stops the container) — all fixture
    // rows go with it, so nothing leaks between runs.
    if (pgContainer) await pgContainer.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  /** Minimal FK chain: Organization → Event → EventVolunteerRole → EventVolunteerShift. */
  async function seedRoleAndShift(
    db: PrismaClient,
    opts?: { roleCapacity?: number | null; shiftCapacity?: number | null },
  ) {
    const tag = randomUUID().slice(0, 8);
    const org = await db.organization.create({
      data: {
        name: `Vol Occupancy Org ${tag}`,
        slug: `vol-occupancy-org-${tag}`,
        status: "ACTIVE",
      },
    });
    const event = await db.event.create({
      data: {
        orgId: org.id,
        title: `Vol Occupancy Event ${tag}`,
        startsAt: new Date("2027-01-01T20:00:00Z"),
        endsAt: new Date("2027-01-01T23:00:00Z"),
        status: "PUBLISHED",
        volunteeringEnabled: true,
      },
    });
    const role = await db.eventVolunteerRole.create({
      data: {
        eventId: event.id,
        name: `Role ${tag}`,
        capacity: opts?.roleCapacity ?? null,
      },
    });
    const shift = await db.eventVolunteerShift.create({
      data: {
        roleId: role.id,
        label: "Main shift",
        startsAt: new Date("2027-01-01T19:00:00Z"),
        endsAt: new Date("2027-01-01T22:00:00Z"),
        capacity: opts?.shiftCapacity ?? null,
      },
    });
    return {
      orgId: org.id,
      eventId: event.id,
      roleId: role.id,
      shiftId: shift.id,
    };
  }

  async function createSignupRow(
    db: PrismaClient,
    args: {
      eventId: string;
      roleId: string;
      shiftId?: string | null;
      status: "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "CHECKED_IN" | "NO_SHOW";
    },
  ) {
    return db.volunteerSignup.create({
      data: {
        eventId: args.eventId,
        roleId: args.roleId,
        shiftId: args.shiftId ?? null,
        contactEmail: uniqueEmail(),
        status: args.status,
      },
    });
  }

  test(
    "shift branch counts only APPROVED + CHECKED_IN on that shift",
    async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }
      const fx = await seedRoleAndShift(prisma, { shiftCapacity: 2 });

      // On the target shift: one of each status that matters.
      await createSignupRow(prisma, { ...fx, status: "APPROVED" });
      await createSignupRow(prisma, { ...fx, status: "PENDING" });
      await createSignupRow(prisma, { ...fx, status: "CHECKED_IN" });
      await createSignupRow(prisma, { ...fx, status: "REJECTED" });

      // Accepted signup on a *different* shift of the same role — must not
      // leak into the shift-scoped count.
      const otherShift = await prisma.eventVolunteerShift.create({
        data: {
          roleId: fx.roleId,
          startsAt: new Date("2027-01-02T19:00:00Z"),
          endsAt: new Date("2027-01-02T22:00:00Z"),
        },
      });
      await createSignupRow(prisma, {
        eventId: fx.eventId,
        roleId: fx.roleId,
        shiftId: otherShift.id,
        status: "APPROVED",
      });

      const count = await prisma.$transaction(async (tx) =>
        makeVolunteeringRepo(tx).countAcceptedOccupancy({
          shiftId: fx.shiftId,
        }),
      );

      // APPROVED + CHECKED_IN on the target shift; PENDING/REJECTED and the
      // other shift's signup excluded.
      expect(count).toBe(2);
    },
    300_000,
  );

  test(
    "role branch counts accepted signups with and without a shift",
    async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }
      const fx = await seedRoleAndShift(prisma, { roleCapacity: 5 });

      // Accepted, pinned to a shift.
      await createSignupRow(prisma, { ...fx, status: "APPROVED" });
      // Accepted, general role signup (no shift).
      await createSignupRow(prisma, {
        eventId: fx.eventId,
        roleId: fx.roleId,
        shiftId: null,
        status: "APPROVED",
      });
      await createSignupRow(prisma, {
        eventId: fx.eventId,
        roleId: fx.roleId,
        shiftId: null,
        status: "CHECKED_IN",
      });
      // Non-accepted statuses must be excluded.
      await createSignupRow(prisma, { ...fx, status: "PENDING" });
      await createSignupRow(prisma, {
        eventId: fx.eventId,
        roleId: fx.roleId,
        shiftId: null,
        status: "WITHDRAWN",
      });

      const count = await prisma.$transaction(async (tx) =>
        makeVolunteeringRepo(tx).countAcceptedOccupancy({ roleId: fx.roleId }),
      );

      expect(count).toBe(3);
    },
    300_000,
  );

  test(
    "concurrent approval transactions serialize on the shift row lock",
    async ({ skip }) => {
      if (runtimeError || !prisma || !prismaB) {
        skip();
        return;
      }
      const capacity = 1;
      const fx = await seedRoleAndShift(prisma, { shiftCapacity: capacity });

      const events: string[] = [];
      const gateA = deferred(); // released by the test once B is observed blocking
      const aCounted = deferred();

      // Tx A: count (takes the shift row lock), hold, then approve if under
      // capacity — mirroring what volunteer-signups.ts does inside repos.tx().
      const txA = prisma.$transaction(
        async (tx) => {
          const repo = makeVolunteeringRepo(tx);
          const count = await repo.countAcceptedOccupancy({
            shiftId: fx.shiftId,
          });
          events.push("A:counted");
          aCounted.resolve();
          await gateA.promise; // hold the lock across the race window
          if (count < capacity) {
            await repo.createSignup({
              eventId: fx.eventId,
              roleId: fx.roleId,
              shiftId: fx.shiftId,
              contactEmail: uniqueEmail(),
              status: "APPROVED",
            });
            events.push("A:created");
          }
        },
        { timeout: 30_000 },
      );

      await aCounted.promise;

      // Tx B: same flow on the second client. Its count must block on A's
      // row lock and only resolve after A commits.
      let bSettled = false;
      const txB = prismaB
        .$transaction(
          async (tx) => {
            const repo = makeVolunteeringRepo(tx);
            const count = await repo.countAcceptedOccupancy({
              shiftId: fx.shiftId,
            });
            events.push("B:counted");
            if (count < capacity) {
              await repo.createSignup({
                eventId: fx.eventId,
                roleId: fx.roleId,
                shiftId: fx.shiftId,
                contactEmail: uniqueEmail(),
                status: "APPROVED",
              });
              events.push("B:created");
            }
          },
          { timeout: 30_000 },
        )
        .finally(() => {
          bSettled = true;
        });

      // Deterministic wait: poll pg_stat_activity until B's connection shows
      // a heavyweight Lock wait (no sleeps, no timing guesses).
      const waitState = await waitForLockWait(
        prisma,
        B_APP_NAME,
        () => bSettled,
      );
      const bCountedWhileAHeldLock = events.includes("B:counted");

      gateA.resolve();
      await Promise.all([txA, txB]);

      // B observably blocked on the lock instead of racing past it…
      expect(waitState).toBe("waiting");
      // …and its count had not resolved while A held the lock.
      expect(bCountedWhileAHeldLock).toBe(false);

      // A won the race and filled the last slot; B re-counted after A's
      // commit, saw the shift full, and declined.
      expect(events).toContain("A:created");
      expect(events.indexOf("B:counted")).toBeGreaterThan(
        events.indexOf("A:created"),
      );
      expect(events).not.toContain("B:created");

      // Capacity invariant: accepted occupancy never exceeds capacity.
      const accepted = await prisma.volunteerSignup.count({
        where: {
          shiftId: fx.shiftId,
          status: { in: ["APPROVED", "CHECKED_IN"] },
        },
      });
      expect(accepted).toBe(capacity);
    },
    300_000,
  );

  test(
    "shift target holds FOR UPDATE on the EventVolunteerShift row",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pool) {
        skip();
        return;
      }
      const fx = await seedRoleAndShift(prisma, { shiftCapacity: 1 });

      const gate = deferred();
      const locked = deferred();
      const tx = prisma.$transaction(
        async (txClient) => {
          await makeVolunteeringRepo(txClient).countAcceptedOccupancy({
            shiftId: fx.shiftId,
          });
          locked.resolve();
          await gate.promise;
        },
        { timeout: 30_000 },
      );

      await locked.promise;
      const whileHeld = await probeRowLockNowait(
        pool,
        "EventVolunteerShift",
        fx.shiftId,
      );
      // The shift-target branch must NOT lock the role row.
      const roleRowWhileHeld = await probeRowLockNowait(
        pool,
        "EventVolunteerRole",
        fx.roleId,
      );
      gate.resolve();
      await tx;
      const afterCommit = await probeRowLockNowait(
        pool,
        "EventVolunteerShift",
        fx.shiftId,
      );

      expect(whileHeld).toBe("55P03"); // lock_not_available
      expect(roleRowWhileHeld).toBe("acquired");
      expect(afterCommit).toBe("acquired");
    },
    300_000,
  );

  test(
    "role target holds FOR UPDATE on the EventVolunteerRole row",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pool) {
        skip();
        return;
      }
      const fx = await seedRoleAndShift(prisma, { roleCapacity: 1 });

      const gate = deferred();
      const locked = deferred();
      const tx = prisma.$transaction(
        async (txClient) => {
          await makeVolunteeringRepo(txClient).countAcceptedOccupancy({
            roleId: fx.roleId,
          });
          locked.resolve();
          await gate.promise;
        },
        { timeout: 30_000 },
      );

      await locked.promise;
      const whileHeld = await probeRowLockNowait(
        pool,
        "EventVolunteerRole",
        fx.roleId,
      );
      gate.resolve();
      await tx;
      const afterCommit = await probeRowLockNowait(
        pool,
        "EventVolunteerRole",
        fx.roleId,
      );

      expect(whileHeld).toBe("55P03"); // lock_not_available
      expect(afterCommit).toBe("acquired");
    },
    300_000,
  );
});
