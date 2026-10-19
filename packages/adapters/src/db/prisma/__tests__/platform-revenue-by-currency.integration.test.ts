import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeAnalyticsRepo } from "../analytics";
import { makePayoutItemsRepo } from "../payout-items";

// ---------------------------------------------------------------------------
// Platform revenue aggregates (integration).
//
// Two things are under test and neither is provable against a mocked Prisma
// client:
//
//  1. `getPlatformStats`'s WIDENED STATUS SET. It filtered on
//     `status: "SUCCEEDED"`, so a single partial refund moved an order out of
//     the totals and took its ENTIRE platform fee with it, even though the
//     fee had been charged. The regression only shows against real rows in
//     every status.
//  2. `sumPlatformRevenueByCurrency` / `sumConnectAccountFeesByCurrency` —
//     both are raw grouped SQL with `lower(currency)` normalisation and
//     `::bigint` casts.
//  3. `netKeptCents` — a PER-ORDER expression with four eligibility
//     conditions, a mode-dependent doubling, a LEAST() basis cap and two
//     one-row-per-order LEFT JOINs. None of that is provable in JS against a
//     mock: the joins either multiply the order sums or they do not, and
//     only real rows say which.
//
// Tables are created in a minimal shape: only the columns these aggregates
// touch. `getPlatformStats` also counts Event / Ticket / Human / Organization,
// so those exist as id-only stubs.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "OrderStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'SUCCEEDED', 'PART_REFUNDED',
  'REFUNDED', 'DISPUTED', 'CANCELLED'
);

CREATE TYPE "OrderSource" AS ENUM ('PRIMARY', 'RESALE', 'COMP');

-- The real enum. markDisputeStatus writes Order.disputeStatus and never
-- touches status, so this column is how a disputed order really looks.
CREATE TYPE "DisputeStatus" AS ENUM (
  'NEEDS_TRIAGE', 'OPEN', 'UNDER_REVIEW', 'WON', 'LOST',
  'WARNING_OPEN', 'WARNING_UNDER_REVIEW', 'WARNING_CLOSED'
);

CREATE TABLE "Order" (
  "id"                TEXT NOT NULL,
  "status"            "OrderStatus" NOT NULL DEFAULT 'PENDING',
  -- The real enum and the real default. A RESALE order records
  -- feesPlatformCents 0 with a hardcoded PASS_THROUGH snapshot, so the net
  -- has to exclude it by SOURCE; nothing about the amounts gives it away.
  "source"            "OrderSource" NOT NULL DEFAULT 'PRIMARY',
  -- Wider than the real VARCHAR(3) on purpose, so a padded value can be
  -- stored and the query's btrim is actually exercised.
  "currency"          VARCHAR(8) NOT NULL DEFAULT 'usd',
  "amountGrossCents"  INTEGER NOT NULL DEFAULT 0,
  "feesPlatformCents" INTEGER NOT NULL DEFAULT 0,
  "taxAmountCents"    INTEGER NOT NULL DEFAULT 0,
  -- NULLABLE on purpose, both of them, matching Order in the real schema.
  -- processorFeeCents means "not attributed", never zero -- the query COUNTs
  -- it to report coverage, so a NOT NULL DEFAULT 0 here would make every row
  -- look measured and quietly invert what the test proves.
  -- (No backticks in this comment: it lives inside a template literal.)
  "processorFeeCents" INTEGER,
  -- Sweep bookkeeping (migration 20260915190000): the parked count reads it.
  "processorFeeReadFailures" INTEGER NOT NULL DEFAULT 0,
  "stripePaymentIntentId" TEXT,
  -- JSONB like the real column; the query reads ->>'feeMode' from it.
  "feePolicySnapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- NULLABLE like the real column: NULL is "never disputed".
  "disputeStatus"     "DisputeStatus",
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- Only what the fees-returned subquery touches. refundedPlatformFeeCents is
-- NULLABLE for the same reason processorFeeCents is above: NULL is "not
-- attributed" and the query COUNTs it for coverage.
CREATE TABLE "OrderItem" (
  "id"                       TEXT NOT NULL,
  "orderId"                  TEXT NOT NULL,
  "kind"                     TEXT NOT NULL DEFAULT 'ticket',
  "refundedAt"               TIMESTAMP(3),
  "refundedPlatformFeeCents" INTEGER,
  -- Face and meta, typed like the real columns, for condition (10): the
  -- ticket items' faces and meta.platformFeePerTicketCents decide whether an
  -- unstamped order's tickets are alike. Defaults match the real schema's
  -- meta default, so a fixture that sets neither reads as "fee not recorded".
  "amountCents"              INTEGER NOT NULL DEFAULT 0,
  "meta"                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- Platform-funded credit applied to an order. Only what the net's credit
-- subquery touches. releasedAt / refundedAt are NULLABLE and are what makes
-- a redemption inert: the money went back to the buyer's balance, so the
-- platform is not out of pocket and it must not subtract.
CREATE TABLE "UserCreditRedemption" (
  "id"          TEXT NOT NULL,
  "creditId"    TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "releasedAt"  TIMESTAMP(3),
  "refundedAt"  TIMESTAMP(3),
  CONSTRAINT "UserCreditRedemption_pkey" PRIMARY KEY ("id")
);

-- One row per payee per order, as in the real schema (unique on orderId +
-- payeeId). Condition (10) reads each payee's amount: a payee's credit is
-- attributed to the tickets on its own, so a partial refund of like tickets
-- is exact only when every payee's split divides by the ticket count.
CREATE TABLE "OrderSplit" (
  "id"          TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "payeeId"     TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  CONSTRAINT "OrderSplit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderSplit_orderId_payeeId_key" UNIQUE ("orderId", "payeeId")
);

-- The columns condition (11) reads: the audit row a reconciled Stripe-side
-- partial refund leaves on its order (entity 'order', the order id, action
-- stripe_partial_refund_reconciled).
CREATE TABLE "AuditLog" (
  "id"       TEXT NOT NULL,
  "entity"   TEXT NOT NULL,
  "entityId" TEXT,
  "action"   TEXT NOT NULL,
  "data"     JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayoutItem" (
  "id"                     TEXT NOT NULL,
  "currency"               VARCHAR(3) NOT NULL DEFAULT 'usd',
  "connectAccountFeeCents" INTEGER NOT NULL DEFAULT 0,
  "status"                 TEXT NOT NULL DEFAULT 'pending',
  CONSTRAINT "PayoutItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Event"        ("id" TEXT NOT NULL, CONSTRAINT "Event_pkey" PRIMARY KEY ("id"));
CREATE TABLE "Ticket"       ("id" TEXT NOT NULL, CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id"));
CREATE TABLE "Human"        ("id" TEXT NOT NULL, CONSTRAINT "Human_pkey" PRIMARY KEY ("id"));
CREATE TABLE "Organization" ("id" TEXT NOT NULL, CONSTRAINT "Organization_pkey" PRIMARY KEY ("id"));
`;

describe("platform revenue aggregates (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let analytics: ReturnType<typeof makeAnalyticsRepo>;
  let payoutItems: ReturnType<typeof makePayoutItemsRepo>;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    analytics = makeAnalyticsRepo(prisma);
    payoutItems = makePayoutItemsRepo(prisma);
  }, 300_000);

  beforeEach(async () => {
    await pool!.query(
      `TRUNCATE "Order", "OrderItem", "UserCreditRedemption", "OrderSplit", "AuditLog", "PayoutItem"`,
    );
  });

  // Explicit timeout: tearing a Testcontainers Postgres down routinely takes
  // longer than vitest's 10s default hook timeout.
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  let orderSeq = 0;
  async function order(opts: {
    status: string;
    currency?: string;
    grossCents: number;
    feeCents: number;
    taxCents?: number;
    /** Omitted → an empty snapshot, i.e. no recognisable mode. */
    feeMode?: "PASS_THROUGH" | "ABSORB" | "WEIRD";
    processorFeeCents?: number | null;
    intent?: string | null;
    readFailures?: number;
    /** Omitted → PRIMARY, like the column default. */
    source?: "PRIMARY" | "RESALE" | "COMP";
    /**
     * `feePolicySnapshot.organiserCredit`. Omitted → no key, i.e. an order
     * sold before the 2026-10-11 change (credited price minus fee). Checkout
     * only ever writes "FULL_PRICE"; any other string is here to prove the
     * query reads it as unstamped.
     */
    organiserCredit?: string;
    /**
     * Raw JSON text written to `feePolicySnapshot` verbatim, overriding
     * feeMode/organiserCredit. For shapes the typed options cannot build:
     * arrays, bare scalars, JSON null, wrong-typed marker values.
     */
    rawSnapshot?: string;
    /** `Order.disputeStatus`, the column the dispute lifecycle writes. Omitted → NULL. */
    disputeStatus?: string;
  }): Promise<string> {
    orderSeq += 1;
    const id = `order_${orderSeq}`;
    await pool!.query(
      `INSERT INTO "Order"
         ("id","status","currency","amountGrossCents","feesPlatformCents","taxAmountCents",
          "feePolicySnapshot","processorFeeCents","stripePaymentIntentId","processorFeeReadFailures",
          "source","disputeStatus")
       VALUES ($1, $2::"OrderStatus", $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::"OrderSource",
               $12::"DisputeStatus")`,
      [
        id,
        opts.status,
        opts.currency ?? "usd",
        opts.grossCents,
        opts.feeCents,
        opts.taxCents ?? 0,
        opts.rawSnapshot ??
          JSON.stringify({
            ...(opts.feeMode ? { feeMode: opts.feeMode } : {}),
            ...(opts.organiserCredit
              ? { organiserCredit: opts.organiserCredit }
              : {}),
          }),
        opts.processorFeeCents ?? null,
        opts.intent ?? null,
        opts.readFailures ?? 0,
        opts.source ?? "PRIMARY",
        opts.disputeStatus ?? null,
      ],
    );
    return id;
  }

  let auditSeq = 0;
  /** An AuditLog row on an order, as `tx.audit.log` writes it. */
  async function auditRow(orderId: string, action: string, entity = "order") {
    auditSeq += 1;
    await pool!.query(
      `INSERT INTO "AuditLog" ("id","entity","entityId","action") VALUES ($1, $2, $3, $4)`,
      [`audit_${auditSeq}`, entity, orderId, action],
    );
  }

  let orderItemSeq = 0;
  async function orderItem(opts: {
    orderId: string;
    kind?: string;
    refunded?: boolean;
    refundedPlatformFeeCents?: number | null;
    /** `amountCents`, the face. Omitted → 0. */
    faceCents?: number;
    /**
     * `meta.platformFeePerTicketCents`, as checkout writes it. Omitted → no
     * key. A string is written verbatim, for malformed values.
     */
    feeCents?: number | string;
  }) {
    orderItemSeq += 1;
    await pool!.query(
      `INSERT INTO "OrderItem"
         ("id","orderId","kind","refundedAt","refundedPlatformFeeCents","amountCents","meta")
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        `oi_${orderItemSeq}`,
        opts.orderId,
        opts.kind ?? "ticket",
        opts.refunded ? new Date("2026-09-01T00:00:00.000Z") : null,
        opts.refundedPlatformFeeCents ?? null,
        opts.faceCents ?? 0,
        JSON.stringify(
          opts.feeCents === undefined
            ? {}
            : { platformFeePerTicketCents: opts.feeCents },
        ),
      ],
    );
  }

  /** The zero-valued tail every row carries when nothing is measured. */
  const NOTHING_MEASURED = {
    platformFeesPassThroughCents: 0,
    platformFeesAbsorbCents: 0,
    processorFeeCents: 0,
    processorFeeMeasuredCount: 0,
    processorFeeEligibleCount: 0,
    processorFeeParkedCount: 0,
    feesReturnedCents: 0,
    feesReturnedMeasuredCount: 0,
    feesReturnedEligibleCount: 0,
    // Nothing eligible for the net either: the shared fixtures record no
    // fee mode, which is the first condition that excludes an order.
    netKeptCents: 0,
    netKeptEligibleCount: 0,
  };

  let redemptionSeq = 0;
  async function creditRedemption(opts: {
    orderId: string;
    amountCents: number;
    /** Set → the order died unpaid and the credit went back. Inert. */
    released?: boolean;
    /** Set → the order was refunded and the credit went back. Inert. */
    refunded?: boolean;
  }) {
    redemptionSeq += 1;
    await pool!.query(
      `INSERT INTO "UserCreditRedemption"
         ("id","creditId","orderId","amountCents","releasedAt","refundedAt")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        `ucr_${redemptionSeq}`,
        `credit_${redemptionSeq}`,
        opts.orderId,
        opts.amountCents,
        opts.released ? new Date("2026-09-01T00:00:00.000Z") : null,
        opts.refunded ? new Date("2026-09-02T00:00:00.000Z") : null,
      ],
    );
  }

  let splitSeq = 0;
  /** One OrderSplit row per payee amount, payees named in order. */
  async function splits(orderId: string, amounts: number[]) {
    for (const [i, amountCents] of amounts.entries()) {
      splitSeq += 1;
      await pool!.query(
        `INSERT INTO "OrderSplit" ("id","orderId","payeeId","amountCents")
         VALUES ($1, $2, $3, $4)`,
        [`split_${splitSeq}`, orderId, `payee_${i}`, amountCents],
      );
    }
  }

  let itemSeq = 0;
  async function payoutItem(opts: {
    status: string;
    currency?: string;
    feeCents: number;
  }) {
    itemSeq += 1;
    await pool!.query(
      `INSERT INTO "PayoutItem" ("id","currency","connectAccountFeeCents","status")
       VALUES ($1, $2, $3, $4)`,
      [`item_${itemSeq}`, opts.currency ?? "usd", opts.feeCents, opts.status],
    );
  }

  // ── The bug: a partial refund used to delete a whole order's fee ──────────

  test("a PART_REFUNDED order keeps its platform fee in the totals", async () => {
    await order({ status: "SUCCEEDED", grossCents: 10_000, feeCents: 333 });
    await order({ status: "PART_REFUNDED", grossCents: 20_000, feeCents: 666 });

    const stats = await analytics.getPlatformStats();
    // 333 + 666. The old `status: "SUCCEEDED"` filter reported 333 and
    // silently dropped a fee that had been charged in full.
    expect(stats.totalPlatformFeesCents).toBe(999);
    expect(stats.totalGrossRevenueCents).toBe(30_000);
    expect(stats.totalSucceededOrders).toBe(2);
  });

  test("REFUNDED and DISPUTED orders count; CANCELLED, PENDING and PROCESSING do not", async () => {
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10 });
    await order({ status: "PART_REFUNDED", grossCents: 2_000, feeCents: 20 });
    await order({ status: "REFUNDED", grossCents: 4_000, feeCents: 40 });
    await order({ status: "DISPUTED", grossCents: 8_000, feeCents: 80 });
    // None of these represents captured money — see the adapter comment for
    // the three CANCELLED writers that make that verifiable rather than
    // assumed.
    await order({ status: "CANCELLED", grossCents: 100_000, feeCents: 9_999 });
    await order({ status: "PENDING", grossCents: 100_000, feeCents: 9_999 });
    await order({ status: "PROCESSING", grossCents: 100_000, feeCents: 9_999 });

    const stats = await analytics.getPlatformStats();
    expect(stats.totalPlatformFeesCents).toBe(150);
    expect(stats.totalGrossRevenueCents).toBe(15_000);
    expect(stats.totalSucceededOrders).toBe(4);
    // `totalOrders` is genuinely every order, excluded ones included.
    expect(stats.totalOrders).toBe(7);

    // The grouped read applies the SAME set.
    const byCurrency = await analytics.sumPlatformRevenueByCurrency();
    expect(byCurrency).toEqual([
      {
        currency: "usd",
        ticketVolumeCents: 15_000,
        platformFeesChargedCents: 150,
        taxCollectedCents: 0,
        orderCount: 4,
        ...NOTHING_MEASURED,
        platformFeesUnknownModeCents: 150,
      },
    ]);
  });

  // ── Currency grouping ─────────────────────────────────────────────────────

  test("returns ONE ROW PER CURRENCY and never sums them", async () => {
    await order({ status: "SUCCEEDED", currency: "usd", grossCents: 10_000, feeCents: 333, taxCents: 800 });
    await order({ status: "PART_REFUNDED", currency: "usd", grossCents: 5_000, feeCents: 166, taxCents: 400 });
    await order({ status: "SUCCEEDED", currency: "mxn", grossCents: 90_000, feeCents: 2_000, taxCents: 0 });

    const rows = await analytics.sumPlatformRevenueByCurrency();

    expect(rows).toEqual([
      {
        currency: "mxn",
        ticketVolumeCents: 90_000,
        platformFeesChargedCents: 2_000,
        taxCollectedCents: 0,
        orderCount: 1,
        ...NOTHING_MEASURED,
        platformFeesUnknownModeCents: 2_000,
      },
      {
        currency: "usd",
        ticketVolumeCents: 15_000,
        platformFeesChargedCents: 499,
        taxCollectedCents: 1_200,
        orderCount: 2,
        ...NOTHING_MEASURED,
        platformFeesUnknownModeCents: 499,
      },
    ]);
  });

  test("mixed-casing and padded currencies fold into ONE row, trimmed and lower-cased", async () => {
    await order({ status: "SUCCEEDED", currency: "usd", grossCents: 1_000, feeCents: 10 });
    await order({ status: "SUCCEEDED", currency: "USD", grossCents: 1_500, feeCents: 15 });
    // The test column is widened so a padded value can be stored at all;
    // the query btrims like the ledger reads do, so it folds into "usd".
    await order({ status: "SUCCEEDED", currency: " USD ", grossCents: 500, feeCents: 5 });

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows).toEqual([
      {
        currency: "usd",
        ticketVolumeCents: 3_000,
        platformFeesChargedCents: 30,
        taxCollectedCents: 0,
        orderCount: 3,
        ...NOTHING_MEASURED,
        platformFeesUnknownModeCents: 30,
      },
    ]);
  });

  test("an empty table returns no rows — not a zero row", async () => {
    expect(await analytics.sumPlatformRevenueByCurrency()).toEqual([]);
  });

  // ── The recovered Connect account fee ─────────────────────────────────────

  test("sums connectAccountFeeCents over TRANSFERRED items only, per currency", async () => {
    await payoutItem({ status: "transferred", currency: "usd", feeCents: 200 });
    await payoutItem({ status: "transferred", currency: "usd", feeCents: 0 });
    await payoutItem({ status: "transferred", currency: "USD", feeCents: 50 });
    await payoutItem({ status: "transferred", currency: "mxn", feeCents: 75 });
    // Never transferred → nothing was withheld, so neither may inflate the
    // recovered-cost line.
    await payoutItem({ status: "pending", currency: "usd", feeCents: 9_999 });
    await payoutItem({ status: "failed", currency: "usd", feeCents: 9_999 });

    const rows = await payoutItems.sumConnectAccountFeesByCurrency();

    expect(rows).toEqual([
      { currency: "mxn", connectAccountFeeCents: 75, itemCount: 1 },
      { currency: "usd", connectAccountFeeCents: 250, itemCount: 3 },
    ]);
  });

  test("no transferred items returns no rows at all", async () => {
    await payoutItem({ status: "pending", feeCents: 500 });
    expect(await payoutItems.sumConnectAccountFeesByCurrency()).toEqual([]);
  });

  // ── Fee-mode split ────────────────────────────────────────────────────────

  test("splits the recorded fee by feePolicySnapshot.feeMode, unknown kept apart, all summing to the total", async () => {
    await order({ status: "SUCCEEDED", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH" });
    await order({ status: "PART_REFUNDED", grossCents: 3_000, feeCents: 33, feeMode: "PASS_THROUGH" });
    await order({ status: "SUCCEEDED", grossCents: 10_000, feeCents: 300, feeMode: "ABSORB" });
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 7 }); // no key
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 11, feeMode: "WEIRD" });
    // Excluded status: contributes to no bucket.
    await order({ status: "CANCELLED", grossCents: 9_999, feeCents: 999, feeMode: "ABSORB" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      currency: "usd",
      platformFeesChargedCents: 401,
      platformFeesPassThroughCents: 83,
      platformFeesAbsorbCents: 300,
      platformFeesUnknownModeCents: 18,
      orderCount: 5,
    });
    expect(
      row!.platformFeesPassThroughCents +
        row!.platformFeesAbsorbCents +
        row!.platformFeesUnknownModeCents,
    ).toBe(row!.platformFeesChargedCents);
  });

  // ── Parked processor-fee rows ─────────────────────────────────────────────

  test("counts PARKED orders (at the failure cap, still NULL) without moving the measured counts", async () => {
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, intent: "pi_parked", readFailures: 24 });
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, intent: "pi_backoff", readFailures: 3 });
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, intent: "pi_fresh" });
    // Stamped despite a history of failures: measured, NOT parked.
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, intent: "pi_recovered", readFailures: 30, processorFeeCents: 45 });
    // No intent: not eligible, so it cannot be parked either.
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, intent: null, readFailures: 99 });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 5,
      processorFeeCents: 45,
      processorFeeMeasuredCount: 1,
      processorFeeEligibleCount: 4,
      processorFeeParkedCount: 1,
    });
  });

  // ── Fees returned on refunds ──────────────────────────────────────────────

  test("sums refundedPlatformFeeCents over refunded ticket items, counting NULL stamps as coverage gaps", async () => {
    const o1 = await order({ status: "PART_REFUNDED", grossCents: 6_000, feeCents: 99 });
    const o2 = await order({ status: "REFUNDED", grossCents: 2_000, feeCents: 33 });
    // o1: three ticket items, one refunded and stamped, one refunded and
    // NOT attributed (legacy), one not refunded at all.
    await orderItem({ orderId: o1, refunded: true, refundedPlatformFeeCents: 33 });
    await orderItem({ orderId: o1, refunded: true, refundedPlatformFeeCents: null });
    await orderItem({ orderId: o1, refunded: false });
    // o2: one refunded ticket item, stamped 0 — a MEASURED zero, which must
    // count as measured, not as a gap.
    await orderItem({ orderId: o2, refunded: true, refundedPlatformFeeCents: 0 });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      feesReturnedCents: 33,
      feesReturnedMeasuredCount: 2,
      feesReturnedEligibleCount: 3,
    });
  });

  test("a refunded NON-ticket line is not in the denominator — it was never going to be stamped", async () => {
    const o = await order({ status: "PART_REFUNDED", grossCents: 6_000, feeCents: 99 });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 50 });
    await orderItem({ orderId: o, kind: "discount", refunded: true, refundedPlatformFeeCents: null });
    await orderItem({ orderId: o, kind: "membership", refunded: true, refundedPlatformFeeCents: null });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      feesReturnedCents: 50,
      feesReturnedMeasuredCount: 1,
      feesReturnedEligibleCount: 1,
    });
  });

  test("refunded items on an EXCLUDED-status order do not count", async () => {
    const o = await order({ status: "CANCELLED", grossCents: 6_000, feeCents: 99 });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 99 });

    expect(await analytics.sumPlatformRevenueByCurrency()).toEqual([]);
  });

  test("JOINING ITEMS DOES NOT MULTIPLY THE ORDER SUMS", async () => {
    // One order, five items, three of them refunded. Every order-level
    // figure must still be counted exactly once.
    const o = await order({
      status: "PART_REFUNDED",
      grossCents: 5_000,
      feeCents: 165,
      taxCents: 400,
      feeMode: "ABSORB",
      processorFeeCents: 175,
      intent: "pi_1",
    });
    for (let i = 0; i < 3; i += 1) {
      await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 33 });
    }
    await orderItem({ orderId: o, refunded: false });
    await orderItem({ orderId: o, refunded: false });

    expect(await analytics.sumPlatformRevenueByCurrency()).toEqual([
      {
        currency: "usd",
        ticketVolumeCents: 5_000,
        platformFeesChargedCents: 165,
        platformFeesPassThroughCents: 0,
        platformFeesAbsorbCents: 165,
        platformFeesUnknownModeCents: 0,
        taxCollectedCents: 400,
        orderCount: 1,
        processorFeeCents: 175,
        processorFeeMeasuredCount: 1,
        processorFeeEligibleCount: 1,
        processorFeeParkedCount: 0,
        feesReturnedCents: 99,
        feesReturnedMeasuredCount: 3,
        feesReturnedEligibleCount: 3,
        // ABSORB **with refunded items** → INELIGIBLE by condition (5):
        // the refund withheld the actual Stripe fee from the buyer, so the
        // platform got its processor fee back, and nothing records how much.
        // This row used to net −109 (165 − 175 − 99), which double-charged
        // the recovered 175. 0 of 0 now, and the caller reports `unread`.
        // (The negative-net path is still covered — see the credit
        // redemption test below, which nets −40 on an unrefunded order.)
        netKeptCents: 0,
        netKeptEligibleCount: 0,
      },
    ]);
  });

  test("fees returned are grouped by the ORDER's currency, trimmed and lower-cased like the rest", async () => {
    const usd = await order({ status: "REFUNDED", currency: "USD", grossCents: 1_000, feeCents: 10 });
    const mxn = await order({ status: "REFUNDED", currency: "mxn", grossCents: 9_000, feeCents: 90 });
    await orderItem({ orderId: usd, refunded: true, refundedPlatformFeeCents: 10 });
    await orderItem({ orderId: mxn, refunded: true, refundedPlatformFeeCents: 90 });
    await orderItem({ orderId: mxn, refunded: true, refundedPlatformFeeCents: null });

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.feesReturnedCents, r.feesReturnedMeasuredCount, r.feesReturnedEligibleCount]))
      .toEqual([
        ["mxn", 90, 1, 2],
        ["usd", 10, 1, 1],
      ]);
  });

  test("a currency with orders but no refunds reports 0-of-0 returned, not a missing row", async () => {
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10 });
    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      feesReturnedCents: 0,
      feesReturnedMeasuredCount: 0,
      feesReturnedEligibleCount: 0,
    });
  });

  // ── The net: eligibility ─────────────────────────────────────────────────
  //
  // ELEVEN conditions, ALL of which must hold. Each one is exercised on its
  // own below, most with a known-good sibling order in the same currency, so a
  // broken condition shows up as a wrong count AND a wrong sum rather than
  // an empty result that could mean anything.

  test("an order with NO recorded fee mode is excluded from the net", async () => {
    // No mode → the buyer-side unit is unknowable and so is whether the
    // processor fee was ours.
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10 });
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, feeMode: "ABSORB" });
    // A mode string that is neither of the two is just as unknown.
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, feeMode: "WEIRD" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 3,
      // Only the ABSORB order: 10 basis-side unit, no processor fee to
      // subtract (no intent), no refunds, no credit.
      netKeptCents: 10,
      netKeptEligibleCount: 1,
    });
  });

  test("a DISPUTED order is EXCLUDED from the net, not modelled", async () => {
    // A lost dispute returns principal (and costs a dispute fee) this read
    // cannot see, so it is dropped from both the sum and the count — while
    // still counting in orderCount and the recorded-fee totals. This row
    // carries both markers; the next test has the realistic shape, where
    // only disputeStatus is written.
    await order({ status: "DISPUTED", disputeStatus: "LOST", grossCents: 50_000, feeCents: 1_650, feeMode: "PASS_THROUGH" });
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, feeMode: "PASS_THROUGH" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 2,
      // The disputed order's fee is still CHARGED...
      platformFeesChargedCents: 1_660,
      // ...but only the succeeded one is in the net: 10 basis-side + 10
      // buyer-side.
      netKeptCents: 20,
      netKeptEligibleCount: 1,
    });
  });

  test("REGRESSION: a disputed order is excluded on disputeStatus alone — status stays SUCCEEDED, as markDisputeStatus leaves it", async () => {
    // markDisputeStatus writes Order.disputeStatus and never status, so a
    // check on status = 'DISPUTED' alone admitted every charged-back order.
    // EVERY non-null value excludes: LOST, OPEN and UNDER_REVIEW can move
    // principal; on ticketing the platform bears Stripe's dispute fee, which
    // no term of the net subtracts; and the order row does not say whether a
    // WON or WARNING_* dispute left a fee behind.
    const statuses = [
      "NEEDS_TRIAGE", "OPEN", "UNDER_REVIEW", "WON", "LOST",
      "WARNING_OPEN", "WARNING_UNDER_REVIEW", "WARNING_CLOSED",
    ];
    for (const disputeStatus of statuses) {
      await order({ status: "SUCCEEDED", disputeStatus, grossCents: 5_000, feeCents: 50, feeMode: "PASS_THROUGH" });
    }
    // The control: never disputed.
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, feeMode: "PASS_THROUGH" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: statuses.length + 1,
      platformFeesChargedCents: statuses.length * 50 + 10,
      // Only the control: 10 basis-side + 10 buyer-side.
      netKeptCents: 20,
      netKeptEligibleCount: 1,
    });
  });

  test("an ABSORB order with a payment intent but NO stamped processor fee is excluded", async () => {
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, feeMode: "ABSORB", intent: "pi_unstamped" });
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, feeMode: "ABSORB", intent: "pi_stamped", processorFeeCents: 33 });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 2,
      // Only the stamped one: 10 − 33 = −23. Under ABSORB the processor fee
      // is OURS, so an unstamped one is a real unknown, not a zero.
      netKeptCents: -23,
      netKeptEligibleCount: 1,
    });
  });

  test("an ABSORB order with NO payment intent is still eligible — there is no fee to stamp", async () => {
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, feeMode: "ABSORB", intent: null });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      netKeptCents: 10,
      netKeptEligibleCount: 1,
    });
  });

  test("a PASS_THROUGH order with an UNSTAMPED processor fee is still eligible — the buyer funded it", async () => {
    // Condition (3) is ABSORB-only on purpose: under PASS_THROUGH the
    // checkout gross-up had the buyer pay the processor fee, so it is not a
    // platform cost and an unread one does not disqualify the order.
    await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 10, feeMode: "PASS_THROUGH", intent: "pi_unstamped" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      processorFeeMeasuredCount: 0,
      processorFeeEligibleCount: 1,
      // 10 basis-side + 10 buyer-side, and NOTHING subtracted for the
      // processor.
      netKeptCents: 20,
      netKeptEligibleCount: 1,
    });
  });

  test("an UNSTAMPED refunded TICKET item excludes the order; a non-ticket line does not", async () => {
    // PASS_THROUGH throughout, deliberately: an ABSORB order with ANY
    // refund is excluded by condition (5), which would mask whether (4) is
    // doing anything at all.
    const unstamped = await order({ status: "PART_REFUNDED", grossCents: 1_000, feeCents: 100, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: unstamped, refunded: true, refundedPlatformFeeCents: 20 });
    await orderItem({ orderId: unstamped, refunded: true, refundedPlatformFeeCents: null });

    const stamped = await order({ status: "PART_REFUNDED", grossCents: 1_000, feeCents: 100, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: stamped, refunded: true, refundedPlatformFeeCents: 20 });

    // A refunded NON-ticket line is never stamped by construction, so it
    // must not disqualify the order.
    const nonTicket = await order({ status: "PART_REFUNDED", grossCents: 1_000, feeCents: 100, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: nonTicket, refunded: true, refundedPlatformFeeCents: 20 });
    await orderItem({ orderId: nonTicket, kind: "discount", refunded: true, refundedPlatformFeeCents: null });

    // NOT refunded → a NULL stamp is expected and harmless.
    const notRefunded = await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 100, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: notRefunded, refunded: false, refundedPlatformFeeCents: null });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 4,
      // Two refunded-and-stamped orders at (100 + 100 − 20 − 20) = 160
      // each, plus the unrefunded one at (100 + 100) = 200. 520 over three
      // eligible orders; the unstamped one is excluded entirely.
      netKeptCents: 520,
      netKeptEligibleCount: 3,
    });
  });

  // ── The net: platform-funded credit ──────────────────────────────────────

  test("LIVE credit redemptions subtract; RELEASED and REFUNDED ones do not", async () => {
    const live = await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 100, feeMode: "ABSORB" });
    await creditRedemption({ orderId: live, amountCents: 250 });

    const released = await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 100, feeMode: "ABSORB" });
    await creditRedemption({ orderId: released, amountCents: 250, released: true });

    const refunded = await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 100, feeMode: "ABSORB" });
    await creditRedemption({ orderId: refunded, amountCents: 250, refunded: true });

    // Two live redemptions on one order both subtract.
    const two = await order({ status: "SUCCEEDED", grossCents: 1_000, feeCents: 100, feeMode: "ABSORB" });
    await creditRedemption({ orderId: two, amountCents: 30 });
    await creditRedemption({ orderId: two, amountCents: 20 });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 4,
      // Credit never touches amountGrossCents, so volume is untouched by
      // all of this — the net is the only place it shows up.
      ticketVolumeCents: 4_000,
      // (100 − 250) + 100 + 100 + (100 − 50) = 100.
      netKeptCents: 100,
      netKeptEligibleCount: 4,
    });
  });

  test("credit redemptions do NOT multiply the order sums either", async () => {
    // Same hazard as items: three redemption rows on one order must not
    // triple the order-level figures.
    const o = await order({
      status: "SUCCEEDED",
      grossCents: 5_000,
      feeCents: 165,
      taxCents: 400,
      feeMode: "ABSORB",
      processorFeeCents: 175,
      intent: "pi_credit",
    });
    await creditRedemption({ orderId: o, amountCents: 10 });
    await creditRedemption({ orderId: o, amountCents: 10 });
    await creditRedemption({ orderId: o, amountCents: 10 });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      ticketVolumeCents: 5_000,
      platformFeesChargedCents: 165,
      taxCollectedCents: 400,
      processorFeeCents: 175,
      processorFeeMeasuredCount: 1,
      // 165 − 175 − 30 = −40, counted once.
      netKeptCents: -40,
      netKeptEligibleCount: 1,
    });
  });

  // ── The net: the basis cap and the doubled refund ────────────────────────

  test("LEAST(fee, gross) binds when the fee EXCEEDS the gross — once, at ORDER level", async () => {
    // The header's worked example: a $10.00 ticket with a $9.90 promo
    // records gross 10 and fee 33. The basis is max(10 − 33, 0) = 0, the
    // organiser is credited nothing, and the platform took 10 out of the
    // basis — not the 33 recorded.
    const absorb = await order({ status: "SUCCEEDED", currency: "usd", grossCents: 10, feeCents: 33, feeMode: "ABSORB" });
    // Two ticket items, so a cap applied per ITEM would clip twice and land
    // somewhere other than 10.
    await orderItem({ orderId: absorb, refunded: false });
    await orderItem({ orderId: absorb, refunded: false });
    // Same ticket sold PASS_THROUGH: the capped basis-side unit (10) plus
    // the full buyer-side unit (33) the buyer actually paid = 43.
    await order({ status: "SUCCEEDED", currency: "mxn", grossCents: 10, feeCents: 33, feeMode: "PASS_THROUGH" });

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount])).toEqual([
      ["mxn", 43, 1],
      ["usd", 10, 1],
    ]);
    // And the recorded charge exceeds what was kept in BOTH modes.
    expect(rows.every((r) => r.platformFeesChargedCents === 33)).toBe(true);
  });

  test("a PASS_THROUGH refund subtracts the stamp TWICE; a refunded ABSORB order is excluded instead", async () => {
    // The column stores ONE unit in both modes by spec. The platform's
    // actual give-back under PASS_THROUGH is two units (the fee to the
    // buyer, plus the share of face the organiser does not fund back) — the
    // decision record's worked table.
    const pt = await order({ status: "PART_REFUNDED", currency: "usd", grossCents: 10_000, feeCents: 333, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: pt, refunded: true, refundedPlatformFeeCents: 100 });

    // The ABSORB side is NOT netted at 233. The refund withheld the actual
    // Stripe fee from the buyer, so the platform recovered the processor
    // fee it paid, and the recovered share is stored nowhere — so the order
    // is excluded by condition (5) rather than netted from inputs that do
    // not add up.
    const ab = await order({ status: "PART_REFUNDED", currency: "mxn", grossCents: 10_000, feeCents: 333, feeMode: "ABSORB" });
    await orderItem({ orderId: ab, refunded: true, refundedPlatformFeeCents: 100 });

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["mxn", 0, 0, 1],
      // 333 basis-side + 333 buyer-side − 100 basis-side give-back (capped,
      // but 100 < 333 <= 10_000 so it does not bite) − 100 buyer-side = 466.
      ["usd", 466, 1, 1],
    ]);
    // Both fees are still CHARGED and both refunds still RETURNED — only
    // the net drops the order.
    expect(rows.map((r) => [r.currency, r.platformFeesChargedCents, r.feesReturnedCents])).toEqual([
      ["mxn", 333, 100],
      ["usd", 333, 100],
    ]);
  });

  test("a FULLY refunded PASS_THROUGH order nets the platform ZERO — a measured zero, not a gap", async () => {
    const o = await order({ status: "REFUNDED", grossCents: 10_000, feeCents: 333, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 333 });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      // 333 + 333 − 333 × 2 = 0. Both units given back, exactly as the
      // decision record's table says.
      netKeptCents: 0,
      // ...and the order IS eligible, so the caller reports a complete zero
      // rather than `unread`.
      netKeptEligibleCount: 1,
      orderCount: 1,
    });
  });

  // ── The net: the errors review caught ────────────────────────────────────
  //
  // Every one of these produced a wrong number before review caught it, and
  // none of the cases above would have failed. Three understated profit on
  // the refund side; the fourth (RESALE) rendered a confident, fully-covered
  // ZERO, which is worse. They are the regression floor.

  test("REGRESSION: a refunded ABSORB order with a STAMPED processor fee is excluded, not netted", async () => {
    // The exact shape that double-charged. Face 1000, fee 33, Stripe 59,
    // fully refunded and fully stamped. Every refund path withholds the
    // ACTUAL Stripe fee from the buyer, so cash in 941 = cash out 941 and
    // the ledger is +967 / −967: the truth is 0. The old expression read
    // 33 − 59 − 33 = −59, booking the recovered 59 as a loss. Scaled up by
    // a cancelled event (which refunds every order and stamps every share),
    // that was hundreds of dollars of net that never happened.
    const o = await order({
      status: "REFUNDED",
      grossCents: 1_000,
      feeCents: 33,
      feeMode: "ABSORB",
      intent: "pi_absorb_refunded",
      processorFeeCents: 59,
    });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 33 });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      // Still measured as a COST line — only the net excludes the order.
      processorFeeCents: 59,
      processorFeeMeasuredCount: 1,
      feesReturnedCents: 33,
      netKeptCents: 0,
      netKeptEligibleCount: 0,
    });
    expect(row!.netKeptCents).not.toBe(-59);
  });

  test("REGRESSION: the basis-side give-back is CAPPED, so a deep discount nets 0 rather than negative", async () => {
    // Ten $50 tickets at 99.5% off: gross 250 against a fee of 500,
    // computed on full face. PASS_THROUGH, fully refunded, stamp 500.
    // Basis-side take is capped at min(500, 250) = 250, so the basis-side
    // GIVE-BACK must be capped at the same 250 — the organiser is docked
    // only what they were credited. Buyer-side is uncapped both ways: they
    // paid the full 500 on top and get all of it back.
    //   250 + 500 − 250 − 500 = 0.
    // An uncapped give-back read 250 + 500 − 1000 = −250.
    const o = await order({
      status: "REFUNDED",
      grossCents: 250,
      feeCents: 500,
      feeMode: "PASS_THROUGH",
    });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 500 });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      netKeptCents: 0,
      netKeptEligibleCount: 1,
    });
    expect(row!.netKeptCents).not.toBe(-250);
  });

  test("REGRESSION: a refunded order that spent LIVE credit is excluded", async () => {
    // PASS_THROUGH gross 1000, fee 33, credit 400, Stripe 47, fully
    // refunded — PASS_THROUGH so condition (5) is not what excludes it.
    // The refund pays the buyer NET of credit while the organiser is
    // debited their FULL basis of 967, so the refund recovers what the
    // credit cost the platform. The truth is 0; subtracting the credit
    // anyway read 33 + 33 − 33 − 33 − 400 = −400.
    // `UserCreditRedemption.refundedAt` has NO writer in the repo, so
    // nothing marks the redemption inert — the exclusion is the only
    // honest option.
    const o = await order({
      status: "REFUNDED",
      grossCents: 1_000,
      feeCents: 33,
      feeMode: "PASS_THROUGH",
      intent: "pi_credit_refunded",
      processorFeeCents: 47,
    });
    await creditRedemption({ orderId: o, amountCents: 400 });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 33 });

    // ...and the SAME order without the refund stays eligible, so the
    // exclusion is pinned to the refund and not to the credit alone.
    const unrefunded = await order({
      status: "SUCCEEDED",
      currency: "mxn",
      grossCents: 1_000,
      feeCents: 33,
      feeMode: "PASS_THROUGH",
    });
    await creditRedemption({ orderId: unrefunded, amountCents: 400 });

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount])).toEqual([
      // 33 + 33 − 400 = −334. Credit on an UNREFUNDED order is a real cost.
      ["mxn", -334, 1],
      // Excluded: refunded AND credited.
      ["usd", 0, 0],
    ]);
  });

  test("REGRESSION: a RESALE order is excluded — its 0 fee is not \"kept nothing\"", async () => {
    // The worst failure this read can have: not a null, a CONFIDENT
    // fully-covered wrong number. create-resale-checkout records
    // feesPlatformCents: 0 (the platform's cut is an OrderSplit line plus
    // processingPassThroughCents, never the fee column) while hardcoding
    // feeMode: 'PASS_THROUGH' in the snapshot. Nothing about the amounts
    // distinguishes it, so every other condition passes and the net was
    // LEAST(0, 6000) + 0 = 0 with measured === total — reason null, and a
    // resale-only currency rendered "Net kept $0.00" as a complete answer.
    await order({
      status: "SUCCEEDED",
      grossCents: 6_000,
      feeCents: 0,
      feeMode: "PASS_THROUGH",
      source: "RESALE",
    });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    // The order is still COUNTED — volume and coverage must show it exists.
    // What must not happen is a net over it: 0 of 1, so the caller reports
    // `unread` and the UI has nothing to render as a figure.
    expect(row).toMatchObject({
      orderCount: 1,
      ticketVolumeCents: 6_000,
      netKeptEligibleCount: 0,
    });
  });

  test("a genuine FEE-WAIVED primary order with a 0 fee is still eligible — 0 is its true net", async () => {
    // The reason condition (7) keys on SOURCE and not on
    // feesPlatformCents = 0: a free or fee-waived ticketing order records 0
    // too, and for THAT order 0 is the correct answer. A zero-amount guard
    // would have thrown away real coverage.
    await order({
      status: "SUCCEEDED",
      grossCents: 6_000,
      feeCents: 0,
      feeMode: "ABSORB",
      source: "PRIMARY",
    });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      netKeptCents: 0,
      netKeptEligibleCount: 1,
    });
  });

  test("REGRESSION: a PARTIAL refund under a biting basis cap is excluded, not approximated", async () => {
    // 10 tickets at fee 50 each (fee 500) with a promo taking gross to 250,
    // PASS_THROUGH, HALF refunded with 250 stamped. The cap clamps the
    // AGGREGATE give-back at min(500, 250) = 250 instead of pro-rating it
    // per ticket, so:
    //   pre-fix  250 + 500 − LEAST(250, 250) − 250 = 250
    //   truth    the buyer paid 750 and got back 5 × (25 + 50) = 375, so 375
    // The expression was 125 LIGHT. 5 of 10 ticket items refunded is
    // exactly "not everything was refunded", so this is excluded while the
    // full refund below stays eligible.
    //
    // The tickets are LIKE (one face, one recorded fee summing to the order
    // fee, no discount line written), so (10) leaves this order alone and
    // (8) is the only condition that can exclude it.
    const o = await order({
      status: "PART_REFUNDED",
      grossCents: 250,
      feeCents: 500,
      feeMode: "PASS_THROUGH",
    });
    for (let i = 0; i < 5; i += 1) {
      await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 50, faceCents: 25, feeCents: 50 });
    }
    for (let i = 0; i < 5; i += 1) {
      await orderItem({ orderId: o, refunded: false, faceCents: 25, feeCents: 50 });
    }

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      netKeptEligibleCount: 0,
    });
    // Emphatically not the old approximation.
    expect(row!.netKeptCents).not.toBe(250);
  });

  test("a FULL refund under a biting cap stays eligible — the aggregate cap is exact there", async () => {
    // Same order, every ticket refunded: 10 of 10, so condition (8) does
    // not fire and the cap is exact.
    //   250 + 500 − LEAST(500, 250) − 500 = 0, and the buyer paid 750 and
    //   got all 750 back. Pins that (8) is scoped to the INEXACT case and
    //   does not quietly swallow the full-refund coverage.
    const o = await order({
      status: "REFUNDED",
      grossCents: 250,
      feeCents: 500,
      feeMode: "PASS_THROUGH",
    });
    for (let i = 0; i < 10; i += 1) {
      await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 50 });
    }

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      netKeptCents: 0,
      netKeptEligibleCount: 1,
    });
  });

  // (8) counts ticket items; it no longer reads Σ stamped = fee.

  test("(8) a PARTIAL refund whose stamps happen to reach the order fee is still partial, and EXCLUDED", async () => {
    // Three LIKE tickets (face 20, fee 33 recorded on each, Σ 99 = the order
    // fee, no discount), so (10) does not fire and (8) alone decides. Two are
    // refunded with stamps 50 + 49 = 99: the stamp-sum test read that as a
    // full refund and kept the order. Counting sees 2 of 3. (Stamps that
    // disagree with the recorded fees are not a shape checkout writes; they
    // isolate the count from the stamps.)
    const o = await order({ status: "PART_REFUNDED", grossCents: 60, feeCents: 99, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 50, faceCents: 20, feeCents: 33 });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 49, faceCents: 20, feeCents: 33 });
    await orderItem({ orderId: o, faceCents: 20, feeCents: 33 });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({ orderCount: 1, netKeptCents: 0, netKeptEligibleCount: 0, feesReturnedCents: 99 });
  });

  test("(8) a FEE-WAIVED ticket HELD while every fee-bearing ticket is refunded, under a biting cap, is EXCLUDED", async () => {
    // Unstamped, fee 100 > gross 60: two tickets at fee 50 refunded (stamps
    // reach the order fee) and a waived ticket (fee 0) still held. Read off
    // the stamps this was a full refund; it is 2 of 3. (10) excludes it too,
    // since fees 50 and 0 are unlike; the case the stamp sum got wrong now
    // has no way back in.
    const o = await order({ status: "PART_REFUNDED", grossCents: 60, feeCents: 100, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 50, faceCents: 20, feeCents: 50 });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 50, faceCents: 20, feeCents: 50 });
    await orderItem({ orderId: o, faceCents: 20, feeCents: 0 });
    // Every ticket refunded, same shape: a full refund under the cap stays
    // eligible at 60 + 100 − LEAST(100, 60) − 100 = 0.
    const full = await order({ status: "REFUNDED", currency: "mxn", grossCents: 60, feeCents: 100, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: full, refunded: true, refundedPlatformFeeCents: 50, faceCents: 20, feeCents: 50 });
    await orderItem({ orderId: full, refunded: true, refundedPlatformFeeCents: 50, faceCents: 20, feeCents: 50 });
    await orderItem({ orderId: full, refunded: true, refundedPlatformFeeCents: 0, faceCents: 20, feeCents: 0 });

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["mxn", 0, 1, 1],
      ["usd", 0, 0, 1],
    ]);
  });

  // ── The net: the fee is kept ONCE on a full-price-credited order ─────────
  //
  // Owner ruling 2026-10-11 (docs/specs/2026-10-11/platform-fee-charged-once
  // .spec.yaml, FR-006). An order stamped `organiserCredit: "FULL_PRICE"`
  // credited the organiser the full ticket price, so the platform took no
  // unit out of the basis. An order without the stamp is every order above
  // this block, and must net exactly what it netted before.

  const FULL_PRICE = "FULL_PRICE";

  test("FULL_PRICE: a pass-through order nets the fee ONCE; the same order unstamped nets it twice", async () => {
    // The spec's acceptance order: face 7500, fee 50. Stamped, the organiser
    // is credited 7500 and the platform keeps the 50 the buyer paid on top.
    await order({ status: "SUCCEEDED", currency: "usd", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    // Unstamped, the organiser was credited 7450: 50 + 50 = 100.
    await order({ status: "SUCCEEDED", currency: "mxn", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH" });
    // A value checkout never writes is NOT the stamp. computeAgreementBasis
    // credits such an order price minus fee, so the net must count two units.
    await order({ status: "SUCCEEDED", currency: "cad", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH", organiserCredit: "full_price" });

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["cad", 100, 1, 1],
      ["mxn", 100, 1, 1],
      ["usd", 50, 1, 1],
    ]);
    // The recorded charge is the same 50 under either rule: charged, not kept.
    expect(rows.every((r) => r.platformFeesChargedCents === 50)).toBe(true);
    expect(rows.every((r) => r.platformFeesPassThroughCents === 50)).toBe(true);
  });

  test("FULL_PRICE: a fully refunded order nets ZERO — one unit kept, one unit returned", async () => {
    const o = await order({ status: "REFUNDED", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 50 });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      // 50 − 50. Subtracting the stamp twice, as an unstamped order does,
      // would read −50: a loss on an order that left the platform flat.
      netKeptCents: 0,
      netKeptEligibleCount: 1,
      orderCount: 1,
      feesReturnedCents: 50,
    });
  });

  test("FULL_PRICE: a partial refund subtracts the stamp ONCE", async () => {
    // Two tickets at 7500 / fee 50 each, one refunded with its 50 stamped.
    const stamped = await order({ status: "PART_REFUNDED", currency: "usd", grossCents: 15_000, feeCents: 100, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await orderItem({ orderId: stamped, refunded: true, refundedPlatformFeeCents: 50, faceCents: 7_500 });
    await orderItem({ orderId: stamped, refunded: false, faceCents: 7_500 });
    // One payee credited the full price, so each ticket is debited its face.
    await splits(stamped, [15_000]);
    // The same order unstamped: 100 + 100 − 50 − 50. Its two tickets are
    // LIKE (face 7500, fee 50 recorded on each) and its one payee was
    // credited 15000 − 100, so (10) keeps it.
    const unstamped = await order({ status: "PART_REFUNDED", currency: "mxn", grossCents: 15_000, feeCents: 100, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: unstamped, refunded: true, refundedPlatformFeeCents: 50, faceCents: 7_500, feeCents: 50 });
    await orderItem({ orderId: unstamped, refunded: false, faceCents: 7_500, feeCents: 50 });
    await splits(unstamped, [14_900]);

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount])).toEqual([
      ["mxn", 100, 1],
      // 100 − 50: the fee on the ticket the buyer kept.
      ["usd", 50, 1],
    ]);
  });

  test("FULL_PRICE: a deep discount has NO basis cap — the full fee is kept; a partial refund of it is excluded by (9), not netted", async () => {
    // fee > gross, unrefunded. The buyer paid 10 + 33, the organiser is
    // credited 10, the platform keeps 33. Unstamped this is 43 (see the
    // LEAST test above): the capped 10 out of the basis plus the 33 on top.
    // The promo is on the order as its discount line; unrefunded, it changes
    // nothing.
    const deep = await order({ status: "SUCCEEDED", currency: "cad", grossCents: 10, feeCents: 33, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await orderItem({ orderId: deep });
    await orderItem({ orderId: deep, kind: "discount" });

    // The shape condition (8) excludes on an unstamped order: 2 tickets at
    // fee 50 (fee 100), a promo taking gross to 80, ONE refunded with stamp
    // 50. A promo IS a discount line, so stamped this is condition (9): a
    // partial refund on a discounted full-price order. Two identical tickets
    // and an even discount happen to come out at 100 − 50 = 50, but the
    // query does not tell that case from an inexact one and excludes both.
    const stamped = await order({ status: "PART_REFUNDED", currency: "usd", grossCents: 80, feeCents: 100, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await orderItem({ orderId: stamped, refunded: true, refundedPlatformFeeCents: 50 });
    await orderItem({ orderId: stamped, refunded: false });
    await orderItem({ orderId: stamped, kind: "discount" });

    // The identical order unstamped is still excluded by (8).
    const unstamped = await order({ status: "PART_REFUNDED", currency: "mxn", grossCents: 80, feeCents: 100, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: unstamped, refunded: true, refundedPlatformFeeCents: 50 });
    await orderItem({ orderId: unstamped, refunded: false });
    await orderItem({ orderId: unstamped, kind: "discount" });

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["cad", 33, 1, 1],
      ["mxn", 0, 0, 1],
      ["usd", 0, 0, 1],
    ]);
  });

  // ── The net: condition (9), a partial refund on a discounted FULL_PRICE order ──
  //
  // The worked order: tickets face 1000 / fee 33 and face 2000 / fee 50 with
  // 1500 off, so gross 1500 and fee 83. Refunding the second ticket costs the
  // platform 53 against a stamp of 50 (the buyer's refund is split by what
  // each ticket's buyer paid, the organiser's debit by face; pinned against
  // the real allocators in core's refund-platform-fee-exactness.test.ts).
  // `fee − stamp` would report 33 kept where 30 was, so the order is left out.

  /**
   * The worked order's lines: faces 1000 and 2000, the per-ticket fee NOT
   * recorded in meta (the stamps carry 33 and 50). `refund` says which
   * tickets went back. No split rows: a test that needs the partial refund
   * admitted by (9) adds the payee's split itself.
   */
  async function workedOrderLines(
    orderId: string,
    opts: { discount: boolean; refund: "none" | "second" | "both" },
  ) {
    await orderItem({
      orderId,
      faceCents: 1_000,
      refunded: opts.refund === "both",
      refundedPlatformFeeCents: opts.refund === "both" ? 33 : null,
    });
    await orderItem({
      orderId,
      faceCents: 2_000,
      refunded: opts.refund !== "none",
      refundedPlatformFeeCents: opts.refund !== "none" ? 50 : null,
    });
    if (opts.discount) await orderItem({ orderId, kind: "discount" });
  }

  test("(9) FULL_PRICE + a discount + a PARTIAL refund is EXCLUDED, never netted at fee − stamp", async () => {
    const o = await order({ status: "PART_REFUNDED", grossCents: 1_500, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await workedOrderLines(o, { discount: true, refund: "second" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      // NOT 33 (fee − stamp), and not the true 30 either: it is not known
      // here, so it is not in the sum and not in the count.
      netKeptCents: 0,
      netKeptEligibleCount: 0,
      // The fees-returned line is its own coverage and still reads the stamp.
      feesReturnedCents: 50,
      feesReturnedMeasuredCount: 1,
      feesReturnedEligibleCount: 1,
    });
  });

  test("(9) FULL_PRICE + a discount + a FULL refund stays eligible and nets 0", async () => {
    const o = await order({ status: "REFUNDED", grossCents: 1_500, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await workedOrderLines(o, { discount: true, refund: "both" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      // 83 − (33 + 50). The per-ticket differences (30 and 53) sum to the fee.
      netKeptCents: 0,
      netKeptEligibleCount: 1,
      feesReturnedCents: 83,
    });
  });

  test("(9) FULL_PRICE + NO discount + a partial refund stays eligible and nets fee − stamp", async () => {
    // The same two tickets with nothing off: gross 3000, fee 83.
    const o = await order({ status: "PART_REFUNDED", grossCents: 3_000, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await workedOrderLines(o, { discount: false, refund: "second" });
    // One payee credited the full 3000: each ticket is debited its face.
    await splits(o, [3_000]);

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      // 83 − 50: with no discount the refund costs exactly the stamp.
      netKeptCents: 33,
      netKeptEligibleCount: 1,
    });
  });

  test("(9) FULL_PRICE + a discount and NO refund stays eligible and nets the fee", async () => {
    const o = await order({ status: "SUCCEEDED", grossCents: 1_500, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await workedOrderLines(o, { discount: true, refund: "none" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({ orderCount: 1, netKeptCents: 83, netKeptEligibleCount: 1 });
  });

  test("(9) reads the DISCOUNT line only: a refunded discount-free order beside a discounted one, credit lines and other orders' discounts change nothing", async () => {
    // Excluded: the worked order, second ticket refunded.
    const excluded = await order({ status: "PART_REFUNDED", grossCents: 1_500, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await workedOrderLines(excluded, { discount: true, refund: "second" });
    // Eligible at 33: the discount on the order above is not on this one.
    const clean = await order({ status: "PART_REFUNDED", grossCents: 3_000, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await workedOrderLines(clean, { discount: false, refund: "second" });
    await splits(clean, [3_000]);
    // Eligible at 33: a platform_credit LINE is not a discount (it never
    // touches gross). No live redemption row here, so (6) is not in play.
    // (An order with a platform_credit line and no live redemption is a shape
    // the product does not emit today; it only isolates the discount signal.)
    const creditLine = await order({ status: "PART_REFUNDED", grossCents: 3_000, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await workedOrderLines(creditLine, { discount: false, refund: "second" });
    await splits(creditLine, [3_000]);
    await orderItem({ orderId: creditLine, kind: "platform_credit" });
    // Eligible at 83: TWO discount lines (a code and a member benefit) on an
    // unrefunded order. The fold is one row per order, so nothing doubles.
    const twoDiscounts = await order({ status: "SUCCEEDED", grossCents: 1_500, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await workedOrderLines(twoDiscounts, { discount: true, refund: "none" });
    await orderItem({ orderId: twoDiscounts, kind: "discount" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 4,
      netKeptEligibleCount: 3,
      // 33 + 33 + 83.
      netKeptCents: 149,
      // Four orders, one row each: a join that multiplied would show here.
      platformFeesChargedCents: 332,
      ticketVolumeCents: 9_000,
    });
  });

  test("(9) two discount lines on ONE partially refunded order exclude it once and multiply nothing", async () => {
    const o = await order({ status: "PART_REFUNDED", grossCents: 1_500, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await workedOrderLines(o, { discount: true, refund: "second" });
    await orderItem({ orderId: o, kind: "discount" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      ticketVolumeCents: 1_500,
      platformFeesChargedCents: 83,
      netKeptCents: 0,
      netKeptEligibleCount: 0,
      feesReturnedCents: 50,
    });
  });

  // "Partial" in (9) is COUNTED (refunded ticket items < all ticket items),
  // not read off the stamp sum, so fee-free tickets cannot disguise it.

  test("(9) a ZERO-FEE order with a discount: refunding ONE of three tickets is EXCLUDED, not read as full", async () => {
    // Three waived tickets at face 1000, 101 off: the platform is out a cent
    // on the first refund (the allocators' leftover cents differ), yet
    // Σ stamped (0) = fee (0). Counting items sees one of three.
    const o = await order({ status: "PART_REFUNDED", grossCents: 2_899, feeCents: 0, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 0 });
    await orderItem({ orderId: o });
    await orderItem({ orderId: o });
    await orderItem({ orderId: o, kind: "discount" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({ orderCount: 1, netKeptCents: 0, netKeptEligibleCount: 0 });
  });

  test("(9) a FEE-WAIVED ticket HELD while the fee-bearing tickets are refunded is EXCLUDED", async () => {
    // Stamps 33 + 50 = the order fee 83, so a stamp-sum test would call this
    // a full refund; the waived third ticket is still held.
    const o = await order({ status: "PART_REFUNDED", grossCents: 2_500, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 33 });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 50 });
    await orderItem({ orderId: o });
    await orderItem({ orderId: o, kind: "discount" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({ orderCount: 1, netKeptCents: 0, netKeptEligibleCount: 0 });
  });

  test("(9) a discount, fee-free ticket included, with EVERY ticket refunded stays eligible and nets 0", async () => {
    const o = await order({ status: "REFUNDED", grossCents: 2_500, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 33 });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 50 });
    await orderItem({ orderId: o, refunded: true, refundedPlatformFeeCents: 0 });
    await orderItem({ orderId: o, kind: "discount" });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({ orderCount: 1, netKeptCents: 0, netKeptEligibleCount: 1, feesReturnedCents: 83 });
  });

  test("(9) does NOT touch an UNSTAMPED order: its discounted partial refund is (10)'s, and (10) excludes it", async () => {
    // The worked order sold before the change. fee 83 <= gross 1500, so the
    // cap does not bite and (8) leaves it in. It used to net
    // 83 + 83 − 50 − 50 = 66; unlike tickets with a discount line are not
    // exact on a partial refund, so (10) now leaves it out.
    const o = await order({ status: "PART_REFUNDED", grossCents: 1_500, feeCents: 83, feeMode: "PASS_THROUGH" });
    await workedOrderLines(o, { discount: true, refund: "second" });
    // A marker value checkout never writes is unstamped too.
    const lower = await order({ status: "PART_REFUNDED", currency: "cad", grossCents: 1_500, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: "full_price" });
    await workedOrderLines(lower, { discount: true, refund: "second" });

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["cad", 0, 0, 1],
      ["usd", 0, 0, 1],
    ]);
  });

  // ── The net: condition (10), a partial refund on an UNSTAMPED order of
  //    unlike tickets ─────────────────────────────────────────────────────
  //
  // The worked order sold before the change, no discount: face 1000 / fee 33
  // and face 2000 / fee 50, gross 3000, fee 83. The organiser was credited
  // 2917 by face (972 : 1945), so refunding the second ticket cost the
  // platform 105 where the net gives back 2 × 50 = 100 (pinned in core's
  // refund-platform-fee-exactness.test.ts).

  /** Two ticket items with recorded face and fee. `refund` picks which went back. */
  async function ticketPair(
    orderId: string,
    pair: { a: [face: number, fee: number]; b: [face: number, fee: number] },
    refund: "none" | "second" | "both",
  ) {
    await orderItem({
      orderId,
      faceCents: pair.a[0],
      feeCents: pair.a[1],
      refunded: refund === "both",
      refundedPlatformFeeCents: refund === "both" ? pair.a[1] : null,
    });
    await orderItem({
      orderId,
      faceCents: pair.b[0],
      feeCents: pair.b[1],
      refunded: refund !== "none",
      refundedPlatformFeeCents: refund !== "none" ? pair.b[1] : null,
    });
  }

  const UNLIKE = { a: [1_000, 33], b: [2_000, 50] } as { a: [number, number]; b: [number, number] };
  const LIKE = { a: [1_000, 33], b: [1_000, 33] } as { a: [number, number]; b: [number, number] };

  test("(10) UNSTAMPED, unlike tickets, a PARTIAL refund is EXCLUDED, not netted at 2 × stamp", async () => {
    const o = await order({ status: "PART_REFUNDED", grossCents: 3_000, feeCents: 83, feeMode: "PASS_THROUGH" });
    await ticketPair(o, UNLIKE, "second");

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      // Not 83 + 83 − 50 − 50 = 66 (the truth is 61): left out of both.
      netKeptCents: 0,
      netKeptEligibleCount: 0,
      // Fees returned is its own coverage and still reads the stamp.
      feesReturnedCents: 50,
      feesReturnedMeasuredCount: 1,
    });
  });

  test("(10) UNSTAMPED, unlike tickets, a FULL refund stays eligible and nets 0", async () => {
    const o = await order({ status: "REFUNDED", grossCents: 3_000, feeCents: 83, feeMode: "PASS_THROUGH" });
    await ticketPair(o, UNLIKE, "both");

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    // 83 + 83 − 83 − 83: both units back, and the per-ticket costs (61 and
    // 105) sum to the same 166.
    expect(row).toMatchObject({ orderCount: 1, netKeptCents: 0, netKeptEligibleCount: 1, feesReturnedCents: 83 });
  });

  test("(10) UNSTAMPED, unlike tickets, NO refund stays eligible and nets both units", async () => {
    const o = await order({ status: "SUCCEEDED", grossCents: 3_000, feeCents: 83, feeMode: "PASS_THROUGH" });
    await ticketPair(o, UNLIKE, "none");

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({ orderCount: 1, netKeptCents: 166, netKeptEligibleCount: 1 });
  });

  test("(10) UNSTAMPED, LIKE tickets, a PARTIAL refund stays eligible and nets 2 × stamp", async () => {
    const o = await order({ status: "PART_REFUNDED", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH" });
    await ticketPair(o, LIKE, "second");
    // One payee, credited the whole basis 2000 − 66.
    await splits(o, [1_934]);

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    // 66 + 66 − 33 − 33 = 66: the refunded ticket cost exactly two stamps.
    expect(row).toMatchObject({ orderCount: 1, netKeptCents: 66, netKeptEligibleCount: 1 });
  });

  test("(10) a partial refund is EXCLUDED when any part of LIKE fails", async () => {
    // Same face, different fee (a FEE-WAIVED ticket held).
    const waived = await order({ status: "PART_REFUNDED", currency: "aud", grossCents: 2_000, feeCents: 50, feeMode: "PASS_THROUGH" });
    await ticketPair(waived, { a: [1_000, 0], b: [1_000, 50] }, "second");
    // Same fee, different face.
    const faces = await order({ status: "PART_REFUNDED", currency: "cad", grossCents: 3_000, feeCents: 100, feeMode: "PASS_THROUGH" });
    await ticketPair(faces, { a: [1_000, 50], b: [2_000, 50] }, "second");
    // Like tickets with a discount line (the buyer's base and the
    // organiser's credit place their leftover cents on different tickets).
    const discounted = await order({ status: "PART_REFUNDED", currency: "eur", grossCents: 1_500, feeCents: 66, feeMode: "PASS_THROUGH" });
    await ticketPair(discounted, LIKE, "second");
    await orderItem({ orderId: discounted, kind: "discount", faceCents: -500 });
    // Like tickets whose per-ticket fees do not sum to the order fee (the
    // stamp is then re-allocated, not copied).
    const offSum = await order({ status: "PART_REFUNDED", currency: "gbp", grossCents: 2_000, feeCents: 67, feeMode: "PASS_THROUGH" });
    await ticketPair(offSum, LIKE, "second");
    // Like faces, the fee recorded on only one ticket.
    const unrecorded = await order({ status: "PART_REFUNDED", currency: "mxn", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: unrecorded, faceCents: 1_000, feeCents: 33 });
    await orderItem({ orderId: unrecorded, faceCents: 1_000, refunded: true, refundedPlatformFeeCents: 33 });
    // A malformed fee value never fails the cast; it reads as unrecorded.
    const malformed = await order({ status: "PART_REFUNDED", currency: "nzd", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: malformed, faceCents: 1_000, feeCents: "33x" });
    await orderItem({ orderId: malformed, faceCents: 1_000, feeCents: "99999999999999999999", refunded: true, refundedPlatformFeeCents: 33 });
    // The control: a like pair beside them stays in.
    const control = await order({ status: "PART_REFUNDED", currency: "usd", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH" });
    await ticketPair(control, LIKE, "second");
    await splits(control, [1_934]);

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["aud", 0, 0, 1],
      ["cad", 0, 0, 1],
      ["eur", 0, 0, 1],
      ["gbp", 0, 0, 1],
      ["mxn", 0, 0, 1],
      ["nzd", 0, 0, 1],
      ["usd", 66, 1, 1],
    ]);
  });

  // ── (10) and the payee splits: each payee's credit is attributed to the
  //    tickets on its own, leftover cent on the last ticket ────────────────

  test("(10) UNSTAMPED, LIKE tickets, TWO payees whose splits do not divide by the ticket count: a PARTIAL refund is EXCLUDED", async () => {
    // Two at face 1000 / fee 33, credit 1934 split 50/50 → 967 each,
    // attributed 484 : 483 per payee: refunding the second cost the
    // platform 1033 − 966 = 67, and the net would give back 66.
    const o = await order({ status: "PART_REFUNDED", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH" });
    await ticketPair(o, LIKE, "second");
    await splits(o, [967, 967]);

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    // Not 66 + 66 − 33 − 33 = 66 (the truth is 65).
    expect(row).toMatchObject({ orderCount: 1, netKeptCents: 0, netKeptEligibleCount: 0, feesReturnedCents: 33 });
  });

  test("(10) UNSTAMPED, LIKE tickets, TWO payees whose splits each divide by the ticket count: a PARTIAL refund stays eligible", async () => {
    // Two at face 1000 / fee 34, credit 1932 split 966 : 966, attributed
    // 483 : 483 per payee: each ticket debited 966 = face − fee.
    const o = await order({ status: "PART_REFUNDED", grossCents: 2_000, feeCents: 68, feeMode: "PASS_THROUGH" });
    await ticketPair(o, { a: [1_000, 34], b: [1_000, 34] }, "second");
    await splits(o, [966, 966]);

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    // 68 + 68 − 34 − 34.
    expect(row).toMatchObject({ orderCount: 1, netKeptCents: 68, netKeptEligibleCount: 1 });
  });

  test("(10) the splits must add up to the faces less the fee, and must exist", async () => {
    // Divisible, but short of 1934 by 2 (an unallocated remainder under
    // pre-gate terms). The platform kept those 2 cents of basis on top of
    // both fee units and the refund costs it 1033 − 966 = 67, so it truly
    // kept 134 − 67 = 67 where the net reads 66. Admitting it would
    // UNDERSTATE; it is excluded because the take is not the net.
    const short = await order({ status: "PART_REFUNDED", currency: "aud", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH" });
    await ticketPair(short, LIKE, "second");
    await splits(short, [1_932]);
    // No split rows at all: nothing was credited, so no debit came back,
    // and the platform still holds the basis it never credited. The net
    // would understate; excluded for the same reason.
    const none = await order({ status: "PART_REFUNDED", currency: "cad", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH" });
    await ticketPair(none, LIKE, "second");
    // A payee at 0 divides and adds nothing: still exact.
    const zero = await order({ status: "PART_REFUNDED", currency: "usd", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH" });
    await ticketPair(zero, LIKE, "second");
    await splits(zero, [1_934, 0]);

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["aud", 0, 0, 1],
      ["cad", 0, 0, 1],
      ["usd", 66, 1, 1],
    ]);
  });

  test("(10) the splits are read only for a PARTIAL refund: a FULL refund and an unrefunded order ignore them", async () => {
    // Non-divisible splits, every ticket refunded: exact, 0.
    const full = await order({ status: "REFUNDED", currency: "aud", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH" });
    await ticketPair(full, LIKE, "both");
    await splits(full, [967, 967]);
    // Non-divisible splits, nothing refunded: both units, 132.
    const kept = await order({ status: "SUCCEEDED", currency: "cad", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH" });
    await ticketPair(kept, LIKE, "none");
    await splits(kept, [967, 967]);

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["aud", 0, 1, 1],
      ["cad", 132, 1, 1],
    ]);
  });

  // ── (9) and the payee splits: a FULL_PRICE order's debit is its face only
  //    when every payee's share of every ticket comes out whole ───────────

  test("(9) FULL_PRICE, TWO payees whose shares round: a PARTIAL refund is EXCLUDED, not netted at fee − stamp", async () => {
    // Two at face 1999 / fee 33, credited 3998 split 1999 : 1999. Each
    // payee's 1999 attributes as 1000 : 999 (999.5 rounds up, the remainder
    // takes the rest), so the tickets are debited 2000 and 1998. Refunding
    // the second costs the platform 2032 − 1998 = 34: it kept 66 − 34 = 32,
    // and fee − stamp would read 33.
    const o = await order({ status: "PART_REFUNDED", grossCents: 3_998, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(o, { a: [1_999, 33], b: [1_999, 33] }, "second");
    await splits(o, [1_999, 1_999]);
    // The same shape with uneven splits that also round (the fixture this
    // file used to expect 33 from): 1001 and 999 over two tickets of 1000.
    const uneven = await order({ status: "PART_REFUNDED", currency: "cad", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(uneven, LIKE, "second");
    await splits(uneven, [1_001, 999]);
    // Unlike tickets, two payees whose shares are not whole: faces 1000 and
    // 2000 split 1001 : 1999, and 1001 × 1000 / 3000 is 333.67. The rounded
    // cents cancel (334 + 666 = 1000), so this order is in fact exact; it is
    // excluded only because the test is sufficient, not necessary.
    const unlike = await order({ status: "PART_REFUNDED", currency: "eur", grossCents: 3_000, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(unlike, UNLIKE, "second");
    await splits(unlike, [1_001, 1_999]);

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["cad", 0, 0, 1],
      ["eur", 0, 0, 1],
      ["usd", 0, 0, 1],
    ]);
  });

  test("(9) FULL_PRICE, TWO payees whose shares are whole: a PARTIAL refund stays eligible and nets fee − stamp", async () => {
    // Like tickets, splits that divide by the count: 1000 : 1000 over two
    // tickets of 1000 is 500 : 500 per payee, each ticket debited 1000.
    const like = await order({ status: "PART_REFUNDED", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(like, LIKE, "second");
    await splits(like, [1_000, 1_000]);
    // Unlike tickets, 1500 : 1500 over faces 1000 and 2000: 500 : 1000 per
    // payee, each ticket debited its face. 83 − 50.
    const unlike = await order({ status: "PART_REFUNDED", currency: "cad", grossCents: 3_000, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(unlike, UNLIKE, "second");
    await splits(unlike, [1_500, 1_500]);
    // A zero split is credited and debited nothing: still whole.
    const zero = await order({ status: "PART_REFUNDED", currency: "eur", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(zero, LIKE, "second");
    await splits(zero, [2_000, 0]);

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["cad", 33, 1, 1],
      ["eur", 33, 1, 1],
      ["usd", 33, 1, 1],
    ]);
  });

  test("(9) FULL_PRICE, ONE payee: a PARTIAL refund of UNLIKE tickets stays eligible — one payee's share is always whole", async () => {
    // Faces 1000 and 2000 with odd fees; the single payee holds 3000, so
    // 3000 × face / 3000 is the face itself. 83 − 50.
    const o = await order({ status: "PART_REFUNDED", grossCents: 3_000, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(o, UNLIKE, "second");
    await splits(o, [3_000]);
    // Three unlike faces that share no divisor with their sum.
    const odd = await order({ status: "PART_REFUNDED", currency: "cad", grossCents: 3_331, feeCents: 99, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await orderItem({ orderId: odd, faceCents: 1_001, feeCents: 33 });
    await orderItem({ orderId: odd, faceCents: 997, feeCents: 33 });
    await orderItem({ orderId: odd, faceCents: 1_333, feeCents: 33, refunded: true, refundedPlatformFeeCents: 33 });
    await splits(odd, [3_331]);

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["cad", 66, 1, 1],
      ["usd", 33, 1, 1],
    ]);
  });

  test("(9) FULL_PRICE: the splits must add up to the faces, must exist, and must not be negative", async () => {
    // Over the faces by 2: the platform credited 2 cents more than the
    // faces, so it kept 66 − 2 = 64; each ticket is debited 1001, the refund
    // costs 1033 − 1001 = 32, and it truly kept 32 where fee − stamp reads
    // 33. An OVERSTATEMENT. Excluded.
    const over =await order({ status: "PART_REFUNDED", currency: "aud", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(over, LIKE, "second");
    await splits(over, [2_002]);
    // Short of the faces by 2: the platform kept the 2 uncredited cents
    // (68), each ticket is debited 999, the refund costs 34, and it truly
    // kept 34 where fee − stamp reads 33. Not the net either. Excluded.
    const short = await order({ status: "PART_REFUNDED", currency: "cad", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(short, LIKE, "second");
    await splits(short, [1_998]);
    // No split at all: no credit, so the refund docked nobody.
    const none = await order({ status: "PART_REFUNDED", currency: "eur", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(none, LIKE, "second");
    // A negative split earns no credit (createCreditsFromOrder skips it)
    // yet would make the split sum reach the faces: 2100 − 100.
    const negative = await order({ status: "PART_REFUNDED", currency: "gbp", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(negative, LIKE, "second");
    await splits(negative, [2_100, -100]);
    // The control.
    const control = await order({ status: "PART_REFUNDED", currency: "usd", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(control, LIKE, "second");
    await splits(control, [2_000]);

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["aud", 0, 0, 1],
      ["cad", 0, 0, 1],
      ["eur", 0, 0, 1],
      ["gbp", 0, 0, 1],
      ["usd", 33, 1, 1],
    ]);
  });

  test("(9) FULL_PRICE: the splits are read only for a PARTIAL refund — a FULL refund and an unrefunded order ignore them", async () => {
    // Rounding splits, every ticket refunded: every debit comes back, 0.
    const full = await order({ status: "REFUNDED", currency: "aud", grossCents: 3_998, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(full, { a: [1_999, 33], b: [1_999, 33] }, "both");
    await splits(full, [1_999, 1_999]);
    // Rounding splits, nothing refunded: the fee, 66.
    const kept = await order({ status: "SUCCEEDED", currency: "cad", grossCents: 3_998, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(kept, { a: [1_999, 33], b: [1_999, 33] }, "none");
    await splits(kept, [1_999, 1_999]);

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["aud", 0, 1, 1],
      ["cad", 66, 1, 1],
    ]);
  });

  test("(9) the split × ticket probe is folded per order: many payees and tickets multiply nothing", async () => {
    // Four payees × five tickets is twenty pairs; the order still counts
    // once. 5 × 1000 faces, 4 payees at 1250 each (250 a ticket), two
    // tickets refunded: 5 × 33 − 2 × 33 = 99.
    const o = await order({ status: "PART_REFUNDED", grossCents: 5_000, feeCents: 165, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    for (let i = 0; i < 5; i++) {
      await orderItem({ orderId: o, faceCents: 1_000, feeCents: 33, refunded: i < 2, refundedPlatformFeeCents: i < 2 ? 33 : null });
    }
    await splits(o, [1_250, 1_250, 1_250, 1_250]);

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      ticketVolumeCents: 5_000,
      platformFeesChargedCents: 165,
      netKeptCents: 99,
      netKeptEligibleCount: 1,
      feesReturnedCents: 66,
      feesReturnedMeasuredCount: 2,
    });
  });

  // ── (11) a Stripe-side partial refund that refunded no ticket item ───────

  test("(11) an order a Stripe-side partial refund paid back with NO refunded ticket item is EXCLUDED", async () => {
    // The dashboard refunded 500 of a 2066 order: the payees were debited a
    // proportional share, no item moved, nothing was stamped. It reads as
    // unrefunded, so without (11) it would net the whole fee.
    const marked = await order({ status: "SUCCEEDED", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(marked, LIKE, "none");
    await splits(marked, [2_000]);
    await auditRow(marked, "stripe_partial_refund_reconciled");
    // Unstamped, the same.
    const unmarked = await order({ status: "SUCCEEDED", currency: "cad", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH" });
    await ticketPair(unmarked, LIKE, "none");
    await auditRow(unmarked, "stripe_partial_refund_reconciled");
    // Two rows on one order (two partial refunds) exclude it once and
    // multiply nothing.
    const twice = await order({ status: "SUCCEEDED", currency: "eur", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await auditRow(twice, "stripe_partial_refund_reconciled");
    await auditRow(twice, "stripe_partial_refund_reconciled");

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount, r.ticketVolumeCents])).toEqual([
      ["cad", 0, 0, 1, 2_000],
      ["eur", 0, 0, 1, 2_000],
      ["usd", 0, 0, 1, 2_000],
    ]);
  });

  test("(11) reads only that action on an order, and leaves an in-app partial refund (which leaves the same row) to (9) and (10)", async () => {
    // Stripe fires charge.refunded for the app's own refunds too, so an
    // in-app partial refund carries the same audit row. It HAS a refunded
    // ticket item, so (11) leaves it alone and (9) admits it: 66 − 33.
    const inApp = await order({ status: "PART_REFUNDED", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(inApp, LIKE, "second");
    await splits(inApp, [2_000]);
    await auditRow(inApp, "stripe_partial_refund_reconciled");
    // Another action on the order: not a refund marker. 66.
    const other = await order({ status: "SUCCEEDED", currency: "cad", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await auditRow(other, "order_finalized");
    // The right action on another entity with the same id: not an order. 66.
    const otherEntity = await order({ status: "SUCCEEDED", currency: "eur", grossCents: 2_000, feeCents: 66, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await auditRow(otherEntity, "stripe_partial_refund_reconciled", "event");

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["cad", 66, 1, 1],
      ["eur", 66, 1, 1],
      ["usd", 33, 1, 1],
    ]);
  });

  test("(10) does NOT touch a FULL_PRICE order: unlike tickets with a partial refund net fee − stamp", async () => {
    // Marked, no discount, one payee: (9) keeps it and (10) does not
    // apply. 83 − 50.
    const o = await order({ status: "PART_REFUNDED", grossCents: 3_000, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await ticketPair(o, UNLIKE, "second");
    await splits(o, [3_000]);
    // Marked, unlike, fee not recorded at all: still kept, (10) never reads it.
    const bare = await order({ status: "PART_REFUNDED", currency: "mxn", grossCents: 3_000, feeCents: 83, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await workedOrderLines(bare, { discount: false, refund: "second" });
    await splits(bare, [3_000]);

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["mxn", 33, 1, 1],
      ["usd", 33, 1, 1],
    ]);
  });

  test("(10) the ticket-shape fold is one row per order: many items multiply nothing", async () => {
    // Five like tickets, two refunded, a non-ticket line beside them.
    const o = await order({ status: "PART_REFUNDED", grossCents: 5_000, feeCents: 165, taxCents: 400, feeMode: "PASS_THROUGH" });
    for (let i = 0; i < 5; i += 1) {
      await orderItem({
        orderId: o,
        faceCents: 1_000,
        feeCents: 33,
        refunded: i < 2,
        refundedPlatformFeeCents: i < 2 ? 33 : null,
      });
    }
    await orderItem({ orderId: o, kind: "membership", faceCents: 500 });
    // Two payees, 5000 − 165 = 4835 split 3835 : 1000, each a multiple of
    // five, so every ticket is debited 967.
    await splits(o, [3_835, 1_000]);

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      orderCount: 1,
      ticketVolumeCents: 5_000,
      platformFeesChargedCents: 165,
      taxCollectedCents: 400,
      // 165 + 165 − 66 − 66.
      netKeptCents: 198,
      netKeptEligibleCount: 1,
    });
  });

  test("FULL_PRICE: stamped and unstamped orders in ONE currency each net under their own rule", async () => {
    // Stamped, unrefunded: 50.
    await order({ status: "SUCCEEDED", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    // Unstamped, unrefunded: 100.
    await order({ status: "SUCCEEDED", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH" });
    // Stamped, fully refunded: 50 − 50 = 0.
    const stampedRefunded = await order({ status: "REFUNDED", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await orderItem({ orderId: stampedRefunded, refunded: true, refundedPlatformFeeCents: 50 });
    // Unstamped, fully refunded: 100 − 100 = 0.
    const unstampedRefunded = await order({ status: "REFUNDED", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH" });
    await orderItem({ orderId: unstampedRefunded, refunded: true, refundedPlatformFeeCents: 50 });
    // Stamped, spending 20 of live platform-funded credit: 50 − 20 = 30.
    const stampedCredit = await order({ status: "SUCCEEDED", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await creditRedemption({ orderId: stampedCredit, amountCents: 20 });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({
      currency: "usd",
      orderCount: 5,
      netKeptEligibleCount: 5,
      // 50 + 100 + 0 + 0 + 30.
      netKeptCents: 180,
      // Five orders at 50, whichever rule they were sold under.
      platformFeesChargedCents: 250,
      feesReturnedCents: 100,
    });
  });

  test("FULL_PRICE: the conditions that are not about the basis still exclude a stamped order", async () => {
    // (2) Disputed: disputeStatus written, status left SUCCEEDED, the
    // shape markDisputeStatus leaves.
    await order({ status: "SUCCEEDED", disputeStatus: "LOST", currency: "aud", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    // (1) No recognisable fee mode: the buyer-side unit is the ONLY unit a
    // stamped order has, so without the mode nothing is known.
    await order({ status: "SUCCEEDED", currency: "cad", grossCents: 7_500, feeCents: 50, organiserCredit: FULL_PRICE });
    // (4) A refunded ticket item with no stamp.
    const unstampedRefund = await order({ status: "PART_REFUNDED", currency: "eur", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await orderItem({ orderId: unstampedRefund, refunded: true, refundedPlatformFeeCents: null });
    // (6) Refunded AND spent live credit.
    const creditRefund = await order({ status: "REFUNDED", currency: "gbp", grossCents: 7_500, feeCents: 50, feeMode: "PASS_THROUGH", organiserCredit: FULL_PRICE });
    await orderItem({ orderId: creditRefund, refunded: true, refundedPlatformFeeCents: 50 });
    await creditRedemption({ orderId: creditRefund, amountCents: 400 });
    // (7) RESALE: stamped like every other snapshot, fee still 0, cut still
    // an OrderSplit line.
    await order({ status: "SUCCEEDED", currency: "mxn", grossCents: 6_000, feeCents: 0, feeMode: "PASS_THROUGH", source: "RESALE", organiserCredit: FULL_PRICE });

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["aud", 0, 0, 1],
      ["cad", 0, 0, 1],
      ["eur", 0, 0, 1],
      ["gbp", 0, 0, 1],
      ["mxn", 0, 0, 1],
    ]);
  });

  test("FULL_PRICE: a marked ABSORB order nets the processor fee as a loss (the organiser was credited in full, the platform bore Stripe)", async () => {
    await order({ status: "SUCCEEDED", grossCents: 7_500, feeCents: 50, feeMode: "ABSORB", organiserCredit: FULL_PRICE, intent: "pi_marked_absorb", processorFeeCents: 59 });

    const [row] = await analytics.sumPlatformRevenueByCurrency();
    expect(row).toMatchObject({ orderCount: 1, netKeptEligibleCount: 1, netKeptCents: -59 });
  });

  test("a malformed feePolicySnapshot never throws and never reads as the full-price marker", async () => {
    // The column is JSONB NOT NULL, so SQL NULL is rejected; JSON null
    // ('null'::jsonb) IS accepted and is what is written here.
    const unknownShapes: Array<[string, string]> = [
      ["aud", "[]"],
      ["cad", JSON.stringify("FULL_PRICE")],
      ["eur", "null"],
    ];
    for (const [currency, rawSnapshot] of unknownShapes) {
      await order({ status: "SUCCEEDED", currency, grossCents: 7_500, feeCents: 50, rawSnapshot });
    }
    // Objects with a recognisable mode but a marker that is not the string
    // "FULL_PRICE": the OLD rule, two units.
    await order({ status: "SUCCEEDED", currency: "gbp", grossCents: 7_500, feeCents: 50, rawSnapshot: JSON.stringify({ organiserCredit: true, feeMode: "PASS_THROUGH" }) });
    await order({ status: "SUCCEEDED", currency: "mxn", grossCents: 7_500, feeCents: 50, rawSnapshot: JSON.stringify({ organiserCredit: [FULL_PRICE], feeMode: "PASS_THROUGH" }) });

    const rows = await analytics.sumPlatformRevenueByCurrency();
    const by = Object.fromEntries(rows.map((r) => [r.currency, r]));
    for (const c of ["aud", "cad", "eur"]) {
      expect(by[c]).toMatchObject({
        orderCount: 1,
        platformFeesUnknownModeCents: 50,
        platformFeesPassThroughCents: 0,
        platformFeesAbsorbCents: 0,
        netKeptEligibleCount: 0,
        netKeptCents: 0,
      });
    }
    for (const c of ["gbp", "mxn"]) {
      expect(by[c]).toMatchObject({
        orderCount: 1,
        platformFeesPassThroughCents: 50,
        netKeptEligibleCount: 1,
        netKeptCents: 100,
      });
    }
  });

  // ── The net: per currency ────────────────────────────────────────────────

  test("the net is grouped PER CURRENCY and never summed across them", async () => {
    await order({ status: "SUCCEEDED", currency: "usd", grossCents: 1_000, feeCents: 10, feeMode: "PASS_THROUGH" });
    await order({ status: "SUCCEEDED", currency: "mxn", grossCents: 5_000, feeCents: 100, feeMode: "ABSORB", intent: "pi_mxn", processorFeeCents: 50 });
    // Ineligible, and in the mxn currency: it moves the denominator only.
    await order({ status: "SUCCEEDED", currency: "MXN", grossCents: 5_000, feeCents: 100 });

    const rows = await analytics.sumPlatformRevenueByCurrency();
    expect(rows.map((r) => [r.currency, r.netKeptCents, r.netKeptEligibleCount, r.orderCount])).toEqual([
      ["mxn", 50, 1, 2],
      ["usd", 20, 1, 1],
    ]);
    // 70 — the cross-currency sum — exists on no row.
    expect(rows.some((r) => r.netKeptCents === 70)).toBe(false);
  });
});
