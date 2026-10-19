import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeOrdersRepo } from "../orders";

// ---------------------------------------------------------------------------
// OrderTaxLine (integration).
//
// THE MIGRATION SQL IS READ FROM DISK — the exact bytes that run on prod create
// the table, enums, index and FK. A minimal "Order" table stands in for the
// real one (only its primary key matters to the FK). Proves: the repo write +
// read round-trip, the enum columns accept both values, the FK refuses an
// orphan line, ON DELETE CASCADE removes lines with their order, and the
// migration is idempotent (re-running it is a no-op, as `IF NOT EXISTS` claims).
// ---------------------------------------------------------------------------

const MIGRATION_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations/20260928120000_order_tax_lines/migration.sql",
  ),
  "utf8",
);

const TABLE_SQL = `
CREATE TABLE "Order" (
  "id"             TEXT NOT NULL,
  "taxAmountCents" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);
`;

const ORDER_A = "a0000000-0000-4000-8000-00000000000a";
const ORDER_B = "b0000000-0000-4000-8000-00000000000b";

describe("OrderTaxLine persistence (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    await pool.query(MIGRATION_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool!.query(`TRUNCATE "OrderTaxLine", "Order" CASCADE`);
    await pool!.query(
      `INSERT INTO "Order" ("id","taxAmountCents") VALUES ($1, 260), ($2, 0)`,
      [ORDER_A, ORDER_B],
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  test("round-trips PLATFORM + ORGANISER lines through the repo, scoped to the order", async () => {
    const repo = makeOrdersRepo(prisma!);
    await repo.createTaxLines({
      orderId: ORDER_A,
      lines: [
        {
          code: "SALES",
          label: "Sales tax",
          jurisdiction: "US/TN",
          rateBps: 975,
          base: "BUYER_TOTAL",
          collector: "PLATFORM",
          taxableAmountCents: 2665,
          amountCents: 260,
        },
        {
          code: "VENUE_SEAT",
          label: "Venue seat tax",
          jurisdiction: "US/CO/Denver",
          rateBps: 1000,
          base: "TICKET_FACE",
          collector: "ORGANISER",
          taxableAmountCents: 2500,
          amountCents: 250,
        },
      ],
    });
    await repo.createTaxLines({
      orderId: ORDER_B,
      lines: [
        {
          code: "SALES",
          label: "Sales tax",
          jurisdiction: "US/GA",
          rateBps: 890,
          base: "TICKET_FACE",
          collector: "PLATFORM",
          taxableAmountCents: 0,
          amountCents: 0,
        },
      ],
    });

    const lines = await repo.listTaxLines(ORDER_A);
    expect(
      lines
        .map(({ id: _id, createdAt: _at, ...rest }) => rest)
        .sort((a, b) => a.code.localeCompare(b.code)),
    ).toEqual([
      {
        orderId: ORDER_A,
        code: "SALES",
        label: "Sales tax",
        jurisdiction: "US/TN",
        rateBps: 975,
        base: "BUYER_TOTAL",
        collector: "PLATFORM",
        taxableAmountCents: 2665,
        amountCents: 260,
      },
      {
        orderId: ORDER_A,
        code: "VENUE_SEAT",
        label: "Venue seat tax",
        jurisdiction: "US/CO/Denver",
        rateBps: 1000,
        base: "TICKET_FACE",
        collector: "ORGANISER",
        taxableAmountCents: 2500,
        amountCents: 250,
      },
    ]);
    for (const line of lines) {
      expect(typeof line.id).toBe("string");
      expect(line.createdAt).toBeInstanceOf(Date);
    }

    // The invariant the schema documents holds on what was stored.
    const { rows } = await pool!.query<{ platform: string; tax: number }>(
      `SELECT COALESCE(SUM(l."amountCents") FILTER (WHERE l."collector" = 'PLATFORM'), 0) AS platform,
              o."taxAmountCents" AS tax
         FROM "Order" o LEFT JOIN "OrderTaxLine" l ON l."orderId" = o."id"
        WHERE o."id" = $1 GROUP BY o."id"`,
      [ORDER_A],
    );
    expect(Number(rows[0]!.platform)).toBe(rows[0]!.tax);

    expect(await repo.listTaxLines(ORDER_B)).toHaveLength(1);
  });

  test("listTaxLinesByOrderIds groups many orders' lines from one read; unknown ids are absent", async () => {
    const repo = makeOrdersRepo(prisma!);
    const line = (code: string, base: "BUYER_TOTAL" | "TICKET_FACE", amountCents: number) => ({
      code,
      label: code,
      jurisdiction: "US/MN",
      rateBps: 300,
      base,
      collector: "PLATFORM" as const,
      taxableAmountCents: 3500,
      amountCents,
    });
    await repo.createTaxLines({
      orderId: ORDER_A,
      lines: [line("SALES", "BUYER_TOTAL", 349), line("MPLS_ENTERTAINMENT", "TICKET_FACE", 105)],
    });
    await repo.createTaxLines({ orderId: ORDER_B, lines: [line("SALES", "BUYER_TOTAL", 7)] });

    const byOrder = await repo.listTaxLinesByOrderIds([
      ORDER_A,
      ORDER_B,
      "c0000000-0000-4000-8000-00000000000c",
    ]);

    expect([...byOrder.keys()].sort()).toEqual([ORDER_A, ORDER_B].sort());
    expect(byOrder.get(ORDER_A)!.map((l) => l.code).sort()).toEqual([
      "MPLS_ENTERTAINMENT",
      "SALES",
    ]);
    expect(byOrder.get(ORDER_A)!.every((l) => l.orderId === ORDER_A)).toBe(true);
    expect(byOrder.get(ORDER_B)!.map((l) => l.amountCents)).toEqual([7]);
    // Same rows as the single-order read.
    expect(byOrder.get(ORDER_A)).toEqual(await repo.listTaxLines(ORDER_A));
    expect((await repo.listTaxLinesByOrderIds([])).size).toBe(0);
  });

  test("FK refuses a line for an order that does not exist", async () => {
    const repo = makeOrdersRepo(prisma!);
    await expect(
      repo.createTaxLines({
        orderId: "c0000000-0000-4000-8000-00000000000c",
        lines: [
          {
            code: "SALES",
            label: "Sales tax",
            jurisdiction: "US/GA",
            rateBps: 890,
            base: "TICKET_FACE",
            collector: "PLATFORM",
            taxableAmountCents: 100,
            amountCents: 9,
          },
        ],
      }),
    ).rejects.toThrow();
    const { rows } = await pool!.query(`SELECT count(*)::int AS n FROM "OrderTaxLine"`);
    expect(rows[0].n).toBe(0);
  });

  test("deleting the order cascades to its lines only", async () => {
    const repo = makeOrdersRepo(prisma!);
    const line = {
      code: "SALES",
      label: "Sales tax",
      jurisdiction: "US/GA",
      rateBps: 890,
      base: "TICKET_FACE" as const,
      collector: "PLATFORM" as const,
      taxableAmountCents: 100,
      amountCents: 9,
    };
    await repo.createTaxLines({ orderId: ORDER_A, lines: [line] });
    await repo.createTaxLines({ orderId: ORDER_B, lines: [line] });

    await pool!.query(`DELETE FROM "Order" WHERE "id" = $1`, [ORDER_A]);

    expect(await repo.listTaxLines(ORDER_A)).toEqual([]);
    expect(await repo.listTaxLines(ORDER_B)).toHaveLength(1);
  });

  test("the enum columns reject a value outside the model", async () => {
    await expect(
      pool!.query(
        `INSERT INTO "OrderTaxLine"
           ("id","orderId","code","label","jurisdiction","rateBps","base","collector","taxableAmountCents","amountCents")
         VALUES ('x', $1, 'SALES', 'Sales tax', 'US/GA', 890, 'GROSS', 'PLATFORM', 1, 0)`,
        [ORDER_A],
      ),
    ).rejects.toThrow(/invalid input value for enum "OrderTaxBase"/);
  });

  test("the migration is idempotent: re-running it changes nothing and does not error", async () => {
    const repo = makeOrdersRepo(prisma!);
    await repo.createTaxLines({
      orderId: ORDER_A,
      lines: [
        {
          code: "SALES",
          label: "Sales tax",
          jurisdiction: "US/GA",
          rateBps: 890,
          base: "TICKET_FACE",
          collector: "PLATFORM",
          taxableAmountCents: 100,
          amountCents: 9,
        },
      ],
    });
    await pool!.query(MIGRATION_SQL);
    expect(await repo.listTaxLines(ORDER_A)).toHaveLength(1);
    const { rows } = await pool!.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'OrderTaxLine_orderId_fkey'`,
    );
    expect(rows[0].n).toBe(1);
  });
});
