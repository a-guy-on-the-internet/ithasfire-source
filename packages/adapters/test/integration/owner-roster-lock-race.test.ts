/**
 * Regression coverage for the per-org owner roster lock
 * (`organizations.lockOwnerRoster` / `lockOwnerRostersForMember`).
 *
 * The core unit tests stub the repo, so they can only assert the *shape* of
 * the guard (lock called before the role reads, on the transaction's handle).
 * They can't prove two concurrent transactions actually serialize against
 * real Postgres. This test exercises the real Prisma adapter + a real
 * advisory lock:
 *
 *  - two OWNERs change the roster of the same org at once (demoting each
 *    other, or each demoting themselves), and
 *  - an ownership transfer runs against the deletion of the account it
 *    transfers to, in both arrival orders, and
 *  - an account is deleted while a new org naming it as the only OWNER is
 *    being created.
 *
 * Every case deterministically forces both calls to queue at the roster lock
 * (rather than relying on JS event-loop timing) by pre-acquiring the same
 * advisory lock key from a held-open transaction — the method
 * `admin-role-guard-race.test.ts` uses. Once released, the org must still
 * have an OWNER: an org with none cannot be repaired by any of its members.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { transferOrgOwnership } from "@th/core/use-cases/orgs/transfer-ownership";
import { updateMemberRole } from "@th/core/use-cases/orgs/update-member-role";
import { executeHumanDeletionTx } from "@th/core/use-cases/platform/_shared/delete-human-shared";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";

import { createDbAuthZAdapter } from "../../src/authz/db-authz-adapter";
import { createPrismaRepos } from "../../src/db/prisma";

const NOW = new Date("2026-07-01T12:00:00.000Z");

type OrgRole = "OWNER" | "ADMIN" | "EDITOR";

function makeFixedClock(now: Date): ClockPort {
  return { now: () => now };
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

/** Mirrors admin-role-guard-race.test.ts's helper: polls pg_stat_activity
 * until `expectedWaiters` connections tagged with `applicationName` are
 * blocked on a lock, or every promise in `promises` has settled first. */
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

describe("Prisma adapters integration – org owner roster lock", () => {
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
      console.error("[owner-roster-lock-race.test] setup failed:", err);
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
    // Cascades to OrgMember. Organization rows from earlier tests stay, so
    // each test's org gets its own slug.
    await prisma.$executeRawUnsafe(`TRUNCATE "Human" RESTART IDENTITY CASCADE`);
  }, 60_000);

  /** One org and its members, in the order given. Returns the ids. */
  async function seedOrg(
    roles: OrgRole[],
  ): Promise<{ orgId: string; humanIds: string[] }> {
    if (!prisma) throw new Error("prisma not ready");
    const org = await prisma.organization.create({
      data: {
        name: `Roster Org ${testCounter}`,
        slug: `roster-org-${testCounter}-${Date.now()}`,
        status: "ACTIVE",
      },
    });
    const humanIds: string[] = [];
    for (const [i, role] of roles.entries()) {
      const human = await prisma.human.create({
        data: { name: `Member ${testCounter}-${i}`, status: "ACTIVE" },
      });
      await prisma.orgMember.create({
        data: { orgId: org.id, humanId: human.id, role },
      });
      humanIds.push(human.id);
    }
    return { orgId: org.id, humanIds };
  }

  async function ownerIds(orgId: string): Promise<string[]> {
    const owners = await prisma!.orgMember.findMany({
      where: { orgId, role: "OWNER" },
      select: { humanId: true },
    });
    return owners.map((o) => o.humanId);
  }

  /**
   * Pre-acquire the SAME advisory lock key `lockOwnerRoster` uses for
   * `orgId`, from a separate held-open transaction, so the real use-case
   * calls a test starts are forced to queue right at the roster lock instead
   * of racing through on JS-event-loop timing luck.
   */
  function holdRosterLock(orgId: string) {
    const lockKey = `org_owner_roster:${orgId}`;
    return holdOpen(async (tx) => {
      // $executeRaw, not $queryRaw — pg_advisory_xact_lock returns
      // Postgres `void`, which the driver-adapter's $queryRaw result
      // decoder can't deserialize. Same statement and key as
      // lockOwnerRoster in src/db/prisma/organizations.ts.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    });
  }

  /**
   * Run `work` in a separate transaction and keep it open, holding whatever
   * locks `work` took, until `release` or `close`.
   *
   * Returns the worker repos to run the racing calls on, and the handles to
   * watch them queue, let them go, and close the connections.
   */
  async function holdOpen(
    work: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<{
    repos: Repos;
    authz: AuthZPort;
    waiters: (
      promises: Promise<unknown>[],
      expectedWaiters: number,
    ) => Promise<"waiting" | "settled" | "timed_out">;
    release: () => Promise<void>;
    close: (promises: Array<Promise<unknown> | undefined>) => Promise<void>;
  }> {
    if (!prisma || !pgContainer) throw new Error("prisma not ready");
    const applicationName = `owner-roster-lock-${testCounter}`;

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

    const holdingTx = holderPrisma.$transaction(
      async (tx) => {
        await work(tx);
        holdAcquired();
        await mayRelease;
      },
      { timeout: 10_000 },
    );

    const close = async (promises: Array<Promise<unknown> | undefined>) => {
      releaseHold();
      await holdingTx.catch(() => undefined);
      await Promise.allSettled(
        promises.filter((p): p is Promise<unknown> => Boolean(p)),
      );
      await workerPrisma.$disconnect();
      await workerPool.end();
      await holderPrisma.$disconnect();
      await holderPool.end();
    };

    try {
      // Fails instead of hanging if the hold transaction dies before it has
      // the lock.
      await Promise.race([
        holdIsAcquired,
        holdingTx.then(() => {
          throw new Error("the hold transaction ended before it was released");
        }),
      ]);
    } catch (err) {
      await close([]);
      throw err;
    }

    const mainPrisma = prisma;
    return {
      repos: workerRepos,
      // The real adapter over the real repos: the early role check reads the
      // same rows the transaction re-reads under the lock.
      authz: createDbAuthZAdapter({ repos: workerRepos }),
      waiters: (promises, expectedWaiters) =>
        waitForApplicationLockWaitCount(
          mainPrisma,
          applicationName,
          promises,
          expectedWaiters,
        ),
      release: async () => {
        releaseHold();
        await holdingTx;
      },
      close,
    };
  }

  test(
    "two OWNERs demoting each other at once: exactly one wins, the loser gets INSUFFICIENT_ROLE, one OWNER remains",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pgContainer) {
        skip();
        return;
      }

      const { orgId, humanIds } = await seedOrg(["OWNER", "OWNER"]);
      const [ownerA, ownerB] = humanIds as [string, string];
      const race = await holdRosterLock(orgId);
      const deps = {
        repos: race.repos,
        authz: race.authz,
        clock: makeFixedClock(NOW),
      };

      let demoteBPromise: ReturnType<typeof updateMemberRole> | undefined;
      let demoteAPromise: ReturnType<typeof updateMemberRole> | undefined;

      try {
        demoteBPromise = updateMemberRole(deps, {
          actorHumanId: ownerA,
          orgId,
          targetHumanId: ownerB,
          newRole: "ADMIN",
        });
        demoteAPromise = updateMemberRole(deps, {
          actorHumanId: ownerB,
          orgId,
          targetHumanId: ownerA,
          newRole: "ADMIN",
        });

        await expect(
          race.waiters([demoteBPromise, demoteAPromise], 2),
        ).resolves.toBe("waiting");

        await race.release();

        const results = await Promise.allSettled([
          demoteBPromise,
          demoteAPromise,
        ]);
        const fulfilled = results.filter(
          (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof updateMemberRole>>> =>
            r.status === "fulfilled",
        );
        const rejected = results.filter(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );

        // Never both (that is the org with no OWNER), never neither. The
        // loser re-reads its own row under the lock, finds it is an ADMIN
        // now, and may no longer touch an OWNER.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(fulfilled[0]?.value).toMatchObject({
          ok: true,
          previousRole: "OWNER",
        });
        expect(rejected[0]?.reason).toMatchObject({
          code: "INSUFFICIENT_ROLE",
        });

        const owners = await ownerIds(orgId);
        expect(owners).toHaveLength(1);
        expect([ownerA, ownerB]).toContain(owners[0]);
      } finally {
        await race.close([demoteBPromise, demoteAPromise]);
      }
    },
    300_000,
  );

  test(
    "two OWNERs each demoting themselves at once: exactly one wins, the loser gets CANNOT_DEMOTE_LAST_OWNER, one OWNER remains",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pgContainer) {
        skip();
        return;
      }

      const { orgId, humanIds } = await seedOrg(["OWNER", "OWNER"]);
      const [ownerA, ownerB] = humanIds as [string, string];
      const race = await holdRosterLock(orgId);
      const deps = {
        repos: race.repos,
        authz: race.authz,
        clock: makeFixedClock(NOW),
      };

      let stepDownAPromise: ReturnType<typeof updateMemberRole> | undefined;
      let stepDownBPromise: ReturnType<typeof updateMemberRole> | undefined;

      try {
        stepDownAPromise = updateMemberRole(deps, {
          actorHumanId: ownerA,
          orgId,
          targetHumanId: ownerA,
          newRole: "ADMIN",
        });
        stepDownBPromise = updateMemberRole(deps, {
          actorHumanId: ownerB,
          orgId,
          targetHumanId: ownerB,
          newRole: "ADMIN",
        });

        await expect(
          race.waiters([stepDownAPromise, stepDownBPromise], 2),
        ).resolves.toBe("waiting");

        await race.release();

        const results = await Promise.allSettled([
          stepDownAPromise,
          stepDownBPromise,
        ]);
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );

        // Two different rows are written, so row locks cannot serialize
        // these: without the roster lock both count two OWNERs and both
        // step down.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toMatchObject({
          code: "CANNOT_DEMOTE_LAST_OWNER",
        });

        expect(await ownerIds(orgId)).toHaveLength(1);
      } finally {
        await race.close([stepDownAPromise, stepDownBPromise]);
      }
    },
    300_000,
  );

  test(
    "ownership transfer queued ahead of the new owner's account deletion: the transfer wins, the deletion gets CANNOT_DELETE_SOLE_ORG_OWNER, the org keeps its OWNER",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pgContainer) {
        skip();
        return;
      }

      const { orgId, humanIds } = await seedOrg(["OWNER", "EDITOR"]);
      const [owner, editor] = humanIds as [string, string];
      const race = await holdRosterLock(orgId);

      let transferPromise: ReturnType<typeof transferOrgOwnership> | undefined;
      let deletePromise: ReturnType<typeof executeHumanDeletionTx> | undefined;

      try {
        transferPromise = transferOrgOwnership(
          { repos: race.repos, authz: race.authz, clock: makeFixedClock(NOW) },
          { actorHumanId: owner, orgId, targetHumanId: editor },
        );
        // The transfer is in the lock queue before the deletion starts, so
        // it is granted the lock first.
        await expect(race.waiters([transferPromise], 1)).resolves.toBe(
          "waiting",
        );

        // The deletion locks the roster of an org the human is only an
        // EDITOR of. If it did not, it would not queue here at all: it would
        // pass its sole-owner check on the pre-transfer rows and delete the
        // member the transfer is about to make the org's only OWNER.
        deletePromise = executeHumanDeletionTx(
          { repos: race.repos },
          {
            humanId: editor,
            actorHumanId: editor,
            actorKind: "self",
            deletedEmail: "editor@example.com",
            deletedName: "Member",
          },
        );
        await expect(
          race.waiters([transferPromise, deletePromise], 2),
        ).resolves.toBe("waiting");

        await race.release();

        const [transferResult, deleteResult] = await Promise.allSettled([
          transferPromise,
          deletePromise,
        ]);

        expect(transferResult).toMatchObject({
          status: "fulfilled",
          value: { ok: true, previousTargetRole: "EDITOR" },
        });
        expect(deleteResult).toMatchObject({
          status: "rejected",
          reason: { code: "CANNOT_DELETE_SOLE_ORG_OWNER" },
        });

        // The new owner still exists and is the org's one OWNER; the old
        // owner is an ADMIN.
        expect(await ownerIds(orgId)).toEqual([editor]);
        expect(
          await prisma!.human.findUnique({
            where: { id: editor },
            select: { id: true },
          }),
        ).toEqual({ id: editor });
        expect(
          await prisma!.orgMember.findUnique({
            where: { orgId_humanId: { orgId, humanId: owner } },
            select: { role: true },
          }),
        ).toEqual({ role: "ADMIN" });
      } finally {
        await race.close([transferPromise, deletePromise]);
      }
    },
    300_000,
  );

  test(
    "account deletion queued ahead of an ownership transfer to that account: the deletion wins, the transfer gets MEMBER_NOT_FOUND, the org keeps its OWNER",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pgContainer) {
        skip();
        return;
      }

      const { orgId, humanIds } = await seedOrg(["OWNER", "EDITOR"]);
      const [owner, editor] = humanIds as [string, string];
      const race = await holdRosterLock(orgId);

      let transferPromise: ReturnType<typeof transferOrgOwnership> | undefined;
      let deletePromise: ReturnType<typeof executeHumanDeletionTx> | undefined;

      try {
        deletePromise = executeHumanDeletionTx(
          { repos: race.repos },
          {
            humanId: editor,
            actorHumanId: editor,
            actorKind: "self",
            deletedEmail: "editor@example.com",
            deletedName: "Member",
          },
        );
        // The deletion is in the lock queue before the transfer starts, so
        // it is granted the lock first.
        await expect(race.waiters([deletePromise], 1)).resolves.toBe(
          "waiting",
        );

        transferPromise = transferOrgOwnership(
          { repos: race.repos, authz: race.authz, clock: makeFixedClock(NOW) },
          { actorHumanId: owner, orgId, targetHumanId: editor },
        );
        await expect(
          race.waiters([deletePromise, transferPromise], 2),
        ).resolves.toBe("waiting");

        await race.release();

        const [deleteResult, transferResult] = await Promise.allSettled([
          deletePromise,
          transferPromise,
        ]);

        expect(deleteResult).toMatchObject({ status: "fulfilled" });
        expect(transferResult).toMatchObject({
          status: "rejected",
          reason: { code: "MEMBER_NOT_FOUND" },
        });

        // The account is gone and the owner never stepped down.
        expect(
          await prisma!.human.findUnique({
            where: { id: editor },
            select: { id: true },
          }),
        ).toBeNull();
        expect(await ownerIds(orgId)).toEqual([owner]);
      } finally {
        await race.close([transferPromise, deletePromise]);
      }
    },
    300_000,
  );
  test(
    "account deletion while a new org naming that account its only OWNER is being created: the deletion waits for it, then gets CANNOT_DELETE_SOLE_ORG_OWNER, and the new org keeps its OWNER",
    async ({ skip }) => {
      if (runtimeError || !prisma || !pgContainer) {
        skip();
        return;
      }

      const human = await prisma.human.create({
        data: { name: `Creator ${testCounter}`, status: "ACTIVE" },
      });
      const newOrgSlug = `new-org-${testCounter}-${Date.now()}`;

      // What `createOrg` writes, left uncommitted: the org, and its creator
      // as its only OWNER. `createOrg` takes no roster lock, and the
      // deletion's first membership read cannot see this row. The insert's
      // foreign key holds FOR KEY SHARE on the creator's `Human` row.
      const race = await holdOpen(async (tx) => {
        const org = await tx.organization.create({
          data: { name: "Brand New Org", slug: newOrgSlug, status: "ACTIVE" },
        });
        await tx.orgMember.create({
          data: { orgId: org.id, humanId: human.id, role: "OWNER" },
        });
      });

      let deletePromise: ReturnType<typeof executeHumanDeletionTx> | undefined;

      try {
        deletePromise = executeHumanDeletionTx(
          { repos: race.repos },
          {
            humanId: human.id,
            actorHumanId: human.id,
            actorKind: "self",
            deletedEmail: "creator@example.com",
            deletedName: "Creator",
          },
        );
        // The deletion's row lock waits for the uncommitted membership. If
        // it took none, it would run on to its `DELETE`, wait there, and
        // after the org commits delete the creator, leaving it no OWNER.
        await expect(race.waiters([deletePromise], 1)).resolves.toBe(
          "waiting",
        );

        await race.release();

        const [deleteResult] = await Promise.allSettled([deletePromise]);
        expect(deleteResult).toMatchObject({
          status: "rejected",
          reason: { code: "CANNOT_DELETE_SOLE_ORG_OWNER" },
        });

        const newOrg = await prisma!.organization.findUniqueOrThrow({
          where: { slug: newOrgSlug },
          select: { id: true },
        });
        expect(await ownerIds(newOrg.id)).toEqual([human.id]);
      } finally {
        await race.close([deletePromise]);
      }
    },
    300_000,
  );
});
