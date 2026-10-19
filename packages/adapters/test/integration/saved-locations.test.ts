import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeSavedLocationsRepo } from "../../src/db/prisma/saved-locations";

describe("Prisma adapters integration – saved-locations", () => {
  let pg: PostgresTestContainer | undefined;
  let prisma: PrismaClient | undefined;
  let pool: Pool | undefined;
  let runtimeError: Error | null = null;

  let orgId: string;
  let humanId: string;

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

      // Seed prerequisite records
      const human = await prisma.human.create({
        data: { name: "Location Tester", status: "ACTIVE" },
      });
      humanId = human.id;

      const org = await prisma.organization.create({
        data: { name: "Loc Org", slug: "loc-org", status: "ACTIVE" },
      });
      orgId = org.id;

      await prisma.orgMember.create({
        data: { orgId: org.id, humanId: human.id, role: "OWNER" },
      });
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

  test("create + getById round-trip", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeSavedLocationsRepo(prisma);

    const created = await repo.create({
      name: "HQ",
      address: "123 Main St",
      countryCode: "US",
      region: "TX",
      locality: "Austin",
      postalCode: "78701",
      lat: 30.27,
      lng: -97.74,
      ownerType: "ORGANIZATION",
      ownerId: orgId,
    });

    expect(created.id).toBeTruthy();
    expect(created.name).toBe("HQ");
    expect(created.address).toBe("123 Main St");
    expect(created.countryCode).toBe("US");
    expect(created.usageCount).toBe(1);
    expect(created.admissionTaxRateBps).toBeNull();

    const fetched = await repo.getById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("HQ");
    expect(fetched!.lat).toBeCloseTo(30.27, 2);
  }, 60_000);

  test("findByOwnerAndAddress dedup (case-insensitive)", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeSavedLocationsRepo(prisma);

    await repo.create({
      name: "Dedup Venue",
      address: "456 Oak Ave",
      countryCode: null,
      region: null,
      locality: null,
      postalCode: null,
      lat: null,
      lng: null,
      ownerType: "HUMAN",
      ownerId: humanId,
    });

    const found = await repo.findByOwnerAndAddress({
      ownerType: "HUMAN",
      ownerId: humanId,
      address: "  456 OAK AVE  ",
    });
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Dedup Venue");

    const notFound = await repo.findByOwnerAndAddress({
      ownerType: "HUMAN",
      ownerId: humanId,
      address: "789 Elm St",
    });
    expect(notFound).toBeNull();
  }, 60_000);

  test("updateTaxRate persists and updates admissionTaxRateBps", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeSavedLocationsRepo(prisma);

    const created = await repo.create({
      name: "Tax Venue",
      address: "789 Elm St",
      ownerType: "ORGANIZATION",
      ownerId: orgId,
      postalCode: "78701",
      countryCode: "US",
      region: null,
      locality: null,
      lat: null,
      lng: null,
    });

    expect(created.admissionTaxRateBps).toBeNull();

    const fetchedAt = new Date("2026-03-01T12:00:00Z");
    await repo.updateTaxRate({
      id: created.id,
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
      taxRateFetchedAt: fetchedAt,
    });

    const after = await repo.getById(created.id);
    expect(after).not.toBeNull();
    expect(after!.admissionTaxRateBps).toBe(825);
    expect(after!.taxRateSource).toBe("ziptax");

    // Update again with a different rate
    await repo.updateTaxRate({
      id: created.id,
      admissionTaxRateBps: 900,
      taxRateSource: "manual",
      taxRateFetchedAt: new Date("2026-03-02T12:00:00Z"),
    });

    const afterUpdate = await repo.getById(created.id);
    expect(afterUpdate!.admissionTaxRateBps).toBe(900);
    expect(afterUpdate!.taxRateSource).toBe("manual");
  }, 60_000);

  test("incrementUsage bumps the counter", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeSavedLocationsRepo(prisma);

    const created = await repo.create({
      name: "Usage Venue",
      address: "101 Usage Rd",
      countryCode: "US",
      region: "TX",
      locality: "Dallas",
      postalCode: "75201",
      lat: null,
      lng: null,
      ownerType: "ORGANIZATION",
      ownerId: orgId,
    });

    expect(created.usageCount).toBe(1);

    await repo.incrementUsage(created.id);
    await repo.incrementUsage(created.id);

    const after = await repo.getById(created.id);
    expect(after!.usageCount).toBe(3);
  }, 60_000);

  test("getAccessibleByOrg returns location for org owner, null for other org", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeSavedLocationsRepo(prisma);

    const created = await repo.create({
      name: "Org Venue",
      address: "202 Org Blvd",
      countryCode: "US",
      region: "CA",
      locality: "LA",
      postalCode: "90001",
      lat: 34.05,
      lng: -118.24,
      ownerType: "ORGANIZATION",
      ownerId: orgId,
    });

    // Owner org can access
    const accessible = await repo.getAccessibleByOrg({
      id: created.id,
      orgId,
    });
    expect(accessible).not.toBeNull();
    expect(accessible!.name).toBe("Org Venue");

    // Random org cannot access
    const notAccessible = await repo.getAccessibleByOrg({
      id: created.id,
      orgId: "non-existent-org-id",
    });
    expect(notAccessible).toBeNull();
  }, 60_000);
});
