import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

// ---------------------------------------------------------------------------
// Executes the checked-in 20261015130000_normalize_ledger_currency migration
// against real Postgres. The fold (colliding PayeeLedgerBalance casings summed
// into one row under the (payeeId, currency) PK), the backfills, the CHECK
// constraints and the lock are all Postgres behaviour; nothing short of
// running the SQL proves them.
//
// THE MIGRATION SQL IS READ FROM DISK, NOT RETYPED HERE, and applied twice to
// prove it is re-applicable. Tables are standalone DDL in the pre-migration
// shape, reduced to the columns the migration touches (no FKs). `currency` is
// VARCHAR(3) as in the real schema, so a padded ' usd' cannot exist there;
// the casings under test are 'usd' / 'USD' / 'Usd'.
// ---------------------------------------------------------------------------

const MIGRATION_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations/20261015130000_normalize_ledger_currency/migration.sql",
  ),
  "utf8",
);

const TABLE_SQL = `
CREATE TABLE "PayeeLedgerEntry" (
  "id" TEXT NOT NULL,
  "payeeId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  CONSTRAINT "PayeeLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayeeLedgerBalance" (
  "payeeId" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "ledgerBalanceCents" INTEGER NOT NULL DEFAULT 0,
  "ledgerPendingHoldCents" INTEGER NOT NULL DEFAULT 0,
  "reserveBalanceCents" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayeeLedgerBalance_pkey" PRIMARY KEY ("payeeId", "currency")
);

CREATE TABLE "Order" (
  "id" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);
`;

const CONSTRAINTS = [
  "PayeeLedgerEntry_currency_normalized_check",
  "PayeeLedgerBalance_currency_normalized_check",
  "Order_currency_normalized_check",
] as const;

const T1 = "2026-10-01 10:00:00.000";
const T2 = "2026-10-03 12:00:00.000"; // the newest — the folded row keeps it
const T3 = "2026-10-02 08:00:00.000";
const T_LONE = "2026-09-20 09:30:00.000";

describe("20261015130000_normalize_ledger_currency migration (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;

  async function seed() {
    await pool!.query(
      `DROP TABLE IF EXISTS "PayeeLedgerEntry", "PayeeLedgerBalance", "Order"`,
    );
    await pool!.query(TABLE_SQL);
    await pool!.query(
      `INSERT INTO "PayeeLedgerBalance"
         ("payeeId", "currency", "ledgerBalanceCents", "ledgerPendingHoldCents", "reserveBalanceCents", "updatedAt")
       VALUES
         ('payee_1', 'usd', 1000,  10,  100, $1),
         ('payee_1', 'USD', 2000,  20,  200, $2),
         ('payee_1', 'Usd', 4000,  40,  400, $3),
         ('payee_2', 'USD', 7777,  33,  -55, $4)`,
      [T1, T2, T3, T_LONE],
    );
    await pool!.query(
      `INSERT INTO "PayeeLedgerEntry" ("id", "payeeId", "amountCents", "currency")
       VALUES ('e1', 'payee_1', 500, 'USD'), ('e2', 'payee_2', 300, 'Usd'), ('e3', 'payee_1', 100, 'usd')`,
    );
    await pool!.query(
      `INSERT INTO "Order" ("id", "currency") VALUES ('o1', 'USD'), ('o2', 'usd')`,
    );
  }

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  test("folds colliding balances, lowercases everything, and installs the CHECKs — applied twice", async () => {
    await seed();

    await pool!.query(MIGRATION_SQL);
    await pool!.query(MIGRATION_SQL);

    const balances = await pool!.query(
      `SELECT "payeeId", "currency", "ledgerBalanceCents", "ledgerPendingHoldCents",
              "reserveBalanceCents", to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "updatedAt"
         FROM "PayeeLedgerBalance" ORDER BY "payeeId", "currency"`,
    );
    expect(balances.rows).toStrictEqual([
      {
        payeeId: "payee_1",
        currency: "usd",
        ledgerBalanceCents: 7000,
        ledgerPendingHoldCents: 70,
        reserveBalanceCents: 700,
        updatedAt: T2,
      },
      {
        payeeId: "payee_2",
        currency: "usd",
        ledgerBalanceCents: 7777,
        ledgerPendingHoldCents: 33,
        reserveBalanceCents: -55,
        updatedAt: T_LONE,
      },
    ]);

    const entries = await pool!.query(
      `SELECT "id", "currency", "amountCents" FROM "PayeeLedgerEntry" ORDER BY "id"`,
    );
    expect(entries.rows).toStrictEqual([
      { id: "e1", currency: "usd", amountCents: 500 },
      { id: "e2", currency: "usd", amountCents: 300 },
      { id: "e3", currency: "usd", amountCents: 100 },
    ]);

    const orders = await pool!.query(
      `SELECT "id", "currency" FROM "Order" ORDER BY "id"`,
    );
    expect(orders.rows).toStrictEqual([
      { id: "o1", currency: "usd" },
      { id: "o2", currency: "usd" },
    ]);

    const constraints = await pool!.query(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1) ORDER BY conname`,
      [[...CONSTRAINTS]],
    );
    expect(constraints.rows.map((r) => r.conname)).toStrictEqual(
      [...CONSTRAINTS].sort(),
    );

    // The invariant holds from here on: a raw casing is rejected on write.
    await expect(
      pool!.query(
        `INSERT INTO "PayeeLedgerBalance" ("payeeId", "currency") VALUES ('payee_3', 'USD')`,
      ),
    ).rejects.toThrow(/PayeeLedgerBalance_currency_normalized_check/);
    await expect(
      pool!.query(
        `INSERT INTO "PayeeLedgerEntry" ("id", "payeeId", "amountCents", "currency")
         VALUES ('e9', 'payee_1', 1, 'USD')`,
      ),
    ).rejects.toThrow(/PayeeLedgerEntry_currency_normalized_check/);
    await expect(
      pool!.query(`INSERT INTO "Order" ("id", "currency") VALUES ('o9', 'USD')`),
    ).rejects.toThrow(/Order_currency_normalized_check/);
  });

  test("lock_timeout applies inside the migration's transaction and does not leak to the session", async () => {
    await seed();
    const client = await pool!.connect();
    try {
      // Same simple-query, multi-statement send Prisma uses: the file runs as
      // one implicit transaction, so SET LOCAL holds until its end.
      const results = (await client.query(
        `${MIGRATION_SQL}\nSELECT current_setting('lock_timeout') AS lt;`,
      )) as unknown as pg.QueryResult[];
      expect(results[results.length - 1]!.rows[0]).toStrictEqual({ lt: "5s" });

      const after = await client.query(`SHOW lock_timeout`);
      expect(after.rows[0]).toStrictEqual({ lock_timeout: "0" });
    } finally {
      client.release();
    }
  });

  /** Polls pg_locks for the migration's first ungranted relation lock. */
  async function firstWait(): Promise<
    { pid: number; relname: string; mode: string } | undefined
  > {
    for (let i = 0; i < 50; i++) {
      const waiting = await pool!.query(
        `SELECT l.pid, c.relname, l.mode FROM pg_locks l
           JOIN pg_class c ON c.oid = l.relation
          WHERE NOT l.granted
            AND c.relname IN ('PayeeLedgerEntry', 'PayeeLedgerBalance', 'Order')`,
      );
      if (waiting.rows[0]) return waiting.rows[0];
      await new Promise((r) => setTimeout(r, 100));
    }
    return undefined;
  }

  test("all three tables are locked ACCESS EXCLUSIVE up front: a live write makes it wait before any change, time out, and roll back whole", async () => {
    await seed();
    const writer = await pool!.connect();
    try {
      await writer.query("BEGIN");
      // An in-flight order insert: ROW EXCLUSIVE on Order, which step 3's
      // UPDATE alone would NOT wait on.
      await writer.query(
        `INSERT INTO "Order" ("id", "currency") VALUES ('o_live', 'usd')`,
      );

      const started = Date.now();
      const migration = pool!.query(MIGRATION_SQL).then(
        () => null,
        (err: unknown) => err,
      );

      // The first wait is the up-front LOCK, on the first table it names
      // (Order), at its final strength, and the migration holds NO lock on
      // any of the three tables yet: nothing has been read or changed.
      // Without the up-front LOCK, steps 1-3 run first (holding ROW
      // EXCLUSIVE on all three) and the first wait is the later ALTER.
      const wait = await firstWait();
      expect(wait).toMatchObject({
        relname: "Order",
        mode: "AccessExclusiveLock",
      });
      const held = await pool!.query(
        `SELECT c.relname, l.mode FROM pg_locks l
           JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = $1 AND l.granted
            AND c.relname IN ('PayeeLedgerEntry', 'PayeeLedgerBalance', 'Order')`,
        [wait!.pid],
      );
      expect(held.rows).toStrictEqual([]);

      const err = await migration;
      expect(String(err)).toMatch(/lock timeout/i);
      const waitedMs = Date.now() - started;
      expect(waitedMs).toBeGreaterThanOrEqual(4_500);
      expect(waitedMs).toBeLessThan(30_000);

      await writer.query("ROLLBACK");
    } finally {
      writer.release();
    }

    // Nothing from the failed run stuck.
    const entries = await pool!.query(
      `SELECT "id", "currency" FROM "PayeeLedgerEntry" ORDER BY "id"`,
    );
    expect(entries.rows).toStrictEqual([
      { id: "e1", currency: "USD" },
      { id: "e2", currency: "Usd" },
      { id: "e3", currency: "usd" },
    ]);
    const balances = await pool!.query(
      `SELECT "payeeId", "currency", "ledgerBalanceCents" FROM "PayeeLedgerBalance"
        ORDER BY "payeeId", "currency" COLLATE "C"`,
    );
    expect(balances.rows).toStrictEqual([
      { payeeId: "payee_1", currency: "USD", ledgerBalanceCents: 2000 },
      { payeeId: "payee_1", currency: "Usd", ledgerBalanceCents: 4000 },
      { payeeId: "payee_1", currency: "usd", ledgerBalanceCents: 1000 },
      { payeeId: "payee_2", currency: "USD", ledgerBalanceCents: 7777 },
    ]);
    const orders = await pool!.query(
      `SELECT "id", "currency" FROM "Order" ORDER BY "id"`,
    );
    expect(orders.rows).toStrictEqual([
      { id: "o1", currency: "USD" },
      { id: "o2", currency: "usd" },
    ]);
    const constraints = await pool!.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = ANY($1)`,
      [[...CONSTRAINTS]],
    );
    expect(constraints.rows[0]).toStrictEqual({ n: 0 });
  }, 60_000);

  test("a live entry-then-balance write running into the migration commits, then the migration applies — no deadlock", async () => {
    // The app's order: insert an entry, then upsert the balance. Were the
    // migration to take ROW EXCLUSIVE on the entry table, then lock the
    // balance table, then ask ACCESS EXCLUSIVE on the entry table for the
    // ALTER, this transaction and the migration would wait on each other.
    await seed();
    const app = await pool!.connect();
    try {
      await app.query("BEGIN");
      await app.query(
        `INSERT INTO "PayeeLedgerEntry" ("id", "payeeId", "amountCents", "currency")
         VALUES ('e_live', 'payee_2', 1, 'usd')`,
      );

      const migration = pool!.query(MIGRATION_SQL).then(
        () => null,
        (err: unknown) => err,
      );
      expect(await firstWait()).toMatchObject({
        relname: "PayeeLedgerEntry",
        mode: "AccessExclusiveLock",
      });

      // The migration holds nothing yet, so the balance write goes through.
      await app.query(
        `UPDATE "PayeeLedgerBalance" SET "ledgerBalanceCents" = "ledgerBalanceCents" + 1
          WHERE "payeeId" = 'payee_2' AND "currency" = 'USD'`,
      );
      await app.query("COMMIT");

      expect(await migration).toBeNull();
    } finally {
      app.release();
    }

    // The live write survived and was normalised with everything else.
    const balance = await pool!.query(
      `SELECT "currency", "ledgerBalanceCents" FROM "PayeeLedgerBalance"
        WHERE "payeeId" = 'payee_2'`,
    );
    expect(balance.rows).toStrictEqual([
      { currency: "usd", ledgerBalanceCents: 7778 },
    ]);
    const live = await pool!.query(
      `SELECT "currency" FROM "PayeeLedgerEntry" WHERE "id" = 'e_live'`,
    );
    expect(live.rows[0]).toStrictEqual({ currency: "usd" });
  }, 60_000);
  test("a live Order-then-entry write running into the migration commits, then the migration applies — no deadlock", async () => {
    // The app's order for cash sales, cash refunds and disputes: touch the
    // Order, then write the ledger. Were the migration to lock the ledger
    // tables before Order, it would hold the entry table while waiting on
    // Order, and this transaction's entry insert would wait on it: a cycle.
    await seed();
    const app = await pool!.connect();
    try {
      await app.query("BEGIN");
      await app.query(
        `INSERT INTO "Order" ("id", "currency") VALUES ('o_live', 'USD')`,
      );

      const migration = pool!.query(MIGRATION_SQL).then(
        () => null,
        (err: unknown) => err,
      );
      expect(await firstWait()).toMatchObject({
        relname: "Order",
        mode: "AccessExclusiveLock",
      });

      // The migration holds nothing yet, so the ledger write goes through.
      await app.query(
        `INSERT INTO "PayeeLedgerEntry" ("id", "payeeId", "amountCents", "currency")
         VALUES ('e_live', 'payee_2', 1, 'USD')`,
      );
      await app.query("COMMIT");

      expect(await migration).toBeNull();
    } finally {
      app.release();
    }

    // Both live rows survived and were normalised with everything else.
    const order = await pool!.query(
      `SELECT "currency" FROM "Order" WHERE "id" = 'o_live'`,
    );
    expect(order.rows[0]).toStrictEqual({ currency: "usd" });
    const entry = await pool!.query(
      `SELECT "currency" FROM "PayeeLedgerEntry" WHERE "id" = 'e_live'`,
    );
    expect(entry.rows[0]).toStrictEqual({ currency: "usd" });
  }, 60_000);
});
