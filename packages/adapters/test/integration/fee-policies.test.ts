import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeFeePoliciesRepo } from "../../src/db/prisma/fee-policies";
import type { UpsertFeePolicyInput } from "@th/ports/repos/fee-policies";

describe("Prisma adapters integration – fee-policies", () => {
  let pg: PostgresTestContainer | undefined;
  let prisma: PrismaClient | undefined;
  let pool: Pool | undefined;
  let runtimeError: Error | null = null;

  let actorHumanId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // Driver-adapter ("client" engine) mode — a bare `new PrismaClient()`
      // throws PrismaClientInitializationError. Constructed the way
      // packages/db/src/index.ts and the sibling integration suites do.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const human = await prisma.human.create({
        data: { name: "Fee Policy Tester", status: "ACTIVE" },
      });
      actorHumanId = human.id;
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

  function makeInput(
    overrides?: Partial<UpsertFeePolicyInput>,
  ): UpsertFeePolicyInput {
    return {
      scopeType: "GLOBAL",
      scopeId: null,
      buyerFeePct: 0.05,
      maxFeeCents: null,
      minFeeCents: 50,
      maxPlatformFeeCents: null,
      platformFixedCents: 100,
      feeMode: "PASS_THROUGH",
      processsorFeePct: 0.029,
      processorFixedCents: 30,
      payoutPct: 0.95,
      payoutFixedCents: 0,
      monthlyPayoutCents: 0,
      payoutMinimumCents: 500,
      actorHumanId,
      ...overrides,
    };
  }

  test("upsert creates a GLOBAL v1 policy, getById returns it", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeFeePoliciesRepo(prisma);

    const created = await repo.upsert(makeInput());

    expect(created.id).toBeTruthy();
    expect(created.scopeType).toBe("GLOBAL");
    expect(created.scopeId).toBeNull();
    expect(created.status).toBe("ACTIVE");
    expect(created.version).toBe(1);
    expect(created.buyerFeePct).toBeCloseTo(0.05);
    expect(created.minFeeCents).toBe(50);
    expect(created.platformFixedCents).toBe(100);
    expect(created.feeMode).toBe("PASS_THROUGH");
    expect(created.effectiveFrom).toBeInstanceOf(Date);
    expect(created.effectiveTo).toBeNull();

    const fetched = await repo.getById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.version).toBe(1);
  }, 60_000);

  test("upsert again bumps version and archives previous", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeFeePoliciesRepo(prisma);

    // First upsert (v1)
    const v1 = await repo.upsert(makeInput({ minFeeCents: 50 }));
    expect(v1.version).toBe(2); // already a v1 from previous test

    // Second upsert (v2)
    const v2 = await repo.upsert(makeInput({ minFeeCents: 75 }));
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.status).toBe("ACTIVE");
    expect(v2.minFeeCents).toBe(75);

    // Old policy should be archived
    const oldRecord = await repo.getById(v1.id);
    expect(oldRecord).not.toBeNull();
    expect(oldRecord!.status).toBe("ARCHIVED");
    expect(oldRecord!.effectiveTo).not.toBeNull();
  }, 60_000);

  test("resolveEffective returns latest active policy for a given date", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeFeePoliciesRepo(prisma);

    // Resolve at "now" should return the most recent ACTIVE global policy
    const effective = await repo.resolveEffective({
      scopeType: "GLOBAL",
      scopeId: null,
      at: new Date(),
    });

    expect(effective).not.toBeNull();
    expect(effective!.status).toBe("ACTIVE");
    expect(effective!.scopeType).toBe("GLOBAL");

    // Resolve at a date far in the past (before any policies) should return null
    const pastEffective = await repo.resolveEffective({
      scopeType: "GLOBAL",
      scopeId: null,
      at: new Date("2000-01-01T00:00:00Z"),
    });
    expect(pastEffective).toBeNull();
  }, 60_000);

  test("maxPlatformFeeCents is preserved as null vs a value", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeFeePoliciesRepo(prisma);

    // With null maxPlatformFeeCents
    const withNull = await repo.upsert(
      makeInput({ maxPlatformFeeCents: null }),
    );
    expect(withNull.maxPlatformFeeCents).toBeNull();

    // With a value
    const withValue = await repo.upsert(
      makeInput({ maxPlatformFeeCents: 2500 }),
    );
    expect(withValue.maxPlatformFeeCents).toBe(2500);

    const fetched = await repo.getById(withValue.id);
    expect(fetched!.maxPlatformFeeCents).toBe(2500);
  }, 60_000);
});
