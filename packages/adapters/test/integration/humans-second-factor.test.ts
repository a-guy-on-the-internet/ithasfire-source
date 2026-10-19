import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeHumansRepo } from "../../src/db/prisma/humans";

/**
 * Coverage for `HumansRepo.hasSecondFactorEnrolled` — backs the platform/
 * moderation staff step-up 2FA gate (`packages/transport/trpc/src/guard.ts`).
 * Exercises the REAL join across `Human` -> `AuthUser` -> `Passkey` /
 * `AuthTwoFactor` against real Postgres (this exact join is the whole point
 * of the adapter method — a stubbed-repo unit test can't prove it).
 */
describe("Prisma adapters integration – humans.hasSecondFactorEnrolled", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      // The repo's Prisma client runs in driver-adapter ("client" engine)
      // mode, so a bare `new PrismaClient()` throws — construct it the way
      // packages/db/src/index.ts does, with a pg Pool adapter.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("humans-second-factor integration setup failed:", error);
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

  let testCounter = 0;
  async function makeHumanWithAuthUser(opts?: {
    humanId?: string;
  }): Promise<{ humanId: string; authUserId: string }> {
    if (!prisma) throw new Error("prisma not ready");
    testCounter += 1;
    const human = await prisma.human.create({
      data: { name: `2FA Tester ${testCounter}`, status: "ACTIVE" },
    });
    const authUser = await prisma.authUser.create({
      data: {
        name: `2FA Tester ${testCounter}`,
        email: `2fa-tester-${testCounter}@example.test`,
        humanId: opts?.humanId ?? human.id,
      },
    });
    return { humanId: human.id, authUserId: authUser.id };
  }

  test("returns false when there is no linked AuthUser at all", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeHumansRepo(prisma);
    const human = await prisma.human.create({
      data: { name: "No AuthUser", status: "ACTIVE" },
    });

    expect(await repo.hasSecondFactorEnrolled(human.id)).toBe(false);
  });

  test("returns false for a linked AuthUser with neither TOTP nor a passkey", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeHumansRepo(prisma);
    const { humanId } = await makeHumanWithAuthUser();

    expect(await repo.hasSecondFactorEnrolled(humanId)).toBe(false);
  });

  test("returns true when AuthUser.twoFactorEnabled is set (TOTP)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeHumansRepo(prisma);
    const { humanId, authUserId } = await makeHumanWithAuthUser();

    await prisma.authUser.update({
      where: { id: authUserId },
      data: { twoFactorEnabled: true },
    });
    // Better Auth's own twoFactor plugin row — not required for the
    // adapter's read (it trusts `twoFactorEnabled` directly, mirroring
    // `customSession`), but included so the fixture reflects a real enrolled
    // account end-to-end.
    await prisma.authTwoFactor.create({
      data: { userId: authUserId, secret: "totp-secret", backupCodes: "[]" },
    });

    expect(await repo.hasSecondFactorEnrolled(humanId)).toBe(true);
  });

  test("returns true when the AuthUser has an enrolled passkey (no TOTP)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeHumansRepo(prisma);
    const { humanId, authUserId } = await makeHumanWithAuthUser();

    await prisma.passkey.create({
      data: {
        userId: authUserId,
        publicKey: "public-key-bytes",
        credentialID: `cred-${authUserId}`,
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      },
    });

    expect(await repo.hasSecondFactorEnrolled(humanId)).toBe(true);
  });

  test("does not leak another human's second-factor enrollment", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeHumansRepo(prisma);
    const enrolled = await makeHumanWithAuthUser();
    const notEnrolled = await makeHumanWithAuthUser();

    await prisma.authUser.update({
      where: { id: enrolled.authUserId },
      data: { twoFactorEnabled: true },
    });

    expect(await repo.hasSecondFactorEnrolled(enrolled.humanId)).toBe(true);
    expect(await repo.hasSecondFactorEnrolled(notEnrolled.humanId)).toBe(
      false,
    );
  });
});
