/**
 * Regression coverage for the last-ADMIN lockout guard's concurrency fix
 * (`admin-revoke-human-role.ts`).
 *
 * The core unit tests stub the repo, so they can only assert the *shape* of
 * the fix (lock called before the count-read). They can't prove the fix
 * actually serializes two concurrent transactions against real Postgres.
 * This test exercises the real Prisma adapter + a real advisory lock:
 *
 *  - two concurrent `adminRevokeHumanRole` calls target two DIFFERENT sole
 *    remaining ADMINs (the confirmed round-2 race — row-level locking can't
 *    help here since the two writes land on two different `Human` rows),
 *  - we deterministically force both calls to queue at
 *    `lockAdminRoleGuard()` (rather than relying on JS event-loop timing) by
 *    pre-acquiring the same advisory lock key from a held-open transaction,
 *  - once released, exactly one revoke must win and the other must lose with
 *    `CANNOT_DEMOTE_LAST_OWNER` — never both, which is the "zero ADMINs left"
 *    outage this guard exists to prevent.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { adminRevokeHumanRole } from "@th/core/use-cases/platform/admin-revoke-human-role";
import type { AdminRevokeHumanRoleDeps } from "@th/core/use-cases/platform/admin-revoke-human-role";
import type { ClockPort } from "@th/ports/clock";

import { createPrismaRepos } from "../../src/db/prisma";

const NOW = new Date("2026-07-01T12:00:00.000Z");

function makeFixedClock(now: Date): ClockPort {
  return { now: () => now };
}

function makeAllowAllStaffAuthz(): AdminRevokeHumanRoleDeps["authz"] {
  return { hasStaffRole: vi.fn(async () => ({ allowed: true })) };
}

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

/** Mirrors settlement-claim.test.ts's helper: polls pg_stat_activity until
 * `expectedWaiters` connections tagged with `applicationName` are blocked on
 * a lock, or every promise in `promises` has settled first. */
async function waitForApplicationLockWaitCount(
  prisma: PrismaClient,
  applicationName: string,
  promises: Promise<unknown>[],
  expectedWaiters: number,
): Promise<"waiting" | "settled" | "timed_out"> {
  let settledCount = 0;
  for (const p of promises) {
    void p.then(
      () => {
        settledCount += 1;
      },
      () => {
        settledCount += 1;
      },
    );
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (settledCount === promises.length) return "settled";

    const rows = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT COUNT(*)::int AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${applicationName}
        AND wait_event_type = 'Lock'
    `;
    if ((rows[0]?.waiting ?? 0) >= expectedWaiters) return "waiting";

    await delay(10);
  }

  return settledCount === promises.length ? "settled" : "timed_out";
}

describe("Prisma adapters integration – admin-revoke-human-role last-ADMIN race guard", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pgContainer = await startPostgresContainer();
      await runPrismaMigrateDeploy(pgContainer.databaseUrl);
      process.env.DATABASE_URL = pgContainer.databaseUrl;
      pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (err) {
      runtimeError = err as Error;
      console.error("[admin-role-guard-race.test] setup failed:", err);
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

  let testCounter = 0;
  beforeEach(async () => {
    testCounter += 1;
    if (!prisma) return;
    await prisma.$executeRawUnsafe(`TRUNCATE "Human" RESTART IDENTITY CASCADE`);
  }, 60_000);

  async function seedAdmins(count: number): Promise<string[]> {
    if (!prisma) throw new Error("prisma not ready");
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const human = await prisma.human.create({
        data: {
          name: `Admin ${testCounter}-${i}`,
          status: "ACTIVE",
          roles: ["ADMIN"],
        },
      });
      ids.push(human.id);
    }
    return ids;
  }

  test(
    "two concurrent revokes targeting two DIFFERENT sole-remaining ADMINs: exactly one wins, the loser gets CANNOT_DEMOTE_LAST_OWNER, never zero ADMINs left",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pgContainer) {
        skip();
        return;
      }

      const [adminA, adminB] = await seedAdmins(2);
      const applicationName = `admin-role-guard-${testCounter}`;

      const holderPool = new pg.Pool({
        connectionString: databaseUrlWithApplicationName(
          pgContainer.databaseUrl,
          applicationName,
        ),
      });
      const holderPrisma = new PrismaClient({ adapter: new PrismaPg(holderPool) });

      const workerPool = new pg.Pool({
        connectionString: databaseUrlWithApplicationName(
          pgContainer.databaseUrl,
          applicationName,
        ),
      });
      const workerPrisma = new PrismaClient({ adapter: new PrismaPg(workerPool) });
      const workerRepos = createPrismaRepos(workerPrisma);

      let releaseHold!: () => void;
      const mayRelease = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      let holdAcquired!: () => void;
      const holdIsAcquired = new Promise<void>((resolve) => {
        holdAcquired = resolve;
      });

      // Pre-acquire the SAME advisory lock key `lockAdminRoleGuard` uses,
      // from a separate held-open transaction, so both real
      // adminRevokeHumanRole calls below are forced to queue right at
      // `lockAdminRoleGuard()` instead of racing straight through to the
      // count-read on JS-event-loop timing luck.
      const holdingTx = holderPrisma.$transaction(
        async (tx) => {
          // $executeRaw, not $queryRaw — pg_advisory_xact_lock returns
          // Postgres `void`, which the driver-adapter's $queryRaw result
          // decoder can't deserialize (see the matching comment on
          // lockAdminRoleGuard in src/db/prisma/authz.ts).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform_admin_role_guard'))`;
          holdAcquired();
          await mayRelease;
        },
        { timeout: 10_000 },
      );

      const deps: AdminRevokeHumanRoleDeps = {
        repos: workerRepos,
        authz: makeAllowAllStaffAuthz(),
        clock: makeFixedClock(NOW),
      };

      let revokeAPromise: ReturnType<typeof adminRevokeHumanRole> | undefined;
      let revokeBPromise: ReturnType<typeof adminRevokeHumanRole> | undefined;

      try {
        await holdIsAcquired;

        revokeAPromise = adminRevokeHumanRole(deps, {
          actorHumanId: adminA,
          targetHumanId: adminA,
          role: "ADMIN",
        });
        revokeBPromise = adminRevokeHumanRole(deps, {
          actorHumanId: adminB,
          targetHumanId: adminB,
          role: "ADMIN",
        });

        await expect(
          waitForApplicationLockWaitCount(
            prisma,
            applicationName,
            [revokeAPromise, revokeBPromise],
            2,
          ),
        ).resolves.toBe("waiting");

        releaseHold();
        await holdingTx;

        const results = await Promise.allSettled([
          revokeAPromise,
          revokeBPromise,
        ]);

        const fulfilled = results.filter(
          (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof adminRevokeHumanRole>>> =>
            r.status === "fulfilled",
        );
        const rejected = results.filter(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );

        // The core assertion: never both succeed (that's the zero-ADMINs-left
        // outage) and never both fail (that would mean the guard is too
        // strict / broken in a different way).
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(fulfilled[0]?.value).toMatchObject({ revoked: true });
        expect(rejected[0]?.reason).toMatchObject({
          code: "CANNOT_DEMOTE_LAST_OWNER",
        });

        // The invariant the guard exists to protect, verified directly
        // against the database: exactly one ADMIN left, never zero.
        const remainingAdmins = await prisma!.human.findMany({
          where: { id: { in: [adminA, adminB] }, roles: { has: "ADMIN" } },
          select: { id: true },
        });
        expect(remainingAdmins).toHaveLength(1);
      } finally {
        releaseHold();
        await holdingTx.catch(() => undefined);
        await Promise.allSettled(
          [revokeAPromise, revokeBPromise].filter(
            (p): p is NonNullable<typeof p> => Boolean(p),
          ),
        );
        await workerPrisma.$disconnect();
        await workerPool.end();
        await holderPrisma.$disconnect();
        await holderPool.end();
      }
    },
    300_000,
  );
});
