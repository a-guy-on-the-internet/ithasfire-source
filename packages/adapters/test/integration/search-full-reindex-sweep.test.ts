import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { buildSearchIndex } from "@th/core/use-cases/search/build-search-index";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { OrganizationSearchDocument } from "@th/ports/search/multi-index.types";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { createPrismaRepos } from "../../src/db/prisma-repos";
import { makeSearchDocumentsWriter } from "../../src/db/prisma/search-documents";
import { MultiIndexPostgresAdapter } from "../../src/search/multi-index-postgres-adapter";

/**
 * The NON-DESTRUCTIVE full rebuild on real Postgres:
 *  · the sweep marker is the DATABASE clock at write time, so a write whose
 *    transaction began before the run but landed after it is kept (the
 *    `indexed_at = now()` of that row is OLDER than the run — the exact race
 *    a marker based on it would lose);
 *  · a row a concurrent, uncommitted write is rewriting is kept;
 *  · a full `buildSearchIndex` never empties the index: live documents stay
 *    visible for the whole run, and a stale one is deleted at the end.
 */
const T = new Date("2026-09-30T12:00:00.000Z");

function orgDoc(id: string, name: string): OrganizationSearchDocument {
  return {
    type: "organization",
    id: `organization_${id}`,
    orgId: id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    status: "ACTIVE",
    eventCount: 0,
    memberCount: 0,
    bio: null,
  };
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("non-destructive full search rebuild – real Postgres", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl, max: 8 });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("search-full-reindex-sweep setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  }, 120_000);

  beforeEach(async () => {
    if (!prisma) return;
    await prisma.searchDocument.deleteMany({});
  });

  const ids = async () =>
    (await prisma!.searchDocument.findMany({ select: { id: true } }))
      .map((r) => r.id)
      .sort();

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("the sweep deletes what nothing rewrote after the marker, and honours keepIds", async ({
    skip,
  }) => {
    if (!prisma) return skip();
    const search = new MultiIndexPostgresAdapter({ prisma });
    await search.upsertDocuments({
      documents: [orgDoc(A, "Old A"), orgDoc(B, "Old B"), orgDoc(C, "Old C")],
    });

    const token = await search.beginSweep();
    if (!token.ok) throw token.error;
    // The rebuild rewrites A only; B is a content error it keeps.
    await search.upsertDocuments({ documents: [orgDoc(A, "New A")] });

    const swept = await search.deleteUnswept({
      type: "organization",
      token: token.value,
      keepIds: [`organization_${B}`],
    });

    expect(swept).toMatchObject({ ok: true, value: { deleted: 1 } });
    expect(await ids()).toEqual([`organization_${A}`, `organization_${B}`]);
  });

  test("a write whose transaction began BEFORE the run but landed after it is kept (its indexed_at is older than the marker)", async ({
    skip,
  }) => {
    if (!prisma) return skip();
    const search = new MultiIndexPostgresAdapter({ prisma });

    let marked!: () => void;
    const tokenTaken = new Promise<void>((r) => (marked = r));
    let tokenValue: { marker: string } | undefined;

    const incremental = prisma.$transaction(async (tx) => {
      // The transaction (and so its now()) starts here, before the run.
      await tx.$queryRaw`SELECT 1`;
      await tokenTaken;
      await makeSearchDocumentsWriter(tx).upsertDocuments({
        documents: [orgDoc(A, "Landed after")],
      });
    });

    await new Promise((r) => setTimeout(r, 100));
    const token = await search.beginSweep();
    if (!token.ok) throw token.error;
    tokenValue = token.value;
    marked();
    await incremental;

    const row = await prisma.$queryRaw<
      Array<{ older: boolean }>
    >`SELECT indexed_at < ${tokenValue.marker}::timestamptz AS older
      FROM "SearchDocument" WHERE id = ${`organization_${A}`}`;
    expect(row[0]?.older).toBe(true);

    await search.deleteUnswept({ type: "organization", token: tokenValue });
    expect(await ids()).toEqual([`organization_${A}`]);
  });

  test("a row an UNCOMMITTED write is rewriting survives: the sweep waits and re-checks", async ({
    skip,
  }) => {
    if (!prisma) return skip();
    const search = new MultiIndexPostgresAdapter({ prisma });
    await search.upsertDocuments({ documents: [orgDoc(A, "Before")] });
    const token = await search.beginSweep();
    if (!token.ok) throw token.error;

    let release!: () => void;
    const mayCommit = new Promise<void>((r) => (release = r));
    let wrote!: () => void;
    const written = new Promise<void>((r) => (wrote = r));
    const incremental = prisma.$transaction(async (tx) => {
      await makeSearchDocumentsWriter(tx).upsertDocuments({
        documents: [orgDoc(A, "Rewritten")],
      });
      wrote();
      await mayCommit;
    });
    await written;

    const sweep = search.deleteUnswept({
      type: "organization",
      token: token.value,
    });
    await new Promise((r) => setTimeout(r, 200));
    release();
    await incremental;

    expect(await sweep).toMatchObject({ ok: true, value: { deleted: 0 } });
    expect(await ids()).toEqual([`organization_${A}`]);
  });

  test("a full buildSearchIndex never drops a live document at ANY write, and removes the stale ones at the end", async ({
    skip,
  }) => {
    if (!prisma) return skip();
    const org = await prisma.organization.create({
      data: { name: "Live Org", slug: `live-org-${Date.now()}` },
    });
    const place = await prisma.place.create({
      data: { name: "Live Venue", address: "1 Fireside Ln", status: "ACTIVE" },
    });
    const event = await prisma.event.create({
      data: {
        title: "Live Show",
        orgId: org.id,
        status: "PUBLISHED",
        visibility: "PUBLIC",
        startsAt: new Date("2026-12-01T01:00:00.000Z"),
        endsAt: new Date("2026-12-01T04:00:00.000Z"),
        publishedAt: T,
        locationMode: "EXACT",
        addressText: "1 Fireside Ln, Nashville, TN",
        lat: 36.1,
        lng: -86.7,
      },
    });
    const repos = createPrismaRepos(prisma);
    const adapter = new MultiIndexPostgresAdapter({ prisma });

    // A first rebuild writes the live documents; then add a stale document
    // per type (entities that no longer exist).
    await buildSearchIndex(
      { repos, search: adapter, clock: { now: () => T } },
      { fullReindex: true, batchSize: 50 },
    );
    const liveIds = [
      `event_${event.id}`,
      `place_${place.id}`,
      `organization_${org.id}`,
    ].sort();
    expect(await ids()).toEqual(liveIds);
    const GONE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await prisma.$executeRaw`
      INSERT INTO "SearchDocument" (id, type, title)
      VALUES (${`event_${GONE}`}, 'event', 'Gone show'),
             (${`place_${GONE}`}, 'place', 'Gone venue'),
             (${`organization_${GONE}`}, 'organization', 'Gone org')`;

    // Before EVERY document write of the rebuild — the fenced event/place
    // writes (on the transaction's writer) and the unfenced org writes (on
    // the port) — count, from a SECOND connection, how many live documents
    // are visible. A clear-first rebuild, or a sweep that ran before its
    // type's pass, drops this below 3.
    const samples: Array<{ at: string; live: number }> = [];
    const sample = async (at: string) => {
      const rows = await prisma!.searchDocument.count({
        where: { id: { in: liveIds } },
      });
      samples.push({ at, live: rows });
    };
    const watchedRepos: typeof repos = {
      ...repos,
      tx: ((
        fn: Parameters<typeof repos.tx>[0],
        o?: Parameters<typeof repos.tx>[1],
      ) =>
        repos.tx(
          (tx) =>
            fn({
              ...tx,
              searchDocuments: tx.searchDocuments && {
                upsertDocuments: async (input) => {
                  await sample(`tx:${input.documents[0]?.type}`);
                  return tx.searchDocuments!.upsertDocuments(input);
                },
                deleteDocuments: (input) =>
                  tx.searchDocuments!.deleteDocuments(input),
              },
            }),
          o,
        )) as typeof repos.tx,
    };
    const watched: MultiSearchPort = Object.assign(
      Object.create(adapter) as MultiSearchPort,
      {
        upsertDocuments: async (
          input: Parameters<MultiSearchPort["upsertDocuments"]>[0],
        ) => {
          await sample(`port:${input.documents[0]?.type}`);
          return adapter.upsertDocuments(input);
        },
        deleteUnswept: async (
          input: Parameters<MultiSearchPort["deleteUnswept"]>[0],
        ) => {
          const out = await adapter.deleteUnswept(input);
          await sample(`after-sweep:${input.type}`);
          return out;
        },
      },
    );

    const result = await buildSearchIndex(
      { repos: watchedRepos, search: watched, clock: { now: () => T } },
      { fullReindex: true, batchSize: 50 },
    );

    expect(result.errors).toEqual([]);
    expect(result.sweptTypes).toEqual([
      "event",
      "human",
      "place",
      "organization",
    ]);
    // Event and place writes went through the fence's transaction writer;
    // the org write through the port. Every sample saw all three live docs.
    expect(samples.map((x) => x.at)).toEqual(
      expect.arrayContaining(["tx:event", "tx:place", "port:organization"]),
    );
    expect(samples.every((x) => x.live === liveIds.length)).toBe(true);
    expect(await ids()).toEqual(liveIds);
  });
});
