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

import { isAppError } from "@th/errors";

import {
  __testOnlyDebtPositionsHooks,
  buildDebtPositionsSql,
  DEBT_TX_MAX_WAIT_MS,
  makePayeeLedgerRepo,
  TX_TIMEOUT_HEADROOM_MS,
} from "../payee-ledger";

// ---------------------------------------------------------------------------
// Integration coverage for `listDebtPositions` — the staff "Payees in debt"
// read. Raw SQL with window functions (running balance → `debtSinceAt`), a
// keyset cursor and a Payee join: none of it is provable against a mocked
// client. Same harness as payee-ledger-payable.integration.test.ts (base
// tables in pre-migration shape + the shipped migration bytes), plus a
// minimal `Payee` for the subject join.
//
// The load-bearing invariant is agreement with `listPayableBalances`: every
// cell this lists must be exactly a cell whose payable is negative there,
// with the same cents. Both queries share `payableEffectSql`, and the last
// test asserts the agreement on a mixed ledger.
// ---------------------------------------------------------------------------

const MIGRATION_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations/20260810190000_ledger_authoritative_foundation/migration.sql",
  ),
  "utf8",
);

/**
 * The cash-sale debit types (spec 2026-10-07 door-sales-same-price-and-tax).
 * The shared non-credit CASE names them as literals, so the debt-position
 * query needs them in the enum like any migrated database has them.
 */
const CASH_SALE_MIGRATION_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations/20261007200000_cash_sale_ledger_debit/migration.sql",
  ),
  "utf8",
);

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

CREATE TYPE "PayeeSubjectType" AS ENUM ('ORGANIZATION', 'HUMAN');

CREATE TABLE "Payee" (
  "id" TEXT NOT NULL,
  "subjectType" "PayeeSubjectType" NOT NULL,
  "subjectId" TEXT NOT NULL,
  CONSTRAINT "Payee_pkey" PRIMARY KEY ("id")
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
  -- Read by the approved-claim freeze (REFUNDED lifts it) and the resale
  -- claim-window maturity gate (source + eventId). Defaults keep every
  -- pre-existing scenario a non-resale, unrefunded order.
  "status" TEXT NOT NULL DEFAULT 'SUCCEEDED',
  "source" TEXT NOT NULL DEFAULT 'PRIMARY',
  "eventId" TEXT,

  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Event" (
  "id" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3),

  CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Claim" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',

  CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);
`;

const AS_OF = new Date("2026-06-15T00:00:00.000Z");
const MATURE = new Date("2026-06-01T00:00:00.000Z");
const IMMATURE = new Date("2026-07-01T00:00:00.000Z");

const ORG_PAYEE = "payee_org";
const HUMAN_PAYEE = "payee_human";
const HEALTHY_PAYEE = "payee_healthy";

describe("payee-ledger listDebtPositions (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let repo: ReturnType<typeof makePayeeLedgerRepo>;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    await pool.query(MIGRATION_SQL);
    await pool.query(CASH_SALE_MIGRATION_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    repo = makePayeeLedgerRepo(prisma);
  }, 300_000);

  beforeEach(async () => {
    __testOnlyDebtPositionsHooks.beforeQuery = null;
    await pool!.query(
      `TRUNCATE "PayeeLedgerEntry", "PayeeLedgerBalance", "Order", "Claim", "Payee"`,
    );
    await pool!.query(
      `INSERT INTO "Payee" ("id", "subjectType", "subjectId") VALUES
        ($1, 'ORGANIZATION', 'org_1'),
        ($2, 'HUMAN', 'human_1'),
        ($3, 'ORGANIZATION', 'org_2')`,
      [ORG_PAYEE, HUMAN_PAYEE, HEALTHY_PAYEE],
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  async function insertOrder(id: string, disputeStatus: string | null = null) {
    await pool!.query(
      `INSERT INTO "Order" ("id", "disputeStatus") VALUES ($1, $2::"DisputeStatus")`,
      [id, disputeStatus],
    );
  }

  /**
   * Pin an entry's createdAt so the running-balance order is deterministic.
   * Sent as an ISO string, not a JS Date: the column is TIMESTAMP(3) WITHOUT
   * time zone and node-pg serialises a Date in the process's LOCAL zone,
   * which would shift every pinned instant by the box's UTC offset.
   */
  async function stampCreatedAt(entryId: string, at: Date) {
    await pool!.query(
      `UPDATE "PayeeLedgerEntry" SET "createdAt" = $2::timestamp WHERE "id" = $1`,
      [entryId, at.toISOString()],
    );
  }

  let seq = 0;
  async function credit(opts: {
    payeeId: string;
    orderId: string;
    amountCents: number;
    availableAt?: Date;
    at: Date;
  }) {
    seq += 1;
    const row = await repo.settlementCredit({
      idempotencyKey: `settlement-credit:${opts.orderId}:${opts.payeeId}:${seq}`,
      payeeId: opts.payeeId,
      amountCents: opts.amountCents,
      currency: "usd",
      orderId: opts.orderId,
      availableAt: opts.availableAt ?? MATURE,
      description: "credit",
      metadata: { items: { [`item_${opts.orderId}`]: opts.amountCents } },
      sourceKind: "order_split",
      sourceId: opts.orderId,
    });
    await stampCreatedAt(row.id, opts.at);
    return row;
  }

  async function refund(opts: {
    payeeId: string;
    orderId: string;
    amountCents: number;
    at: Date;
  }) {
    seq += 1;
    const row = await repo.refundDebit({
      idempotencyKey: `refund-debit:${opts.orderId}:${opts.payeeId}:r${seq}`,
      payeeId: opts.payeeId,
      amountCents: opts.amountCents,
      currency: "usd",
      orderId: opts.orderId,
      description: "refund",
      sourceKind: "refund",
      sourceId: `refund_${seq}`,
    });
    await stampCreatedAt(row.id, opts.at);
    return row;
  }

  async function disputeDebit(opts: {
    payeeId: string;
    orderId: string;
    amountCents: number;
    at: Date;
    fee?: boolean;
  }) {
    seq += 1;
    const row = await repo.debit({
      idempotencyKey: `${opts.fee ? "dispute-debit-fee" : "dispute-debit"}:d${seq}:${opts.payeeId}:usd`,
      payeeId: opts.payeeId,
      amountCents: opts.amountCents,
      currency: "usd",
      disputeId: `dispute_${seq}`,
      orderId: opts.orderId,
      consumeHold: !opts.fee,
    });
    await stampCreatedAt(row.id, opts.at);
    return row;
  }

  async function payout(opts: { payeeId: string; amountCents: number; at: Date }) {
    seq += 1;
    const row = await repo.payoutDebit({
      idempotencyKey: `payout:item_${seq}`,
      payeeId: opts.payeeId,
      amountCents: opts.amountCents,
      currency: "usd",
      sourceKind: "payout_item",
      sourceId: `item_${seq}`,
      description: "payout",
      metadata: { consumedCreditEntryIds: [] },
    });
    await stampCreatedAt(row.id, opts.at);
    return row;
  }

  const T = (day: number) => new Date(`2026-05-${String(day).padStart(2, "0")}T00:00:00.000Z`);

  test("lists only negative cells, largest debt first, joined to the Payee subject, with the debit split (fee twin excluded)", async () => {
    await insertOrder("o1");
    await insertOrder("o2");
    await insertOrder("o3");
    // Org: credit 100, paid out 100, then LOST dispute 80 + fee 15 → −95.
    await credit({ payeeId: ORG_PAYEE, orderId: "o1", amountCents: 10_000, at: T(1) });
    await payout({ payeeId: ORG_PAYEE, amountCents: 10_000, at: T(2) });
    await disputeDebit({ payeeId: ORG_PAYEE, orderId: "o1", amountCents: 8_000, at: T(3) });
    await disputeDebit({ payeeId: ORG_PAYEE, orderId: "o1", amountCents: 1_500, at: T(3), fee: true });
    // Human: credit 40 immature, refund 40 → −40 today (credit not yet counted).
    await credit({ payeeId: HUMAN_PAYEE, orderId: "o2", amountCents: 4_000, availableAt: IMMATURE, at: T(4) });
    await refund({ payeeId: HUMAN_PAYEE, orderId: "o2", amountCents: 4_000, at: T(5) });
    // Healthy: credit 50, refund 10 → +40, must NOT appear.
    await credit({ payeeId: HEALTHY_PAYEE, orderId: "o3", amountCents: 5_000, at: T(6) });
    await refund({ payeeId: HEALTHY_PAYEE, orderId: "o3", amountCents: 1_000, at: T(7) });

    const page = await repo.listDebtPositions({ now: AS_OF });

    expect(page.total).toBe(2);
    expect(page.pageInfo.hasNextPage).toBe(false);
    expect(page.pageInfo.nextCursor).toBeNull();
    expect(page.items.map((r) => [r.payeeId, r.payableCents])).toEqual([
      [ORG_PAYEE, -9_500],
      [HUMAN_PAYEE, -4_000],
    ]);

    const org = page.items[0]!;
    expect(org).toMatchObject({
      subjectType: "ORGANIZATION",
      subjectId: "org_1",
      currency: "usd",
      // Principal only: the 1_500 fee twin is excluded from the split even
      // though it counts in the payable.
      disputeDebitCents: 8_000,
      refundDebitCents: 0,
      lastDebitType: "DISPUTE_DEBIT",
    });
    expect(org.lastDebitAt?.toISOString()).toBe(T(3).toISOString());
    // Balance path: +100 (T1) → 0 (T2, still >= 0) → −80 (T3). The debt
    // started at the first entry after the last non-negative point.
    expect(org.debtSinceAt?.toISOString()).toBe(T(3).toISOString());

    const human = page.items[1]!;
    expect(human).toMatchObject({
      subjectType: "HUMAN",
      subjectId: "human_1",
      disputeDebitCents: 0,
      refundDebitCents: 4_000,
      lastDebitType: "REFUND_DEBIT",
    });
    // The immature credit weighs 0 TODAY, so the running balance is 0 at T4
    // (non-negative) and −40 at T5.
    expect(human.debtSinceAt?.toISOString()).toBe(T(5).toISOString());
  });

  test("a cash-only organiser (spec 2026-10-07, R6): the cash sale debit IS the debt, and the last debit names it", async () => {
    const debit = await repo.cashSaleDebit({
      idempotencyKey: "cash-sale-debit:o_cash",
      payeeId: ORG_PAYEE,
      amountCents: 1_536,
      currency: "usd",
      orderId: "o_cash",
      description: "cash sale fee + tax",
      sourceKind: "pos_cash_sale",
      sourceId: "o_cash",
    });
    await stampCreatedAt(debit.id, T(2));

    const page = await repo.listDebtPositions({ now: AS_OF });

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      payeeId: ORG_PAYEE,
      payableCents: -1_536,
      lastDebitType: "CASH_SALE_DEBIT",
      // Not a dispute and not a refund.
      disputeDebitCents: 0,
      refundDebitCents: 0,
    });
    expect(page.items[0]!.lastDebitAt?.toISOString()).toBe(T(2).toISOString());
    expect(page.items[0]!.debtSinceAt?.toISOString()).toBe(T(2).toISOString());
  });

  test("debtSinceAt is the LAST crossing below zero, not the first", async () => {
    await insertOrder("o1");
    await insertOrder("o2");
    // −30 (T1) → +20 (T2, recovers) → −10 (T3): since = T3, not T1.
    await refund({ payeeId: ORG_PAYEE, orderId: "o1", amountCents: 3_000, at: T(1) });
    await credit({ payeeId: ORG_PAYEE, orderId: "o2", amountCents: 5_000, at: T(2) });
    await refund({ payeeId: ORG_PAYEE, orderId: "o2", amountCents: 3_000, at: T(3) });

    const page = await repo.listDebtPositions({ now: AS_OF });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.payableCents).toBe(-1_000);
    expect(page.items[0]!.debtSinceAt?.toISOString()).toBe(T(3).toISOString());
  });

  test("a cell negative ONLY through a pending hold has no journal crossing → debtSinceAt null", async () => {
    await insertOrder("o1", "OPEN");
    await insertOrder("o2");
    // Credit 50 on the disputed order (hold present → the hold is the
    // mechanism, credit stays in) + a hold of 80 that exceeds it: entry sum
    // +50, pendingHold 80 → payable −30 with no negative journal prefix.
    await credit({ payeeId: ORG_PAYEE, orderId: "o1", amountCents: 5_000, at: T(1) });
    const hold = await repo.hold({
      idempotencyKey: "dispute-hold:d1:payee_org:usd",
      payeeId: ORG_PAYEE,
      amountCents: 8_000,
      currency: "usd",
      disputeId: "d1",
      orderId: "o1",
    });
    await stampCreatedAt(hold.id, T(2));

    const page = await repo.listDebtPositions({ now: AS_OF });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      payeeId: ORG_PAYEE,
      payableCents: -3_000,
      debtSinceAt: null,
      lastDebitType: null,
      lastDebitAt: null,
    });
  });

  test("keyset pagination walks every debt cell once, in order, and the cursor survives a round trip", async () => {
    // Three debt cells with distinct amounts + one healthy.
    const amounts: Array<[string, number]> = [
      [ORG_PAYEE, 7_000],
      [HUMAN_PAYEE, 2_000],
      [HEALTHY_PAYEE, 4_000],
    ];
    let day = 1;
    for (const [payeeId, cents] of amounts) {
      await insertOrder(`o_${payeeId}`);
      await refund({ payeeId, orderId: `o_${payeeId}`, amountCents: cents, at: T(day++) });
    }

    const first = await repo.listDebtPositions({ now: AS_OF, limit: 2 });
    expect(first.total).toBe(3);
    expect(first.pageInfo.hasNextPage).toBe(true);
    expect(first.pageInfo.limit).toBe(2);
    expect(first.items.map((r) => r.payableCents)).toEqual([-7_000, -4_000]);

    // The cursor carries the payable as a DECIMAL STRING (bigint-safe).
    const decoded = JSON.parse(
      Buffer.from(first.pageInfo.nextCursor!, "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({ payableCents: "-4000", payeeId: HEALTHY_PAYEE, currency: "usd" });

    const second = await repo.listDebtPositions({
      now: AS_OF,
      limit: 2,
      cursor: first.pageInfo.nextCursor,
    });
    expect(second.items.map((r) => r.payableCents)).toEqual([-2_000]);
    expect(second.pageInfo.hasNextPage).toBe(false);
    expect(second.pageInfo.nextCursor).toBeNull();
    // Remaining-from-cursor count on a later page.
    expect(second.total).toBe(1);

    // An undecodable cursor restarts from the top rather than throwing.
    const restarted = await repo.listDebtPositions({
      now: AS_OF,
      limit: 2,
      cursor: "not-a-cursor",
    });
    expect(restarted.items.map((r) => r.payableCents)).toEqual([-7_000, -4_000]);
  });

  test("a cell beyond int4 (3,000,000,000 cents) LISTS instead of raising 22003 — display-only bigint path", async () => {
    // Two 1.5B-cent refund debits: each fits INTEGER, the cell's sum does
    // not. Inserted raw — the writer's rollup increment is int4 and would
    // itself overflow, which is the batch's deliberate posture, not ours.
    for (const n of [1, 2]) {
      await pool!.query(
        `INSERT INTO "PayeeLedgerEntry"
          ("id","idempotencyKey","payeeId","type","amountCents","currency","sourceKind","sourceId","orderId","description","createdAt")
         VALUES ($1,$2,$3,'REFUND_DEBIT',1500000000,'usd','refund',$4,'o_big','huge refund',$5::timestamp)`,
        [`big_${n}`, `refund-debit:o_big:${ORG_PAYEE}:big${n}`, ORG_PAYEE, `refund_big_${n}`, T(n).toISOString()],
      );
    }
    // The money query's ::int cast raises here — by design (never wrap
    // money silently). The diagnostic view must still show the cell.
    await expect(repo.listPayableBalances(AS_OF)).rejects.toThrow(/22003|out of range/i);

    const page = await repo.listDebtPositions({ now: AS_OF });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      payeeId: ORG_PAYEE,
      payableCents: -3_000_000_000,
      refundDebitCents: 3_000_000_000,
      lastDebitType: "REFUND_DEBIT",
    });
    expect(page.items[0]!.debtSinceAt?.toISOString()).toBe(T(1).toISOString());
    // And the cursor round-trips a bigint-sized payable.
    const paged = await repo.listDebtPositions({ now: AS_OF, limit: 1 });
    expect(paged.pageInfo.nextCursor).toBeNull();
  });

  test("scale: 500 payees / ~20k entries — EXPLAIN (ANALYZE, BUFFERS) of the exact statement, wall time, and the statement_timeout degrade path", async () => {
    // Throwaway seed via one multi-row INSERT per table. Mix mirrors a real
    // ledger: 30 credits (some immature, some on OPEN/LOST orders), 6
    // refund debits, 2 dispute debits, 2 payouts per payee → 40 entries.
    const PAYEES = 500;
    const payeeValues: string[] = [];
    for (let i = 0; i < PAYEES; i++) {
      payeeValues.push(`('perf_${i}', '${i % 3 === 0 ? "HUMAN" : "ORGANIZATION"}', 'subject_${i}')`);
    }
    await pool!.query(`INSERT INTO "Payee" ("id","subjectType","subjectId") VALUES ${payeeValues.join(",")}`);
    const orderValues: string[] = [];
    for (let i = 0; i < PAYEES * 4; i++) {
      const status = i % 17 === 0 ? "'OPEN'" : i % 23 === 0 ? "'LOST'" : "NULL";
      orderValues.push(`('perf_o_${i}', ${status})`);
    }
    await pool!.query(`INSERT INTO "Order" ("id","disputeStatus") VALUES ${orderValues.join(",")}`);
    await pool!.query(`INSERT INTO "Claim" ("id","orderId","status") SELECT 'perf_c_' || g, 'perf_o_' || (g * 41), 'open' FROM generate_series(0, 40) g`);

    const rows: string[] = [];
    let n = 0;
    const day = (k: number) => `'2026-04-${String(1 + (k % 28)).padStart(2, "0")}T00:00:00Z'::timestamp`;
    for (let i = 0; i < PAYEES; i++) {
      const payee = `perf_${i}`;
      for (let k = 0; k < 30; k++) {
        const order = `perf_o_${(i * 4 + (k % 4))}`;
        const avail = k % 5 === 0 ? "'2026-07-01T00:00:00Z'" : "'2026-06-01T00:00:00Z'";
        rows.push(`('pe_${n++}','k_${n}','${payee}','SETTLEMENT_CREDIT',${1000 + k},'usd','order_split','${order}','${order}','c',${day(k)},${avail}::timestamp)`);
      }
      for (let k = 0; k < 6; k++) {
        const order = `perf_o_${(i * 4 + (k % 4))}`;
        // Every 7th payee is pushed into debt.
        const amt = i % 7 === 0 ? 9000 : 300;
        rows.push(`('pe_${n++}','k_${n}','${payee}','REFUND_DEBIT',${amt},'usd','refund','r_${n}','${order}','r',${day(k + 10)},NULL)`);
      }
      for (let k = 0; k < 2; k++) {
        const order = `perf_o_${i * 4}`;
        rows.push(`('pe_${n++}','k_${n}','${payee}','DISPUTE_DEBIT',${i % 11 === 0 ? 20000 : 500},'usd','dispute','d_${n}','${order}','d',${day(k + 20)},NULL)`);
      }
      for (let k = 0; k < 2; k++) {
        rows.push(`('pe_${n++}','payout:item_${n}','${payee}','PAYOUT',4000,'usd','payout_item','item_${n}',NULL,'p',${day(k + 25)},NULL)`);
      }
    }
    for (let i = 0; i < rows.length; i += 4000) {
      await pool!.query(
        `INSERT INTO "PayeeLedgerEntry" ("id","idempotencyKey","payeeId","type","amountCents","currency","sourceKind","sourceId","orderId","description","createdAt","availableAt") VALUES ${rows.slice(i, i + 4000).join(",")}`,
      );
    }
    await pool!.query(`ANALYZE "PayeeLedgerEntry"; ANALYZE "Order"; ANALYZE "Claim"; ANALYZE "Payee"`);
    const [{ count }] = (await pool!.query(`SELECT COUNT(*)::int AS count FROM "PayeeLedgerEntry"`)).rows;
    expect(count).toBe(PAYEES * 40);

    // (a) The plan of the EXACT statement the adapter runs, under the
    // adapter's own session settings (`SET LOCAL jit = off` — see the
    // header in payee-ledger.ts). The JIT-on figure is logged beside it
    // because it is the whole story: the planner's inflated cost estimate
    // trips `jit_optimize_above_cost`, and LLVM compilation of ~220
    // functions costs seconds for a query that executes in tens of ms.
    const sql = buildDebtPositionsSql({ asOf: AS_OF, limit: 25, cursor: null });
    const explain = `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql.text}`;
    const jitOn = await pool!.query(explain, sql.values as unknown[]);
    const jitOnText = jitOn.rows.map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"]).join("\n");
    const jitOnExecMs = Number(/Execution Time: ([\d.]+) ms/.exec(jitOnText)?.[1]);
    const jitOnCompileMs = Number(/Total ([\d.]+) ms/.exec(jitOnText)?.[1]);
    const planText = await prisma!.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL jit = off`);
      const plan = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
        explain,
        ...sql.values,
      );
      return plan.map((r) => r["QUERY PLAN"]).join("\n");
    });
    console.log(
      `\n[debt-positions EXPLAIN @ ${count} entries / ${PAYEES} payees, jit=off (production setting)]\n${planText}\n` +
        `[same statement with jit=on] Execution Time ${jitOnExecMs} ms, of which JIT compile ${Number.isFinite(jitOnCompileMs) ? jitOnCompileMs : "n/a"} ms\n`,
    );
    const execMs = Number(/Execution Time: ([\d.]+) ms/.exec(planText)?.[1]);
    expect(Number.isFinite(execMs)).toBe(true);
    expect(planText).not.toMatch(/^JIT:/m);

    // Wall time of the real repo call, with the production budget — and of
    // the batch's own planning read on the same data, which is the honest
    // yardstick: a page load can never beat the ledger's own aggregate.
    const t0 = performance.now();
    const page = await repo.listDebtPositions({ now: AS_OF, statementTimeoutMs: 8_000 });
    const wallMs = performance.now() - t0;
    const t1 = performance.now();
    await repo.listPayableBalances(AS_OF);
    const payableWallMs = performance.now() - t1;
    const t2 = performance.now();
    await repo.listDebtPositions({ now: AS_OF, statementTimeoutMs: 8_000 });
    const wallMs2 = performance.now() - t2;
    console.log(
      `[debt-positions repo wall time] cold ${wallMs.toFixed(1)} ms, warm ${wallMs2.toFixed(1)} ms; listPayableBalances (batch planning read, same seed) ${payableWallMs.toFixed(1)} ms; total=${page.total}, first=${page.items[0]?.payableCents}`,
    );
    expect(page.items.length).toBe(25);
    expect(page.total).toBeGreaterThan(25);
    expect(page.items.every((r) => r.payableCents < 0)).toBe(true);
    // Agreement with the money query still holds at scale (cent-for-cent on
    // the first page, and the same total count of negative cells).
    const payables = await repo.listPayableBalances(AS_OF);
    const negative = payables.filter((p) => p.payableCents < 0);
    expect(page.total).toBe(negative.length);
    const byKey = new Map(negative.map((p) => [`${p.payeeId}:${p.currency}`, p.payableCents]));
    for (const r of page.items) expect(byKey.get(`${r.payeeId}:${r.currency}`)).toBe(r.payableCents);
    // Ceiling: measured ~25ms warm / ~90ms cold on a laptop container with
    // jit off (vs ~1.8s with it on). 1s is generous for a slow CI box and
    // still fails loudly if JIT sneaks back or the shape regresses.
    expect(execMs).toBeLessThan(1_000);
    expect(wallMs2).toBeLessThan(1_000);

    // (b) Degrade path: an absurd budget cancels the statement, and the
    // adapter surfaces SERVICE_UNAVAILABLE rather than a raw driver error.
    const err = await repo
      .listDebtPositions({ now: AS_OF, statementTimeoutMs: 1 })
      .then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(isAppError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "payee_ledger_debt_positions_timeout",
    });
    // And the connection is healthy afterwards (SET LOCAL died with its tx).
    expect((await repo.listDebtPositions({ now: AS_OF, limit: 1 })).items).toHaveLength(1);
  }, 120_000);

  // ── Budgets: statement vs transaction ────────────────────────────────────

  async function idleInTransactionCount(): Promise<number> {
    const r = await pool!.query(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE state = 'idle in transaction' AND datname = current_database()`,
    );
    return r.rows[0].n as number;
  }

  test("opens its OWN interactive transaction with timeout = statement budget + headroom (Postgres must fire first)", async () => {
    const calls: Array<unknown> = [];
    // Proxy the real client so `$transaction` is observable but still real.
    const spied = new Proxy(prisma!, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          return (fn: unknown, opts: unknown) => {
            calls.push(opts);
            return (target.$transaction as Function).call(target, fn, opts);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const spiedRepo = makePayeeLedgerRepo(spied);
    await spiedRepo.listDebtPositions({ now: AS_OF, statementTimeoutMs: 1_000 });
    expect(calls).toEqual([
      { maxWait: DEBT_TX_MAX_WAIT_MS, timeout: 1_000 + TX_TIMEOUT_HEADROOM_MS },
    ]);
    // Default budget when the caller passes none: 8000 → tx 10000.
    calls.length = 0;
    await spiedRepo.listDebtPositions({ now: AS_OF });
    expect(calls).toEqual([{ maxWait: DEBT_TX_MAX_WAIT_MS, timeout: 10_000 }]);
  });

  test("SLOW PATH for real: pg_sleep(2) under a 1000ms statement budget → SERVICE_UNAVAILABLE (expired=statement), transaction released", async () => {
    await insertOrder("o1");
    await refund({ payeeId: ORG_PAYEE, orderId: "o1", amountCents: 500, at: T(1) });
    __testOnlyDebtPositionsHooks.beforeQuery = async (tx) => {
      // `SELECT 1 FROM pg_sleep(...)`: bare pg_sleep returns `void`, which
      // the driver adapter cannot deserialise — the statement would fail
      // instantly (P2010) and never sleep.
      await tx.$queryRawUnsafe(`SELECT 1 FROM pg_sleep(2)`);
    };
    const t0 = performance.now();
    const err = await repo
      .listDebtPositions({ now: AS_OF, statementTimeoutMs: 1_000 })
      .then(() => null, (e: unknown) => e);
    const elapsed = performance.now() - t0;
    expect(isAppError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "payee_ledger_debt_positions_timeout",
      meta: { expired: "statement", statementTimeoutMs: 1_000, transactionTimeoutMs: 3_000 },
    });
    // Postgres fired at ~1s — well before the 3s transaction budget.
    expect(elapsed).toBeGreaterThan(900);
    expect(elapsed).toBeLessThan(2_500);
    __testOnlyDebtPositionsHooks.beforeQuery = null;
    expect(await idleInTransactionCount()).toBe(0);
    expect((await repo.listDebtPositions({ now: AS_OF })).items).toHaveLength(1);
  }, 30_000);

  test("if the TRANSACTION budget ever wins (P2028), it still degrades to SERVICE_UNAVAILABLE (expired=transaction)", async () => {
    await insertOrder("o1");
    await refund({ payeeId: ORG_PAYEE, orderId: "o1", amountCents: 500, at: T(1) });
    // Defeat the statement budget from inside the tx so only Prisma's
    // interactive-transaction timeout (1000 + 2000 = 3000ms) can fire.
    __testOnlyDebtPositionsHooks.beforeQuery = async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = 0`);
      await tx.$queryRawUnsafe(`SELECT 1 FROM pg_sleep(4)`);
    };
    const err = await repo
      .listDebtPositions({ now: AS_OF, statementTimeoutMs: 1_000 })
      .then(() => null, (e: unknown) => e);
    expect(isAppError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      meta: { expired: "transaction", transactionTimeoutMs: 3_000 },
    });
    const cause = (err as { cause?: { code?: string; message?: string; meta?: unknown } }).cause;
    console.log(`[tx-budget path] cause.code=${cause?.code} message=${JSON.stringify(String(cause?.message).slice(0, 220))}`);
    expect(cause?.code).toBe("P2028");
    __testOnlyDebtPositionsHooks.beforeQuery = null;
    // Give the rolled-back tx a beat, then prove the pool is clean.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await idleInTransactionCount()).toBe(0);
    expect((await repo.listDebtPositions({ now: AS_OF })).items).toHaveLength(1);
  }, 30_000);

  test("reviewer's claim, reproduced: a DEFAULT-options interactive tx (client built like apps/api dep.ts: PrismaClient + PrismaPg) kills pg_sleep(6) with P2028, not 57014", async () => {
    const t0 = performance.now();
    const err = await prisma!
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = 8000`);
        // Prisma does not cancel the in-flight statement; it closes the tx
        // at 5000ms and the NEXT statement is refused with P2028.
        await tx.$queryRawUnsafe(`SELECT 1 FROM pg_sleep(6)`);
        return tx.$queryRawUnsafe(`SELECT 1`);
      })
      .then(() => null, (e: unknown) => e as { code?: string; message?: string; name?: string });
    const elapsed = performance.now() - t0;
    console.log(`[P2028 repro] name=${err?.name} code=${err?.code} elapsed=${elapsed.toFixed(0)}ms message=${JSON.stringify(String(err?.message).slice(0, 260))}`);
    expect(err?.code).toBe("P2028");
    expect(String(err?.message)).toMatch(/Transaction already closed|expired transaction/i);
    await new Promise((r) => setTimeout(r, 1_500));
  }, 30_000);

  test("refuses to run on a caller's TransactionClient (SET LOCAL would leak onto their work)", async () => {
    const err = await prisma!
      .$transaction((tx) => makePayeeLedgerRepo(tx).listDebtPositions({ now: AS_OF }))
      .then(() => null, (e: unknown) => e);
    expect(isAppError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "INTERNAL",
      message: "payee_ledger_debt_positions_requires_top_level_client",
    });
  });

  test("returns an empty page when nobody owes anything", async () => {
    await insertOrder("o1");
    await credit({ payeeId: ORG_PAYEE, orderId: "o1", amountCents: 5_000, at: T(1) });
    const page = await repo.listDebtPositions({ now: AS_OF });
    expect(page).toEqual({
      items: [],
      pageInfo: {
        cursorField: "payableCents,payeeId,currency",
        nextCursor: null,
        limit: 25,
        hasNextPage: false,
      },
      total: 0,
    });
  });

  test("AGREES with listPayableBalances: the debt set is exactly the negative payables, cent for cent", async () => {
    // A mixed ledger touching every effect branch: maturity, an OPEN order
    // with its hold, a LOST debit, a debit-compensating release, a legacy
    // debt-recovery PAYOUT, a transfer reversal, and a claim block.
    await insertOrder("o_open", "OPEN");
    await insertOrder("o_lost", "LOST");
    await insertOrder("o_plain");
    await insertOrder("o_claim");
    await pool!.query(
      `INSERT INTO "Claim" ("id", "orderId", "status") VALUES ('c1', 'o_claim', 'open')`,
    );

    // ORG: 100 matured, LOST 100 debit (consumes hold), then WON-after-LOST
    // reversal of 30, payout 20 → 100 − 100 + 30 − 20 = +10 → healthy.
    await credit({ payeeId: ORG_PAYEE, orderId: "o_lost", amountCents: 10_000, at: T(1) });
    const orgHold = await repo.hold({
      idempotencyKey: "dispute-hold:dl:payee_org:usd",
      payeeId: ORG_PAYEE,
      amountCents: 10_000,
      currency: "usd",
      disputeId: "dl",
      orderId: "o_lost",
    });
    await stampCreatedAt(orgHold.id, T(2));
    const orgDebit = await repo.debit({
      idempotencyKey: "dispute-debit:dl:payee_org:usd",
      payeeId: ORG_PAYEE,
      amountCents: 10_000,
      currency: "usd",
      disputeId: "dl",
      orderId: "o_lost",
    });
    await stampCreatedAt(orgDebit.id, T(3));
    const rev = await repo.reverseDisputeDebit({
      idempotencyKey: "dispute-debit-reversal:dl:payee_org:usd",
      payeeId: ORG_PAYEE,
      amountCents: 3_000,
      currency: "usd",
      disputeId: "dl",
      debitEntryId: orgDebit.id,
      orderId: "o_lost",
    });
    await stampCreatedAt(rev.id, T(4));
    await payout({ payeeId: ORG_PAYEE, amountCents: 2_000, at: T(5) });

    // HUMAN: 50 immature + 40 claim-blocked + 30 on OPEN order with hold 30,
    // refund 60 with a 10 transfer reversal → 0 + 0 + 30 − 60 + 10 − 30(hold)
    // = −50 → in debt.
    await credit({ payeeId: HUMAN_PAYEE, orderId: "o_plain", amountCents: 5_000, availableAt: IMMATURE, at: T(1) });
    await credit({ payeeId: HUMAN_PAYEE, orderId: "o_claim", amountCents: 4_000, at: T(2) });
    await credit({ payeeId: HUMAN_PAYEE, orderId: "o_open", amountCents: 3_000, at: T(3) });
    const hHold = await repo.hold({
      idempotencyKey: "dispute-hold:do:payee_human:usd",
      payeeId: HUMAN_PAYEE,
      amountCents: 3_000,
      currency: "usd",
      disputeId: "do",
      orderId: "o_open",
    });
    await stampCreatedAt(hHold.id, T(4));
    const hRefund = await refund({ payeeId: HUMAN_PAYEE, orderId: "o_plain", amountCents: 6_000, at: T(5) });
    const trc = await repo.transferReversalCredit({
      idempotencyKey: `transfer-reversal-credit:${hRefund.id}`,
      payeeId: HUMAN_PAYEE,
      amountCents: 1_000,
      currency: "usd",
      orderId: "o_plain",
      relatedEntryId: hRefund.id,
      description: "reversal",
    });
    await stampCreatedAt(trc.id, T(6));

    // HEALTHY (org_2): a pre-cutover legacy debt-recovery PAYOUT row reads
    // POSITIVE; refund 25 → +25 − 25 = 0 → NOT in debt (zero is not debt).
    await pool!.query(
      `INSERT INTO "PayeeLedgerEntry"
        ("id","idempotencyKey","payeeId","type","amountCents","currency","sourceKind","sourceId","description","createdAt")
       VALUES ('legacy_1','debt-recovery:item_legacy',$1,'PAYOUT',2500,'usd','payout_item','item_legacy','legacy recovery',$2::timestamp)`,
      [HEALTHY_PAYEE, T(1).toISOString()],
    );
    await refund({ payeeId: HEALTHY_PAYEE, orderId: "o_plain", amountCents: 2_500, at: T(2) });

    const payables = await repo.listPayableBalances(AS_OF);
    const expectedDebt = payables
      .filter((p) => p.payableCents < 0)
      .map((p) => [p.payeeId, p.currency, p.payableCents])
      .sort((a, b) => (a[2] as number) - (b[2] as number));
    expect(expectedDebt).toEqual([[HUMAN_PAYEE, "usd", -5_000]]);

    const debt = await repo.listDebtPositions({ now: AS_OF });
    expect(debt.items.map((r) => [r.payeeId, r.currency, r.payableCents])).toEqual(
      expectedDebt,
    );
    expect(debt.total).toBe(1);
  });
});
