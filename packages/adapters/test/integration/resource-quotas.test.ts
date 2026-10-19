import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeResourceQuotasRepo } from "../../src/db/prisma/resource-quotas";

describe("Prisma adapters integration – resource-quotas incrementUsage (zero-floor)", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // Prisma 7 requires a driver adapter (mirrors @th/db's construction).
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (error) {
      runtimeError = error as Error;
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

  test("insert path floors a negative initial delta at 0", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeResourceQuotasRepo(prisma);

    // No existing row → INSERT branch. A negative delta must clamp to 0.
    const row = await repo.incrementUsage({
      subjectType: "ORG",
      subjectId: "org-insert-neg",
      kind: "STORAGE_BYTES_ORG",
      delta: -500n,
    });

    expect(row.currentUsage).toBe(0n);
  });

  test("insert path stores a positive initial delta", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeResourceQuotasRepo(prisma);

    const row = await repo.incrementUsage({
      subjectType: "ORG",
      subjectId: "org-insert-pos",
      kind: "STORAGE_BYTES_ORG",
      delta: 1000n,
    });

    expect(row.currentUsage).toBe(1000n);
  });

  test("normal positive increment is unchanged (GREATEST is a no-op)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeResourceQuotasRepo(prisma);
    const subjectId = "human-incr-pos";

    await repo.incrementUsage({
      subjectType: "HUMAN",
      subjectId,
      kind: "STORAGE_BYTES_HUMAN",
      delta: 1000n,
    });
    const after = await repo.incrementUsage({
      subjectType: "HUMAN",
      subjectId,
      kind: "STORAGE_BYTES_HUMAN",
      delta: 500n,
    });

    expect(after.currentUsage).toBe(1500n);
  });

  test("a decrement that stays >= 0 subtracts exactly", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeResourceQuotasRepo(prisma);
    const subjectId = "org-decr-exact";

    await repo.incrementUsage({
      subjectType: "ORG",
      subjectId,
      kind: "STORAGE_BYTES_ORG",
      delta: 1000n,
    });
    const after = await repo.incrementUsage({
      subjectType: "ORG",
      subjectId,
      kind: "STORAGE_BYTES_ORG",
      delta: -300n,
    });

    expect(after.currentUsage).toBe(700n);
  });

  test("a decrement LARGER than current usage floors at 0 (never negative)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeResourceQuotasRepo(prisma);
    const subjectId = "org-decr-underflow";

    await repo.incrementUsage({
      subjectType: "ORG",
      subjectId,
      kind: "STORAGE_BYTES_ORG",
      delta: 200n,
    });
    const after = await repo.incrementUsage({
      subjectType: "ORG",
      subjectId,
      kind: "STORAGE_BYTES_ORG",
      delta: -9999n, // over-credit larger than the balance
    });

    // Clamped to 0, not -9799.
    expect(after.currentUsage).toBe(0n);

    // And it stays exactly 0 on a further over-credit (idempotent floor).
    const again = await repo.incrementUsage({
      subjectType: "ORG",
      subjectId,
      kind: "STORAGE_BYTES_ORG",
      delta: -100n,
    });
    expect(again.currentUsage).toBe(0n);
  });

  test("updatedAt is bumped on the update branch", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeResourceQuotasRepo(prisma);
    const subjectId = "org-updatedat";

    const first = await repo.incrementUsage({
      subjectType: "ORG",
      subjectId,
      kind: "STORAGE_BYTES_ORG",
      delta: 100n,
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await repo.incrementUsage({
      subjectType: "ORG",
      subjectId,
      kind: "STORAGE_BYTES_ORG",
      delta: 100n,
    });

    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(
      first.updatedAt.getTime(),
    );
    expect(second.currentUsage).toBe(200n);
  });

  // Moderator place page spec R5: a community moderator's page uploads are
  // held by the PLACE (QuotaSubjectType PLACE, STORAGE_BYTES_PLACE; migration
  // 20261016120000_place_storage_quota).
  test("a PLACE subject charges, credits and resolves the built-in default", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeResourceQuotasRepo(prisma);
    const subject = {
      subjectType: "PLACE" as const,
      subjectId: "place-quota-1",
      kind: "STORAGE_BYTES_PLACE" as const,
    };

    await repo.incrementUsage({ ...subject, delta: 5000n });
    const credited = await repo.incrementUsage({ ...subject, delta: -1200n });
    expect(credited.subjectType).toBe("PLACE");
    expect(credited.currentUsage).toBe(3800n);

    const quota = await repo.getEffectiveQuota(subject);
    expect(quota.currentUsage).toBe(3800n);
    expect(quota.limitValue).toBe(536_870_912n);

    // A human with the same id is a different ledger.
    const human = await repo.getUsage({
      subjectType: "HUMAN",
      subjectId: "place-quota-1",
      kind: "STORAGE_BYTES_HUMAN",
    });
    expect(human).toBeNull();
  });
});
