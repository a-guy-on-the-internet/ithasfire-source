import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import type { Repos } from "@th/ports/repos";
import type { SavedSnippetListKey } from "@th/ports/repos/saved-snippets";
import { listSavedSnippets } from "@th/core/use-cases/saved-snippets/list-saved-snippets";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeSavedSnippetsRepo } from "../saved-snippets";
import type { PrismaClientOrTx } from "../types";

// ---------------------------------------------------------------------------
// Real-Postgres proof of the saved-reasons FIRST USE (booking-the-night
// FR-013): `listSavedSnippets` against the Prisma adapter.
//
//   1. Two first reads at once copy the platform starters EXACTLY ONCE —
//      whether the list row does not exist yet or exists un-copied. The
//      second reader is seen WAITING on the list lock while the first holds
//      it (so it is the lock that serialises them, not luck), and then reads
//      the first's committed copy.
//   2. Once the starters are copied, a read takes NO lock: it completes while
//      another transaction holds the list's lock — also for a list whose
//      owner deleted every reason.
//
// The full migration set is applied, so this also proves every migration
// (including 20261002120000_venue_confirmation_withdrawn_reason_1000)
// applies on top of the rest.
// ---------------------------------------------------------------------------

const ACTOR = "d1d1d1d1-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-02T12:00:00.000Z");

/** A promise plus its resolver. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe("saved reasons — first use on real Postgres (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.connectionUri });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 600_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  const LIST: SavedSnippetListKey = {
    ownerType: "HUMAN",
    ownerId: ACTOR,
    kind: "DECLINE_REASON",
  };

  async function someoneWaitsOnALock(): Promise<boolean> {
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    return rows[0]!.n > 0;
  }

  async function waitUntil(check: () => Promise<boolean>, ms = 5_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timed out waiting for the second reader to block on the list lock");
  }

  /**
   * The use case's repo bag on real Postgres. `hooks` wrap the saved-snippets
   * repo on each surface so a test can line both readers up.
   */
  function buildRepos(hooks: {
    onGetListState?: () => Promise<void>;
    onTxLocked?: () => Promise<void>;
  } = {}): Repos {
    const bagFor = (client: PrismaClientOrTx, inTx: boolean) => {
      const savedSnippets = makeSavedSnippetsRepo(client);
      return {
        savedSnippets: {
          ...savedSnippets,
          async getListState(key: SavedSnippetListKey) {
            const state = await savedSnippets.getListState(key);
            if (!inTx) await hooks.onGetListState?.();
            return state;
          },
          async lockList(key: SavedSnippetListKey) {
            const state = await savedSnippets.lockList(key);
            if (inTx) await hooks.onTxLocked?.();
            return state;
          },
        },
        humans: { getById: async (id: string) => ({ id, locale: null }) },
        audit: { log: async () => {} },
      };
    };
    return {
      ...bagFor(prisma!, false),
      tx: <R>(fn: (tx: unknown) => Promise<R>) =>
        prisma!.$transaction((tx) => fn(bagFor(tx as PrismaClientOrTx, true)), {
          timeout: 20_000,
        }),
    } as unknown as Repos;
  }

  const deps = (repos: Repos) => ({ repos, clock: { now: () => NOW } });
  const read = (repos: Repos) =>
    listSavedSnippets(deps(repos), { actorHumanId: ACTOR, owner: { kind: "self" } });

  /**
   * Both readers pass the lock-free checks (empty list, starters not copied)
   * before either opens its transaction; the first to take the list lock is
   * then held until the second is seen waiting on it.
   */
  async function raceTwoFirstReads() {
    let statesRead = 0;
    const bothReadState = gate();
    let locks = 0;
    const firstLocked = gate();
    const releaseFirst = gate();

    const repos = buildRepos({
      onGetListState: async () => {
        statesRead += 1;
        if (statesRead === 2) bothReadState.open();
        await bothReadState.opened;
      },
      onTxLocked: async () => {
        locks += 1;
        if (locks === 1) {
          firstLocked.open();
          await releaseFirst.opened;
        }
      },
    });

    const a = read(repos);
    const b = read(repos);
    await firstLocked.opened;
    // The other reader is parked on the list lock — not done.
    await waitUntil(someoneWaitsOnALock);
    expect(locks).toBe(1);
    releaseFirst.open();
    const [outA, outB] = await Promise.all([a, b]);
    expect(statesRead).toBe(2);
    expect(locks).toBe(2);
    return [outA, outB] as const;
  }

  async function assertCopiedOnce(outs: readonly Awaited<ReturnType<typeof read>>[]) {
    const { rows } = await pool!.query<{ n: number; starters: number; orders: number[] }>(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE "isStarter")::int AS starters,
              array_agg("sortOrder" ORDER BY "sortOrder") AS orders
         FROM "SavedSnippet" WHERE "ownerType" = 'HUMAN' AND "ownerId" = $1`,
      [ACTOR],
    );
    expect(rows[0]).toEqual({ n: 6, starters: 6, orders: [0, 1, 2, 3, 4, 5] });
    const { rows: lists } = await pool!.query<{ n: number; copied: number }>(
      `SELECT COUNT(*)::int AS n, COUNT("startersCopiedAt")::int AS copied
         FROM "SavedSnippetList" WHERE "ownerType" = 'HUMAN' AND "ownerId" = $1`,
      [ACTOR],
    );
    expect(lists[0]).toEqual({ n: 1, copied: 1 });
    // Both readers got the same six.
    const ids = outs.map((o) => o.snippets.map((s) => s.id));
    expect(ids[0]).toHaveLength(6);
    expect(ids[1]).toEqual(ids[0]);
  }

  test("two first reads on a list with NO row yet copy the starters exactly once", async () => {
    await pool!.query(`TRUNCATE "SavedSnippet", "SavedSnippetList"`);
    const outs = await raceTwoFirstReads();
    await assertCopiedOnce(outs);
  }, 30_000);

  test("two first reads on a list whose row exists un-copied copy the starters exactly once", async () => {
    await pool!.query(`TRUNCATE "SavedSnippet", "SavedSnippetList"`);
    // A committed list row with startersCopiedAt NULL (e.g. an earlier
    // reorder of the empty list).
    await prisma!.$transaction((tx) => makeSavedSnippetsRepo(tx).lockList(LIST));
    const outs = await raceTwoFirstReads();
    await assertCopiedOnce(outs);
  }, 30_000);

  test("once copied, a read takes no lock — it finishes while another tx holds the list lock, even when the list is empty", async () => {
    await pool!.query(`TRUNCATE "SavedSnippet", "SavedSnippetList"`);
    const first = await read(buildRepos());
    expect(first.snippets).toHaveLength(6);

    const readUnderHeldLock = async () => {
      const held = gate();
      const release = gate();
      const holder = prisma!.$transaction(
        async (tx) => {
          await makeSavedSnippetsRepo(tx).lockList(LIST);
          held.open();
          await release.opened;
        },
        { timeout: 20_000 },
      );
      await held.opened;
      try {
        // Would hang until `release` if the read touched the lock.
        return await Promise.race([
          read(buildRepos()),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("the read waited on the list lock")), 3_000),
          ),
        ]);
      } finally {
        release.open();
        await holder;
      }
    };

    await expect(readUnderHeldLock()).resolves.toMatchObject({ total: 6 });

    // Delete every reason: the starters never come back, and the empty read
    // still takes no lock.
    await pool!.query(`DELETE FROM "SavedSnippet" WHERE "ownerId" = $1`, [ACTOR]);
    await expect(readUnderHeldLock()).resolves.toMatchObject({ snippets: [], total: 0 });
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "SavedSnippet" WHERE "ownerId" = $1`,
      [ACTOR],
    );
    expect(rows[0]!.n).toBe(0);
  }, 30_000);
});
