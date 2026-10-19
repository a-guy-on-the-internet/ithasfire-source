import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEntityPagesRepo } from "../../src/db/prisma/entity-pages";

/**
 * Integration coverage for the batched entity-pages accessors added by the
 * lineup-listen-embeds spec: `getByOwners` and `listBlocksByPageIds`.
 * Mirrors the event-saves testcontainers setup (bare `new PrismaClient()`
 * throws in driver-adapter mode — construct with a pg Pool adapter).
 */
describe("Prisma adapters integration – entity-pages batched accessors", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let humanAId: string;
  let humanBId: string;
  let orgOwnerId: string;
  let pageAId: string;
  let pageBId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const humanA = await prisma.human.create({
        data: { name: "Lineup Artist A", status: "ACTIVE" },
      });
      humanAId = humanA.id;
      const humanB = await prisma.human.create({
        data: { name: "Lineup Artist B", status: "ACTIVE" },
      });
      humanBId = humanB.id;

      const pageA = await prisma.entityPage.create({
        data: {
          ownerType: "HUMAN",
          ownerId: humanAId,
          slug: "lineup-artist-a",
          visibility: "PUBLIC",
        },
      });
      pageAId = pageA.id;

      const pageB = await prisma.entityPage.create({
        data: {
          ownerType: "HUMAN",
          ownerId: humanBId,
          slug: "lineup-artist-b",
          visibility: "UNLISTED",
        },
      });
      pageBId = pageB.id;

      // Same ownerId reused under a DIFFERENT ownerType — getByOwners must
      // scope by type, not just id.
      orgOwnerId = humanAId;
      await prisma.entityPage.create({
        data: {
          ownerType: "ORGANIZATION",
          ownerId: orgOwnerId,
          slug: "org-collides-with-human-a",
          visibility: "PUBLIC",
        },
      });

      // Blocks: interleaved orderIndex across the two pages so the per-page
      // sort-order assertion is meaningful.
      await prisma.pageBlock.createMany({
        data: [
          { pageId: pageAId, kind: "links", orderIndex: 2, data: {} },
          { pageId: pageAId, kind: "tracks", orderIndex: 0, data: {} },
          { pageId: pageAId, kind: "music", orderIndex: 1, data: {} },
          { pageId: pageBId, kind: "bio", orderIndex: 1, data: {} },
          {
            pageId: pageBId,
            kind: "tracks",
            orderIndex: 0,
            data: {},
            visible: false,
          },
        ],
      });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("entity-pages-batched integration setup failed:", error);
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

  test("getByOwners returns only pages for the requested owner type/ids", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEntityPagesRepo(prisma);

    const pages = await repo.getByOwners("HUMAN", [
      humanAId,
      humanBId,
      "00000000-0000-4000-8000-000000000000", // no page — no null placeholder
    ]);

    expect(pages).toHaveLength(2);
    const byOwner = new Map(pages.map((p) => [p.ownerId, p]));
    expect(byOwner.get(humanAId)?.slug).toBe("lineup-artist-a");
    expect(byOwner.get(humanAId)?.visibility).toBe("PUBLIC");
    expect(byOwner.get(humanBId)?.visibility).toBe("UNLISTED");
    // The ORGANIZATION page sharing humanA's ownerId must NOT leak in.
    expect(pages.every((p) => p.ownerType === "HUMAN")).toBe(true);

    expect(await repo.getByOwners("HUMAN", [])).toEqual([]);
  }, 60_000);

  test("listBlocksByPageIds returns all blocks preserving per-page sortOrder", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEntityPagesRepo(prisma);

    const blocks = await repo.listBlocksByPageIds([pageAId, pageBId]);
    expect(blocks).toHaveLength(5);

    const pageAKinds = blocks
      .filter((b) => b.pageId === pageAId)
      .map((b) => b.kind);
    expect(pageAKinds).toEqual(["tracks", "music", "links"]);

    const pageBBlocks = blocks.filter((b) => b.pageId === pageBId);
    expect(pageBBlocks.map((b) => b.kind)).toEqual(["tracks", "bio"]);
    // Hidden blocks are returned (visibility filtering is the use case's job).
    expect(pageBBlocks[0]?.visible).toBe(false);

    // Mapping parity with the single-page accessor.
    const single = await repo.listBlocks(pageAId);
    expect(blocks.filter((b) => b.pageId === pageAId)).toEqual(single);

    expect(await repo.listBlocksByPageIds([])).toEqual([]);
  }, 60_000);
  // ── bulkCreate (bulk place import mints a page per venue) ───────────────
  //
  // `bulkImportPlaces` calls this inside its transaction and throws on a short
  // count. Both halves have to be true against real Postgres: the happy path
  // inserts every row, and a unique collision comes back as a SHORT COUNT
  // rather than a P2002 that would abort the enclosing transaction.
  test("bulkCreate inserts every row and reports the count", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEntityPagesRepo(prisma);

    const placeIds = [
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000002",
      "aaaaaaaa-0000-4000-8000-000000000003",
    ];

    const result = await repo.bulkCreate(
      placeIds.map((id, i) => ({
        ownerType: "PLACE" as const,
        ownerId: id,
        slug: `bulk-venue-${i}-${id.slice(0, 8)}`,
        displayName: `Bulk Venue ${i}`,
      })),
    );

    expect(result).toEqual({ created: 3 });

    for (const [i, id] of placeIds.entries()) {
      const page = await repo.getByOwner("PLACE", id);
      expect(page?.slug).toBe(`bulk-venue-${i}-${id.slice(0, 8)}`);
      expect(page?.displayName).toBe(`Bulk Venue ${i}`);
      // Schema defaults apply on a CREATE-only insert.
      expect(page?.bio).toBeNull();
      expect(page?.visibility).toBe("PUBLIC");
      expect(page?.allowFollows).toBe(true);
    }

    expect(await repo.bulkCreate([])).toEqual({ created: 0 });
  }, 60_000);

  test("bulkCreate reports a SHORT COUNT on a unique collision instead of throwing", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makeEntityPagesRepo(prisma);

    const fresh = "bbbbbbbb-0000-4000-8000-000000000001";

    const result = await repo.bulkCreate([
      {
        ownerType: "PLACE",
        ownerId: fresh,
        slug: "collision-fresh-row",
        displayName: "Fresh",
      },
      {
        // Collides on the globally-unique `slug` index with a page created in
        // beforeAll under a different owner type.
        ownerType: "PLACE",
        ownerId: "bbbbbbbb-0000-4000-8000-000000000002",
        slug: "lineup-artist-a",
        displayName: "Slug Collision",
      },
      {
        // Collides on (ownerType, ownerId) with the row created above.
        ownerType: "PLACE",
        ownerId: fresh,
        slug: "collision-owner-dupe",
        displayName: "Owner Collision",
      },
    ]);

    // Two rows dropped, no throw — which is exactly why the caller MUST
    // compare the count and roll its transaction back.
    expect(result.created).toBe(1);
    expect((await repo.getByOwner("PLACE", fresh))?.slug).toBe(
      "collision-fresh-row",
    );
    expect(
      await repo.getByOwner("PLACE", "bbbbbbbb-0000-4000-8000-000000000002"),
    ).toBeNull();
  }, 60_000);
});
