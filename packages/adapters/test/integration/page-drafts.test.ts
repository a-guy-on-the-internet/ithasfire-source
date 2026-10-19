import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { isAppError } from "@th/errors";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEntityPagesRepo } from "../../src/db/prisma/entity-pages";

/**
 * PageDraft storage primitives (venue WYSIWYG editor, step 3):
 * lockDraftForUpdate / writeDraft / clearDraft / getDraft against a real
 * Postgres, including the CHECK constraints from migration
 * 20261008230000_page_draft. Constructed with a PrismaPg adapter (a bare
 * `new PrismaClient()` throws in driver-adapter mode and the suite would
 * silently skip).
 *
 * The postgis image is amd64-only and boots slowly under emulation on arm
 * Macs: hooks get long timeouts; locally, point
 * TESTCONTAINERS_REUSE_DATABASE_URL at a container you started.
 */
describe("Prisma adapters integration – page drafts", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const TX = { timeout: 60_000, maxWait: 60_000 } as const;

  async function makePage(label: string): Promise<string> {
    const human = await prisma!.human.create({
      data: { name: `Draft ${label}`, status: "ACTIVE" },
    });
    const page = await prisma!.entityPage.create({
      data: {
        ownerType: "HUMAN",
        ownerId: human.id,
        slug: `draft-${label}-${randomUUID().slice(0, 8)}`,
        visibility: "PUBLIC",
      },
    });
    return page.id;
  }

  async function errorOf(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error("expected the promise to reject");
  }

  /** Run `fn` with a repo bound to a fresh interactive transaction. */
  function inTx<T>(
    fn: (repo: ReturnType<typeof makeEntityPagesRepo>) => Promise<T>,
  ): Promise<T> {
    return prisma!.$transaction((tx) => fn(makeEntityPagesRepo(tx)), TX);
  }

  async function expectInternal(
    promise: Promise<unknown>,
    message: string,
  ): Promise<void> {
    const err = await errorOf(promise);
    expect(isAppError(err) && err.code).toBe("INTERNAL");
    expect((err as Error).message).toBe(message);
  }

  const EMPTY_WRITE = {
    data: {},
    placePatch: {},
    placeBase: {},
    fieldEditors: {},
    appliedBatchIds: [] as string[],
    updatedByHumanId: null,
  };

  /**
   * Two autosaves on one page, choreographed: the first locks and holds the
   * lock until Postgres itself reports a backend of this database waiting on
   * a lock (the second, blocked), then writes and commits. Returns the event
   * order and the SQL the blocked backend was waiting in.
   */
  async function raceTwoSaves(pageId: string): Promise<{
    events: string[];
    waiterQuery: string | null;
  }> {
    const events: string[] = [];
    let firstLocked!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });
    let secondRequested!: () => void;
    const secondHasRequested = new Promise<void>((resolve) => {
      secondRequested = resolve;
    });
    let waiterQuery: string | null = null;

    const first = inTx(async (repo) => {
      const locked = await repo.lockDraftForUpdate(pageId);
      events.push(`first-locked@${locked.revision}`);
      firstLocked();
      await secondHasRequested;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const [row] = await prisma!.$queryRaw<Array<{ query: string }>>`
          SELECT query FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
          LIMIT 1`;
        if (row) {
          waiterQuery = row.query;
          break;
        }
        await sleep(50);
      }
      await repo.writeDraft(pageId, {
        ...locked,
        data: { ...locked.data, "page.bio": "first" },
        appliedBatchIds: [...locked.appliedBatchIds, randomUUID()],
        revision: locked.revision + 1,
      });
      events.push("first-wrote");
    });

    const second = (async () => {
      await firstHasLock;
      return inTx(async (repo) => {
        events.push("second-requests-lock");
        secondRequested();
        const locked = await repo.lockDraftForUpdate(pageId);
        events.push(`second-locked@${locked.revision}`);
        await repo.writeDraft(pageId, {
          ...locked,
          data: { ...locked.data, "page.displayName": "second" },
          appliedBatchIds: [...locked.appliedBatchIds, randomUUID()],
          revision: locked.revision + 1,
        });
      });
    })();

    const results = await Promise.allSettled([first, second]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    return { events, waiterQuery };
  }

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl, max: 6 });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("page-drafts integration setup failed:", error);
    }
  }, 600_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  }, 120_000);

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("getDraft is null for a page never edited and creates nothing", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const pageId = await makePage("never-edited");
    const repo = makeEntityPagesRepo(prisma);

    expect(await repo.getDraft(pageId)).toBeNull();
    expect(await prisma.pageDraft.count({ where: { pageId } })).toBe(0);
  }, 60_000);

  test("two concurrent first saves: no error, one row, the second waits for the first", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const pageId = await makePage("race");

    const { events, waiterQuery } = await raceTwoSaves(pageId);

    // No row existed: the second blocked in the INSERT … ON CONFLICT, on the
    // first's uncommitted insert, and then saw its committed revision (1).
    expect(waiterQuery).toContain('INSERT INTO "PageDraft"');
    expect(events).toEqual([
      "first-locked@0",
      "second-requests-lock",
      "first-wrote",
      "second-locked@1",
    ]);
    const rows = await prisma.pageDraft.findMany({ where: { pageId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revision).toBe(2);
    expect(rows[0]!.data).toEqual({
      "page.bio": "first",
      "page.displayName": "second",
    });
    expect(rows[0]!.appliedBatchIds).toHaveLength(2);
  }, 120_000);

  test("two concurrent saves on an existing draft: the second waits in SELECT … FOR UPDATE", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const pageId = await makePage("race-existing");
    const seeded = await inTx(async (repo) => {
      const locked = await repo.lockDraftForUpdate(pageId);
      return repo.writeDraft(pageId, {
        ...EMPTY_WRITE,
        data: { "page.slugHint": "seed" },
        appliedBatchIds: [randomUUID()],
        revision: locked.revision + 5,
      });
    });
    expect(seeded.revision).toBe(5);

    const { events, waiterQuery } = await raceTwoSaves(pageId);

    expect(waiterQuery).toContain("FOR UPDATE");
    expect(events).toEqual([
      "first-locked@5",
      "second-requests-lock",
      "first-wrote",
      "second-locked@6",
    ]);
    const rows = await prisma.pageDraft.findMany({ where: { pageId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revision).toBe(7);
    expect(rows[0]!.data).toEqual({
      "page.slugHint": "seed",
      "page.bio": "first",
      "page.displayName": "second",
    });
    expect(rows[0]!.appliedBatchIds).toHaveLength(3);
  }, 120_000);

  test("writeDraft round-trips every column and advances updatedAt", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const pageId = await makePage("roundtrip");
    const humanId = randomUUID();
    const batchA = randomUUID();
    const batchB = randomUUID();

    const created = await prisma.$transaction(
      (tx) => makeEntityPagesRepo(tx).lockDraftForUpdate(pageId),
      TX,
    );
    expect(created).toMatchObject({
      pageId,
      data: {},
      placePatch: {},
      placeBase: {},
      fieldEditors: {},
      appliedBatchIds: [],
      revision: 0,
      lastPublishedRevision: null,
      updatedByHumanId: null,
    });

    const at = new Date("2026-10-08T12:00:00.000Z").toISOString();
    const firstWrite = await prisma.$transaction(async (tx) => {
      const repo = makeEntityPagesRepo(tx);
      const locked = await repo.lockDraftForUpdate(pageId);
      return repo.writeDraft(pageId, {
        data: { theme: { colorBg: "#181818" }, "page.bio": "Hello" },
        placePatch: { phone: "+1 612 555 0100" },
        placeBase: { phone: null },
        fieldEditors: { "page.bio": { humanId, at } },
        appliedBatchIds: [batchA],
        revision: locked.revision + 1,
        updatedByHumanId: humanId,
      });
    }, TX);

    const read = await makeEntityPagesRepo(prisma).getDraft(pageId);
    expect(read).toEqual(firstWrite);
    expect(read).toMatchObject({
      id: created.id,
      data: { theme: { colorBg: "#181818" }, "page.bio": "Hello" },
      placePatch: { phone: "+1 612 555 0100" },
      placeBase: { phone: null },
      fieldEditors: { "page.bio": { humanId, at } },
      appliedBatchIds: [batchA],
      revision: 1,
      lastPublishedRevision: null,
      updatedByHumanId: humanId,
    });
    expect(read!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      created.updatedAt.getTime(),
    );

    await sleep(25);
    const secondWrite = await prisma.$transaction(async (tx) => {
      const repo = makeEntityPagesRepo(tx);
      const locked = await repo.lockDraftForUpdate(pageId);
      return repo.writeDraft(pageId, {
        ...locked,
        appliedBatchIds: [...locked.appliedBatchIds, batchB],
        revision: locked.revision + 1,
      });
    }, TX);
    expect(secondWrite.revision).toBe(2);
    expect(secondWrite.appliedBatchIds).toEqual([batchA, batchB]);
    expect(secondWrite.updatedAt.getTime()).toBeGreaterThan(
      firstWrite.updatedAt.getTime(),
    );
    expect(secondWrite.createdAt).toEqual(created.createdAt);
  }, 120_000);

  test("clearDraft resets overlays to {} and keeps revision history and appliedBatchIds", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const pageId = await makePage("clear");
    const humanId = randomUUID();
    const ids = [randomUUID(), randomUUID()];

    await prisma.$transaction(async (tx) => {
      const repo = makeEntityPagesRepo(tx);
      await repo.lockDraftForUpdate(pageId);
      await repo.writeDraft(pageId, {
        data: { "page.bio": "pending" },
        placePatch: { name: "New name" },
        placeBase: { name: "Old name" },
        fieldEditors: { "page.bio": { humanId, at: "x" } },
        appliedBatchIds: ids,
        revision: 3,
        updatedByHumanId: humanId,
      });
    }, TX);

    // Publish: revision and lastPublishedRevision move together in one
    // statement, so the CHECK lastPublishedRevision <= revision holds.
    const published = await prisma.$transaction(async (tx) => {
      const repo = makeEntityPagesRepo(tx);
      const locked = await repo.lockDraftForUpdate(pageId);
      return repo.clearDraft(pageId, {
        revision: locked.revision + 1,
        lastPublishedRevision: locked.revision + 1,
        updatedByHumanId: humanId,
      });
    }, TX);
    expect(published).toMatchObject({
      data: {},
      placePatch: {},
      placeBase: {},
      fieldEditors: {},
      appliedBatchIds: ids,
      revision: 4,
      lastPublishedRevision: 4,
      updatedByHumanId: humanId,
    });

    // Stored as JSON objects, never JSON null (the object CHECK would reject
    // null; this asserts what actually landed).
    const types = await prisma.$queryRaw<
      Array<{ d: string; pp: string; pb: string; fe: string }>
    >`SELECT jsonb_typeof("data") AS d, jsonb_typeof("placePatch") AS pp,
             jsonb_typeof("placeBase") AS pb, jsonb_typeof("fieldEditors") AS fe
      FROM "PageDraft" WHERE "pageId" = ${pageId}`;
    expect(types).toEqual([
      { d: "object", pp: "object", pb: "object", fe: "object" },
    ]);

    // Discard: no lastPublishedRevision given → the column keeps its value.
    const discarded = await prisma.$transaction(async (tx) => {
      const repo = makeEntityPagesRepo(tx);
      const locked = await repo.lockDraftForUpdate(pageId);
      return repo.clearDraft(pageId, {
        revision: locked.revision + 1,
        updatedByHumanId: null,
      });
    }, TX);
    expect(discarded).toMatchObject({
      revision: 5,
      lastPublishedRevision: 4,
      appliedBatchIds: ids,
      updatedByHumanId: null,
    });
    expect(await prisma.pageDraft.count({ where: { pageId } })).toBe(1);
  }, 120_000);

  test("writeDraft refuses more than 100 batch ids before Postgres sees them; 100 is accepted", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const pageId = await makePage("cap");
    const hundred = Array.from({ length: 100 }, () => randomUUID());

    const ok = await inTx(async (repo) => {
      await repo.lockDraftForUpdate(pageId);
      return repo.writeDraft(pageId, {
        ...EMPTY_WRITE,
        appliedBatchIds: hundred,
        revision: 1,
      });
    });
    expect(ok.appliedBatchIds).toHaveLength(100);

    await expectInternal(
      inTx(async (repo) => {
        await repo.lockDraftForUpdate(pageId);
        return repo.writeDraft(pageId, {
          ...EMPTY_WRITE,
          appliedBatchIds: [...hundred, randomUUID()],
          revision: 2,
        });
      }),
      "page_draft_applied_batch_ids_over_cap",
    );
    const after = await makeEntityPagesRepo(prisma).getDraft(pageId);
    expect(after!.revision).toBe(1);
    expect(after!.appliedBatchIds).toEqual(hundred);
  }, 120_000);

  test("writeDraft refuses a non-object overlay; clearDraft refuses revisions its CHECKs would reject", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const pageId = await makePage("prechecks");
    await inTx(async (repo) => {
      await repo.lockDraftForUpdate(pageId);
      await repo.writeDraft(pageId, { ...EMPTY_WRITE, revision: 2 });
    });

    for (const bad of [[], null, "x"]) {
      await expectInternal(
        inTx(async (repo) => {
          await repo.lockDraftForUpdate(pageId);
          return repo.writeDraft(pageId, {
            ...EMPTY_WRITE,
            placePatch: bad as unknown as Record<string, unknown>,
            revision: 3,
          });
        }),
        "page_draft_overlay_not_object",
      );
    }
    await expectInternal(
      inTx((repo) =>
        repo.writeDraft(pageId, { ...EMPTY_WRITE, revision: -1 }),
      ),
      "page_draft_revision_out_of_range",
    );

    // lastPublishedRevision must lie in [1, revision].
    for (const lastPublishedRevision of [0, 4]) {
      await expectInternal(
        inTx(async (repo) => {
          await repo.lockDraftForUpdate(pageId);
          return repo.clearDraft(pageId, {
            revision: 3,
            lastPublishedRevision,
            updatedByHumanId: null,
          });
        }),
        "page_draft_lastPublishedRevision_out_of_range",
      );
    }
    await expectInternal(
      inTx((repo) =>
        repo.clearDraft(pageId, { revision: -1, updatedByHumanId: null }),
      ),
      "page_draft_revision_out_of_range",
    );
    const after = await makeEntityPagesRepo(prisma).getDraft(pageId);
    expect(after!.revision).toBe(2);
    expect(after!.lastPublishedRevision).toBeNull();
  }, 120_000);

  test("writeDraft and clearDraft refuse a revision that does not increase", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const pageId = await makePage("monotonic");
    await inTx(async (repo) => {
      await repo.lockDraftForUpdate(pageId);
      await repo.writeDraft(pageId, {
        ...EMPTY_WRITE,
        data: { "page.bio": "keep" },
        revision: 4,
      });
    });

    for (const revision of [4, 3, 0]) {
      await expectInternal(
        inTx(async (repo) => {
          await repo.lockDraftForUpdate(pageId);
          return repo.writeDraft(pageId, { ...EMPTY_WRITE, revision });
        }),
        "page_draft_row_missing_or_revision_not_increasing",
      );
      await expectInternal(
        inTx(async (repo) => {
          await repo.lockDraftForUpdate(pageId);
          return repo.clearDraft(pageId, {
            revision,
            updatedByHumanId: null,
          });
        }),
        "page_draft_row_missing_or_revision_not_increasing",
      );
    }
    const after = await makeEntityPagesRepo(prisma).getDraft(pageId);
    expect(after!.revision).toBe(4);
    expect(after!.data).toEqual({ "page.bio": "keep" });
  }, 120_000);

  test("lock, write and clear refuse to run outside a transaction", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const pageId = await makePage("outside-tx");
    const root = makeEntityPagesRepo(prisma);

    await expectInternal(
      root.lockDraftForUpdate(pageId),
      "page_draft_lock_outside_tx",
    );
    expect(await prisma.pageDraft.count({ where: { pageId } })).toBe(0);

    await inTx((repo) => repo.lockDraftForUpdate(pageId));
    await expectInternal(
      root.writeDraft(pageId, { ...EMPTY_WRITE, revision: 1 }),
      "page_draft_write_outside_tx",
    );
    await expectInternal(
      root.clearDraft(pageId, { revision: 1, updatedByHumanId: null }),
      "page_draft_clear_outside_tx",
    );
    expect((await root.getDraft(pageId))!.revision).toBe(0);
  }, 120_000);

  test("a missing page is PAGE_NOT_FOUND; a missing row is INTERNAL (caller skipped the lock)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const missingPageId = randomUUID();

    const lockErr = await errorOf(
      inTx((repo) => repo.lockDraftForUpdate(missingPageId)),
    );
    expect(isAppError(lockErr) && lockErr.code).toBe("PAGE_NOT_FOUND");
    expect(
      await prisma.pageDraft.count({ where: { pageId: missingPageId } }),
    ).toBe(0);

    // A real page whose caller skipped the lock (so no row exists yet).
    const pageId = await makePage("no-row");
    await expectInternal(
      inTx((repo) =>
        repo.writeDraft(pageId, { ...EMPTY_WRITE, revision: 1 }),
      ),
      "page_draft_row_missing_or_revision_not_increasing",
    );
    await expectInternal(
      inTx((repo) =>
        repo.clearDraft(pageId, { revision: 1, updatedByHumanId: null }),
      ),
      "page_draft_row_missing_or_revision_not_increasing",
    );
    expect(await prisma.pageDraft.count({ where: { pageId } })).toBe(0);
  }, 120_000);

  test("deleting the EntityPage cascades its draft", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const pageId = await makePage("cascade");
    await prisma.$transaction(
      (tx) => makeEntityPagesRepo(tx).lockDraftForUpdate(pageId),
      TX,
    );
    expect(await prisma.pageDraft.count({ where: { pageId } })).toBe(1);

    await prisma.entityPage.delete({ where: { id: pageId } });
    expect(await prisma.pageDraft.count({ where: { pageId } })).toBe(0);
  }, 60_000);
});
