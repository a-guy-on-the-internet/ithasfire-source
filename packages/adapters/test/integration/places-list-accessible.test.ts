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
 * Integration coverage for listAccessibleByHuman's server-side sort, status
 * scope, verified-only scope and eventsCount aggregation (admin Places
 * table). The seeded venue names encode the expected name-asc order:
 * Alpha < Bravo < Charlie < Delta < Echo.
 *
 * Seeded fixture matrix (all owned by one human via VERIFIED ownership):
 *   Alpha Hall    ACTIVE     VERIFIED    cap 100   created 2026-01-01   events: PUBLISHED+DRAFT
 *   Bravo Barn    ACTIVE     VERIFIED    cap null  created 2026-03-01   events: none
 *   Charlie Club  ARCHIVED   VERIFIED    cap 50    created 2026-02-01   events: CANCELLED
 *   Delta Den     SUSPENDED  VERIFIED    cap 200   created 2026-04-01   events: PUBLISHED
 *   Echo Attic    ACTIVE     UNVERIFIED  cap 10    created 2026-05-01   events: none
 *
 * Echo is invisible to every default-flag (includeOwnedUnverified=false ⇒
 * verification=VERIFIED) query, so the sort/status/pagination tests below
 * stay a clean 4-venue matrix; the verified-scope test flips the flag.
 */
describe("Prisma adapters integration – places listAccessibleByHuman", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let humanId: string;

  const placeIdsByName = new Map<string, string>();

  const FIXTURES = [
    {
      name: "Alpha Hall",
      status: "ACTIVE" as const,
      verification: "VERIFIED" as const,
      capacity: 100,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      // Only the PUBLISHED one may count toward eventsCount.
      eventStatuses: ["PUBLISHED", "DRAFT"] as const,
    },
    {
      name: "Bravo Barn",
      status: "ACTIVE" as const,
      verification: "VERIFIED" as const,
      capacity: null,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      eventStatuses: [] as const,
    },
    {
      name: "Charlie Club",
      status: "ARCHIVED" as const,
      verification: "VERIFIED" as const,
      capacity: 50,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      // Non-PUBLISHED only — must aggregate to zero.
      eventStatuses: ["CANCELLED"] as const,
    },
    {
      name: "Delta Den",
      status: "SUSPENDED" as const,
      verification: "VERIFIED" as const,
      capacity: 200,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      eventStatuses: ["PUBLISHED"] as const,
    },
    {
      name: "Echo Attic",
      status: "ACTIVE" as const,
      verification: "UNVERIFIED" as const,
      capacity: 10,
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      eventStatuses: [] as const,
    },
  ];

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // The repo's Prisma client runs in driver-adapter ("client" engine)
      // mode, so a bare `new PrismaClient()` throws — construct it the way
      // packages/db/src/index.ts does, with a pg Pool adapter.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const human = await prisma.human.create({
        data: { name: "Venue Owner", status: "ACTIVE" },
      });
      humanId = human.id;

      for (const fixture of FIXTURES) {
        const place = await prisma.place.create({
          data: {
            name: fixture.name,
            address: `1 ${fixture.name} Way`,
            capacity: fixture.capacity,
            status: fixture.status,
            verification: fixture.verification,
            createdAt: fixture.createdAt,
          },
        });
        placeIdsByName.set(fixture.name, place.id);

        // VERIFIED, non-revoked ownership — the access-granting predicate.
        await prisma.placeOwnership.create({
          data: {
            placeId: place.id,
            ownerType: "HUMAN",
            ownerId: humanId,
            verified: true,
          },
        });

        // Mixed lifecycle statuses on purpose: eventsCount must aggregate
        // ONLY the PUBLISHED rows (draft/cancelled counts on non-owned
        // verified venues would leak cross-tenant activity metadata).
        for (const [i, eventStatus] of fixture.eventStatuses.entries()) {
          await prisma.event.create({
            data: {
              title: `${fixture.name} event ${i + 1}`,
              startsAt: new Date("2026-08-01T20:00:00.000Z"),
              endsAt: new Date("2026-08-01T23:00:00.000Z"),
              status: eventStatus,
              humanId,
              placeId: place.id,
            },
          });
        }
      }
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error(
        "places-list-accessible integration setup failed:",
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

  test("legacy scope (no status param) stays ACTIVE-only", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makePlacesRepo(prisma);
    const result = await repo.listAccessibleByHuman({ humanId, limit: 50 });

    expect(result.items.map((p) => p.name)).toEqual([
      "Alpha Hall",
      "Bravo Barn",
    ]);
    expect(result.pageInfo.total).toBe(2);
  }, 60_000);

  test("status filter scopes rows AND pageInfo.total", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makePlacesRepo(prisma);

    const active = await repo.listAccessibleByHuman({
      humanId,
      limit: 50,
      status: "active",
    });
    // "active" = NOT ARCHIVED — includes SUSPENDED.
    expect(active.items.map((p) => p.name)).toEqual([
      "Alpha Hall",
      "Bravo Barn",
      "Delta Den",
    ]);
    expect(active.pageInfo.total).toBe(3);

    const archived = await repo.listAccessibleByHuman({
      humanId,
      limit: 50,
      status: "archived",
    });
    expect(archived.items.map((p) => p.name)).toEqual(["Charlie Club"]);
    expect(archived.pageInfo.total).toBe(1);

    const all = await repo.listAccessibleByHuman({
      humanId,
      limit: 50,
      status: "all",
    });
    expect(all.items).toHaveLength(4);
    expect(all.pageInfo.total).toBe(4);
  }, 60_000);

  test("sort applies BEFORE pagination (page 2 continues the order)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makePlacesRepo(prisma);

    const page1 = await repo.listAccessibleByHuman({
      humanId,
      status: "all",
      sort: { field: "name", direction: "desc" },
      limit: 2,
      offset: 0,
    });
    expect(page1.items.map((p) => p.name)).toEqual([
      "Delta Den",
      "Charlie Club",
    ]);
    expect(page1.pageInfo.total).toBe(4);
    expect(page1.pageInfo.hasNextPage).toBe(true);

    const page2 = await repo.listAccessibleByHuman({
      humanId,
      status: "all",
      sort: { field: "name", direction: "desc" },
      limit: 2,
      offset: 2,
    });
    expect(page2.items.map((p) => p.name)).toEqual([
      "Bravo Barn",
      "Alpha Hall",
    ]);
    expect(page2.pageInfo.hasNextPage).toBe(false);
  }, 60_000);

  test("capacity sort puts nulls last in BOTH directions", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makePlacesRepo(prisma);

    const asc = await repo.listAccessibleByHuman({
      humanId,
      status: "all",
      sort: { field: "capacity", direction: "asc" },
      limit: 50,
    });
    expect(asc.items.map((p) => p.name)).toEqual([
      "Charlie Club", // 50
      "Alpha Hall", // 100
      "Delta Den", // 200
      "Bravo Barn", // null — last
    ]);

    const desc = await repo.listAccessibleByHuman({
      humanId,
      status: "all",
      sort: { field: "capacity", direction: "desc" },
      limit: 50,
    });
    expect(desc.items.map((p) => p.name)).toEqual([
      "Delta Den",
      "Alpha Hall",
      "Charlie Club",
      "Bravo Barn", // null — still last
    ]);
  }, 60_000);

  test("created and status sorts order server-side", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makePlacesRepo(prisma);

    const createdDesc = await repo.listAccessibleByHuman({
      humanId,
      status: "all",
      sort: { field: "created", direction: "desc" },
      limit: 50,
    });
    expect(createdDesc.items.map((p) => p.name)).toEqual([
      "Delta Den", // 2026-04
      "Bravo Barn", // 2026-03
      "Charlie Club", // 2026-02
      "Alpha Hall", // 2026-01
    ]);

    // Status sort uses the Postgres enum order (ACTIVE, SUSPENDED,
    // ARCHIVED) with a name-asc tiebreak.
    const statusAsc = await repo.listAccessibleByHuman({
      humanId,
      status: "all",
      sort: { field: "status", direction: "asc" },
      limit: 50,
    });
    expect(statusAsc.items.map((p) => p.status)).toEqual([
      "ACTIVE",
      "ACTIVE",
      "SUSPENDED",
      "ARCHIVED",
    ]);
    expect(statusAsc.items.slice(0, 2).map((p) => p.name)).toEqual([
      "Alpha Hall",
      "Bravo Barn",
    ]);
  }, 60_000);

  test("eventsCount aggregates ONLY PUBLISHED events per place", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makePlacesRepo(prisma);
    const result = await repo.listAccessibleByHuman({
      humanId,
      status: "all",
      limit: 50,
    });

    const countsByName = new Map(
      result.items.map((p) => [p.name, p.eventsCount]),
    );
    expect(countsByName.get("Alpha Hall")).toBe(1); // PUBLISHED yes, DRAFT no
    expect(countsByName.get("Bravo Barn")).toBe(0); // no events at all
    expect(countsByName.get("Charlie Club")).toBe(0); // CANCELLED only
    expect(countsByName.get("Delta Den")).toBe(1); // PUBLISHED
  }, 60_000);

  test("verified-only scope filters rows AND pageInfo.total in SQL", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makePlacesRepo(prisma);

    // Default flags (includeOwnedUnverified=false) = the verifiedOnly=true
    // path of listHumanPlaces: the owned-but-UNVERIFIED Echo Attic must be
    // excluded from the rows AND from the total (no lying pagination).
    const verifiedOnly = await repo.listAccessibleByHuman({
      humanId,
      status: "all",
      limit: 50,
    });
    expect(verifiedOnly.items.map((p) => p.name)).not.toContain("Echo Attic");
    expect(verifiedOnly.items).toHaveLength(4);
    expect(verifiedOnly.pageInfo.total).toBe(4);

    // includeOwnedUnverified=true (verifiedOnly=false) widens the scope to
    // the actor's own unverified places — rows and total both grow.
    const withOwnedUnverified = await repo.listAccessibleByHuman({
      humanId,
      status: "all",
      includeOwnedUnverified: true,
      limit: 50,
    });
    expect(withOwnedUnverified.items.map((p) => p.name)).toContain(
      "Echo Attic",
    );
    expect(withOwnedUnverified.items).toHaveLength(5);
    expect(withOwnedUnverified.pageInfo.total).toBe(5);
  }, 60_000);

  test("status filter composes with a search query", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makePlacesRepo(prisma);

    // "Club" only matches the ARCHIVED Charlie Club.
    const archivedMatch = await repo.listAccessibleByHuman({
      humanId,
      query: "Club",
      status: "archived",
      limit: 50,
    });
    expect(archivedMatch.items.map((p) => p.name)).toEqual(["Charlie Club"]);
    expect(archivedMatch.pageInfo.total).toBe(1);

    // Same query under the "active" scope finds nothing — and the total
    // says so.
    const activeMiss = await repo.listAccessibleByHuman({
      humanId,
      query: "Club",
      status: "active",
      limit: 50,
    });
    expect(activeMiss.items).toEqual([]);
    expect(activeMiss.pageInfo.total).toBe(0);
  }, 60_000);

  test("offset beyond total returns empty items with an honest total", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makePlacesRepo(prisma);
    const result = await repo.listAccessibleByHuman({
      humanId,
      status: "all",
      limit: 2,
      offset: 10,
    });

    expect(result.items).toEqual([]);
    expect(result.pageInfo.total).toBe(4);
    expect(result.pageInfo.count).toBe(0);
    expect(result.pageInfo.hasNextPage).toBe(false);
  }, 60_000);
});
