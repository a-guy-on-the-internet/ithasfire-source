import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { TaxNexusRollupRow } from "@th/ports/repos/orders";
import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import { getTaxNexusRollup } from "@th/core/use-cases/tax/get-tax-nexus-rollup";

import { makeOrdersRepo } from "../orders";

// ---------------------------------------------------------------------------
// `getTaxNexusRollup` nets partial refunds (integration).
//
// The rollup answers "what tax do we owe this state". Until now a
// PART_REFUNDED order contributed its FULL original `taxAmountCents` and its
// FULL `amountGrossCents`, overstating both — safe for threshold-watching,
// wrong for a return.
//
// This hits real Postgres because the netting IS the SQL: a LATERAL aggregate
// over OrderItem folded into the situs grouping, `SUM ... FILTER`, NULL
// handling, and integer rounding of a proportional slice. None of that is
// provable against a mocked Prisma client.
//
// THE MIGRATION SQL IS READ FROM DISK. `refundedTaxCents` is added to the
// table by the exact bytes that will run on prod, not by a hand-copied
// `ALTER TABLE` that would stay green if the shipped DDL were changed.
// ---------------------------------------------------------------------------

const MIGRATION_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations/20260907120000_order_item_refunded_tax_cents/migration.sql",
  ),
  "utf8",
);

/** `OrderTaxLine`, likewise from the shipped migration bytes. */
const TAX_LINES_MIGRATION_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations/20260928120000_order_tax_lines/migration.sql",
  ),
  "utf8",
);

/**
 * Just the columns the rollup reads, with Prisma's default mapping (quoted
 * PascalCase table, camelCase columns). `OrderItem` is created WITHOUT
 * `refundedTaxCents` on purpose — the migration under test adds it.
 */
const TABLE_SQL = `
CREATE TYPE "OrderStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'SUCCEEDED', 'PART_REFUNDED',
  'REFUNDED', 'DISPUTED', 'CANCELLED'
);

CREATE TABLE "Order" (
  "id"               TEXT NOT NULL,
  "status"           "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "amountGrossCents" INTEGER NOT NULL,
  "taxAmountCents"   INTEGER NOT NULL DEFAULT 0,
  "taxSitusCountry"  VARCHAR(2),
  "taxSitusState"    TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderItem" (
  "id"          TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "meta"        JSONB NOT NULL DEFAULT '{}',
  "status"      TEXT NOT NULL DEFAULT 'active',
  CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId")
    REFERENCES "Order"("id") ON DELETE CASCADE
);
`;

const SINCE = new Date("2026-01-01T00:00:00.000Z");
const IN_WINDOW = new Date("2026-06-01T00:00:00.000Z");
const BEFORE_WINDOW = new Date("2025-06-01T00:00:00.000Z");

type SeedItem = {
  id: string;
  kind?: string;
  amountCents: number;
  status?: string;
  refundedTaxCents?: number | null;
  meta?: Record<string, unknown>;
};

type SeedTaxLine = {
  code: string;
  jurisdiction: string;
  base: "TICKET_FACE" | "BUYER_TOTAL";
  collector?: "PLATFORM" | "ORGANISER";
  amountCents: number;
};

/** The five fields the rollup returned before `taxLineParts` existed. */
function existingFields(rows: TaxNexusRollupRow[]) {
  return rows.map(
    ({ country, state, netSalesCents, taxCollectedCents, orderCount }) => ({
      country,
      state,
      netSalesCents,
      taxCollectedCents,
      orderCount,
    }),
  );
}

describe("getTaxNexusRollup partial-refund netting (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    await pool.query(MIGRATION_SQL);
    await pool.query(TAX_LINES_MIGRATION_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool!.query(`TRUNCATE "OrderTaxLine", "OrderItem", "Order" CASCADE`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  async function seedOrder(order: {
    id: string;
    status: string;
    amountGrossCents: number;
    taxAmountCents: number;
    country: string | null;
    state: string | null;
    createdAt?: Date;
    items: SeedItem[];
    taxLines?: SeedTaxLine[];
  }) {
    await pool!.query(
      `INSERT INTO "Order"
         ("id","status","amountGrossCents","taxAmountCents",
          "taxSitusCountry","taxSitusState","createdAt")
       VALUES ($1,$2::"OrderStatus",$3,$4,$5,$6,$7)`,
      [
        order.id,
        order.status,
        order.amountGrossCents,
        order.taxAmountCents,
        order.country,
        order.state,
        order.createdAt ?? IN_WINDOW,
      ],
    );

    for (const item of order.items) {
      await pool!.query(
        `INSERT INTO "OrderItem"
           ("id","orderId","kind","amountCents","status","refundedTaxCents","meta")
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          item.id,
          order.id,
          item.kind ?? "ticket",
          item.amountCents,
          item.status ?? "active",
          item.refundedTaxCents ?? null,
          JSON.stringify(item.meta ?? {}),
        ],
      );
    }

    for (const [index, line] of (order.taxLines ?? []).entries()) {
      await pool!.query(
        `INSERT INTO "OrderTaxLine"
           ("id","orderId","code","label","jurisdiction","rateBps","base",
            "collector","taxableAmountCents","amountCents")
         VALUES ($1,$2,$3,$3,$4,0,$5::"OrderTaxBase",$6::"OrderTaxCollector",0,$7)`,
        [
          `${order.id}-tl-${index}`,
          order.id,
          line.code,
          line.jurisdiction,
          line.base,
          line.collector ?? "PLATFORM",
          line.amountCents,
        ],
      );
    }
  }

  const rollup = () =>
    makeOrdersRepo(prisma!).getTaxNexusRollup({ since: SINCE });

  test("a PART_REFUNDED order contributes only what it kept", async () => {
    // Three $30 tickets + $3 platform fee each, tax 800, two refunded. The
    // refund stamped 247c of tax on each (see refund-tax-share.ts).
    await seedOrder({
      id: "o-part",
      status: "PART_REFUNDED",
      amountGrossCents: 9900,
      taxAmountCents: 800,
      country: "US",
      state: "TN",
      items: [
        { id: "i-1", amountCents: 3300, status: "refunded", refundedTaxCents: 247 },
        { id: "i-2", amountCents: 3300, status: "refunded", refundedTaxCents: 247 },
        { id: "i-3", amountCents: 3300 },
      ],
    });

    const rows = await rollup();

    expect(existingFields(rows)).toEqual([
      {
        country: "US",
        state: "TN",
        // BEFORE this change: 9900 gross and 800 tax — the whole order, as if
        // nothing had been returned. AFTER: two thirds of each is netted out.
        netSalesCents: 3300,
        taxCollectedCents: 306,
        orderCount: 1,
      },
    ]);
  });

  test("fully REFUNDED orders still drop out entirely, and are not double-netted", async () => {
    await seedOrder({
      id: "o-refunded",
      status: "REFUNDED",
      amountGrossCents: 5000,
      taxAmountCents: 400,
      country: "US",
      state: "TN",
      items: [
        { id: "r-1", amountCents: 5000, status: "refunded", refundedTaxCents: 400 },
      ],
    });

    expect(existingFields(await rollup())).toEqual([]);
  });

  test("an UNATTRIBUTED refund (NULL) degrades to the old overstatement, never to a credit", async () => {
    // Refunds issued before the column existed. SUM skips NULL, so the tax leg
    // keeps its pre-change value rather than inventing a netting. The gross
    // leg needs no stamp, so it nets these historical rows correctly.
    await seedOrder({
      id: "o-null",
      status: "PART_REFUNDED",
      amountGrossCents: 4000,
      taxAmountCents: 300,
      country: "US",
      state: "FL",
      items: [
        { id: "n-1", amountCents: 2000, status: "refunded", refundedTaxCents: null },
        { id: "n-2", amountCents: 2000 },
      ],
    });

    expect(existingFields(await rollup())).toEqual([
      {
        country: "US",
        state: "FL",
        netSalesCents: 2000,
        taxCollectedCents: 300,
        orderCount: 1,
      },
    ]);
  });

  test("gross netting is proportional, so a discounted order is not over-netted", async () => {
    // `amountGrossCents` is POST-discount (1800) while the ticket lines still
    // carry face value (2 x 1000). Subtracting the refunded line's
    // `amountCents` outright would net 1000 off an 1800 basis and understate
    // the state's sales; scaling by the refunded fraction nets 900.
    await seedOrder({
      id: "o-discount",
      status: "PART_REFUNDED",
      amountGrossCents: 1800,
      taxAmountCents: 100,
      country: "CA",
      state: "AB",
      items: [
        { id: "d-1", amountCents: 1000, status: "refunded", refundedTaxCents: 50 },
        { id: "d-2", amountCents: 1000 },
      ],
    });

    expect(existingFields(await rollup())).toEqual([
      {
        country: "CA",
        state: "AB",
        netSalesCents: 900,
        taxCollectedCents: 50,
        orderCount: 1,
      },
    ]);
  });

  test("groups by situs, counts orders, and honours the window", async () => {
    await seedOrder({
      id: "g-1",
      status: "PART_REFUNDED",
      amountGrossCents: 9900,
      taxAmountCents: 800,
      country: "US",
      state: "TN",
      items: [
        { id: "g1-1", amountCents: 3300, status: "refunded", refundedTaxCents: 247 },
        { id: "g1-2", amountCents: 3300, status: "refunded", refundedTaxCents: 247 },
        { id: "g1-3", amountCents: 3300 },
      ],
    });
    await seedOrder({
      id: "g-2",
      status: "SUCCEEDED",
      amountGrossCents: 5000,
      taxAmountCents: 400,
      country: "US",
      state: "TN",
      items: [{ id: "g2-1", amountCents: 5000 }],
    });
    await seedOrder({
      id: "g-3",
      status: "SUCCEEDED",
      amountGrossCents: 7000,
      taxAmountCents: 500,
      country: "US",
      state: "TN",
      createdAt: BEFORE_WINDOW,
      items: [{ id: "g3-1", amountCents: 7000 }],
    });

    const rows = await rollup();

    expect(existingFields(rows)).toEqual([
      {
        country: "US",
        state: "TN",
        netSalesCents: 3300 + 5000,
        taxCollectedCents: 306 + 400,
        orderCount: 2,
      },
    ]);
  });

  test("an order with no ticket lines is left alone rather than divided by zero", async () => {
    await seedOrder({
      id: "o-membership",
      status: "SUCCEEDED",
      amountGrossCents: 2500,
      taxAmountCents: 200,
      country: "US",
      state: "NY",
      items: [{ id: "m-1", kind: "membership", amountCents: 2500 }],
    });

    expect(existingFields(await rollup())).toEqual([
      {
        country: "US",
        state: "NY",
        netSalesCents: 2500,
        taxCollectedCents: 200,
        orderCount: 1,
      },
    ]);
  });

  // ── taxByLine (per-tax-line breakdown) ───────────────────────────────────
  //
  // The SQL produces the parts; the use case folds them, splitting multi-line
  // refunds with the same allocator the refund paths stamped them with. So
  // this runs the REAL use case over the REAL repo: the invariant under test
  // spans both.

  const MN = "US/MN";
  const MPLS = "US/MN/Minneapolis";
  const TN = "US/TN";
  const FL = "US/FL";
  const WI = "US/WI";
  const OH = "US/OH";
  const MI = "US/MI";
  const DETROIT = "US/MI/Detroit";

  async function seedPerLineFixture() {
    // 1. Single-line MN order, one item part-refunded (stamp 150 of 300).
    await seedOrder({
      id: "pl-single",
      status: "PART_REFUNDED",
      amountGrossCents: 4000,
      taxAmountCents: 300,
      country: "US",
      state: "MN",
      items: [
        { id: "pl-s-1", amountCents: 2000, status: "refunded", refundedTaxCents: 150 },
        { id: "pl-s-2", amountCents: 2000 },
      ],
      taxLines: [
        { code: "SALES", jurisdiction: MN, base: "BUYER_TOTAL", amountCents: 300 },
      ],
    });
    // 2. Two-line Minneapolis order; item a refunded, stamped 316 (= SALES
    //    241 + MPLS 75 under the per-line allocator).
    await seedOrder({
      id: "pl-two",
      status: "PART_REFUNDED",
      amountGrossCents: 3865,
      taxAmountCents: 454,
      country: "US",
      state: "MN",
      items: [
        {
          id: "pl-a",
          amountCents: 2500,
          meta: { buyerTotalCents: 2665 },
          status: "refunded",
          refundedTaxCents: 316,
        },
        { id: "pl-b", amountCents: 1000, meta: { buyerTotalCents: 1200 } },
      ],
      taxLines: [
        { code: "SALES", jurisdiction: MN, base: "BUYER_TOTAL", amountCents: 349 },
        {
          code: "MPLS_ENTERTAINMENT",
          jurisdiction: MPLS,
          base: "TICKET_FACE",
          amountCents: 105,
        },
      ],
    });
    // 3. Legacy MN order: no tax lines at all.
    await seedOrder({
      id: "pl-legacy",
      status: "SUCCEEDED",
      amountGrossCents: 5000,
      taxAmountCents: 400,
      country: "US",
      state: "MN",
      items: [{ id: "pl-l-1", amountCents: 5000 }],
    });
    // A fully REFUNDED two-line MN order: drops out on status, lines and all.
    await seedOrder({
      id: "pl-refunded",
      status: "REFUNDED",
      amountGrossCents: 3865,
      taxAmountCents: 454,
      country: "US",
      state: "MN",
      items: [
        {
          id: "pl-r-a",
          amountCents: 2500,
          meta: { buyerTotalCents: 2665 },
          status: "refunded",
          refundedTaxCents: 316,
        },
        {
          id: "pl-r-b",
          amountCents: 1000,
          meta: { buyerTotalCents: 1200 },
          status: "refunded",
          refundedTaxCents: 138,
        },
      ],
      taxLines: [
        { code: "SALES", jurisdiction: MN, base: "BUYER_TOTAL", amountCents: 349 },
        {
          code: "MPLS_ENTERTAINMENT",
          jurisdiction: MPLS,
          base: "TICKET_FACE",
          amountCents: 105,
        },
      ],
    });
    // 4. TN order, so rows stay separate. Its ORGANISER line is disclosed,
    //    never charged, and must not appear.
    await seedOrder({
      id: "pl-tn",
      status: "SUCCEEDED",
      amountGrossCents: 3000,
      taxAmountCents: 210,
      country: "US",
      state: "TN",
      items: [{ id: "pl-t-1", amountCents: 3000 }],
      taxLines: [
        { code: "SALES", jurisdiction: TN, base: "BUYER_TOTAL", amountCents: 210 },
        {
          code: "VENUE_TAX",
          jurisdiction: TN,
          base: "TICKET_FACE",
          collector: "ORGANISER",
          amountCents: 50,
        },
      ],
    });
    // 5. Unstamped situs (NULL country + state) with one line: pins the
    //    IS NOT DISTINCT FROM join of lines back to their row.
    await seedOrder({
      id: "pl-null-situs",
      status: "SUCCEEDED",
      amountGrossCents: 2000,
      taxAmountCents: 100,
      country: null,
      state: null,
      items: [{ id: "pl-n-1", amountCents: 2000 }],
      taxLines: [
        { code: "SALES", jurisdiction: "US/XX", base: "BUYER_TOTAL", amountCents: 100 },
      ],
    });
    // 6. SUCCEEDED two-line MN order, nothing refunded: charged on both lines,
    //    but NOT a split order.
    await seedOrder({
      id: "pl-two-unrefunded",
      status: "SUCCEEDED",
      amountGrossCents: 3865,
      taxAmountCents: 454,
      country: "US",
      state: "MN",
      items: [
        { id: "pl-u-a", amountCents: 2500, meta: { buyerTotalCents: 2665 } },
        { id: "pl-u-b", amountCents: 1000, meta: { buyerTotalCents: 1200 } },
      ],
      taxLines: [
        { code: "SALES", jurisdiction: MN, base: "BUYER_TOTAL", amountCents: 349 },
        {
          code: "MPLS_ENTERTAINMENT",
          jurisdiction: MPLS,
          base: "TICKET_FACE",
          amountCents: 105,
        },
      ],
    });
    // 7. Single-line order with a NULL stamp on its refunded item: nothing was
    //    netted, so the line keeps its whole charge.
    await seedOrder({
      id: "pl-null-stamp",
      status: "PART_REFUNDED",
      amountGrossCents: 4000,
      taxAmountCents: 300,
      country: "US",
      state: "FL",
      items: [
        { id: "pl-f-1", amountCents: 2000, status: "refunded", refundedTaxCents: null },
        { id: "pl-f-2", amountCents: 2000 },
      ],
      taxLines: [
        { code: "SALES", jurisdiction: FL, base: "BUYER_TOTAL", amountCents: 300 },
      ],
    });
    // 8. A lone line that DISAGREES with the order's tax (100 vs 60), stamps
    //    90: SALES keeps 60 and refunds nothing; 100 − 60 − 90 = −50 goes to
    //    UNATTRIBUTED, and the order is reported.
    await seedOrder({
      id: "pl-mismatch",
      status: "PART_REFUNDED",
      amountGrossCents: 2000,
      taxAmountCents: 100,
      country: "US",
      state: "WI",
      items: [
        { id: "pl-w-1", amountCents: 1000, status: "refunded", refundedTaxCents: 90 },
        { id: "pl-w-2", amountCents: 1000 },
      ],
      taxLines: [
        { code: "SALES", jurisdiction: WI, base: "BUYER_TOTAL", amountCents: 60 },
      ],
    });
    // 9. ≤0 PLATFORM lines are ignored everywhere. One order carries a real
    //    line beside a −5 and a 0; the other has ONLY a −5 line, so it is a
    //    no-line order (counting the −5 on one side only would break Σ by 5).
    await seedOrder({
      id: "pl-oh-mixed",
      status: "SUCCEEDED",
      amountGrossCents: 3000,
      taxAmountCents: 200,
      country: "US",
      state: "OH",
      items: [{ id: "pl-o-1", amountCents: 3000 }],
      taxLines: [
        { code: "SALES", jurisdiction: OH, base: "BUYER_TOTAL", amountCents: 200 },
        { code: "ADJ", jurisdiction: OH, base: "BUYER_TOTAL", amountCents: -5 },
        { code: "ZERO", jurisdiction: OH, base: "TICKET_FACE", amountCents: 0 },
      ],
    });
    await seedOrder({
      id: "pl-oh-negative-only",
      status: "SUCCEEDED",
      amountGrossCents: 2000,
      taxAmountCents: 150,
      country: "US",
      state: "OH",
      items: [{ id: "pl-o2-1", amountCents: 2000 }],
      taxLines: [
        { code: "ADJ", jurisdiction: OH, base: "BUYER_TOTAL", amountCents: -5 },
      ],
    });
    // 10. SUCCEEDED two-line order whose lines (150 + 40 = 190) disagree with
    //     its tax (200), nothing refunded: counted in lineMismatchOrderCount,
    //     the 10 residual on UNATTRIBUTED.
    await seedOrder({
      id: "pl-mi-mismatch",
      status: "SUCCEEDED",
      amountGrossCents: 3000,
      taxAmountCents: 200,
      country: "US",
      state: "MI",
      items: [{ id: "pl-mi-1", amountCents: 3000 }],
      taxLines: [
        { code: "SALES", jurisdiction: MI, base: "BUYER_TOTAL", amountCents: 150 },
        { code: "CITY", jurisdiction: DETROIT, base: "TICKET_FACE", amountCents: 40 },
      ],
    });
    // 11. The same disagreement (60 + 30 = 90 vs 100) on a PART_REFUNDED order
    //     (stamp 50): a split order, so NOT in the count. Core's allocator
    //     flags it and reports it once, by id; its stamp goes to UNATTRIBUTED.
    await seedOrder({
      id: "pl-mi-split-mismatch",
      status: "PART_REFUNDED",
      amountGrossCents: 2000,
      taxAmountCents: 100,
      country: "US",
      state: "MI",
      items: [
        { id: "pl-mi-2", amountCents: 1000, status: "refunded", refundedTaxCents: 50 },
        { id: "pl-mi-3", amountCents: 1000 },
      ],
      taxLines: [
        { code: "SALES", jurisdiction: MI, base: "BUYER_TOTAL", amountCents: 60 },
        { code: "CITY", jurisdiction: DETROIT, base: "TICKET_FACE", amountCents: 30 },
      ],
    });
  }

  test("existing fields are unchanged by the per-line parts", async () => {
    await seedPerLineFixture();

    // Pre-change expectation, computed with the unchanged formulas:
    // MN gross 4000 − 2000 + 3865 − round(3865 × 2500 / 3500 = 2760.7) + 5000
    //   + 3865; MN tax (300 − 150) + (454 − 316) + 400 + 454.
    // Lines never touched these figures: FL keeps its full tax (NULL stamp),
    // WI nets the 90 stamp, OH ignores its ≤0 lines, NULL situs sorts last.
    expect(existingFields(await rollup())).toEqual(EXPECTED_EXISTING);
  });

  const EXPECTED_EXISTING = [
    { country: "US", state: "FL", netSalesCents: 2000, taxCollectedCents: 300, orderCount: 1 },
    // 3000 + (2000 − 1000); 200 + (100 − 50).
    { country: "US", state: "MI", netSalesCents: 4000, taxCollectedCents: 250, orderCount: 2 },
    {
      country: "US",
      state: "MN",
      netSalesCents: 2000 + 1104 + 5000 + 3865,
      taxCollectedCents: 150 + 138 + 400 + 454,
      orderCount: 4,
    },
    { country: "US", state: "OH", netSalesCents: 5000, taxCollectedCents: 350, orderCount: 2 },
    { country: "US", state: "TN", netSalesCents: 3000, taxCollectedCents: 210, orderCount: 1 },
    { country: "US", state: "WI", netSalesCents: 1000, taxCollectedCents: 10, orderCount: 1 },
    { country: null, state: null, netSalesCents: 2000, taxCollectedCents: 100, orderCount: 1 },
  ];

  test("existing fields hold for every row", async () => {
    await seedPerLineFixture();
    expect(existingFields(await rollup())).toEqual(EXPECTED_EXISTING);
  });

  test("the SQL parts: exact single-line refunds, legacy as unattributed, split orders listed", async () => {
    await seedPerLineFixture();

    const rows = await rollup();

    expect(rows.map((row) => row.taxLineParts)).toEqual([
      {
        // FL: exact single line, the NULL stamp nets nothing.
        lines: [
          { code: "SALES", jurisdiction: FL, chargedCents: 300, refundedCents: 0 },
        ],
        unattributedCents: 0,
        lineMismatchOrderCount: 0,
        splitOrders: [],
      },
      {
        // MI: residuals (200 − 190) + (100 − 90); only the unrefunded order
        // is counted, the refunded one is a split order.
        lines: [
          { code: "CITY", jurisdiction: DETROIT, chargedCents: 70, refundedCents: 0 },
          { code: "SALES", jurisdiction: MI, chargedCents: 210, refundedCents: 0 },
        ],
        unattributedCents: 20,
        lineMismatchOrderCount: 1,
        splitOrders: [
          {
            orderId: "pl-mi-split-mismatch",
            taxAmountCents: 100,
            refundedTaxCents: 50,
          },
        ],
      },
      {
        lines: [
          {
            code: "MPLS_ENTERTAINMENT",
            jurisdiction: MPLS,
            chargedCents: 105 + 105,
            refundedCents: 0,
          },
          // 300 + 349 + 349 charged; only the single-line order's 150 is
          // exact here.
          {
            code: "SALES",
            jurisdiction: MN,
            chargedCents: 300 + 349 + 349,
            refundedCents: 150,
          },
        ],
        unattributedCents: 400,
        lineMismatchOrderCount: 0,
        // The unrefunded two-line order is NOT here; only the refunded one.
        splitOrders: [
          { orderId: "pl-two", taxAmountCents: 454, refundedTaxCents: 316 },
        ],
      },
      {
        // OH: no ADJ / ZERO entries; the −5-only order is a no-line order.
        lines: [
          { code: "SALES", jurisdiction: OH, chargedCents: 200, refundedCents: 0 },
        ],
        unattributedCents: 150,
        lineMismatchOrderCount: 0,
        splitOrders: [],
      },
      {
        lines: [
          { code: "SALES", jurisdiction: TN, chargedCents: 210, refundedCents: 0 },
        ],
        unattributedCents: 0,
        lineMismatchOrderCount: 0,
        splitOrders: [],
      },
      {
        // WI: the disagreeing line refunds nothing; 100 − 60 − 90.
        lines: [
          { code: "SALES", jurisdiction: WI, chargedCents: 60, refundedCents: 0 },
        ],
        unattributedCents: -50,
        lineMismatchOrderCount: 1,
        splitOrders: [],
      },
      {
        lines: [
          {
            code: "SALES",
            jurisdiction: "US/XX",
            chargedCents: 100,
            refundedCents: 0,
          },
        ],
        unattributedCents: 0,
        lineMismatchOrderCount: 0,
        splitOrders: [],
      },
    ]);
  });

  test("taxByLine per row, with Σ taxByLine === taxCollectedCents", async () => {
    await seedPerLineFixture();
    const reportError = vi.fn();
    const repos = { orders: makeOrdersRepo(prisma!) } as unknown as Repos;
    const authz = {
      hasStaffRole: async () => ({ allowed: true }),
    } as unknown as AuthZPort;

    const out = await getTaxNexusRollup(
      {
        repos,
        authz,
        clock: { now: () => new Date("2026-07-01T00:00:00.000Z") },
        reportError,
      },
      { actorHumanId: "00000000-0000-4000-8000-000000000001" },
    );

    const taxByLine = [
      [{ code: "SALES", jurisdiction: FL, collectedCents: 300 }],
      [
        { code: "CITY", jurisdiction: DETROIT, collectedCents: 70 },
        { code: "SALES", jurisdiction: MI, collectedCents: 210 },
        // 20 residual − the split order's unattributable 50 stamp.
        { code: "UNATTRIBUTED", jurisdiction: MI, collectedCents: 20 - 50 },
      ],
      [
        // (105 − a's MPLS share 75) + 105 unrefunded.
        { code: "MPLS_ENTERTAINMENT", jurisdiction: MPLS, collectedCents: 30 + 105 },
        // (300 − 150) + (349 − a's SALES share 241) + 349 unrefunded.
        { code: "SALES", jurisdiction: MN, collectedCents: 150 + 108 + 349 },
        // The legacy order: expected, so not reported.
        { code: "UNATTRIBUTED", jurisdiction: MN, collectedCents: 400 },
      ],
      [
        { code: "SALES", jurisdiction: OH, collectedCents: 200 },
        { code: "UNATTRIBUTED", jurisdiction: OH, collectedCents: 150 },
      ],
      [{ code: "SALES", jurisdiction: TN, collectedCents: 210 }],
      [
        { code: "SALES", jurisdiction: WI, collectedCents: 60 },
        { code: "UNATTRIBUTED", jurisdiction: WI, collectedCents: -50 },
      ],
      // NULL situs: UNATTRIBUTED would carry jurisdiction "", but none is due.
      [{ code: "SALES", jurisdiction: "US/XX", collectedCents: 100 }],
    ];
    expect(out.rows).toEqual(
      EXPECTED_EXISTING.map((row, i) => ({ ...row, taxByLine: taxByLine[i] })),
    );
    // The invariant, on EVERY row.
    for (const row of out.rows) {
      expect(
        row.taxByLine.reduce((sum, line) => sum + line.collectedCents, 0),
      ).toBe(row.taxCollectedCents);
    }
    // Each disagreeing order is reported exactly once: MI's unrefunded order
    // via the row count, MI's split order by id, WI's lone line via the row
    // count. Legacy, NULL-stamp and ≤0 lines are not reported.
    const extras = reportError.mock.calls.map(
      (call) => (call[1] as { extra: Record<string, unknown> }).extra,
    );
    expect(extras).toHaveLength(3);
    expect(extras).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "MI",
          lineMismatchOrderCount: 1,
          problems: ["line_mismatch_orders"],
        }),
        expect.objectContaining({
          state: "MI",
          orderId: "pl-mi-split-mismatch",
          unattributedCents: 50,
          problems: ["line_mismatch"],
        }),
        expect.objectContaining({
          state: "WI",
          lineMismatchOrderCount: 1,
          problems: ["line_mismatch_orders"],
        }),
      ]),
    );
  });
});
