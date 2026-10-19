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

import { makePayeeLedgerRepo } from "../payee-ledger";

// ---------------------------------------------------------------------------
// Integration coverage for the RECONCILIATION queries of the
// ledger-authoritative settlement model (spec 2026-08-10 §9):
// `listRollupDrift`, `listConservationViolations`, `listCompletenessGaps`.
//
// None of this is provable against a mocked Prisma client — all three are raw
// aggregate SQL (FULL OUTER JOIN recompute, HAVING conservation, era-scoped
// splits-vs-credits join). This hits real Postgres, in the same harness style
// as payee-ledger-payable.integration.test.ts: base tables in pre-migration
// shape, the SHIPPED migration bytes applied on top (twice — the dev
// databases are db-push-managed, so re-apply must be a no-op).
//
// Setup NOTE (repo memory: adapter integration tests silently skip unless
// constructed with PrismaPg): `startPostgresContainer` THROWS when Docker is
// absent — a missing Docker fails this suite loudly, it never greens it.
// ---------------------------------------------------------------------------

const MIGRATION_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations/20260810190000_ledger_authoritative_foundation/migration.sql",
  ),
  "utf8",
);

/**
 * The cash-sale debit types (spec 2026-10-07 door-sales-same-price-and-tax,
 * FR-004 / owner ruling R6), applied on top of the foundation migration from
 * the SHIPPED bytes — twice, like the foundation, to prove re-apply.
 */
const CASH_SALE_MIGRATION_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations/20261007200000_cash_sale_ledger_debit/migration.sql",
  ),
  "utf8",
);

/** One CASH_SALE_DEBIT_REVERSAL per debit — the partial unique index. */
const CASH_SALE_REVERSAL_UNIQUE_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations/20261007200100_cash_sale_debit_reversal_unique/migration.sql",
  ),
  "utf8",
);

/**
 * Standalone DDL, pre-migration shape — the same base as the payable
 * integration harness plus the columns/tables the reconciliation queries
 * touch: `Order.status/currency/updatedAt` (completeness scope + grace
 * cutoff), `OrderSplit` (the expected-amount source both credit writers
 * read), and `SettlementLine` (the pre-cutover era discriminator).
 */
const TABLE_SQL = `
CREATE TYPE "PayeeLedgerEntryType" AS ENUM (
  'SETTLEMENT_CREDIT',
  'REFUND_DEBIT',
  'DISPUTE_HOLD',
  'DISPUTE_DEBIT',
  'DISPUTE_RELEASE',
  'PAYOUT',
  'RESERVE_HOLD',
  'RESERVE_RELEASE',
  'MANUAL_ADJUSTMENT'
);

CREATE TYPE "DisputeStatus" AS ENUM (
  'NEEDS_TRIAGE',
  'OPEN',
  'UNDER_REVIEW',
  'WON',
  'LOST',
  'WARNING_OPEN',
  'WARNING_UNDER_REVIEW',
  'WARNING_CLOSED'
);

CREATE TYPE "OrderStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'PART_REFUNDED',
  'REFUNDED',
  'DISPUTED',
  'CANCELLED'
);

CREATE TABLE "PayeeLedgerEntry" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payeeId" TEXT NOT NULL,
  "type" "PayeeLedgerEntryType" NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "orderId" TEXT,
  "settlementId" TEXT,
  "disputeId" TEXT,
  "relatedEntryId" TEXT,
  "description" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PayeeLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayeeLedgerEntry_idempotencyKey_key"
  ON "PayeeLedgerEntry"("idempotencyKey");

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
  "disputeStatus" "DisputeStatus",
  "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderSplit" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "payeeId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,

  CONSTRAINT "OrderSplit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SettlementLine" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,

  CONSTRAINT "SettlementLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Claim" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',

  CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);
`;

const PAYEE = "payee_1";
// Grace cutoff every completeness scenario is judged against. Orders
// "finalized long ago" get OLD_UPDATED_AT (<= cutoff); "just finalized"
// orders get RECENT_UPDATED_AT (> cutoff).
const CUTOFF = new Date("2026-06-15T00:00:00.000Z");
const OLD_UPDATED_AT = "2026-06-01T00:00:00.000Z";
const RECENT_UPDATED_AT = "2026-06-15T00:20:00.000Z";
const MATURE = new Date("2026-06-01T00:00:00.000Z");

describe("payee-ledger reconciliation queries (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let repo: ReturnType<typeof makePayeeLedgerRepo>;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    // Apply the SHIPPED migration bytes — twice, proving the re-apply
    // idempotence the db-push-managed dev databases rely on.
    await pool.query(MIGRATION_SQL);
    await pool.query(MIGRATION_SQL);
    await pool.query(CASH_SALE_MIGRATION_SQL);
    await pool.query(CASH_SALE_MIGRATION_SQL);
    await pool.query(CASH_SALE_REVERSAL_UNIQUE_SQL);
    await pool.query(CASH_SALE_REVERSAL_UNIQUE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    repo = makePayeeLedgerRepo(prisma);
  }, 300_000);

  beforeEach(async () => {
    await pool!.query(
      `TRUNCATE "PayeeLedgerEntry", "PayeeLedgerBalance", "Order",
                "OrderSplit", "SettlementLine", "Claim"`,
    );
  });

  // Explicit timeout: tearing a Testcontainers Postgres down routinely takes
  // longer than vitest's 10s default hook timeout, which fails the SUITE
  // after every test in it has already passed.
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  async function insertOrder(
    id: string,
    opts: {
      status?: string;
      currency?: string;
      updatedAt?: string;
      disputeStatus?: string | null;
    } = {},
  ) {
    await pool!.query(
      `INSERT INTO "Order" ("id", "status", "currency", "updatedAt", "disputeStatus")
       VALUES ($1, $2::"OrderStatus", $3, $4::timestamp, $5::"DisputeStatus")`,
      [
        id,
        opts.status ?? "SUCCEEDED",
        opts.currency ?? "usd",
        opts.updatedAt ?? OLD_UPDATED_AT,
        opts.disputeStatus ?? null,
      ],
    );
  }

  let splitSeq = 0;
  async function insertSplit(
    orderId: string,
    payeeId: string,
    amountCents: number,
  ) {
    splitSeq += 1;
    await pool!.query(
      `INSERT INTO "OrderSplit" ("id", "orderId", "payeeId", "amountCents")
       VALUES ($1, $2, $3, $4)`,
      [`split_${splitSeq}`, orderId, payeeId, amountCents],
    );
  }

  async function insertSettlementLine(orderId: string) {
    await pool!.query(
      `INSERT INTO "SettlementLine" ("id", "orderId") VALUES ($1, $2)`,
      [`sline_${orderId}`, orderId],
    );
  }

  /** Raw entry insert — for shapes no writer produces any more (legacy rows,
   *  deliberately-orphaned entries whose rollup effect was "lost"). */
  let rawSeq = 0;
  async function insertRawEntry(opts: {
    type: string;
    amountCents: number;
    payeeId?: string;
    currency?: string;
    orderId?: string | null;
    idempotencyKey?: string;
    availableAt?: Date | null;
  }) {
    rawSeq += 1;
    const id = `raw_${rawSeq}`;
    await pool!.query(
      `INSERT INTO "PayeeLedgerEntry"
         ("id", "idempotencyKey", "payeeId", "type", "amountCents", "currency",
          "sourceKind", "sourceId", "orderId", "availableAt", "description")
       VALUES ($1, $2, $3, $4::"PayeeLedgerEntryType", $5, $6, 'test', $1, $7,
               $8::timestamp, 'raw seed')`,
      [
        id,
        opts.idempotencyKey ?? `raw:${rawSeq}`,
        opts.payeeId ?? PAYEE,
        opts.type,
        opts.amountCents,
        opts.currency ?? "usd",
        opts.orderId ?? null,
        opts.availableAt === undefined
          ? opts.type === "SETTLEMENT_CREDIT"
            ? MATURE.toISOString()
            : null
          : (opts.availableAt?.toISOString() ?? null),
      ],
    );
    return id;
  }

  let creditSeq = 0;
  async function credit(opts: {
    orderId: string;
    amountCents: number;
    payeeId?: string;
    currency?: string;
  }) {
    creditSeq += 1;
    return repo.settlementCredit({
      idempotencyKey: `settlement-credit:${opts.orderId}:${opts.payeeId ?? PAYEE}:${creditSeq}`,
      payeeId: opts.payeeId ?? PAYEE,
      amountCents: opts.amountCents,
      currency: opts.currency ?? "usd",
      orderId: opts.orderId,
      availableAt: MATURE,
      description: `credit for ${opts.orderId}`,
      metadata: { items: { [`item_${opts.orderId}`]: opts.amountCents } },
      sourceKind: "order_split",
      sourceId: opts.orderId,
    });
  }

  // ── Clean state ───────────────────────────────────────────────────────────

  test("a clean, writer-produced ledger reports ZERO violations in all three sweeps", async () => {
    // Ticketing order: splits match its credit exactly.
    await insertOrder("order_ok");
    await insertSplit("order_ok", PAYEE, 10_000);
    await credit({ orderId: "order_ok", amountCents: 10_000 });

    // A partial refund inside conservation bounds.
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_ok:payee_1:refund_1",
      payeeId: PAYEE,
      amountCents: 4_000,
      currency: "usd",
      orderId: "order_ok",
      description: "partial refund",
      sourceKind: "refund",
      sourceId: "refund_1",
    });

    // Dispute hold → release cycle (pendingHold back to 0) and a hold that
    // stays ACTIVE (pendingHold carries it).
    const releasedHold = await repo.hold({
      idempotencyKey: "dispute-hold:dispute_released:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 2_000,
      currency: "usd",
      disputeId: "dispute_released",
      orderId: "order_ok",
    });
    await repo.releaseHold({ holdEntryId: releasedHold.id });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_active:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 1_500,
      currency: "usd",
      disputeId: "dispute_active",
      orderId: "order_ok",
    });

    // Reserve hold + release pair, plus one still outstanding.
    const reserveHold = await repo.reserveHold({
      idempotencyKey: "reserve-hold:item_1",
      payeeId: PAYEE,
      amountCents: 500,
      currency: "usd",
      payoutItemId: "item_1",
    });
    await repo.reserveRelease({
      idempotencyKey: `reserve-release:${reserveHold.id}`,
      holdEntryId: reserveHold.id,
      payoutItemId: "item_2",
    });
    await repo.reserveHold({
      idempotencyKey: "reserve-hold:item_3",
      payeeId: PAYEE,
      amountCents: 700,
      currency: "usd",
      payoutItemId: "item_3",
    });

    // A payout out the door.
    await repo.payoutDebit({
      idempotencyKey: "payout:item_1",
      payeeId: PAYEE,
      amountCents: 3_000,
      currency: "usd",
      sourceKind: "payout_item",
      sourceId: "item_1",
      description: "payout",
      metadata: { consumedCreditEntryIds: [] },
    });

    expect(await repo.listRollupDrift()).toEqual({ total: 0, rows: [] });
    expect(await repo.listConservationViolations()).toEqual({
      total: 0,
      rows: [],
    });
    expect(await repo.listCompletenessGaps(CUTOFF)).toEqual({
      total: 0,
      rows: [],
    });
  });

  // ── Invariant 1: rollup drift ─────────────────────────────────────────────

  test("a directly-corrupted ledgerPendingHoldCents is detected with exact cents; the clamp cannot hide it", async () => {
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 10_000 });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_1:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 8_000,
      currency: "usd",
      disputeId: "dispute_1",
      orderId: "order_1",
    });

    // Simulate the drift class the GREATEST(0, ·) clamp masks: the cached
    // counter was decremented (or zeroed) without a consuming release/debit
    // entry ever being written.
    await pool!.query(
      `UPDATE "PayeeLedgerBalance" SET "ledgerPendingHoldCents" = 0
       WHERE "payeeId" = $1 AND "currency" = 'usd'`,
      [PAYEE],
    );

    const scan = await repo.listRollupDrift();
    expect(scan.total).toBe(1);
    expect(scan.rows).toEqual([
      {
        payeeId: PAYEE,
        currency: "usd",
        cachedLedgerBalanceCents: 10_000,
        expectedLedgerBalanceCents: 10_000,
        cachedPendingHoldCents: 0,
        expectedPendingHoldCents: 8_000,
        cachedReserveCents: 0,
        expectedReserveCents: 0,
        rollupRowMissing: false,
        orphanRollupRow: false,
      },
    ]);
  });

  test("a hold CONSUMED by a dispute debit is not active — no drift is invented for it", async () => {
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 10_000 });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_1:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 8_000,
      currency: "usd",
      disputeId: "dispute_1",
      orderId: "order_1",
    });
    // The debit consumes the hold (relatedEntryId link, DISPUTE_DEBIT is in
    // RELEASE_TYPES) and the writer decrements pendingHold in the same pass.
    await repo.debit({
      idempotencyKey: "dispute-debit:dispute_1:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 8_000,
      currency: "usd",
      disputeId: "dispute_1",
      orderId: "order_1",
    });

    expect(await repo.listRollupDrift()).toEqual({ total: 0, rows: [] });
  });

  test("corrupted reserveBalanceCents and a MISSING rollup row are both detected", async () => {
    // Cell A: reserve drift.
    await repo.reserveHold({
      idempotencyKey: "reserve-hold:item_1",
      payeeId: "payee_reserve",
      amountCents: 900,
      currency: "usd",
      payoutItemId: "item_1",
    });
    await pool!.query(
      `UPDATE "PayeeLedgerBalance" SET "reserveBalanceCents" = 100
       WHERE "payeeId" = 'payee_reserve' AND "currency" = 'usd'`,
    );

    // Cell B: an entry whose rollup effect was LOST entirely (no balance row).
    await insertRawEntry({
      type: "SETTLEMENT_CREDIT",
      amountCents: 2_500,
      payeeId: "payee_missing",
      orderId: "order_x",
    });

    const scan = await repo.listRollupDrift();
    expect(scan.total).toBe(2);
    expect(scan.rows).toEqual([
      {
        payeeId: "payee_missing",
        currency: "usd",
        cachedLedgerBalanceCents: 0,
        expectedLedgerBalanceCents: 2_500,
        cachedPendingHoldCents: 0,
        expectedPendingHoldCents: 0,
        cachedReserveCents: 0,
        expectedReserveCents: 0,
        rollupRowMissing: true,
        orphanRollupRow: false,
      },
      {
        payeeId: "payee_reserve",
        currency: "usd",
        cachedLedgerBalanceCents: 0,
        expectedLedgerBalanceCents: 0,
        cachedPendingHoldCents: 0,
        expectedPendingHoldCents: 0,
        cachedReserveCents: 100,
        expectedReserveCents: 900,
        rollupRowMissing: false,
        orphanRollupRow: false,
      },
    ]);
  });

  test("an ORPHAN rollup row (no entries) with non-zero counters is flagged; legacy debt-recovery PAYOUT rows read + (no false drift)", async () => {
    // Orphan: a counter with no journal behind it.
    await pool!.query(
      `INSERT INTO "PayeeLedgerBalance"
         ("payeeId", "currency", "ledgerBalanceCents", "ledgerPendingHoldCents", "reserveBalanceCents")
       VALUES ('payee_orphan', 'usd', 4000, 0, 0)`,
    );

    // Legacy cell: pre-cutover debt-recovery PAYOUT applied += to the rollup;
    // the recompute must read it + too (same namespace discrimination as the
    // payable query) or every pre-cutover database would page on day one.
    await insertOrder("order_legacy");
    await credit({
      orderId: "order_legacy",
      amountCents: 10_000,
      payeeId: "payee_legacy",
    });
    await insertRawEntry({
      type: "PAYOUT",
      amountCents: 3_000,
      payeeId: "payee_legacy",
      idempotencyKey: "debt-recovery:payout_item_1",
    });
    await pool!.query(
      `UPDATE "PayeeLedgerBalance"
          SET "ledgerBalanceCents" = "ledgerBalanceCents" + 3000
        WHERE "payeeId" = 'payee_legacy' AND "currency" = 'usd'`,
    );

    const scan = await repo.listRollupDrift();
    expect(scan.total).toBe(1);
    expect(scan.rows[0]).toMatchObject({
      payeeId: "payee_orphan",
      cachedLedgerBalanceCents: 4_000,
      expectedLedgerBalanceCents: 0,
      rollupRowMissing: false,
      orphanRollupRow: true,
    });
  });

  test("sums beyond int4 FLAG (via bigint) instead of raising 22003", async () => {
    // Two near-int4-max credits in one cell: their sum (4.0e9) overflows
    // int4. The payable query would deliberately RAISE on this; the sweep
    // must instead report it — its whole job is to surface the pathological
    // cell. Raw inserts (no rollup row), so expected 4e9 vs cached 0.
    await insertRawEntry({
      type: "SETTLEMENT_CREDIT",
      amountCents: 2_000_000_000,
      payeeId: "payee_huge",
      orderId: "order_huge",
    });
    await insertRawEntry({
      type: "SETTLEMENT_CREDIT",
      amountCents: 2_000_000_000,
      payeeId: "payee_huge",
      orderId: "order_huge",
    });

    const scan = await repo.listRollupDrift();
    expect(scan.total).toBe(1);
    expect(scan.rows[0]).toMatchObject({
      payeeId: "payee_huge",
      expectedLedgerBalanceCents: 4_000_000_000,
      cachedLedgerBalanceCents: 0,
      rollupRowMissing: true,
    });
  });

  // ── Invariant 2: conservation ─────────────────────────────────────────────

  test("refund debits exceeding the credit are flagged with exact cents; in-bounds cells are not", async () => {
    // Violating cell: 6_000 refunded of a 5_000 grant.
    await insertOrder("order_over");
    await credit({ orderId: "order_over", amountCents: 5_000 });
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_over:payee_1:refund_1",
      payeeId: PAYEE,
      amountCents: 6_000,
      currency: "usd",
      orderId: "order_over",
      description: "over-refund",
      sourceKind: "refund",
      sourceId: "refund_1",
    });

    // Clean cell: full refund exactly at the bound.
    await insertOrder("order_even");
    await credit({ orderId: "order_even", amountCents: 3_000 });
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_even:payee_1:refund_2",
      payeeId: PAYEE,
      amountCents: 3_000,
      currency: "usd",
      orderId: "order_even",
      description: "full refund",
      sourceKind: "refund",
      sourceId: "refund_2",
    });

    const scan = await repo.listConservationViolations();
    expect(scan.total).toBe(1);
    expect(scan.rows).toEqual([
      {
        orderId: "order_over",
        payeeId: PAYEE,
        currency: "usd",
        creditCents: 5_000,
        refundDebitCents: 6_000,
        transferReversalCreditCents: 0,
        disputeDebitCents: 0,
        disputeDebitReversalCents: 0,
        disputeFeeDebitCents: 0,
        cashSaleDebitCents: 0,
        cashSaleDebitReversalCents: 0,
      },
    ]);
  });

  test("a transfer reversal exceeding its refund debits is flagged (manufactured money)", async () => {
    await insertOrder("order_rev");
    await credit({ orderId: "order_rev", amountCents: 10_000 });
    const debit = await repo.refundDebit({
      idempotencyKey: "refund-debit:order_rev:payee_1:refund_1",
      payeeId: PAYEE,
      amountCents: 2_000,
      currency: "usd",
      orderId: "order_rev",
      description: "refund",
      sourceKind: "refund",
      sourceId: "refund_1",
    });
    await repo.transferReversalCredit({
      idempotencyKey: `transfer-reversal-credit:${debit.id}`,
      payeeId: PAYEE,
      amountCents: 3_500,
      currency: "usd",
      orderId: "order_rev",
      relatedEntryId: debit.id,
      description: "reversal larger than the debit it compensates",
    });

    const scan = await repo.listConservationViolations();
    expect(scan.total).toBe(1);
    expect(scan.rows[0]).toMatchObject({
      orderId: "order_rev",
      refundDebitCents: 2_000,
      transferReversalCreditCents: 3_500,
    });
  });

  test("a dispute debit stacked on a full refund is flagged; a debit within the un-refunded remainder is not; a reversed debit nets out", async () => {
    // VIOLATION: credit 5000, fully refunded (5000), then a lost chargeback
    // debits 5000 again — the payee kept nothing yet owes 5000. This is the
    // cell the LOST cap (`retainedCreditByPayee`) prevents; planting it
    // directly proves the sweep would catch a writer that bypassed the cap.
    await insertOrder("order_stack", { disputeStatus: "LOST" });
    await credit({ orderId: "order_stack", amountCents: 5_000 });
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_stack:payee_1:refund_1",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      orderId: "order_stack",
      description: "full refund",
      sourceKind: "refund",
      sourceId: "refund_1",
    });
    await repo.debit({
      idempotencyKey: "dispute-debit:dispute_stack:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      disputeId: "dispute_stack",
      orderId: "order_stack",
    });

    // CLEAN: credit 5000, partial refund 2000, dispute debit 3000 — exactly
    // the remainder. Sum of takings == credit, in bounds.
    await insertOrder("order_fit", { disputeStatus: "LOST" });
    await credit({ orderId: "order_fit", amountCents: 5_000 });
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_fit:payee_1:refund_2",
      payeeId: PAYEE,
      amountCents: 2_000,
      currency: "usd",
      orderId: "order_fit",
      description: "partial refund",
      sourceKind: "refund",
      sourceId: "refund_2",
    });
    await repo.debit({
      idempotencyKey: "dispute-debit:dispute_fit:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 3_000,
      currency: "usd",
      disputeId: "dispute_fit",
      orderId: "order_fit",
    });

    // CLEAN via reversal: full refund + a dispute debit that was then
    // reversed on WON-after-LOST — the debit-compensating DISPUTE_RELEASE
    // nets it out of the check. A hold→release cycle on the same cell is
    // ignored (hold-release flavour has no balance effect).
    await insertOrder("order_won", { disputeStatus: "WON" });
    await credit({ orderId: "order_won", amountCents: 5_000 });
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_won:payee_1:refund_3",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      orderId: "order_won",
      description: "full refund",
      sourceKind: "refund",
      sourceId: "refund_3",
    });
    const wonDebit = await repo.debit({
      idempotencyKey: "dispute-debit:dispute_won:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      disputeId: "dispute_won",
      orderId: "order_won",
    });
    await repo.reverseDisputeDebit({
      idempotencyKey: "dispute-debit-reversal:dispute_won:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      disputeId: "dispute_won",
      debitEntryId: wonDebit.id,
      orderId: "order_won",
    });
    const cycledHold = await repo.hold({
      idempotencyKey: "dispute-hold:dispute_won_hold:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      disputeId: "dispute_won_hold",
      orderId: "order_won",
    });
    await repo.releaseHold({ holdEntryId: cycledHold.id });

    const scan = await repo.listConservationViolations();
    expect(scan.total).toBe(1);
    expect(scan.rows).toEqual([
      {
        orderId: "order_stack",
        payeeId: PAYEE,
        currency: "usd",
        creditCents: 5_000,
        refundDebitCents: 5_000,
        transferReversalCreditCents: 0,
        disputeDebitCents: 5_000,
        disputeDebitReversalCents: 0,
        disputeFeeDebitCents: 0,
        cashSaleDebitCents: 0,
        cashSaleDebitReversalCents: 0,
      },
    ]);
  });

  test("a membership fee debit is NOT a claim against the credit: credit 5000 + principal 5000 + fee 1500 scans clean, principal 5000 + refund 5000 still flags", async () => {
    // CLEAN: the whole credit came back as principal, and the fee sits on
    // top of it. Counting the fee would flag every lost membership dispute
    // forever.
    await insertOrder("order_fee_ok", { disputeStatus: "LOST" });
    await credit({ orderId: "order_fee_ok", amountCents: 5_000 });
    await repo.debit({
      idempotencyKey: "dispute-debit:dispute_fee_ok:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      disputeId: "dispute_fee_ok",
      orderId: "order_fee_ok",
    });
    await repo.debit({
      idempotencyKey: "dispute-debit-fee:dispute_fee_ok:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 1_500,
      currency: "usd",
      disputeId: "dispute_fee_ok",
      orderId: "order_fee_ok",
      consumeHold: false,
    });
    expect(await repo.listConservationViolations()).toEqual({
      total: 0,
      rows: [],
    });

    // CLEAN after a WON-after-LOST flip that reverses BOTH entries: the fee
    // reversal must be excluded like the fee, or the left side goes
    // negative and could mask a real violation elsewhere on the cell.
    const feeRow = (await repo.listDebitsForDispute("dispute_fee_ok")).find((e) =>
      e.idempotencyKey.startsWith("dispute-debit-fee:"),
    )!;
    await repo.reverseDisputeDebit({
      idempotencyKey: "dispute-debit-reversal-fee:dispute_fee_ok:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 1_500,
      currency: "usd",
      disputeId: "dispute_fee_ok",
      debitEntryId: feeRow.id,
      orderId: "order_fee_ok",
    });
    // Plant a refund on top: principal 5000 + refund 1000 > credit 5000 is
    // a real violation, and the −1500 fee reversal must not hide it.
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_fee_ok:payee_1:refund_x",
      payeeId: PAYEE,
      amountCents: 1_000,
      currency: "usd",
      orderId: "order_fee_ok",
      description: "refund on top",
      sourceKind: "refund",
      sourceId: "refund_x",
    });
    const scan = await repo.listConservationViolations();
    expect(scan.total).toBe(1);
    expect(scan.rows[0]).toMatchObject({
      orderId: "order_fee_ok",
      creditCents: 5_000,
      refundDebitCents: 1_000,
      disputeDebitCents: 5_000,
      disputeDebitReversalCents: 0,
      disputeFeeDebitCents: 1_500,
    });
  });

  test("a transfer reversal does NOT make room for a dispute debit (the money already went back through Stripe)", async () => {
    // Post-payout full refund, reversal succeeded, then a lost chargeback
    // debits the full credit. Ledger balance nets to −5000 for a payee who
    // holds nothing of the order. Adding the reversal back on the left would
    // hide this; the sweep must flag it.
    await insertOrder("order_rev_stack", { disputeStatus: "LOST" });
    await credit({ orderId: "order_rev_stack", amountCents: 5_000 });
    const refund = await repo.refundDebit({
      idempotencyKey: "refund-debit:order_rev_stack:payee_1:refund_1",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      orderId: "order_rev_stack",
      description: "full refund",
      sourceKind: "refund",
      sourceId: "refund_1",
    });
    await repo.transferReversalCredit({
      idempotencyKey: `transfer-reversal-credit:${refund.id}`,
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      orderId: "order_rev_stack",
      relatedEntryId: refund.id,
      description: "reversal",
    });
    await repo.debit({
      idempotencyKey: "dispute-debit:dispute_rev_stack:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      disputeId: "dispute_rev_stack",
      orderId: "order_rev_stack",
    });

    const scan = await repo.listConservationViolations();
    expect(scan.total).toBe(1);
    expect(scan.rows[0]).toMatchObject({
      orderId: "order_rev_stack",
      refundDebitCents: 5_000,
      transferReversalCreditCents: 5_000,
      disputeDebitCents: 5_000,
    });
  });

  // ── Invariant 3: completeness ─────────────────────────────────────────────

  test("cash sales (spec 2026-10-07): writer-produced debit + reversal show no rollup drift and no conservation violation", async () => {
    await insertOrder("order_card");
    await credit({ orderId: "order_card", amountCents: 10_000 });
    for (const orderId of ["order_cash_1", "order_cash_2"]) {
      await repo.cashSaleDebit({
        idempotencyKey: `cash-sale-debit:${orderId}`,
        payeeId: PAYEE,
        amountCents: 700,
        currency: "usd",
        orderId,
        description: "cash sale fee + tax",
        sourceKind: "pos_cash_sale",
        sourceId: orderId,
      });
    }
    await repo.cashSaleDebitReversal({
      idempotencyKey: "cash-sale-debit-reversal:order_cash_1",
      debitIdempotencyKey: "cash-sale-debit:order_cash_1",
      description: "cash sale refunded",
      sourceKind: "pos_cash_refund",
      sourceId: "order_cash_1",
    });

    // The drift CASE signs the two new types exactly as the writers moved
    // the rollup: 10000 − 700 − 700 + 700.
    expect(await repo.listRollupDrift()).toEqual({ total: 0, rows: [] });
    const { rows } = await pool!.query(
      `SELECT "ledgerBalanceCents" FROM "PayeeLedgerBalance" WHERE "payeeId" = $1`,
      [PAYEE],
    );
    expect(rows[0].ledgerBalanceCents).toBe(9_300);
    expect(await repo.listConservationViolations()).toEqual({
      total: 0,
      rows: [],
    });
  });

  test("cash sales: a reversal exceeding its debit is flagged (manufactured money); a corrupted rollup is drift", async () => {
    await insertRawEntry({
      type: "CASH_SALE_DEBIT",
      amountCents: 700,
      orderId: "order_cash",
      idempotencyKey: "cash-sale-debit:order_cash",
    });
    await insertRawEntry({
      type: "CASH_SALE_DEBIT_REVERSAL",
      amountCents: 900,
      orderId: "order_cash",
      idempotencyKey: "cash-sale-debit-reversal:order_cash",
    });

    const scan = await repo.listConservationViolations();
    expect(scan.total).toBe(1);
    expect(scan.rows[0]).toMatchObject({
      orderId: "order_cash",
      payeeId: PAYEE,
      cashSaleDebitCents: 700,
      cashSaleDebitReversalCents: 900,
    });

    // Raw rows never touched the rollup: the entries say +200, the missing
    // rollup row says 0.
    const drift = await repo.listRollupDrift();
    expect(drift.total).toBe(1);
    expect(drift.rows[0]).toMatchObject({
      payeeId: PAYEE,
      cachedLedgerBalanceCents: 0,
      expectedLedgerBalanceCents: 200,
    });
  });

  test("a SUCCEEDED, aged, ledger-era order with splits and NO credits is a gap; the same order pre-cutover (SettlementLine) is not", async () => {
    // The genuine gap — the dev-DB shape that motivated this check: a
    // finalized order whose credit mint silently never happened.
    await insertOrder("order_gap");
    await insertSplit("order_gap", PAYEE, 3_450);

    // Pre-cutover twin: identical except the old settlement writer left its
    // SettlementLine rows — paid through the DELETED system, owed nothing
    // from the ledger. The era discriminator must exclude it.
    await insertOrder("order_precutover");
    await insertSplit("order_precutover", PAYEE, 3_450);
    await insertSettlementLine("order_precutover");

    const scan = await repo.listCompletenessGaps(CUTOFF);
    expect(scan.total).toBe(1);
    expect(scan.rows).toEqual([
      {
        orderId: "order_gap",
        payeeId: PAYEE,
        currency: "usd",
        expectedFromSplitsCents: 3_450,
        creditCents: 0,
      },
    ]);
  });

  test("credits summing to the WRONG amount are a gap; matching credits are not; multi-payee orders are judged per payee", async () => {
    await insertOrder("order_multi");
    await insertSplit("order_multi", "payee_a", 7_000);
    await insertSplit("order_multi", "payee_b", 3_000);
    // payee_a got the right credit; payee_b's credit is short.
    await credit({
      orderId: "order_multi",
      amountCents: 7_000,
      payeeId: "payee_a",
    });
    await credit({
      orderId: "order_multi",
      amountCents: 2_500,
      payeeId: "payee_b",
    });

    const scan = await repo.listCompletenessGaps(CUTOFF);
    expect(scan.total).toBe(1);
    expect(scan.rows).toEqual([
      {
        orderId: "order_multi",
        payeeId: "payee_b",
        currency: "usd",
        expectedFromSplitsCents: 3_000,
        creditCents: 2_500,
      },
    ]);
  });

  test("grace window: an order finalized after the cutoff is NOT flagged (yet)", async () => {
    await insertOrder("order_fresh", { updatedAt: RECENT_UPDATED_AT });
    await insertSplit("order_fresh", PAYEE, 5_000);

    expect(await repo.listCompletenessGaps(CUTOFF)).toEqual({
      total: 0,
      rows: [],
    });
    // Once the cutoff passes its updatedAt, it flags.
    const later = new Date("2026-06-15T01:00:00.000Z");
    expect((await repo.listCompletenessGaps(later)).total).toBe(1);
  });

  test("status scope: REFUNDED/PENDING/CANCELLED orders never flag; PART_REFUNDED does", async () => {
    // Fully refunded (incl. the pre-cutover pending-settlement shape on dev):
    // owed zero, must not page.
    await insertOrder("order_refunded", { status: "REFUNDED" });
    await insertSplit("order_refunded", PAYEE, 4_000);
    await insertOrder("order_pending", { status: "PENDING" });
    await insertSplit("order_pending", PAYEE, 4_000);
    await insertOrder("order_cancelled", { status: "CANCELLED" });
    await insertSplit("order_cancelled", PAYEE, 4_000);

    // PART_REFUNDED means payment finalized — its mint should exist.
    await insertOrder("order_part", { status: "PART_REFUNDED" });
    await insertSplit("order_part", PAYEE, 4_000);

    const scan = await repo.listCompletenessGaps(CUTOFF);
    expect(scan.total).toBe(1);
    expect(scan.rows[0]).toMatchObject({ orderId: "order_part" });
  });

  test("orders with no splits (cash sales, free orders) and zero-sum payees create no expectation", async () => {
    // No OrderSplit rows at all — record-cash-sale's shape.
    await insertOrder("order_cash");
    // A zero split — the writers skip amount <= 0 (skippedZeroAmount).
    await insertOrder("order_zero");
    await insertSplit("order_zero", PAYEE, 0);

    expect(await repo.listCompletenessGaps(CUTOFF)).toEqual({
      total: 0,
      rows: [],
    });
  });

  test("sample cap: total counts every violation, rows are capped", async () => {
    for (let i = 0; i < 5; i++) {
      await insertOrder(`order_gap_${i}`);
      await insertSplit(`order_gap_${i}`, PAYEE, 1_000 + i);
    }

    const scan = await repo.listCompletenessGaps(CUTOFF, 2);
    expect(scan.total).toBe(5);
    expect(scan.rows).toHaveLength(2);
  });
});
