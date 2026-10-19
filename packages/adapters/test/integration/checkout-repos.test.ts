import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { createPrismaRepos } from "../../src/db/prisma";

interface SeedData {
  buyerHumanId: string;
  eventId: string;
  ticketTypeId: string;
}

describe("Prisma adapters integration – checkout flow", () => {
  let pg: PostgresTestContainer | undefined;
  let prisma: PrismaClient | undefined;
  let pool: Pool | undefined;
  let seed: SeedData | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      // PrismaClientOptions typing can vary across Prisma versions; using env var
      // avoids relying on the presence of a typed `datasources` option.
      process.env.DATABASE_URL = pg.databaseUrl;
      // Driver-adapter ("client" engine) mode — a bare `new PrismaClient()`
      // throws PrismaClientInitializationError. Constructed the way
      // packages/db/src/index.ts and the sibling integration suites do.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      seed = await seedCheckoutPrerequisites(prisma);
    } catch (error) {
      runtimeError = error as Error;
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
    // Release the pool BEFORE stopping the container. `$disconnect()` does not
    // close a driver-adapter's pool, so a live connection outlives the server
    // and surfaces as an uncaught `57P01 terminating connection due to
    // administrator command` after the suite has already passed.
    if (pool) {
      await pool.end();
    }
    if (pg) {
      await pg.stop();
    }
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("orders repo persists lifecycle with real Postgres", async ({
    skip,
  }) => {
    if (runtimeError) {
      skip();
      return;
    }

    if (!prisma || !seed) {
      skip();
      return;
    }

    const repos = createPrismaRepos(prisma);

    const createResult = await repos.orders.createPending({
      eventId: seed.eventId,
      buyerHumanId: seed.buyerHumanId,
      amountGrossCents: 100_00,
      feesPlatformCents: 5_00,
      currency: "usd",
      source: "PRIMARY",
      stripePaymentIntentId: "pi_test_123",
      feePolicySnapshot: { version: 1 },
      checkoutIp: "203.0.113.9",
      items: [
        {
          kind: "ticket",
          ticketTypeId: seed.ticketTypeId,
          qty: 2,
          unitPriceCents: 5_000,
          amountCents: 10_000,
        },
      ],
    });

    expect(createResult.amountGrossCents).toBe(100_00);
    expect(createResult.currency).toBe("usd");

    const fetched = await repos.orders.getById(createResult.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.buyerHumanId).toBe(seed.buyerHumanId);
    expect(fetched?.items).toHaveLength(1);
    expect(fetched?.items[0]?.ticketTypeId).toBe(seed.ticketTypeId);
    expect(fetched?.stripePaymentIntentId).toBe("pi_test_123");
    expect(fetched?.checkoutIp).toBe("203.0.113.9");

    const byPi = await repos.orders.findByPaymentIntent("pi_test_123");
    expect(byPi).toEqual({ id: createResult.id, status: "PENDING" });

    await repos.orders.markSucceeded(createResult.id);
    const afterSuccess = await repos.orders.findByPaymentIntent("pi_test_123");
    expect(afterSuccess).toEqual({ id: createResult.id, status: "SUCCEEDED" });

    await repos.orders.markRefunded(createResult.id, 5_00);
    const afterRefund = await repos.orders.findByPaymentIntent("pi_test_123");
    expect(afterRefund).toEqual({
      id: createResult.id,
      status: "PART_REFUNDED",
    });
  }, 300_000);
});

async function seedCheckoutPrerequisites(
  prisma: PrismaClient,
): Promise<SeedData> {
  const buyer = await prisma.human.create({
    data: {
      name: "Buyer",
      status: "ACTIVE",
    },
  });

  const org = await prisma.organization.create({
    data: {
      name: "Integration Org",
      slug: "integration-org",
      status: "ACTIVE",
    },
  });

  await prisma.orgMember.create({
    data: {
      orgId: org.id,
      humanId: buyer.id,
      role: "OWNER",
    },
  });

  const payee = await prisma.payee.create({
    data: {
      subjectType: "ORGANIZATION",
      subjectId: org.id,
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
    },
  });

  const agreement = await prisma.payoutTerms.create({
    data: {
      kind: "PRIMARY",
      status: "ACTIVE",
      settlementCurrency: "usd",
      lines: {
        create: [
          {
            payeeId: payee.id,
            percent: 100,
            floorCents: 0,
            priority: 0,
          },
        ],
      },
    },
  });

  const event = await prisma.event.create({
    data: {
      orgId: org.id,
      payoutTermsId: agreement.id,
      title: "Integration Showcase",
      startsAt: new Date("2025-01-01T20:00:00Z"),
      endsAt: new Date("2025-01-01T22:00:00Z"),
      status: "PUBLISHED",
      defaultLocale: "en",
    },
  });

  const ticketType = await prisma.ticketType.create({
    data: {
      eventId: event.id,
      name: "General Admission",
      priceCents: 5_000,
      capacity: 100,
      status: "ACTIVE",
    },
  });

  return {
    buyerHumanId: buyer.id,
    eventId: event.id,
    ticketTypeId: ticketType.id,
  };
}
