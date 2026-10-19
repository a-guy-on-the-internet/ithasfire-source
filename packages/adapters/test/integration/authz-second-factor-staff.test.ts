import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import { SECOND_FACTOR_STAFF_ROLES } from "@th/ports/authz";

import { revokeSecondFactorStaffSessions } from "@th/core/use-cases/platform/revoke-second-factor-staff-sessions";

import { createPrismaRepos } from "../../src/db/prisma";
import { makeAuthZRepo } from "../../src/db/prisma/authz";
import { makeHumansRepo } from "../../src/db/prisma/humans";

/**
 * `AuthZRepo.listSecondFactorStaffAuthUsers` against real Postgres: the
 * selection of the one-time staff session sweep
 * (`revokeSecondFactorStaffSessions`). The join (Human.roles array ->
 * AuthUser -> Passkey / twoFactorEnabled, plus the session count) is the
 * whole point, so a stubbed repo cannot prove it.
 */
describe("Prisma adapters integration – authz.listSecondFactorStaffAuthUsers", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("authz-second-factor-staff integration setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  let counter = 0;
  async function account(opts: {
    roles: Array<"USER" | "ADMIN" | "SUPPORT" | "COMMUNITY_MODERATOR">;
    totp?: boolean;
    passkey?: boolean;
    sessions?: number;
  }): Promise<{ humanId: string; authUserId: string }> {
    if (!prisma) throw new Error("prisma not ready");
    counter += 1;
    const human = await prisma.human.create({
      data: { name: `Staff ${counter}`, status: "ACTIVE", roles: opts.roles },
    });
    const authUser = await prisma.authUser.create({
      data: {
        name: `Staff ${counter}`,
        email: `sf-staff-${counter}@example.test`,
        humanId: human.id,
        twoFactorEnabled: opts.totp ?? false,
      },
    });
    if (opts.passkey) {
      await prisma.passkey.create({
        data: {
          userId: authUser.id,
          publicKey: "pk",
          credentialID: `cred-${authUser.id}`,
          counter: 0,
          deviceType: "singleDevice",
          backedUp: false,
        },
      });
    }
    for (let i = 0; i < (opts.sessions ?? 0); i += 1) {
      await prisma.authSession.create({
        data: {
          userId: authUser.id,
          token: `tok-${authUser.id}-${i}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    }
    return { humanId: human.id, authUserId: authUser.id };
  }

  test("selects staff with a passkey or TOTP, with their session counts; skips staff with no factor and non-staff", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const passkeyAdmin = await account({
      roles: ["ADMIN"],
      passkey: true,
      sessions: 2,
    });
    const totpModerator = await account({
      roles: ["COMMUNITY_MODERATOR"],
      totp: true,
      sessions: 1,
    });
    const bothSupport = await account({
      roles: ["USER", "SUPPORT"],
      totp: true,
      passkey: true,
    });
    const noFactorAdmin = await account({ roles: ["ADMIN"], sessions: 1 });
    const passkeyUser = await account({
      roles: ["USER"],
      passkey: true,
      sessions: 1,
    });
    const nobody = await account({ roles: [], totp: true, sessions: 1 });

    const rows = await makeAuthZRepo(prisma).listSecondFactorStaffAuthUsers(
      SECOND_FACTOR_STAFF_ROLES,
    );
    const byHuman = new Map(rows.map((r) => [r.humanId, r]));

    expect(byHuman.get(passkeyAdmin.humanId)).toEqual({
      ...passkeyAdmin,
      sessionCount: 2,
    });
    expect(byHuman.get(totpModerator.humanId)).toEqual({
      ...totpModerator,
      sessionCount: 1,
    });
    expect(byHuman.get(bothSupport.humanId)).toEqual({
      ...bothSupport,
      sessionCount: 0,
    });
    expect(byHuman.has(noFactorAdmin.humanId)).toBe(false);
    expect(byHuman.has(passkeyUser.humanId)).toBe(false);
    expect(byHuman.has(nobody.humanId)).toBe(false);
    // One row per account even with a passkey AND TOTP.
    expect(rows.filter((r) => r.humanId === bothSupport.humanId)).toHaveLength(1);

    // The sweep's delete takes exactly that account's sessions.
    const { count } = await makeHumansRepo(
      prisma,
    ).invalidateSessionsForAuthUsers([passkeyAdmin.authUserId]);
    expect(count).toBe(2);
    expect(
      await prisma.authSession.count({
        where: { userId: noFactorAdmin.authUserId },
      }),
    ).toBe(1);
  });

  test("the sweep use case through the real repos: dry run writes nothing, apply signs every enrolled staff holder out with one audit row each", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    // Earlier tests left rows; clear sessions so the counts are this test's.
    await prisma.authSession.deleteMany({});
    const admin = await account({ roles: ["ADMIN"], passkey: true, sessions: 2 });
    const mod = await account({
      roles: ["COMMUNITY_MODERATOR"],
      totp: true,
      sessions: 1,
    });
    const buyer = await account({ roles: [], passkey: true, sessions: 1 });
    const deps = {
      repos: createPrismaRepos(prisma),
      clock: { now: () => new Date() },
    };

    const dry = await revokeSecondFactorStaffSessions(deps, { dryRun: true });
    expect(dry.sessionsFound).toBe(3);
    expect(dry.sessionsRevoked).toBe(0);
    expect(await prisma.authSession.count()).toBe(4);

    const applied = await revokeSecondFactorStaffSessions(deps, {
      dryRun: false,
    });
    expect(applied.sessionsRevoked).toBe(3);
    expect(
      await prisma.authSession.count({
        where: { userId: { in: [admin.authUserId, mod.authUserId] } },
      }),
    ).toBe(0);
    expect(
      await prisma.authSession.count({ where: { userId: buyer.authUserId } }),
    ).toBe(1);
    const audits = await prisma.auditLog.findMany({
      where: { action: "staff.sessions_revoked", entityId: admin.humanId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data).toMatchObject({
      authUserId: admin.authUserId,
      sessionsInvalidated: 2,
      source: "OPS_SCRIPT",
    });
  });

  test("an empty role list selects nobody", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    expect(await makeAuthZRepo(prisma).listSecondFactorStaffAuthUsers([])).toEqual(
      [],
    );
  });
});
