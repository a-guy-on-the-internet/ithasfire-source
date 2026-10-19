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

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeSearchIndexStateRepo } from "../../src/db/prisma/search-index-state";
import { makeSearchReindexPendingRepo } from "../../src/db/prisma/search-reindex-pending";

/**
 * Real-Postgres semantics of the edit-triggered search reindex tables: the
 * generation-guarded clear (including against a mark that is still
 * uncommitted), rollback of a mark with its transaction, concurrent marks,
 * keyset paging, and the format-rebuild claim under concurrent boots.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T0 = new Date("2026-09-30T12:00:00.000Z");
const T1 = new Date("2026-09-30T12:00:01.000Z");
const T2 = new Date("2026-09-30T12:00:02.000Z");

describe("Prisma adapters integration – SearchReindexPending / SearchIndexState", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl, max: 12 });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("search-reindex-pending integration setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  }, 120_000);

  beforeEach(async () => {
    if (!prisma) return;
    await prisma.searchReindexPending.deleteMany({});
    await prisma.searchIndexState.deleteMany({});
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("a mark larger than one statement chunk marks every target (chunked)", async ({
    skip,
  }) => {
    if (!prisma) return skip();
    const repo = makeSearchReindexPendingRepo(prisma);
    // Past two chunks of MARK_CHUNK_SIZE (1,000); random UUIDs like real ids.
    const targets = Array.from({ length: 2_500 }, () => ({
      entityType: "event" as const,
      entityId: crypto.randomUUID(),
    }));

    await prisma.$transaction(async (tx) => {
      await makeSearchReindexPendingRepo(tx).mark(targets, T0);
    });
    const generationsOf = () =>
      prisma!.searchReindexPending.groupBy({
        by: ["generation"],
        _count: { _all: true },
      });
    // Every row exists and every chunk was bumped alike.
    const first = await generationsOf();
    expect(first).toHaveLength(1);
    expect(first[0]?._count._all).toBe(2_500);

    await repo.mark(targets, T1);
    expect(await generationsOf()).toEqual([
      { generation: first[0]!.generation + 1, _count: { _all: 2_500 } },
    ]);
  });

  test("mark inserts, re-mark bumps the generation and resets the failure count", async ({
    skip,
  }) => {
    if (!prisma) return skip();
    const repo = makeSearchReindexPendingRepo(prisma);

    await repo.mark(
      [
        { entityType: "event", entityId: A },
        { entityType: "event", entityId: A },
        { entityType: "place", entityId: B },
      ],
      T0,
    );
    const [first] = await repo.getMany([{ entityType: "event", entityId: A }]);
    expect(first).toMatchObject({ attempts: 0, markedAt: T0 });

    await repo.recordFailure(
      [{ entityType: "event", entityId: A, generation: first!.generation }],
      { error: "boom", at: T1 },
    );
    await repo.mark([{ entityType: "event", entityId: A }], T2);

    const [again] = await repo.getMany([{ entityType: "event", entityId: A }]);
    expect(again!.generation).toBe(first!.generation + 1);
    expect(again).toMatchObject({ attempts: 0, lastError: null, markedAt: T2 });
    expect(await prisma.searchReindexPending.count()).toBe(2);
  });

  test("a mark rolls back with its transaction", async ({ skip }) => {
    if (!prisma) return skip();
    await expect(
      prisma.$transaction(async (tx) => {
        await makeSearchReindexPendingRepo(tx).mark(
          [{ entityType: "event", entityId: A }],
          T0,
        );
        throw new Error("the edit failed");
      }),
    ).rejects.toThrow("the edit failed");
    expect(await prisma.searchReindexPending.count()).toBe(0);
  });

  test("the guarded clear deletes only an unchanged generation", async ({
    skip,
  }) => {
    if (!prisma) return skip();
    const repo = makeSearchReindexPendingRepo(prisma);
    await repo.mark([{ entityType: "event", entityId: A }], T0);
    const [snap] = await repo.getMany([{ entityType: "event", entityId: A }]);

    await repo.mark([{ entityType: "event", entityId: A }], T1);
    expect(
      await repo.clearIfUnchanged([
        { entityType: "event", entityId: A, generation: snap!.generation },
      ]),
    ).toBe(0);

    const [now] = await repo.getMany([{ entityType: "event", entityId: A }]);
    expect(
      await repo.clearIfUnchanged([
        { entityType: "event", entityId: A, generation: now!.generation },
      ]),
    ).toBe(1);
  });

  test("a clear racing an UNCOMMITTED re-mark waits for it, then keeps the row", async ({
    skip,
  }) => {
    if (!prisma) return skip();
    const repo = makeSearchReindexPendingRepo(prisma);
    await repo.mark([{ entityType: "event", entityId: A }], T0);
    const [snap] = await repo.getMany([{ entityType: "event", entityId: A }]);

    let releaseEdit!: () => void;
    const editMayCommit = new Promise<void>((r) => (releaseEdit = r));
    let marked!: () => void;
    const editMarked = new Promise<void>((r) => (marked = r));

    const edit = prisma.$transaction(async (tx) => {
      await makeSearchReindexPendingRepo(tx).mark(
        [{ entityType: "event", entityId: A }],
        T1,
      );
      marked();
      await editMayCommit;
    });
    await editMarked;

    // The clear blocks on the edit's row lock; once the edit commits, the
    // DELETE re-checks its WHERE against the new row and matches nothing.
    const clear = repo.clearIfUnchanged([
      { entityType: "event", entityId: A, generation: snap!.generation },
    ]);
    await new Promise((r) => setTimeout(r, 200));
    releaseEdit();
    await edit;

    expect(await clear).toBe(0);
    const [row] = await repo.getMany([{ entityType: "event", entityId: A }]);
    expect(row!.generation).toBe(snap!.generation + 1);
  });

  test("concurrent marks of the same entity both commit", async ({ skip }) => {
    if (!prisma) return skip();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        prisma!.$transaction((tx) =>
          makeSearchReindexPendingRepo(tx).mark(
            [
              { entityType: "event", entityId: A },
              { entityType: "place", entityId: B },
            ],
            new Date(T0.getTime() + i),
          ),
        ),
      ),
    );
    const rows = await prisma.searchReindexPending.findMany({});
    expect(rows).toHaveLength(2);
  });

  test("listDue: oldest first, skips parked rows, pages with the keyset cursor", async ({
    skip,
  }) => {
    if (!prisma) return skip();
    const repo = makeSearchReindexPendingRepo(prisma);
    await repo.mark([{ entityType: "event", entityId: C }], T2);
    await repo.mark([{ entityType: "event", entityId: A }], T0);
    await repo.mark([{ entityType: "place", entityId: B }], T1);
    const [b] = await repo.getMany([{ entityType: "place", entityId: B }]);
    for (let i = 0; i < 2; i += 1) {
      await repo.recordFailure(
        [{ entityType: "place", entityId: B, generation: b!.generation }],
        { error: "x".repeat(2000), at: T2 },
      );
    }

    const due = await repo.listDue({ limit: 10, maxAttempts: 2 });
    expect(due.map((r) => r.entityId)).toEqual([A, C]);

    const all = await repo.listDue({ limit: 10, maxAttempts: 100 });
    expect(all.map((r) => r.entityId)).toEqual([A, B, C]);
    expect(all[1]!.lastError!.length).toBe(1000);

    const page2 = await repo.listDue({
      limit: 10,
      maxAttempts: 100,
      after: {
        markedAt: all[0]!.markedAt,
        entityType: all[0]!.entityType,
        entityId: all[0]!.entityId,
      },
    });
    expect(page2.map((r) => r.entityId)).toEqual([B, C]);
  });

  test("format claim: 8 concurrent boots, exactly one wins; stale claims are retaken", async ({
    skip,
  }) => {
    if (!prisma) return skip();
    const repo = makeSearchIndexStateRepo(prisma);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repo.claimFormatRebuild({
          version: 2,
          now: T0,
          staleBefore: new Date(0),
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);

    // Fresh claim blocks; a stale one (claimedAt < staleBefore) is retaken.
    expect(
      await repo.claimFormatRebuild({ version: 2, now: T1, staleBefore: T0 }),
    ).toBe(false);
    expect(
      await repo.claimFormatRebuild({ version: 2, now: T2, staleBefore: T1 }),
    ).toBe(true);

    await repo.recordFormatVersion({ version: 2, at: T2 });
    await repo.recordFormatVersion({ version: 1, at: T2 });
    expect((await repo.get())?.formatVersion).toBe(2);
    expect(
      await repo.claimFormatRebuild({ version: 2, now: T2, staleBefore: T2 }),
    ).toBe(false);

    await repo.releaseFormatRebuildClaim({ version: 2 });
    expect((await repo.get())?.rebuildClaimedVersion).toBeNull();
  });
});
