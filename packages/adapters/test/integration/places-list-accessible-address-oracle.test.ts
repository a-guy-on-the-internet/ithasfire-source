import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makePlacesRepo } from "../../src/db/prisma/places";

/**
 * listAccessibleByHuman's SEARCH is not a street oracle for a venue that
 * withholds its address.
 *
 * Inclusion is the leak, not the row: the rows this finder returns are
 * redacted downstream, but "does a venue come back for `shelby`?" answered for
 * a withheld venue lets any signed-in user (the `ownedOnly: false` directory
 * scope) — or a door SCANNER in the org-admin spotlight (`ownedOnly: true`
 * over the org's own venues) — recover the street a few characters at a time.
 *
 * Fixture (all ACTIVE + VERIFIED, all at "Shelby Ave", all in Nashville):
 *   Hidden House  OBSCURED (circle)   1417 Shelby Ave   org-owned
 *   Dark Parlour  OBSCURED (hidden)   1500 Shelby Ave   org-owned
 *   Open Hall     EXACT               22 Shelby Ave     org-owned
 */
describe("Prisma adapters integration – listAccessibleByHuman street oracle", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  /** A signed-in stranger: owns nothing, sees every VERIFIED venue. */
  let strangerId: string;
  /** The org that owns all three venues (ownership rows carry no org FK). */
  const orgId = randomUUID();

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // Driver-adapter mode: a bare `new PrismaClient()` throws — construct
      // it the way packages/db/src/index.ts does, with a pg Pool adapter.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const stranger = await prisma.human.create({
        data: { name: "Stranger", status: "ACTIVE" },
      });
      strangerId = stranger.id;

      const fixtures = [
        {
          name: "Hidden House",
          address: "1417 Shelby Ave",
          locationMode: "OBSCURED" as const,
          locationRadiusMeters: 800,
        },
        {
          name: "Dark Parlour",
          address: "1500 Shelby Ave",
          locationMode: "OBSCURED" as const,
          locationRadiusMeters: null,
        },
        {
          name: "Open Hall",
          address: "22 Shelby Ave",
          locationMode: "EXACT" as const,
          locationRadiusMeters: null,
        },
      ];
      for (const fixture of fixtures) {
        const place = await prisma.place.create({
          data: {
            name: fixture.name,
            address: fixture.address,
            city: "Nashville",
            status: "ACTIVE",
            verification: "VERIFIED",
            locationMode: fixture.locationMode,
            locationRadiusMeters: fixture.locationRadiusMeters,
          },
        });
        await prisma.placeOwnership.create({
          data: {
            placeId: place.id,
            ownerType: "ORGANIZATION",
            ownerId: orgId,
            verified: true,
          },
        });
      }
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error(
        "places-list-accessible-address-oracle integration setup failed:",
        error,
      );
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

  /** The directory scope: any signed-in user, every VERIFIED venue. */
  function asStranger(query: string) {
    return makePlacesRepo(prisma!).listAccessibleByHuman({
      humanId: strangerId,
      query,
      limit: 50,
    });
  }

  /** The org-admin spotlight's exact call shape (`searchOrgAdmin`). */
  function asOrgSpotlight(query: string) {
    return makePlacesRepo(prisma!).listAccessibleByHuman({
      humanId: strangerId,
      orgIds: [orgId],
      query,
      ownedOnly: true,
      includeOwnedUnverified: true,
      limit: 50,
    });
  }

  test("a query matching ONLY a withheld street returns nothing — rows AND total", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    for (const search of [asStranger, asOrgSpotlight]) {
      for (const probe of ["1417", "1417 shelby", "1500 SHELBY AVE"]) {
        const result = await search(probe);
        expect(result.items).toEqual([]);
        // The count is the same oracle — it must not move either.
        expect(result.pageInfo.total).toBe(0);
      }
    }
  }, 60_000);

  test("a shared street substring matches only the EXACT venue", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    for (const search of [asStranger, asOrgSpotlight]) {
      const result = await search("Shelby");
      expect(result.items.map((p) => p.name)).toEqual(["Open Hall"]);
      expect(result.pageInfo.total).toBe(1);
    }
  }, 60_000);

  test("a withheld venue IS found by its name", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    for (const search of [asStranger, asOrgSpotlight]) {
      expect((await search("hidden house")).items.map((p) => p.name)).toEqual([
        "Hidden House",
      ]);
      expect((await search("Parlour")).items.map((p) => p.name)).toEqual([
        "Dark Parlour",
      ]);
    }
  }, 60_000);

  test("the EXACT venue is still found by its street", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    for (const search of [asStranger, asOrgSpotlight]) {
      const result = await search("22 shelby");
      expect(result.items.map((p) => p.name)).toEqual(["Open Hall"]);
    }
  }, 60_000);

  test("city stays searchable for every venue (a withheld venue publishes it)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const result = await asStranger("nashville");
    expect(result.items.map((p) => p.name)).toEqual([
      "Dark Parlour",
      "Hidden House",
      "Open Hall",
    ]);
  }, 60_000);
});
