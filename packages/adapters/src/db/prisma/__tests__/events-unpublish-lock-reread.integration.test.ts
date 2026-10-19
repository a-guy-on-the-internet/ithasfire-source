import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventsRepo } from "../events";

// ---------------------------------------------------------------------------
// The race `unpublishEvent` closes, against REAL Postgres: its PUBLISHED check
// used to run outside the tx, and `events.unpublish` is an unconditional
// flip, so a `cancelEvent` that committed in between was overwritten
// (CANCELLED → DRAFT, a refunded show re-publishable).
//
// The fix rests on one database property, pinned here: in READ COMMITTED, a
// `getById` issued AFTER `lockRows({ mode: "update" })` returns the row as
// the lock holder COMMITTED it. So the in-tx re-read under the lock sees
// CANCELLED and refuses. The second test is the control: the same flip with
// no lock and no re-read overwrites the cancel.
//
// This pins the database property only. That `unpublishEvent` itself takes
// the lock and re-reads inside its tx (and refuses on CANCELLED) is pinned by
// `packages/core/src/use-cases/events/__tests__/unpublish-event.test.ts`.
// ---------------------------------------------------------------------------

const EVENT = "72000000-0000-4000-8000-0000000000a1";

describe("events adapter — unpublish lock + re-read vs a concurrent cancel (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    // No Org/Human/Place graph needed: nothing under test joins through FKs.
    await pool.query(`ALTER TABLE "Event" DISABLE TRIGGER ALL`);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  beforeEach(async () => {
    await pool!.query(`TRUNCATE "Event" CASCADE`);
    await pool!.query(
      `INSERT INTO "Event" (id, title, "startsAt", "endsAt", status, "updatedAt")
       VALUES ($1, 'e', '2026-10-10T20:00:00Z', '2026-10-10T23:00:00Z',
               'PUBLISHED'::"EventStatus", '2026-01-01T00:00:00Z')`,
      [EVENT],
    );
  });

  async function statusInDb(): Promise<string> {
    const { rows } = await pool!.query(`SELECT status FROM "Event" WHERE id = $1`, [EVENT]);
    return (rows[0] as { status: string }).status;
  }

  /**
   * Resolves once THIS backend (the unpublish tx's, by pid) is blocked by
   * another. Scoped by pid because th-test-pg is shared: a lock wait in some
   * other test file must not let the race start early.
   */
  async function untilBlocked(pidOf: Promise<number>): Promise<void> {
    const pid = await pidOf;
    for (let i = 0; i < 100; i++) {
      const { rows } = await pool!.query(
        `SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS blocked`,
        [pid],
      );
      if ((rows[0] as { blocked: boolean }).blocked) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`backend ${pid} never waited on the lock`);
  }

  /** The tx's backend pid, published so the test can watch that backend. */
  function pidChannel() {
    let publish!: (pid: number) => void;
    const pid = new Promise<number>((r) => (publish = r));
    const capture = async (tx: unknown) => {
      const [row] = await (tx as PrismaClient).$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid() AS pid`;
      publish(row!.pid);
    };
    return { pid, capture };
  }

  /**
   * A `cancelEvent`-shaped tx: lock, cancel, then hold the lock until
   * `release` is called, then commit.
   */
  function startCancelHoldingLock() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    const done = prisma!.$transaction(
      async (tx) => {
        const repo = makeEventsRepo(tx as never);
        await repo.lockRows({ ids: [EVENT], mode: "update" });
        await repo.cancel({ eventId: EVENT });
        locked();
        await gate;
      },
      { timeout: 20_000 },
    );
    return { holding, release, done };
  }

  test("integration environment is up (canary — do not skip)", () => {
    expect(prisma).toBeDefined();
    expect(pool).toBeDefined();
  });

  test("the re-read under FOR UPDATE sees the committed CANCELLED and the unpublish writes nothing", async () => {
    // `unpublishEvent`'s pre-tx load: PUBLISHED.
    const preTx = await makeEventsRepo(prisma! as never).getById(EVENT);
    expect(preTx?.status).toBe("PUBLISHED");

    const cancel = startCancelHoldingLock();
    await cancel.holding;

    let reread: string | undefined;
    const backend = pidChannel();
    const unpublish = prisma!.$transaction(
      async (tx) => {
        await backend.capture(tx);
        const repo = makeEventsRepo(tx as never);
        await repo.lockRows({ ids: [EVENT], mode: "update" }); // waits for the cancel
        const locked = await repo.getById(EVENT);
        reread = locked?.status;
        if (locked?.status === "PUBLISHED") {
          await repo.unpublish({ eventId: EVENT });
        }
      },
      { timeout: 20_000 },
    );

    await untilBlocked(backend.pid);
    cancel.release();
    await cancel.done;
    await unpublish;

    expect(reread).toBe("CANCELLED");
    expect(await statusInDb()).toBe("CANCELLED");
  }, 60_000);

  test("control: the old shape (check outside the tx, unconditional flip) overwrites the cancel", async () => {
    const preTx = await makeEventsRepo(prisma! as never).getById(EVENT);
    expect(preTx?.status).toBe("PUBLISHED");

    const cancel = startCancelHoldingLock();
    await cancel.holding;

    const backend = pidChannel();
    const unpublish = prisma!.$transaction(
      async (tx) => {
        await backend.capture(tx);
        // No lock, no re-read: the pre-tx PUBLISHED is all it checked. The
        // UPDATE itself queues behind the cancel's row lock, then flips.
        if (preTx?.status === "PUBLISHED") {
          await makeEventsRepo(tx as never).unpublish({ eventId: EVENT });
        }
      },
      { timeout: 20_000 },
    );

    await untilBlocked(backend.pid);
    cancel.release();
    await cancel.done;
    await unpublish;

    expect(await statusInDb()).toBe("DRAFT");
  }, 60_000);
});
