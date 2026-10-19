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
  __testOnlyLedgerBudgetHooks,
  makePayeeLedgerRepo,
} from "../payee-ledger";

// ---------------------------------------------------------------------------
// Integration coverage for THE money query of the ledger-authoritative
// settlement model (spec 2026-08-10): `listPayableBalances` +
// `listConsumableCredits`, plus the SQL-only CHECK
// `PayeeLedgerEntry_settlement_credit_available_check` and the
// `markCreditsConsumed` NULL-guard.
//
// None of this is provable against a mocked Prisma client — the payable query
// is raw SQL (CASE-signed SUM with NOT EXISTS subqueries against Order and
// Claim), the CHECK is Postgres, and the consumed-guard is an UPDATE ...
// WHERE consumedByEntryId IS NULL race gate. This hits real Postgres.
//
// THE MIGRATION SQL IS READ FROM DISK, NOT RETYPED HERE (house precedent:
// fee-policies-one-active-per-scope). The base tables are created in their
// PRE-migration shape and the shipped migration bytes are applied on top —
// twice, because the dev databases are db-push-managed and the migration
// must be re-applicable.
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
 * Standalone DDL, pre-migration shape. `PayeeLedgerEntry` /
 * `PayeeLedgerBalance` mirror migration 20260515120000_add_payee_ledger
 * (minus FKs to Payee/Dispute — irrelevant to these queries); the enum
 * deliberately LACKS 'TRANSFER_REVERSAL_CREDIT' and the table LACKS
 * `availableAt` / `consumedByEntryId`, so the shipped migration is what puts
 * them there. `Order` and `Claim` are minimal: the payable query touches only
 * (id, disputeStatus) and (orderId, status).
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

// The clock of every scenario. Credits maturing ON the boundary are payable
// (availableAt <= asOf).
const AS_OF = new Date("2026-06-15T00:00:00.000Z");
const MATURE = new Date("2026-06-01T00:00:00.000Z"); // <= AS_OF
const IMMATURE = new Date("2026-07-01T00:00:00.000Z"); // > AS_OF

const PAYEE = "payee_1";

describe("payee-ledger payable query (integration)", () => {
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
    __testOnlyLedgerBudgetHooks.beforeQuery = null;
    await pool!.query(
      `TRUNCATE "PayeeLedgerEntry", "PayeeLedgerBalance", "Order", "Claim", "Event"`,
    );
  });

  // Explicit timeout: tearing a Testcontainers Postgres down routinely takes
  // longer than vitest's 10s default hook timeout, which fails the SUITE after
  // every test in it has already passed.
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

  async function insertClaim(orderId: string, status: string) {
    await pool!.query(
      `INSERT INTO "Claim" ("id", "orderId", "status") VALUES ($1, $2, $3)`,
      [`claim_${orderId}_${status}`, orderId, status],
    );
  }

  let creditSeq = 0;
  async function credit(opts: {
    orderId: string;
    amountCents: number;
    availableAt?: Date;
    currency?: string;
    payeeId?: string;
  }) {
    creditSeq += 1;
    return repo.settlementCredit({
      idempotencyKey: `settlement-credit:${opts.orderId}:${opts.payeeId ?? PAYEE}:${creditSeq}`,
      payeeId: opts.payeeId ?? PAYEE,
      amountCents: opts.amountCents,
      currency: opts.currency ?? "usd",
      orderId: opts.orderId,
      availableAt: opts.availableAt ?? MATURE,
      description: `credit for ${opts.orderId}`,
      metadata: { items: { [`item_${opts.orderId}`]: opts.amountCents } },
      sourceKind: "order_split",
      sourceId: opts.orderId,
    });
  }

  async function payableFor(payeeId: string, currency: string, asOf = AS_OF) {
    const rows = await repo.listPayableBalances(asOf);
    return rows.find((r) => r.payeeId === payeeId && r.currency === currency)
      ?.payableCents;
  }

  // ── Maturity ──────────────────────────────────────────────────────────────

  test("an immature credit is excluded, then enters once asOf passes availableAt", async () => {
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 10_000, availableAt: IMMATURE });

    expect(await payableFor(PAYEE, "usd", AS_OF)).toBe(0);
    // Boundary is inclusive: availableAt <= asOf.
    expect(await payableFor(PAYEE, "usd", IMMATURE)).toBe(10_000);
    expect(
      await payableFor(PAYEE, "usd", new Date("2026-08-01T00:00:00.000Z")),
    ).toBe(10_000);
  });

  test("a refund debit is ALWAYS effective — it reduces payable even while its credit is immature", async () => {
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 10_000, availableAt: IMMATURE });
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_1:payee_1:refund_1",
      payeeId: PAYEE,
      amountCents: 4_000,
      currency: "usd",
      orderId: "order_1",
      description: "refund",
      sourceKind: "refund",
      sourceId: "refund_1",
    });

    // Credit not yet counted, debit counted: the asymmetry IS the P0 fix.
    expect(await payableFor(PAYEE, "usd", AS_OF)).toBe(-4_000);
    // After maturity both count: 10_000 − 4_000.
    expect(await payableFor(PAYEE, "usd", IMMATURE)).toBe(6_000);
  });

  // ── Disputes: exactly one mechanism per state (spec §5) ───────────────────

  test("dispute OPEN excludes the credit; dispute LOST does NOT (the DISPUTE_DEBIT nets instead)", async () => {
    // OPEN cell: exclusion is the mechanism → payable 0, not -10_000.
    await insertOrder("order_open", "OPEN");
    await credit({ orderId: "order_open", amountCents: 10_000 });
    expect(await payableFor(PAYEE, "usd")).toBe(0);

    // LOST cell: the debit is the mechanism → credit re-enters, debit nets it.
    // Copying the legacy 3-status exclusion list would read -10_000 here
    // (double-punish); the correct net for the never-paid case is 0.
    await insertOrder("order_lost", "LOST");
    await credit({ orderId: "order_lost", amountCents: 10_000 });
    await repo.debit({
      idempotencyKey: "dispute-debit:dispute_lost:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 10_000,
      currency: "usd",
      disputeId: "dispute_lost",
      orderId: "order_lost",
    });
    expect(await payableFor(PAYEE, "usd")).toBe(0);

    // And UNDER_REVIEW behaves like OPEN.
    await insertOrder("order_review", "UNDER_REVIEW");
    await credit({ orderId: "order_review", amountCents: 3_000 });
    expect(await payableFor(PAYEE, "usd")).toBe(0);

    // WON never blocks.
    await insertOrder("order_won", "WON");
    await credit({ orderId: "order_won", amountCents: 2_000 });
    expect(await payableFor(PAYEE, "usd")).toBe(2_000);
  });

  test("dispute OPEN with its hold present: the hold is the ONLY mechanism — payable is the undisputed remainder", async () => {
    // The production-realistic state: the dispute lifecycle writes
    // Order.disputeStatus AND the per-payee DISPUTE_HOLD in the same pass
    // (core/use-cases/disputes/shared.ts). Matured credits $80 (order A) +
    // $50 (order B); chargeback opens on A → hold $80 + status OPEN.
    // Single-mechanism answer: 80 + 50 − 80(pendingHold) = 50. The
    // pre-review query stacked the status exclusion on top of the hold
    // (0 + 50 − 80 = −30) and would have paid $0.
    await insertOrder("order_a", "OPEN");
    await insertOrder("order_b");
    await credit({ orderId: "order_a", amountCents: 8_000 });
    await credit({ orderId: "order_b", amountCents: 5_000 });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_a:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 8_000,
      currency: "usd",
      disputeId: "dispute_a",
      orderId: "order_a",
    });

    expect(await payableFor(PAYEE, "usd")).toBe(5_000);

    // And the held-but-payable credit stays in the consumable feed — the
    // predicate is identical to the payable query's, so FIFO attribution
    // can always cover the amount actually paid.
    const consumable = await repo.listConsumableCredits(PAYEE, "usd", AS_OF);
    expect(consumable.map((c) => c.orderId).sort()).toEqual([
      "order_a",
      "order_b",
    ]);

    // Once the hold is CONSUMED by a LOST debit, it is no longer active —
    // the mechanism is the debit alone: 80 + 50 − 80(debit) − 0(hold) = 50.
    await pool!.query(
      `UPDATE "Order" SET "disputeStatus" = 'LOST' WHERE "id" = 'order_a'`,
    );
    await repo.debit({
      idempotencyKey: "dispute-debit:dispute_a:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 8_000,
      currency: "usd",
      disputeId: "dispute_a",
      orderId: "order_a",
    });
    expect(await payableFor(PAYEE, "usd")).toBe(5_000);
  });

  test("ticketing LOST across several payees: each debit consumes its own hold, pending-hold returns to zero, payable = credited − debited per payee", async () => {
    // The ticketing shape the dispute lifecycle now writes on LOST (it used
    // to write nothing and leave the holds standing): a 3000/2000 split
    // across artist + venue, disputed in full. Same keys and amounts as
    // core/use-cases/disputes/shared.ts `debitDisputeLoss` produces, so this
    // is the SQL half of that contract — no query change was needed for
    // ticketing to join the membership path, and this proves it.
    await insertOrder("order_t", "OPEN");
    await credit({ orderId: "order_t", amountCents: 3_000, payeeId: "payee_artist" });
    await credit({ orderId: "order_t", amountCents: 2_000, payeeId: "payee_venue" });
    // Undisputed money on another order keeps the artist cell non-degenerate.
    await insertOrder("order_u");
    await credit({ orderId: "order_u", amountCents: 1_000, payeeId: "payee_artist" });
    const artistHold = await repo.hold({
      idempotencyKey: "dispute-hold:dispute_t:payee_artist:usd",
      payeeId: "payee_artist",
      amountCents: 3_000,
      currency: "usd",
      disputeId: "dispute_t",
      orderId: "order_t",
    });
    const venueHold = await repo.hold({
      idempotencyKey: "dispute-hold:dispute_t:payee_venue:usd",
      payeeId: "payee_venue",
      amountCents: 2_000,
      currency: "usd",
      disputeId: "dispute_t",
      orderId: "order_t",
    });
    // Open: the hold is the one mechanism → 3000 + 1000 − 3000 = 1000; 0.
    expect(await payableFor("payee_artist", "usd")).toBe(1_000);
    expect(await payableFor("payee_venue", "usd")).toBe(0);

    await pool!.query(
      `UPDATE "Order" SET "disputeStatus" = 'LOST' WHERE "id" = 'order_t'`,
    );
    const artistDebit = await repo.debit({
      idempotencyKey: "dispute-debit:dispute_t:payee_artist:usd",
      payeeId: "payee_artist",
      amountCents: 3_000,
      currency: "usd",
      disputeId: "dispute_t",
      orderId: "order_t",
    });
    const venueDebit = await repo.debit({
      idempotencyKey: "dispute-debit:dispute_t:payee_venue:usd",
      payeeId: "payee_venue",
      amountCents: 2_000,
      currency: "usd",
      disputeId: "dispute_t",
      orderId: "order_t",
    });

    // Each debit consumed ITS payee's hold (never the other's), leaving no
    // active hold on the dispute.
    expect(artistDebit.relatedEntryId).toBe(artistHold.id);
    expect(venueDebit.relatedEntryId).toBe(venueHold.id);
    expect(await repo.listActiveHoldsByDispute("dispute_t")).toHaveLength(0);
    // Rollup bookkeeping: pending-hold decremented to zero when consumed, and
    // the cached balance carries credited − debited.
    expect(await repo.getBalance("payee_artist", "usd")).toMatchObject({
      pendingHoldCents: 0,
      ledgerBalanceCents: 1_000,
    });
    expect(await repo.getBalance("payee_venue", "usd")).toMatchObject({
      pendingHoldCents: 0,
      ledgerBalanceCents: 0,
    });
    // Payable: LOST is absent from the exclusion list, so the credit
    // re-enters and the debit nets it — the same "exactly one mechanism"
    // cell memberships already occupied, now for ticketing. Conservation:
    // per payee, payable == credited − debited, and nothing went negative
    // because nothing was ever transferred.
    expect(await payableFor("payee_artist", "usd")).toBe(1_000);
    expect(await payableFor("payee_venue", "usd")).toBe(0);
    // Replay of the debit (stable key) is a no-op on every number above.
    await repo.debit({
      idempotencyKey: "dispute-debit:dispute_t:payee_venue:usd",
      payeeId: "payee_venue",
      amountCents: 2_000,
      currency: "usd",
      disputeId: "dispute_t",
      orderId: "order_t",
    });
    expect(await payableFor("payee_venue", "usd")).toBe(0);
    expect(await repo.getBalance("payee_venue", "usd")).toMatchObject({
      pendingHoldCents: 0,
      ledgerBalanceCents: 0,
    });
  });

  test("ticketing LOST after the payout already went out: the debit drives payable negative by exactly the paid share, which the next credit nets", async () => {
    // `settlement_transfer_in_flight`: the venue was paid its $20 before the
    // dispute landed, so there was no hold to consume. The debit is written
    // in full anyway; the payable goes to −2000 — never below −(what was
    // actually transferred) — and the batch pays nothing until fresh credits
    // cover it (run-batch.ts: "a NEGATIVE payable is a debt position — pay
    // nothing, carry forward").
    await insertOrder("order_paid");
    await credit({ orderId: "order_paid", amountCents: 2_000, payeeId: "payee_venue" });
    await repo.payoutDebit({
      idempotencyKey: "payout:item_venue",
      payeeId: "payee_venue",
      amountCents: 2_000,
      currency: "usd",
      sourceKind: "payout_item",
      sourceId: "item_venue",
      description: "payout",
      metadata: { consumedCreditEntryIds: [] },
    });
    expect(await payableFor("payee_venue", "usd")).toBe(0);

    await pool!.query(
      `UPDATE "Order" SET "disputeStatus" = 'LOST' WHERE "id" = 'order_paid'`,
    );
    const debit = await repo.debit({
      idempotencyKey: "dispute-debit:dispute_paid:payee_venue:usd",
      payeeId: "payee_venue",
      amountCents: 2_000,
      currency: "usd",
      disputeId: "dispute_paid",
      orderId: "order_paid",
    });
    // No hold existed, so nothing was consumed and pending-hold is untouched.
    expect(debit.relatedEntryId).toBeNull();
    expect(await repo.getBalance("payee_venue", "usd")).toMatchObject({
      pendingHoldCents: 0,
      ledgerBalanceCents: -2_000,
    });
    expect(await payableFor("payee_venue", "usd")).toBe(-2_000);

    // The next order's credit nets the debt: 2500 − 2000 = 500 payable.
    await insertOrder("order_next");
    await credit({ orderId: "order_next", amountCents: 2_500, payeeId: "payee_venue" });
    expect(await payableFor("payee_venue", "usd")).toBe(500);
  });

  test("a debit written with consumeHold:false links no hold and leaves the pending-hold rollup untouched", async () => {
    // The dispute FEE entry: money on top of the principal. If it matched
    // the active hold it would release the hold's cents against the wrong
    // entry and the principal would never consume it. Written FIRST here,
    // while the hold is still active, to prove the guard is what stops it.
    await insertOrder("order_fee", "LOST");
    await credit({ orderId: "order_fee", amountCents: 5_000 });
    const hold = await repo.hold({
      idempotencyKey: "dispute-hold:dispute_fee:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      disputeId: "dispute_fee",
      orderId: "order_fee",
    });
    const fee = await repo.debit({
      idempotencyKey: "dispute-debit-fee:dispute_fee:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 1_500,
      currency: "usd",
      disputeId: "dispute_fee",
      orderId: "order_fee",
      consumeHold: false,
    });
    expect(fee.relatedEntryId).toBeNull();
    expect(await repo.listActiveHoldsByDispute("dispute_fee")).toEqual([
      expect.objectContaining({ id: hold.id }),
    ]);
    expect(await repo.getBalance(PAYEE, "usd")).toMatchObject({
      pendingHoldCents: 5_000,
      ledgerBalanceCents: 3_500,
    });

    // The principal entry (default consumeHold) is what consumes the hold.
    const principal = await repo.debit({
      idempotencyKey: "dispute-debit:dispute_fee:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      disputeId: "dispute_fee",
      orderId: "order_fee",
    });
    expect(principal.relatedEntryId).toBe(hold.id);
    expect(await repo.listActiveHoldsByDispute("dispute_fee")).toHaveLength(0);
    expect(await repo.getBalance(PAYEE, "usd")).toMatchObject({
      pendingHoldCents: 0,
      ledgerBalanceCents: -1_500,
    });
    expect(await payableFor(PAYEE, "usd")).toBe(-1_500);
  });

  test("listOrderEntries returns the order's dispute debits and releases alongside credits/refunds/reversals, never holds or payouts", async () => {
    await insertOrder("order_mix", "LOST");
    await credit({ orderId: "order_mix", amountCents: 5_000 });
    const hold = await repo.hold({
      idempotencyKey: "dispute-hold:dispute_mix:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      disputeId: "dispute_mix",
      orderId: "order_mix",
    });
    const debit = await repo.debit({
      idempotencyKey: "dispute-debit:dispute_mix:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 1_000,
      currency: "usd",
      disputeId: "dispute_mix",
      orderId: "order_mix",
    });
    const reversal = await repo.reverseDisputeDebit({
      idempotencyKey: "dispute-debit-reversal:dispute_mix:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 1_000,
      currency: "usd",
      disputeId: "dispute_mix",
      debitEntryId: debit.id,
      orderId: "order_mix",
    });
    await repo.payoutDebit({
      idempotencyKey: "payout:item_mix",
      payeeId: PAYEE,
      amountCents: 100,
      currency: "usd",
      sourceKind: "payout_item",
      sourceId: "item_mix",
      description: "payout",
      metadata: { consumedCreditEntryIds: [] },
    });

    const entries = await repo.listOrderEntries("order_mix");
    expect(entries.map((e) => e.type).sort()).toEqual([
      "DISPUTE_DEBIT",
      "DISPUTE_RELEASE",
      "SETTLEMENT_CREDIT",
    ]);
    // The release carries its relatedEntryId so consumers can tell the
    // debit-compensating flavour from a hold-release.
    expect(entries.find((e) => e.type === "DISPUTE_RELEASE")).toMatchObject({
      id: reversal.id,
      relatedEntryId: debit.id,
    });
    expect(entries.some((e) => e.id === hold.id)).toBe(false);
    const batched = await repo.listOrderEntriesForOrders(["order_mix"]);
    expect(batched.get("order_mix")?.map((e) => e.id).sort()).toEqual(
      entries.map((e) => e.id).sort(),
    );
  });

  test("legacy debt-recovery PAYOUT rows count POSITIVE; new payout rows count negative", async () => {
    // The pre-cutover `recoverDebt` writer is DELETED, but rows it wrote can
    // still exist in a database that predates the cutover: type PAYOUT with a
    // += rollup effect under the `debt-recovery:` key namespace. Reading one
    // as − would double-count the recovered debt against the payee, so the
    // query discriminates on the namespace and query↔rollup keep agreeing.
    // The legacy row is INSERTED DIRECTLY here (entry + the += it applied to
    // the cached rollup) because no writer produces this shape any more —
    // which is exactly why the discrimination has to stay tested.
    // Net: 10_000 credit − 4_000 payout + 3_000 recovery = 9_000.
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 10_000 });
    await repo.payoutDebit({
      idempotencyKey: "payout:payout_item_1",
      payeeId: PAYEE,
      amountCents: 4_000,
      currency: "usd",
      sourceKind: "payout_item",
      sourceId: "payout_item_1",
      description: "payout",
      metadata: { consumedCreditEntryIds: [] },
    });
    await pool!.query(
      `INSERT INTO "PayeeLedgerEntry"
         ("id", "idempotencyKey", "payeeId", "type", "amountCents", "currency",
          "sourceKind", "sourceId", "description", "createdAt")
       VALUES ('legacy_recovery_1', 'debt-recovery:payout_item_1', $1, 'PAYOUT',
               3000, 'usd', 'payout_item', 'payout_item_1',
               'legacy dispute debt recovery', NOW())`,
      [PAYEE],
    );
    // The deleted writer applied `ledgerBalanceCents += amountCents`; replay
    // that here so the rollup assertion below still checks query↔rollup
    // agreement rather than an artefact of the raw insert.
    await pool!.query(
      `UPDATE "PayeeLedgerBalance"
          SET "ledgerBalanceCents" = "ledgerBalanceCents" + 3000
        WHERE "payeeId" = $1 AND "currency" = 'usd'`,
      [PAYEE],
    );

    expect(await payableFor(PAYEE, "usd")).toBe(9_000);
    // Query↔rollup agreement: the cached balance moved the same way.
    const balance = await repo.getBalance(PAYEE, "usd");
    expect(balance.ledgerBalanceCents).toBe(9_000);
  });

  test("DISPUTE_RELEASE counts + only when it compensates a DEBIT; a hold→release cycle nets zero", async () => {
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 10_000 });

    // Hold: pendingHold subtracts.
    const hold = await repo.hold({
      idempotencyKey: "dispute-hold:dispute_1:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 4_000,
      currency: "usd",
      disputeId: "dispute_1",
      orderId: "order_1",
    });
    expect(await payableFor(PAYEE, "usd")).toBe(6_000);

    // Release of the HOLD: pendingHold returns to 0 and the release entry
    // contributes NOTHING — counting it + would hand the payee 4_000 of free
    // payable on every hold→release cycle.
    await repo.releaseHold({ holdEntryId: hold.id });
    expect(await payableFor(PAYEE, "usd")).toBe(10_000);

    // Debit then WON-after-LOST reversal: the release DOES count + here,
    // compensating the debit's −.
    const debit = await repo.debit({
      idempotencyKey: "dispute-debit:dispute_2:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 2_500,
      currency: "usd",
      disputeId: "dispute_2",
      orderId: "order_1",
    });
    expect(await payableFor(PAYEE, "usd")).toBe(7_500);
    await repo.reverseDisputeDebit({
      idempotencyKey: "dispute-debit-reversal:dispute_2:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 2_500,
      currency: "usd",
      disputeId: "dispute_2",
      debitEntryId: debit.id,
      orderId: "order_1",
    });
    expect(await payableFor(PAYEE, "usd")).toBe(10_000);
  });

  // ── Claims ────────────────────────────────────────────────────────────────

  test("an open claim on the order excludes the credit; resolved claims do not", async () => {
    await insertOrder("order_claimed");
    await credit({ orderId: "order_claimed", amountCents: 5_000 });
    await insertClaim("order_claimed", "open");
    expect(await payableFor(PAYEE, "usd")).toBe(0);

    await insertOrder("order_reviewed");
    await credit({ orderId: "order_reviewed", amountCents: 3_000 });
    await insertClaim("order_reviewed", "under_review");
    expect(await payableFor(PAYEE, "usd")).toBe(0);

    // 'denied' is outside the open set (same list as
    // claims.settlementIdsWithOpenClaims): the credit pays.
    await insertOrder("order_denied");
    await credit({ orderId: "order_denied", amountCents: 2_000 });
    await insertClaim("order_denied", "denied");
    expect(await payableFor(PAYEE, "usd")).toBe(2_000);
  });

  test("an APPROVED claim keeps freezing the credit until the order is REFUNDED", async () => {
    // review-claim commits the approval before the Stripe refund; a failed
    // or pending refund leaves the order SUCCEEDED and the money owed back.
    await insertOrder("order_approved");
    await credit({ orderId: "order_approved", amountCents: 5_000 });
    await insertClaim("order_approved", "approved");
    expect(await payableFor(PAYEE, "usd")).toBe(0);
    expect(
      await repo.listConsumableCredits(PAYEE, "usd", AS_OF),
    ).toHaveLength(0);

    // Refund landed (markRefunded commits with the REFUND_DEBITs).
    await pool!.query(
      `UPDATE "Order" SET "status" = 'REFUNDED' WHERE "id" = 'order_approved'`,
    );
    expect(await payableFor(PAYEE, "usd")).toBe(5_000);
  });

  // ── Resale claim window, from the event's CURRENT end ────────────────────

  async function insertResaleOrder(id: string, eventEndsAt: Date) {
    // UTC wall time, the way Prisma writes `timestamp without time zone`.
    // NOT a raw JS Date: node-postgres serialises a Date in the HOST's local
    // zone with an offset, and the tz-naive column silently drops the offset
    // — on a CDT box that stored this end 5h early and made the claim window
    // close 5h early (the bug this guard pins).
    const iso = eventEndsAt.toISOString();
    await pool!.query(
      `INSERT INTO "Event" ("id", "startsAt", "endsAt")
       VALUES ($1, ($2::timestamptz AT TIME ZONE 'UTC'), ($2::timestamptz AT TIME ZONE 'UTC'))`,
      [`event_${id}`, iso],
    );
    const stored = await pool!.query(
      `SELECT to_char("endsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endsAt"
       FROM "Event" WHERE "id" = $1`,
      [`event_${id}`],
    );
    expect(stored.rows[0]?.endsAt).toBe(iso);
    await pool!.query(
      `INSERT INTO "Order" ("id", "source", "eventId") VALUES ($1, 'RESALE', $2)`,
      [id, `event_${id}`],
    );
  }

  test("a matured RESALE credit waits for the claim window measured from the event's CURRENT end", async () => {
    // Credit matured at MATURE, but the event was moved later after finalize:
    // it now ends 2026-06-13, so claims run until 2026-06-16 > AS_OF.
    const movedEnd = new Date("2026-06-13T00:00:00.000Z");
    await insertResaleOrder("order_resale_moved", movedEnd);
    await credit({ orderId: "order_resale_moved", amountCents: 6_000 });

    expect(await payableFor(PAYEE, "usd")).toBe(0);
    expect(
      await repo.listConsumableCredits(PAYEE, "usd", AS_OF),
    ).toHaveLength(0);

    // Half-open: payable exactly AT the close (create-claim refuses then).
    const close = new Date("2026-06-16T00:00:00.000Z");
    const atClose = await repo.listPayableBalances(close, [PAYEE]);
    expect(atClose.find((c) => c.currency === "usd")?.payableCents).toBe(6_000);
    const justBefore = await repo.listPayableBalances(
      new Date(close.getTime() - 1),
      [PAYEE],
    );
    expect(justBefore.find((c) => c.currency === "usd")?.payableCents ?? 0).toBe(0);
  });

  test("the claim window does not touch PRIMARY orders or RESALE orders whose window has closed", async () => {
    // Event ended 2026-06-01 → window closed 2026-06-04 < AS_OF.
    await insertResaleOrder("order_resale_closed", new Date("2026-06-01T00:00:00.000Z"));
    await credit({ orderId: "order_resale_closed", amountCents: 6_000 });
    // A PRIMARY order with no event row at all.
    await insertOrder("order_primary");
    await credit({ orderId: "order_primary", amountCents: 1_000 });

    expect(await payableFor(PAYEE, "usd")).toBe(7_000);
    expect(
      await repo.listConsumableCredits(PAYEE, "usd", AS_OF),
    ).toHaveLength(2);
  });

  test("an open or under_review claim holds a RESALE credit PAST the claim-window close until staff decide", async () => {
    // Owner ruling Q9 (2026-10-06): no claim is closed automatically. The
    // window closed 2026-06-04 < AS_OF, so maturity alone would pay these;
    // the open-claim block must still hold them, and out of the forecast too
    // (a held credit is in neither payable nor upcoming).
    await insertResaleOrder("order_resale_open", new Date("2026-06-01T00:00:00.000Z"));
    await credit({ orderId: "order_resale_open", amountCents: 6_000 });
    await insertClaim("order_resale_open", "open");
    await insertResaleOrder("order_resale_review", new Date("2026-06-01T00:00:00.000Z"));
    await credit({ orderId: "order_resale_review", amountCents: 4_000 });
    await insertClaim("order_resale_review", "under_review");

    // Far past the close too: still held, however long review takes.
    const muchLater = new Date("2027-06-15T00:00:00.000Z");
    expect(await payableFor(PAYEE, "usd")).toBe(0);
    expect(await payableFor(PAYEE, "usd", muchLater)).toBe(0);
    expect(
      await repo.listConsumableCredits(PAYEE, "usd", muchLater),
    ).toHaveLength(0);
    expect(await repo.listUpcomingMaturities(AS_OF)).toEqual([]);

    // Staff deny one: that credit pays; the other stays held.
    await pool!.query(
      `UPDATE "Claim" SET "status" = 'denied' WHERE "orderId" = 'order_resale_open'`,
    );
    expect(await payableFor(PAYEE, "usd")).toBe(6_000);
  });

  // ── Approved claim: the freeze never stacks with a debit or hold ────────
  // Review round 2 [BLOCKING]: freezing an approved claim's credit while a
  // debit or active hold ALSO takes the same money punishes the payee twice
  // — and with a LOST debit nothing ever lifted it. Every case below has a
  // second, untouched order (OTHER = 1_000) so "payable = other credits
  // only" is visible.

  async function approvedClaimOrder(id: string) {
    await insertOrder(id);
    await credit({ orderId: id, amountCents: 6_000 });
    await insertClaim(id, "approved");
    await insertOrder(`${id}_other`);
    await credit({ orderId: `${id}_other`, amountCents: 1_000 });
  }

  test("approved claim, refund not yet landed, nothing else on the cell: the credit is frozen", async () => {
    await approvedClaimOrder("order_ac_frozen");
    expect(await payableFor(PAYEE, "usd")).toBe(1_000);
  });

  test("approved claim + ACTIVE dispute hold: payable = other credits only (hold withholds, freeze lifts)", async () => {
    await approvedClaimOrder("order_ac_hold");
    await pool!.query(
      `UPDATE "Order" SET "disputeStatus" = 'OPEN' WHERE "id" = 'order_ac_hold'`,
    );
    const hold = await repo.hold({
      idempotencyKey: "dispute-hold:dispute_ac:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 6_000,
      currency: "usd",
      disputeId: "dispute_ac",
      orderId: "order_ac_hold",
    });
    // 6_000 credit + 1_000 other − 6_000 pending hold. With the freeze
    // stacked this read 1_000 − 6_000 = −5_000.
    expect(await payableFor(PAYEE, "usd")).toBe(1_000);

    // Dispute WON: the hold is released and withholds nothing any more, so
    // the approved claim's freeze applies again.
    await pool!.query(
      `UPDATE "Order" SET "disputeStatus" = 'WON' WHERE "id" = 'order_ac_hold'`,
    );
    await repo.releaseHold({ holdEntryId: hold.id });
    expect(await payableFor(PAYEE, "usd")).toBe(1_000);
  });

  test("approved claim + LOST dispute debit: the order nets to 0, not −credit", async () => {
    await approvedClaimOrder("order_ac_lost");
    await pool!.query(
      `UPDATE "Order" SET "disputeStatus" = 'OPEN' WHERE "id" = 'order_ac_lost'`,
    );
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_acl:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 6_000,
      currency: "usd",
      disputeId: "dispute_acl",
      orderId: "order_ac_lost",
    });
    await pool!.query(
      `UPDATE "Order" SET "disputeStatus" = 'LOST' WHERE "id" = 'order_ac_lost'`,
    );
    await repo.debit({
      idempotencyKey: "dispute-debit:dispute_acl:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 6_000,
      currency: "usd",
      disputeId: "dispute_acl",
      orderId: "order_ac_lost",
    });
    // Order status never becomes REFUNDED on a chargeback. Before the fix
    // this read 1_000 − 6_000 = −5_000 FOREVER.
    expect(await payableFor(PAYEE, "usd")).toBe(1_000);
  });

  test("approved claim + LOST debit later REVERSED (WON after LOST): the freeze returns", async () => {
    // Refund failed → chargeback → LOST → Stripe re-closes as WON. The
    // reversal hands the 6_000 back to the payee, so nothing nets the credit
    // any more — but the buyer is STILL owed the approved claim's refund.
    await approvedClaimOrder("order_ac_won");
    await pool!.query(
      `UPDATE "Order" SET "disputeStatus" = 'OPEN' WHERE "id" = 'order_ac_won'`,
    );
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_acw:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 6_000,
      currency: "usd",
      disputeId: "dispute_acw",
      orderId: "order_ac_won",
    });
    await pool!.query(
      `UPDATE "Order" SET "disputeStatus" = 'LOST' WHERE "id" = 'order_ac_won'`,
    );
    const debit = await repo.debit({
      idempotencyKey: "dispute-debit:dispute_acw:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 6_000,
      currency: "usd",
      disputeId: "dispute_acw",
      orderId: "order_ac_won",
    });
    expect(await payableFor(PAYEE, "usd")).toBe(1_000);

    await pool!.query(
      `UPDATE "Order" SET "disputeStatus" = 'WON' WHERE "id" = 'order_ac_won'`,
    );
    await repo.reverseDisputeDebit({
      idempotencyKey: "dispute-debit-reversal:dispute_acw:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 6_000,
      currency: "usd",
      disputeId: "dispute_acw",
      debitEntryId: debit.id,
      orderId: "order_ac_won",
    });
    // Credit frozen again; debit (−6_000) and its reversal (+6_000) net 0.
    // Counting the reversed debit as "covering" read 7_000 here — the seller
    // paid while the buyer is still owed the refund.
    expect(await payableFor(PAYEE, "usd")).toBe(1_000);
  });

  test("approved claim + refund debits written but status NOT flipped (reconcile's ledger-only degrade): nets to 0", async () => {
    await approvedClaimOrder("order_ac_degrade");
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_ac_degrade:payee_1:re_1",
      payeeId: PAYEE,
      amountCents: 6_000,
      currency: "usd",
      orderId: "order_ac_degrade",
      description: "refund written, status flip lost",
      sourceKind: "order_refund",
      sourceId: "re_1",
    });
    expect(await payableFor(PAYEE, "usd")).toBe(1_000);
  });

  test("a rescheduled RESALE credit is FORECAST at the claim close and payable from it — never between the two", async () => {
    const movedEnd = new Date("2026-06-13T00:00:00.000Z");
    const close = new Date("2026-06-16T00:00:00.000Z");
    await insertResaleOrder("order_resale_forecast", movedEnd);
    await credit({ orderId: "order_resale_forecast", amountCents: 6_000 });

    // Before the close: not payable, but in the forecast at the close.
    expect(await payableFor(PAYEE, "usd")).toBe(0);
    const upcoming = await upcomingFor(PAYEE);
    expect(upcoming).toEqual([
      expect.objectContaining({ maturesAt: close, creditCents: 6_000 }),
    ]);

    // At the close: payable, out of the forecast, and it has waited since the
    // close (effective maturity), not since its stale availableAt.
    const atClose = await repo.listPayableBalances(close, [PAYEE]);
    expect(atClose).toEqual([
      expect.objectContaining({ payableCents: 6_000, oldestMaturedAt: close }),
    ]);
    expect(await upcomingFor(PAYEE, "usd", close)).toEqual([]);
  });

  // ── Debt, currencies, holds, payouts ──────────────────────────────────────

  test("a debt position is returned NEGATIVE, never clamped", async () => {
    await insertOrder("order_1");
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_1:payee_1:refund_1",
      payeeId: PAYEE,
      amountCents: 7_500,
      currency: "usd",
      orderId: "order_1",
      description: "refund with nothing to net against",
      sourceKind: "refund",
      sourceId: "refund_1",
    });

    expect(await payableFor(PAYEE, "usd")).toBe(-7_500);
  });

  test("currencies never sum together", async () => {
    await insertOrder("order_usd");
    await insertOrder("order_cad");
    await credit({ orderId: "order_usd", amountCents: 10_000, currency: "usd" });
    await credit({ orderId: "order_cad", amountCents: 4_000, currency: "cad" });

    const rows = await repo.listPayableBalances(AS_OF);
    expect(
      rows.filter((r) => r.payeeId === PAYEE).sort((a, b) =>
        a.currency.localeCompare(b.currency),
      ),
    ).toEqual([
      {
        payeeId: PAYEE,
        currency: "cad",
        payableCents: 4_000,
        oldestMaturedAt: expect.any(Date),
      },
      {
        payeeId: PAYEE,
        currency: "usd",
        payableCents: 10_000,
        oldestMaturedAt: expect.any(Date),
      },
    ]);
  });

  test("rows come back oldest-matured-money FIRST, so a payee cap starves nobody", async () => {
    // The payout batch caps how many payees it pays per run. Ordering by
    // payeeId — the obvious default — hands the same low-id prefix every night
    // forever once there are more payable payees than the cap, and it degrades
    // silently. Ordering by the oldest MATURED credit makes the queue fair: a
    // payee deferred tonight has older money tomorrow and outranks the payees
    // who just got paid.
    // No Payee row needed — this harness deliberately omits the Payee table
    // (and its FK), same as every other case in this file.
    const OTHER = "payee_2";
    await insertOrder("order_new");
    await insertOrder("order_old");
    // payee_1 sorts FIRST by id but its money is NEWER.
    await credit({
      orderId: "order_new",
      amountCents: 10_000,
      availableAt: new Date("2026-06-01T00:00:00Z"),
    });
    await credit({
      orderId: "order_old",
      payeeId: OTHER,
      amountCents: 8_000,
      availableAt: new Date("2026-01-01T00:00:00Z"),
    });

    const rows = (await repo.listPayableBalances(AS_OF)).filter(
      (r) => r.payeeId === PAYEE || r.payeeId === OTHER,
    );

    expect(rows.map((r) => r.payeeId)).toEqual([OTHER, PAYEE]);
    expect(rows[0]!.oldestMaturedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(rows[1]!.oldestMaturedAt).toEqual(new Date("2026-06-01T00:00:00Z"));
  });

  test("pendingHold subtracts; the payout entry subtracts; the reversal credit adds back", async () => {
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 10_000 });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_1:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 1_000,
      currency: "usd",
      disputeId: "dispute_1",
      orderId: "order_1",
    });
    expect(await payableFor(PAYEE, "usd")).toBe(9_000);

    const payout = await repo.payoutDebit({
      idempotencyKey: "payout:payout_item_1",
      payeeId: PAYEE,
      amountCents: 9_000,
      currency: "usd",
      sourceKind: "payout_item",
      sourceId: "payout_item_1",
      description: "payout",
      metadata: { consumedCreditEntryIds: [] },
    });
    expect(await payableFor(PAYEE, "usd")).toBe(0);

    // Post-payout refund whose Stripe transfer reversal SUCCEEDS: debit +
    // reversal net to zero — payable stays 0, no debt appears.
    const refundDebit = await repo.refundDebit({
      idempotencyKey: "refund-debit:order_1:payee_1:refund_1",
      payeeId: PAYEE,
      amountCents: 2_000,
      currency: "usd",
      orderId: "order_1",
      description: "post-payout refund",
      sourceKind: "refund",
      sourceId: "refund_1",
    });
    expect(await payableFor(PAYEE, "usd")).toBe(-2_000);
    await repo.transferReversalCredit({
      idempotencyKey: `transfer-reversal-credit:${refundDebit.id}`,
      payeeId: PAYEE,
      amountCents: 2_000,
      currency: "usd",
      orderId: "order_1",
      relatedEntryId: refundDebit.id,
      description: "reversal succeeded",
    });
    expect(await payableFor(PAYEE, "usd")).toBe(0);
    expect(payout.type).toBe("PAYOUT");
  });

  // ── Cash sales at the door (spec 2026-10-07, FR-004 / FR-008, R6) ─────────

  async function cashSaleDebit(orderId: string, amountCents: number) {
    return repo.cashSaleDebit({
      idempotencyKey: `cash-sale-debit:${orderId}`,
      payeeId: PAYEE,
      amountCents,
      currency: "usd",
      orderId,
      description: "cash sale fee + tax",
      sourceKind: "pos_cash_sale",
      sourceId: orderId,
    });
  }

  test("a cash sale debit is ALWAYS effective — it reduces payable, and a cash-only payee goes negative", async () => {
    await insertOrder("order_card");
    await credit({ orderId: "order_card", amountCents: 10_000 });
    await insertOrder("order_cash");
    await cashSaleDebit("order_cash", 700);
    expect(await payableFor(PAYEE, "usd")).toBe(9_300);

    // A second payee that only ever sold cash: the debt is the balance,
    // returned negative, never clamped.
    await repo.cashSaleDebit({
      idempotencyKey: "cash-sale-debit:order_cash_2",
      payeeId: "payee_cash_only",
      amountCents: 1_536,
      currency: "usd",
      orderId: "order_cash_2",
      description: "cash sale fee + tax",
      sourceKind: "pos_cash_sale",
      sourceId: "order_cash_2",
    });
    expect(await payableFor("payee_cash_only", "usd")).toBe(-1_536);
  });

  test("a cash sale debit is idempotent on its key; the reversal adds it back once", async () => {
    await insertOrder("order_card");
    await credit({ orderId: "order_card", amountCents: 10_000 });
    await insertOrder("order_cash");
    const debit = await cashSaleDebit("order_cash", 700);
    const replay = await cashSaleDebit("order_cash", 700);
    expect(replay.id).toBe(debit.id);
    expect(await payableFor(PAYEE, "usd")).toBe(9_300);

    const reversal = await repo.cashSaleDebitReversal({
      idempotencyKey: "cash-sale-debit-reversal:order_cash",
      debitIdempotencyKey: "cash-sale-debit:order_cash",
      description: "cash sale refunded",
      sourceKind: "pos_cash_refund",
      sourceId: "order_cash",
    });
    expect(reversal).toMatchObject({
      type: "CASH_SALE_DEBIT_REVERSAL",
      amountCents: 700,
      payeeId: PAYEE,
      orderId: "order_cash",
      relatedEntryId: debit.id,
    });
    expect(await payableFor(PAYEE, "usd")).toBe(10_000);

    const again = await repo.cashSaleDebitReversal({
      idempotencyKey: "cash-sale-debit-reversal:order_cash",
      debitIdempotencyKey: "cash-sale-debit:order_cash",
      description: "cash sale refunded",
      sourceKind: "pos_cash_refund",
      sourceId: "order_cash",
    });
    expect(again?.id).toBe(reversal!.id);
    expect(await payableFor(PAYEE, "usd")).toBe(10_000);

    // A comp has no debit: the reversal finds nothing and writes nothing.
    expect(
      await repo.cashSaleDebitReversal({
        idempotencyKey: "cash-sale-debit-reversal:order_comp",
        debitIdempotencyKey: "cash-sale-debit:order_comp",
        description: "comp refunded",
        sourceKind: "pos_cash_refund",
        sourceId: "order_comp",
      }),
    ).toBeNull();

    // The rollup moved with every write: −700 then +700.
    const { rows } = await pool!.query(
      `SELECT "ledgerBalanceCents" FROM "PayeeLedgerBalance" WHERE "payeeId" = $1`,
      [PAYEE],
    );
    expect(rows[0].ledgerBalanceCents).toBe(10_000);
  });

  test("the database allows ONE reversal per cash sale debit, whatever its key (20261007200100)", async () => {
    await insertOrder("order_cash");
    const debit = await cashSaleDebit("order_cash", 700);
    await repo.cashSaleDebitReversal({
      idempotencyKey: "cash-sale-debit-reversal:order_cash",
      debitIdempotencyKey: "cash-sale-debit:order_cash",
      description: "cash sale refunded",
      sourceKind: "pos_cash_refund",
      sourceId: "order_cash",
    });

    // A second reversal under ANOTHER key, straight to SQL (no writer guard).
    await expect(
      pool!.query(
        `INSERT INTO "PayeeLedgerEntry"
           ("id", "idempotencyKey", "payeeId", "type", "amountCents", "currency",
            "sourceKind", "sourceId", "orderId", "relatedEntryId", "description")
         VALUES ('dup_rev', 'some-other-key', $1, 'CASH_SALE_DEBIT_REVERSAL',
                 700, 'usd', 'test', 'dup', 'order_cash', $2, 'dup')`,
        [PAYEE, debit.id],
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "PayeeLedgerEntry_relatedEntryId_cash_sale_reversal_key",
    });

    // Other types pointing at the same entry are untouched by the index.
    await pool!.query(
      `INSERT INTO "PayeeLedgerEntry"
         ("id", "idempotencyKey", "payeeId", "type", "amountCents", "currency",
          "sourceKind", "sourceId", "orderId", "relatedEntryId", "description")
       VALUES ('adj_1', 'manual:1', $1, 'MANUAL_ADJUSTMENT', 1, 'usd', 'test',
               'adj', 'order_cash', $2, 'adj')`,
      [PAYEE, debit.id],
    );
  });

  test("findCashSaleDebit reads the debit a refund would reverse, before and after the reversal", async () => {
    await insertOrder("order_cash");
    const debit = await cashSaleDebit("order_cash", 700);

    expect(await repo.findCashSaleDebit("cash-sale-debit:order_cash")).toEqual(
      debit,
    );

    await repo.cashSaleDebitReversal({
      idempotencyKey: "cash-sale-debit-reversal:order_cash",
      debitIdempotencyKey: "cash-sale-debit:order_cash",
      description: "cash sale refunded",
      sourceKind: "pos_cash_refund",
      sourceId: "order_cash",
    });
    // Still the debit row, at its recorded amount: the read is not "what is
    // still owed", it is "what the refund reverses".
    expect(
      await repo.findCashSaleDebit("cash-sale-debit:order_cash"),
    ).toMatchObject({ id: debit.id, type: "CASH_SALE_DEBIT", amountCents: 700 });

    // A comp / tax-free sale: no debit.
    expect(
      await repo.findCashSaleDebit("cash-sale-debit:order_comp"),
    ).toBeNull();

    // A non-debit under the key is a collision, never "no debit".
    await expect(
      repo.findCashSaleDebit("cash-sale-debit-reversal:order_cash"),
    ).rejects.toThrow("payee_ledger_cash_sale_debit_key_not_a_debit");
  });

  test("LIABILITY: a cash sale debit nets against what the platform owes the payee", async () => {
    await insertOrder("order_card");
    await credit({ orderId: "order_card", amountCents: 10_000, availableAt: IMMATURE });
    await insertOrder("order_cash");
    await cashSaleDebit("order_cash", 700);

    const rows = await repo.sumOutstandingLiability();
    expect(rows.find((r) => r.currency === "usd")?.unpaidCreditsCents).toBe(
      9_300,
    );
  });

  // ── Consumable credits + consumption stamping ─────────────────────────────

  test("listConsumableCredits: FIFO by availableAt then createdAt; immature/blocked/consumed excluded", async () => {
    await insertOrder("order_a");
    await insertOrder("order_b");
    await insertOrder("order_c");
    await insertOrder("order_disputed", "OPEN");
    await insertOrder("order_claimed");
    await insertClaim("order_claimed", "open");

    const later = new Date("2026-06-05T00:00:00.000Z");
    const creditB = await credit({
      orderId: "order_b",
      amountCents: 2_000,
      availableAt: later,
    });
    const creditA = await credit({
      orderId: "order_a",
      amountCents: 1_000,
      availableAt: MATURE,
    });
    const creditC = await credit({
      orderId: "order_c",
      amountCents: 3_000,
      availableAt: later,
    });
    await credit({ orderId: "order_a", amountCents: 500, availableAt: IMMATURE });
    await credit({ orderId: "order_disputed", amountCents: 400 });
    await credit({ orderId: "order_claimed", amountCents: 300 });

    // Same availableAt for B and C — pin the createdAt tiebreak explicitly
    // (TIMESTAMP(3) writes in one test can collide at ms precision).
    await pool!.query(
      `UPDATE "PayeeLedgerEntry" SET "createdAt" = $2::timestamp WHERE "id" = $1`,
      [creditB.id, "2026-05-01T00:00:00.000Z"],
    );
    await pool!.query(
      `UPDATE "PayeeLedgerEntry" SET "createdAt" = $2::timestamp WHERE "id" = $1`,
      [creditC.id, "2026-05-02T00:00:00.000Z"],
    );

    const consumable = await repo.listConsumableCredits(PAYEE, "usd", AS_OF);
    expect(consumable.map((c) => c.id)).toEqual([
      creditA.id, // matures first
      creditB.id, // same maturity as C, created first
      creditC.id,
    ]);
    expect(consumable[0]).toEqual({
      id: creditA.id,
      orderId: "order_a",
      amountCents: 1_000,
      metadata: { items: { item_order_a: 1_000 } },
    });

    // Consumption: stamp A and B against a payout entry; they drop out.
    const payout = await repo.payoutDebit({
      idempotencyKey: "payout:payout_item_1",
      payeeId: PAYEE,
      amountCents: 3_000,
      currency: "usd",
      sourceKind: "payout_item",
      sourceId: "payout_item_1",
      description: "payout",
      metadata: { consumedCreditEntryIds: [creditA.id, creditB.id] },
    });
    expect(
      await repo.markCreditsConsumed([creditA.id, creditB.id], payout.id),
    ).toBe(2);
    expect(
      (await repo.listConsumableCredits(PAYEE, "usd", AS_OF)).map((c) => c.id),
    ).toEqual([creditC.id]);

    // The NULL-guard refuses a second consumption even by a real later
    // payout — count mismatch is the caller's fault signal.
    const laterPayout = await repo.payoutDebit({
      idempotencyKey: "payout:payout_item_2",
      payeeId: PAYEE,
      amountCents: 1_000,
      currency: "usd",
      sourceKind: "payout_item",
      sourceId: "payout_item_2",
      description: "later payout",
      metadata: { consumedCreditEntryIds: [] },
    });
    expect(await repo.markCreditsConsumed([creditA.id], laterPayout.id)).toBe(0);
    // And the payee/currency scope derived from the payout entry means a
    // foreign payee's payout structurally cannot stamp these credits.
    const foreignPayout = await repo.payoutDebit({
      idempotencyKey: "payout:payout_item_foreign",
      payeeId: "payee_2",
      amountCents: 1_000,
      currency: "usd",
      sourceKind: "payout_item",
      sourceId: "payout_item_foreign",
      description: "foreign payout",
      metadata: { consumedCreditEntryIds: [] },
    });
    expect(
      await repo.markCreditsConsumed([creditC.id], foreignPayout.id),
    ).toBe(0);

    // Consumption is attribution only: the payable AMOUNT is unchanged by
    // stamping (credits 1000+2000+3000 − payouts 3000+1000 = 2000; the
    // foreign payee's payout and the immature/blocked credits stay out
    // either way).
    expect(await payableFor(PAYEE, "usd")).toBe(2_000);
  });

  // ── The opt-in statement budget (staff reads only) ────────────────────────
  //
  // `/platform/settlements` reads these two aggregates interactively and
  // cannot hang, so it passes a budget. The payout batch passes none. The
  // load-bearing property is that the budget changes the FAILURE MODE and
  // NOTHING ELSE: a budgeted read and an unbudgeted one must return the same
  // cents, or the staff "what we owe" view and the batch would disagree
  // about who gets paid tonight.

  test("a budgeted payable read returns EXACTLY the rows the batch's unbudgeted read returns", async () => {
    await insertOrder("order_1");
    await insertOrder("order_2");
    await insertOrder("order_blocked", "OPEN");
    await credit({ orderId: "order_1", amountCents: 10_000 });
    await credit({ orderId: "order_2", amountCents: 4_000, availableAt: IMMATURE });
    await credit({ orderId: "order_blocked", amountCents: 9_999 });
    await credit({ orderId: "order_1", payeeId: "payee_2", amountCents: 2_500 });
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_1:payee_1:budget",
      payeeId: PAYEE,
      amountCents: 1_500,
      currency: "usd",
      orderId: "order_1",
      description: "refund",
      sourceKind: "refund",
      sourceId: "refund_budget",
    });

    const batchRows = await repo.listPayableBalances(AS_OF);
    const staffRows = await repo.listPayableBalances(AS_OF, undefined, {
      statementTimeoutMs: 8_000,
    });

    expect(staffRows).toEqual(batchRows);
    // ...and the rows are the real thing, not two identically-empty answers.
    expect(batchRows.find((r) => r.payeeId === PAYEE)?.payableCents).toBe(8_500);
  });

  test("a budgeted liability read returns EXACTLY the unbudgeted totals", async () => {
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 10_000, availableAt: IMMATURE });

    const plain = await repo.sumOutstandingLiability();
    const budgeted = await repo.sumOutstandingLiability({
      statementTimeoutMs: 8_000,
    });

    expect(budgeted).toEqual(plain);
    // The whole point of liability: an IMMATURE credit is owed even though
    // the payable excludes it.
    expect(plain.find((r) => r.currency === "usd")?.unpaidCreditsCents).toBe(
      10_000,
    );
    // The cell EXISTS at zero — the immature credit groups but contributes
    // nothing — which is precisely why the staff view filters on
    // `payableCents > 0` rather than on row presence.
    expect(await payableFor(PAYEE, "usd")).toBe(0);
  });

  // ── Currency normalisation ────────────────────────────────────────────────
  // The port promises `currency` is "Lowercase ISO-4217" and that each row IS
  // the total for one currency. The query grouped on the RAW column, so two
  // casings returned two rows and broke both halves of that promise.
  //
  // The write path normalises, so these rows arrive only from legacy data, a
  // backfill or direct SQL — which is exactly how they are simulated here.

  test("PAYABLE: mixed-casing entries fold into one cell, not two competing ones", async () => {
    // Worse than the liability duplicate, because run-batch's `cellClaimKey`
    // is ALREADY normalised: two payable cells for one payee-currency both
    // hash to one claim, the second loses it, and the batch records
    // `itemsSkippedClaimLost`. The same casing wins every night, so the losing
    // cell's money is never paid out — silently, forever.
    await insertOrder("order_1");
    await insertOrder("order_2");
    await credit({ orderId: "order_1", amountCents: 10_000 });
    await credit({ orderId: "order_2", amountCents: 4_000 });
    await pool!.query(
      `UPDATE "PayeeLedgerEntry" SET "currency" = 'USD' WHERE "orderId" = $1`,
      ["order_1"],
    );

    const rows = await repo.listPayableBalances(AS_OF);
    const mine = rows.filter((r) => r.payeeId === PAYEE);

    expect(mine).toHaveLength(1);
    expect(mine[0]!.currency).toBe("usd");
    expect(mine[0]!.payableCents).toBe(14_000);
  });

  test("PAYABLE: a pending hold stored in another casing still deducts", async () => {
    // The LEFT JOIN matched the rollup on the raw column too, so a hold
    // recorded under one casing did not reduce the other casing's payable.
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 10_000 });
    await pool!.query(
      `INSERT INTO "PayeeLedgerBalance" ("payeeId", "currency", "ledgerPendingHoldCents")
       VALUES ($1, 'USD', 2500)
       ON CONFLICT ("payeeId", "currency")
       DO UPDATE SET "ledgerPendingHoldCents" = 2500`,
      [PAYEE],
    );

    const rows = await repo.listPayableBalances(AS_OF);
    const mine = rows.filter((r) => r.payeeId === PAYEE);

    expect(mine).toHaveLength(1);
    expect(mine[0]!.payableCents).toBe(7_500);
  });

  test("mixed-casing entries fold into ONE row, summed, not two rows", async () => {
    await insertOrder("order_1");
    await insertOrder("order_2");
    await credit({ orderId: "order_1", amountCents: 1_000_000 });
    await credit({ orderId: "order_2", amountCents: 5_000 });
    // Legacy provenance: bypass the normalising write path.
    await pool!.query(
      `UPDATE "PayeeLedgerEntry" SET "currency" = 'USD' WHERE "orderId" = $1`,
      ["order_1"],
    );

    const rows = await repo.sumOutstandingLiability();
    const usd = rows.filter((r) => r.currency === "usd");

    // One row, and it carries BOTH casings' cents. Grouping on the raw column
    // returns two rows here, and the consumer's `new Map(...)` then keeps
    // whichever arrives last — understating liability, the direction that
    // reports the platform solvent while it is insolvent.
    expect(rows).toHaveLength(1);
    expect(usd).toHaveLength(1);
    expect(usd[0]!.currency).toBe("usd");
    expect(usd[0]!.unpaidCreditsCents).toBe(1_005_000);
  });

  test("the per-payee zero clamp runs ONCE, after the casings are folded", async () => {
    // One payee, one real currency, split across two casings with the debt
    // on one side. Clamping each casing separately would floor the −100 at 0
    // and report 500; folding first yields the true 400.
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 500 });
    await insertOrder("order_2");
    await credit({ orderId: "order_2", amountCents: 100 });
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_2:payee_1:casing",
      payeeId: PAYEE,
      amountCents: 200,
      currency: "usd",
      orderId: "order_2",
      description: "refund past the credit",
      sourceKind: "refund",
      sourceId: "refund_casing",
    });
    await pool!.query(
      `UPDATE "PayeeLedgerEntry" SET "currency" = 'USD' WHERE "orderId" = $1`,
      ["order_2"],
    );

    const rows = await repo.sumOutstandingLiability();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.unpaidCreditsCents).toBe(400);
  });

  test("a budgeted read that outruns its budget degrades to SERVICE_UNAVAILABLE, not a hang", async () => {
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 10_000 });

    // Slow for real, inside the read's own transaction and after its
    // SET LOCALs — so Postgres cancels with 57014 exactly as it would on a
    // pathological ledger.
    __testOnlyLedgerBudgetHooks.beforeQuery = async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_sleep(2)`);
    };

    const err = await repo
      .listPayableBalances(AS_OF, undefined, { statementTimeoutMs: 200 })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(isAppError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "payee_ledger_payable_balances_timeout",
    });
  }, 60_000);

  test("a budget on a TransactionClient is REFUSED — SET LOCAL must never leak onto a caller's transaction", async () => {
    await expect(
      prisma!.$transaction(async (tx) =>
        makePayeeLedgerRepo(tx).listPayableBalances(AS_OF, undefined, {
          statementTimeoutMs: 8_000,
        }),
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: "payee_ledger_payable_balances_requires_top_level_client",
    });

    // Unbudgeted inside a transaction stays legal — that is the batch's path.
    await expect(
      prisma!.$transaction(async (tx) =>
        makePayeeLedgerRepo(tx).listPayableBalances(AS_OF),
      ),
    ).resolves.toEqual([]);
  });

  // ── Upcoming maturities: the FORWARD half of the payable ──────────────────
  //
  // `listUpcomingMaturities` covers exactly the credit rows the payable
  // EXCLUDES on maturity. Three properties are worth real tests: it is the
  // complement of the payable on maturity; `creditCents` is a CREDIT FEED
  // rather than a balance — a debit, a payout OR A HOLD must not net against
  // a future tranche, because all of them already came off today's payable;
  // and `heldCents` ANNOTATES the active dispute hold on the tranche's
  // orders, once per order, as written — see the invariant block below for
  // why it is never an operand.

  async function upcomingFor(payeeId: string, currency = "usd", asOf = AS_OF) {
    const rows = await repo.listUpcomingMaturities(asOf);
    return rows.filter((r) => r.payeeId === payeeId && r.currency === currency);
  }

  test("lists ONLY immature credits, grouped per (payee, currency, availableAt), soonest first", async () => {
    const OCT = new Date("2026-10-01T00:00:00.000Z");
    const NOV = new Date("2026-11-01T00:00:00.000Z");
    await insertOrder("order_now");
    await insertOrder("order_oct_a");
    await insertOrder("order_oct_b");
    await insertOrder("order_nov");
    // Matured — belongs to the PAYABLE, must not appear here.
    await credit({ orderId: "order_now", amountCents: 10_000 });
    // Two credits on the same future date fold into ONE tranche.
    await credit({ orderId: "order_oct_a", amountCents: 3_000, availableAt: OCT });
    await credit({ orderId: "order_oct_b", amountCents: 1_500, availableAt: OCT });
    await credit({ orderId: "order_nov", amountCents: 700, availableAt: NOV });
    // A different payee on the nearer date, to prove the ordering.
    await credit({
      orderId: "order_oct_a",
      payeeId: "payee_2",
      amountCents: 250,
      availableAt: OCT,
    });

    const rows = await repo.listUpcomingMaturities(AS_OF);

    expect(rows).toEqual([
      {
        payeeId: PAYEE,
        currency: "usd",
        maturesAt: OCT,
        creditCents: 4_500,
        heldCents: 0,
        creditCount: 2,
      },
      {
        payeeId: "payee_2",
        currency: "usd",
        maturesAt: OCT,
        creditCents: 250,
        heldCents: 0,
        creditCount: 1,
      },
      {
        payeeId: PAYEE,
        currency: "usd",
        maturesAt: NOV,
        creditCents: 700,
        heldCents: 0,
        creditCount: 1,
      },
    ]);
  });

  test("is the exact COMPLEMENT of the payable on maturity — a credit is in one or the other, never both", async () => {
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 10_000, availableAt: IMMATURE });

    // Before maturity: upcoming has it, payable does not.
    expect(await payableFor(PAYEE, "usd", AS_OF)).toBe(0);
    expect(await upcomingFor(PAYEE, "usd", AS_OF)).toEqual([
      {
        payeeId: PAYEE,
        currency: "usd",
        maturesAt: IMMATURE,
        creditCents: 10_000,
        heldCents: 0,
        creditCount: 1,
      },
    ]);

    // ON the boundary the payable claims it (`availableAt <= asOf`) and the
    // forecast drops it (`availableAt > asOf`). No row is in both, and none
    // falls between the two queries.
    expect(await payableFor(PAYEE, "usd", IMMATURE)).toBe(10_000);
    expect(await upcomingFor(PAYEE, "usd", IMMATURE)).toEqual([]);
  });

  test("creditCents is a CREDIT FEED, not a balance: refund debits and payouts do NOT net against a future tranche, and a hold on ANOTHER order is not attributed to it", async () => {
    // THE DOUBLE-COUNT TRAP. A REFUND_DEBIT is effective the moment it is
    // written — it has ALREADY reduced today's payable (see the asymmetry
    // test above). Subtracting it from a FUTURE tranche as well would deduct
    // it twice and understate what the platform will owe on that date.
    await insertOrder("order_future");
    await insertOrder("order_now");
    await credit({ orderId: "order_future", amountCents: 9_000, availableAt: IMMATURE });
    await credit({ orderId: "order_now", amountCents: 5_000 });
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_now:payee_1:forecast",
      payeeId: PAYEE,
      amountCents: 2_000,
      currency: "usd",
      orderId: "order_now",
      description: "refund",
      sourceKind: "refund",
      sourceId: "refund_forecast",
    });
    await repo.payoutDebit({
      idempotencyKey: "payout:payee_1:usd:forecast",
      payeeId: PAYEE,
      amountCents: 3_000,
      currency: "usd",
      description: "payout",
      sourceKind: "payout_item",
      sourceId: "payout_item_forecast",
      metadata: { consumedCreditEntryIds: [] },
    });
    // A hold on the MATURED order: it withholds from today's payable, not
    // from the future tranche on a different order.
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_forecast:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 1_000,
      currency: "usd",
      disputeId: "dispute_forecast",
      orderId: "order_now",
    });

    // The payable absorbed every one of those effects...
    expect(await payableFor(PAYEE, "usd")).toBe(5_000 - 2_000 - 3_000 - 1_000);
    // ...and the forecast's GROSS is untouched by all of them: the future
    // tranche is the credit, whole, with no hold of its own.
    expect(await upcomingFor(PAYEE, "usd")).toEqual([
      {
        payeeId: PAYEE,
        currency: "usd",
        maturesAt: IMMATURE,
        creditCents: 9_000,
        heldCents: 0,
        creditCount: 1,
      },
    ]);
  });

  test("excludes BLOCKED credits — an open dispute WITHOUT a hold, or an open claim, is not forecast as money going out", async () => {
    await insertOrder("order_clean");
    await insertOrder("order_disputed", "OPEN");
    await insertOrder("order_claimed");
    await insertClaim("order_claimed", "open");
    await credit({ orderId: "order_clean", amountCents: 4_000, availableAt: IMMATURE });
    await credit({ orderId: "order_disputed", amountCents: 8_000, availableAt: IMMATURE });
    await credit({ orderId: "order_claimed", amountCents: 6_000, availableAt: IMMATURE });

    // Only the clean credit is forecast. This is the ONE gate shared with the
    // payable, and the deliberate difference from `sumOutstandingLiability`,
    // which KEEPS blocked credits because a liability must err HIGH.
    expect(await upcomingFor(PAYEE, "usd")).toEqual([
      {
        payeeId: PAYEE,
        currency: "usd",
        maturesAt: IMMATURE,
        creditCents: 4_000,
        heldCents: 0,
        creditCount: 1,
      },
    ]);
    expect(
      (await repo.sumOutstandingLiability()).find((r) => r.currency === "usd")
        ?.unpaidCreditsCents,
    ).toBe(18_000);
  });

  test("a disputed credit whose ACTIVE HOLD carries the withholding is forecast WHOLE, with the hold ANNOTATED — and today's payable already carries the hold", async () => {
    // Same single-mechanism rule as the payable: when a DISPUTE_HOLD exists,
    // the hold IS the withholding, so the credit is not additionally
    // excluded — it stays in the feed, gross. The hold reaches the forecast
    // through the payable (−7_000 today → debt), never by subtraction here.
    await insertOrder("order_held", "OPEN");
    await credit({ orderId: "order_held", amountCents: 7_000, availableAt: IMMATURE });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_held:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 7_000,
      currency: "usd",
      disputeId: "dispute_held",
      orderId: "order_held",
    });

    expect(await upcomingFor(PAYEE, "usd")).toEqual([
      {
        payeeId: PAYEE,
        currency: "usd",
        maturesAt: IMMATURE,
        creditCents: 7_000,
        heldCents: 7_000,
        creditCount: 1,
      },
    ]);
    // The hold is ALREADY effective: `hold()` bumps ledgerPendingHoldCents at
    // write time and the payable subtracts it unconditionally, so TODAY the
    // cell reads −7_000 (a debt position) — and on the night, 0.
    expect(await payableFor(PAYEE, "usd", AS_OF)).toBe(-7_000);
    expect(await payableFor(PAYEE, "usd", IMMATURE)).toBe(0);
  });

  test("a PARTIAL hold is annotated at its own amount; a hold LARGER than the tranche is reported AS WRITTEN, not clamped", async () => {
    await insertOrder("order_partial", "OPEN");
    await credit({ orderId: "order_partial", amountCents: 7_000, availableAt: IMMATURE });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_partial:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 3_000,
      currency: "usd",
      disputeId: "dispute_partial",
      orderId: "order_partial",
    });
    // A second payee: hold exceeds the credit (a hold sized from the order
    // total while this payee's split is smaller). An annotation is reported
    // as written — clamping it would misstate what is under dispute.
    await insertOrder("order_over", "OPEN");
    await credit({
      orderId: "order_over",
      payeeId: "payee_2",
      amountCents: 2_000,
      availableAt: IMMATURE,
    });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_over:payee_2:usd",
      payeeId: "payee_2",
      amountCents: 9_000,
      currency: "usd",
      disputeId: "dispute_over",
      orderId: "order_over",
    });

    expect(await upcomingFor(PAYEE, "usd")).toEqual([
      {
        payeeId: PAYEE,
        currency: "usd",
        maturesAt: IMMATURE,
        creditCents: 7_000,
        heldCents: 3_000,
        creditCount: 1,
      },
    ]);
    expect(await upcomingFor("payee_2", "usd")).toEqual([
      {
        payeeId: "payee_2",
        currency: "usd",
        maturesAt: IMMATURE,
        creditCents: 2_000,
        heldCents: 9_000,
        creditCount: 1,
      },
    ]);
  });

  test("TWO credit rows of ONE order in one tranche count the order's hold ONCE", async () => {
    // The join is per order, not per credit row: a 5_000 hold on an order
    // with two credit rows must read 5_000, not 10_000.
    await insertOrder("order_two", "OPEN");
    await credit({ orderId: "order_two", amountCents: 4_000, availableAt: IMMATURE });
    await credit({ orderId: "order_two", amountCents: 2_000, availableAt: IMMATURE });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_two:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      disputeId: "dispute_two",
      orderId: "order_two",
    });

    expect(await upcomingFor(PAYEE, "usd")).toEqual([
      {
        payeeId: PAYEE,
        currency: "usd",
        maturesAt: IMMATURE,
        creditCents: 6_000,
        heldCents: 5_000,
        creditCount: 2,
      },
    ]);
  });

  test("a hold is annotated on its OWN payee's tranche only, and a RELEASED hold is not annotated", async () => {
    // Split order: artist and venue each hold their own share. The venue's
    // hold must not touch the artist's tranche.
    await insertOrder("order_split", "OPEN");
    await credit({ orderId: "order_split", payeeId: "payee_artist", amountCents: 3_000, availableAt: IMMATURE });
    await credit({ orderId: "order_split", payeeId: "payee_venue", amountCents: 2_000, availableAt: IMMATURE });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_split:payee_venue:usd",
      payeeId: "payee_venue",
      amountCents: 2_000,
      currency: "usd",
      disputeId: "dispute_split",
      orderId: "order_split",
    });
    // The artist's own hold is released (dispute WON for them): the release
    // row consumes the hold, so it is no longer ACTIVE — same predicate as
    // findActiveHoldRows / CREDIT_NOT_BLOCKED_SQL.
    const artistHold = await repo.hold({
      idempotencyKey: "dispute-hold:dispute_split:payee_artist:usd",
      payeeId: "payee_artist",
      amountCents: 3_000,
      currency: "usd",
      disputeId: "dispute_split",
      orderId: "order_split",
    });
    await repo.releaseHold({ holdEntryId: artistHold.id });

    // The order is still OPEN, and the artist has no ACTIVE hold — so the
    // status exclusion fires for the artist and the credit leaves the feed
    // entirely (blocked), which is the single-mechanism rule: no hold, no
    // credit; hold: the credit is forecast whole and the hold reaches it as
    // debt. Never both. The venue keeps theirs.
    expect(await upcomingFor("payee_artist", "usd")).toEqual([]);
    expect(await upcomingFor("payee_venue", "usd")).toEqual([
      {
        payeeId: "payee_venue",
        currency: "usd",
        maturesAt: IMMATURE,
        creditCents: 2_000,
        heldCents: 2_000,
        creditCount: 1,
      },
    ]);

    // Once the dispute closes in the artist's favour the status clears; the
    // released hold is history and the credit is forecast whole.
    await pool!.query(
      `UPDATE "Order" SET "disputeStatus" = 'WON' WHERE "id" = 'order_split'`,
    );
    expect(await upcomingFor("payee_artist", "usd")).toEqual([
      {
        payeeId: "payee_artist",
        currency: "usd",
        maturesAt: IMMATURE,
        creditCents: 3_000,
        heldCents: 0,
        creditCount: 1,
      },
    ]);
  });

  test("mixed-casing currencies fold into ONE tranche, and the hold join normalises too", async () => {
    await insertOrder("order_1", "OPEN");
    await credit({ orderId: "order_1", amountCents: 1_000, availableAt: IMMATURE });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_case:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 400,
      currency: "usd",
      disputeId: "dispute_case",
      orderId: "order_1",
    });
    // Legacy/backfill shape: the write path normalises, so this is forced —
    // on the credit AND the hold. The blocked-credit fragment compares the
    // two RAW (so they still pair up as "hold carries the withholding"),
    // while this query's tranche key is normalised — the hold join must fold
    // casing too, or a 'USD' hold would never find its 'usd' tranche.
    await pool!.query(
      `UPDATE "PayeeLedgerEntry" SET "currency" = 'USD' WHERE "payeeId" = $1`,
      [PAYEE],
    );
    // A lower-case credit on a CLEAN order folds into the same tranche. (Not
    // on order_1: the shared fragment's raw compare would see no hold in
    // 'usd' for that OPEN order and block the credit — that is the
    // fragment's contract, not this query's.)
    await insertOrder("order_2");
    await credit({ orderId: "order_2", amountCents: 250, availableAt: IMMATURE });

    const rows = await repo.listUpcomingMaturities(AS_OF);
    expect(rows).toEqual([
      {
        payeeId: PAYEE,
        currency: "usd",
        maturesAt: IMMATURE,
        creditCents: 1_250,
        heldCents: 400,
        creditCount: 2,
      },
    ]);
  });

  test("a budgeted upcoming read returns EXACTLY the unbudgeted rows, and a TransactionClient budget is REFUSED", async () => {
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 2_400, availableAt: IMMATURE });

    const plain = await repo.listUpcomingMaturities(AS_OF);
    const budgeted = await repo.listUpcomingMaturities(AS_OF, undefined, {
      statementTimeoutMs: 8_000,
    });
    expect(budgeted).toEqual(plain);
    expect(plain[0]!.creditCents).toBe(2_400);
    expect(plain[0]!.heldCents).toBe(0);

    await expect(
      prisma!.$transaction(async (tx) =>
        makePayeeLedgerRepo(tx).listUpcomingMaturities(AS_OF, undefined, {
          statementTimeoutMs: 8_000,
        }),
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: "payee_ledger_upcoming_maturities_requires_top_level_client",
    });
  });

  // ── Payee narrowing (the organiser-facing slice) ──────────────────────────
  //
  // The organiser payouts view is THIS read narrowed to the org's own payee.
  // The unit tests assert the BYTES (bound parameter, predicate inside
  // tranche_credits); these assert the ROWS, which is the half a SQL-text
  // assertion can never reach.

  const OTHER_PAYEE = "payee_2";

  test("payeeIds narrows the forecast to those payees, and changes NOTHING else about the rows", async () => {
    await insertOrder("order_1");
    await insertOrder("order_2");
    await credit({ orderId: "order_1", amountCents: 7_000, availableAt: IMMATURE });
    await credit({
      orderId: "order_2",
      amountCents: 3_000,
      availableAt: IMMATURE,
      payeeId: OTHER_PAYEE,
    });

    const all = await repo.listUpcomingMaturities(AS_OF);
    expect(all.map((r) => r.payeeId).sort()).toEqual([OTHER_PAYEE, PAYEE].sort());

    const mine = await repo.listUpcomingMaturities(AS_OF, [PAYEE]);
    // The narrowed row must be BYTE-IDENTICAL to the one the staff read
    // produced — a narrowed forecast is the same forecast, not a second
    // arithmetic. Two surfaces disagreeing about a tranche is the failure
    // this whole design exists to make impossible.
    expect(mine).toEqual(all.filter((r) => r.payeeId === PAYEE));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.creditCents).toBe(7_000);
  });

  test("an EXPLICIT empty payeeIds returns NO rows — never the whole ledger", async () => {
    // The failure mode: an org with no payee row yet passes `[]`, and a
    // coalesce-to-undefined bug shows them every payee on the platform.
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 7_000, availableAt: IMMATURE });

    expect(await repo.listUpcomingMaturities(AS_OF, [])).toEqual([]);
    // Omitted is the OPPOSITE — the full-ledger staff read.
    expect(await repo.listUpcomingMaturities(AS_OF, undefined)).toHaveLength(1);
  });

  test("narrowing preserves the blocked-credit exclusion and the held annotation", async () => {
    // Everything the shared fragment does must survive the filter: a
    // narrowed read that quietly stopped excluding blocked credits would
    // forecast money to an organiser that the batch will never send.
    await insertOrder("order_blocked", "OPEN");
    await insertOrder("order_clean");
    await credit({
      orderId: "order_blocked",
      amountCents: 9_000,
      availableAt: IMMATURE,
    });
    await credit({ orderId: "order_clean", amountCents: 2_000, availableAt: IMMATURE });

    const mine = await repo.listUpcomingMaturities(AS_OF, [PAYEE]);
    // Blocked (OPEN, no hold) is excluded; only the clean credit forecasts.
    expect(mine).toEqual([
      {
        payeeId: PAYEE,
        currency: "usd",
        maturesAt: IMMATURE,
        creditCents: 2_000,
        heldCents: 0,
        creditCount: 1,
      },
    ]);
  });

  // ── listEntries as the tranche ATTRIBUTION feed ───────────────────────────
  //
  // THE INVARIANT: the credit rows listed under a tranche must sum to that
  // tranche's own creditCents. They are two different statements, so nothing
  // but a test holds them together.

  // A SECOND future maturity, so `availableAtBefore` is actually load-bearing.
  // With one future date the upper bound is unconstraining and every
  // assertion below would pass identically with it deleted.
  const IMMATURE_2 = new Date("2026-08-01T00:00:00.000Z"); // > IMMATURE

  test("each tranche's attribution rows sum EXACTLY to that tranche's own total", async () => {
    // The windows below mirror `trancheAttributionOptions`
    // (packages/core/src/use-cases/payouts/_shared/tranche-attribution.ts):
    // half-open `(previous.maturesAt, this.maturesAt]`, currency-scoped,
    // blocked credits excluded, and NO consumption filter. Hand-rolled here
    // only because an adapter test must not import core.
    await insertOrder("order_a");
    await insertOrder("order_b");
    await insertOrder("order_c");
    await insertOrder("order_blocked", "OPEN");
    await insertOrder("order_claimed");
    await insertClaim("order_claimed", "open");

    // Tranche 1 (IMMATURE): 4_000 + 1_500 = 5_500
    await credit({ orderId: "order_a", amountCents: 4_000, availableAt: IMMATURE });
    await credit({ orderId: "order_b", amountCents: 1_500, availableAt: IMMATURE });
    // Tranche 2 (IMMATURE_2): 2_750
    await credit({ orderId: "order_c", amountCents: 2_750, availableAt: IMMATURE_2 });
    // Excluded by BOTH tranche totals — must be excluded from both lists.
    await credit({ orderId: "order_blocked", amountCents: 9_000, availableAt: IMMATURE });
    await credit({ orderId: "order_claimed", amountCents: 6_000, availableAt: IMMATURE_2 });
    // Already payable today: belongs to no tranche, must appear in neither.
    await credit({ orderId: "order_a", amountCents: 999, availableAt: MATURE });

    const tranches = await repo.listUpcomingMaturities(AS_OF, [PAYEE]);
    expect(tranches.map((t) => [t.maturesAt, t.creditCents])).toEqual([
      [IMMATURE, 5_500],
      [IMMATURE_2, 2_750],
    ]);

    // FIRST tranche: lower bound is asOf (strict), upper is its own maturity
    // (inclusive). The 2_750 credit maturing later must NOT appear.
    const firstRows = await repo.listEntries(PAYEE, {
      currency: "usd",
      types: ["SETTLEMENT_CREDIT"],
      availableAtAfter: AS_OF,
      availableAtBefore: IMMATURE,
      excludeBlockedCredits: true,
      limit: 100,
    });
    expect(firstRows.map((r) => r.orderId).sort()).toEqual([
      "order_a",
      "order_b",
    ]);
    expect(firstRows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(
      tranches[0]!.creditCents,
    );

    // SECOND tranche: lower bound is the PREVIOUS tranche's maturity, not
    // asOf. Using asOf here is the defect this window exists to prevent — it
    // would drag order_a and order_b under the 1 Aug heading.
    const secondRows = await repo.listEntries(PAYEE, {
      currency: "usd",
      types: ["SETTLEMENT_CREDIT"],
      availableAtAfter: IMMATURE,
      availableAtBefore: IMMATURE_2,
      excludeBlockedCredits: true,
      limit: 100,
    });
    expect(secondRows.map((r) => r.orderId)).toEqual(["order_c"]);
    expect(secondRows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(
      tranches[1]!.creditCents,
    );

    // PARTITION: no row is shared between the windows, and together they
    // account for every credit both tranches counted.
    const firstIds = new Set(firstRows.map((r) => r.id));
    expect(secondRows.some((r) => firstIds.has(r.id))).toBe(false);
    expect(firstRows.length + secondRows.length).toBe(
      tranches[0]!.creditCount + tranches[1]!.creditCount,
    );
  });

  test("availableAtAfter is STRICT, matching the tranche read's own boundary", async () => {
    // A credit maturing ON the instant is payable TODAY and belongs to no
    // tranche. `>=` here would hand the sub-lines a row the heading excluded.
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 1_000, availableAt: AS_OF });

    expect(await repo.listUpcomingMaturities(AS_OF, [PAYEE])).toEqual([]);
    expect(
      await repo.listEntries(PAYEE, { availableAtAfter: AS_OF, limit: 100 }),
    ).toEqual([]);
    // availableAtBefore, by contrast, is INCLUSIVE.
    expect(
      await repo.listEntries(PAYEE, { availableAtBefore: AS_OF, limit: 100 }),
    ).toHaveLength(1);
  });

  test("unconsumedOnly DIVERGES from the tranche read — which is why the attribution bundle omits it", async () => {
    // `tranche_credits` filters on type, payee, `availableAt > asOf` and the
    // blocked fragment, and on NOTHING ELSE — there is no consumption
    // predicate. So a consumed credit is still inside the tranche total, and
    // an attribution list carrying `unconsumedOnly` would show a $40 heading
    // over an empty list.
    //
    // The option stays on the type (a "still unpaid" journal view is a fair
    // use of it); this test pins WHY it is absent from
    // `trancheAttributionOptions`, and asserts both halves in one breath so
    // the two reads cannot silently drift apart again.
    await insertOrder("order_1");
    const credited = await credit({
      orderId: "order_1",
      amountCents: 4_000,
      availableAt: IMMATURE,
    });
    const payout = await repo.payoutDebit({
      idempotencyKey: "payout:batch_1:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 4_000,
      currency: "usd",
      description: "payout",
      sourceKind: "payout_item",
      sourceId: "payout_item_1",
      metadata: { consumedCreditEntryIds: [credited.id] },
    });
    await repo.markCreditsConsumed([credited.id], payout.id);

    // The heading still counts it.
    const [tranche] = await repo.listUpcomingMaturities(AS_OF, [PAYEE]);
    expect(tranche!.creditCents).toBe(4_000);

    // The attribution bundle (no `unconsumedOnly`) still lists it — sum
    // agrees with the heading.
    const attributed = await repo.listEntries(PAYEE, {
      currency: "usd",
      types: ["SETTLEMENT_CREDIT"],
      availableAtAfter: AS_OF,
      availableAtBefore: tranche!.maturesAt,
      excludeBlockedCredits: true,
      limit: 100,
    });
    expect(attributed.reduce((sum, r) => sum + r.amountCents, 0)).toBe(
      tranche!.creditCents,
    );

    // Adding `unconsumedOnly` is what breaks it. This is the divergence, in
    // one assertion, deliberately recorded rather than hidden.
    expect(
      await repo.listEntries(PAYEE, {
        types: ["SETTLEMENT_CREDIT"],
        unconsumedOnly: true,
        limit: 100,
      }),
    ).toEqual([]);
  });

  test("excludeBlockedCredits drops the blocked CREDIT and keeps every non-credit row", async () => {
    // Row-level proof of the `type <> 'SETTLEMENT_CREDIT' OR <blocked>`
    // disjunction. A SQL-text assertion cannot catch a precedence or
    // NULL-semantics regression here, and a bare predicate (no disjunction)
    // would silently drop every debit — turning a journal view into a
    // credits-only one with no error anywhere.
    await insertOrder("order_open", "OPEN");
    await credit({ orderId: "order_open", amountCents: 10_000 });
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_open:payee_1:refund_1",
      payeeId: PAYEE,
      amountCents: 2_500,
      currency: "usd",
      orderId: "order_open",
      description: "refund",
      sourceKind: "refund",
      sourceId: "refund_1",
    });

    const rows = await repo.listEntries(PAYEE, {
      excludeBlockedCredits: true,
      limit: 100,
    });

    // The debit survives (nothing blocks a debit); the blocked credit does
    // not. `availableAt` is NULL on the debit, which is exactly the
    // NULL-semantics case a text assertion would miss.
    expect(rows.map((r) => r.type)).toEqual(["REFUND_DEBIT"]);
    expect(rows[0]!.amountCents).toBe(2_500);
  });

  test("with NO attribution option, listEntries is the journal read it always was", async () => {
    // The legacy Prisma findMany path: every type, including the ones the
    // attribution filters would have dropped.
    await insertOrder("order_1");
    await credit({ orderId: "order_1", amountCents: 4_000, availableAt: IMMATURE });
    await repo.refundDebit({
      idempotencyKey: "refund-debit:order_1:payee_1:refund_1",
      payeeId: PAYEE,
      amountCents: 1_000,
      currency: "usd",
      orderId: "order_1",
      description: "refund",
      sourceKind: "refund",
      sourceId: "refund_1",
    });

    const rows = await repo.listEntries(PAYEE);
    expect(rows.map((r) => r.type).sort()).toEqual([
      "REFUND_DEBIT",
      "SETTLEMENT_CREDIT",
    ]);
  });

  // ── The export's snapshot walk: `atOrBefore` + `after` + `order` ───────────
  // Both read paths (findMany, and the raw scan any attribution option
  // selects) must answer the same (createdAt, id) bound the same way, on
  // real Postgres: the raw path is a row-value comparison with bound
  // parameters, which no text assertion can prove type-checks.

  test("atOrBefore (inclusive), after (exclusive) and order 'asc' bound and sort by (createdAt, id), on BOTH paths", async () => {
    const T1 = new Date("2026-06-01T00:00:00.000Z");
    const T2 = new Date("2026-06-02T00:00:00.000Z");
    const T3 = new Date("2026-06-03T00:00:00.000Z");
    // Two rows TIE on T2, so the id half of the cursor decides between them.
    for (const [id, at] of [
      ["e_a", T1],
      ["e_b", T2],
      ["e_c", T2],
      ["e_d", T3],
    ] as const) {
      await pool!.query(
        `INSERT INTO "PayeeLedgerEntry"
           ("id","idempotencyKey","payeeId","type","amountCents","currency","sourceKind","sourceId","description","createdAt")
         VALUES ($1, $2, $3, 'REFUND_DEBIT', 100, 'usd', 'refund', $1, 'refund', $4::timestamp)`,
        // UTC wall-clock TEXT, not a Date: node-postgres serialises a Date
        // in the machine's zone, and a zone-less TIMESTAMP(3) column keeps
        // that local wall time — rows would land hours off the cursor.
        [id, `key_${id}`, PAYEE, at.toISOString()],
      );
    }
    const cursor = { createdAt: T2, id: "e_b" };

    // Default order is unchanged: newest first.
    expect((await repo.listEntries(PAYEE)).map((r) => r.id)).toEqual([
      "e_d",
      "e_c",
      "e_b",
      "e_a",
    ]);

    for (const extra of [{}, { unconsumedOnly: true }]) {
      const path = "unconsumedOnly" in extra ? "raw scan" : "findMany";
      const asc = await repo.listEntries(PAYEE, {
        ...extra,
        atOrBefore: cursor,
        order: "asc",
        limit: 100,
      });
      // e_c ties on createdAt but sorts after the cursor id; e_d is later.
      expect(asc.map((r) => r.id), path).toEqual(["e_a", "e_b"]);

      const desc = await repo.listEntries(PAYEE, {
        ...extra,
        atOrBefore: cursor,
        limit: 100,
      });
      expect(desc.map((r) => r.id), path).toEqual(["e_b", "e_a"]);

      const ascAll = await repo.listEntries(PAYEE, {
        ...extra,
        order: "asc",
        limit: 2,
        offset: 2,
      });
      expect(ascAll.map((r) => r.id), path).toEqual(["e_c", "e_d"]);

      // Keyset `after`, EXCLUSIVE: the tie on T2 is split by id.
      const afterB = await repo.listEntries(PAYEE, {
        ...extra,
        after: cursor,
        order: "asc",
        limit: 100,
      });
      expect(afterB.map((r) => r.id), path).toEqual(["e_c", "e_d"]);

      // Both bounds at once: the export's page window.
      const window = await repo.listEntries(PAYEE, {
        ...extra,
        after: { createdAt: T1, id: "e_a" },
        atOrBefore: { createdAt: T2, id: "e_c" },
        order: "asc",
        limit: 100,
      });
      expect(window.map((r) => r.id), path).toEqual(["e_b", "e_c"]);
    }
  });

  // ── Forecast ↔ batch invariant ─────────────────────────────────────────────
  //
  // The only netting a consumer may apply to `creditCents` is the DEBT WALK:
  // consume max(0, −payable(today)) against each tranche's gross, soonest
  // first. A hold is NOT subtracted again — it is already inside today's
  // payable (the rollup is bumped at write time and the payable subtracts it
  // unconditionally), so it arrives here as debt. `heldCents` is an
  // ANNOTATION of that fact, attributed once per (payee, currency, order).
  //
  // The check: the CUMULATIVE expected up to each maturity must equal what
  // the batch would actually have moved by then —
  //   max(0, payable(maturesAt)) − max(0, payable(today)).
  // (For a single tranche this is the plain `payable(maturesAt) −
  // max(0, payable(today))`; the max(0, ·) on the left is what makes it hold
  // for a cell whose earlier tranche is swallowed whole by debt.)

  async function cellPayable(payeeId: string, asOf: Date) {
    return (await payableFor(payeeId, "usd", asOf)) ?? 0;
  }

  async function expectForecastToMatchBatch(payeeId: string) {
    const rows = await upcomingFor(payeeId);
    const today = await cellPayable(payeeId, AS_OF);
    let remaining = Math.max(0, -today);
    let cumulative = 0;
    const walked: Array<{ maturesAt: Date; expectedCents: number }> = [];
    for (const row of rows) {
      const applied = Math.min(remaining, row.creditCents);
      remaining -= applied;
      const expectedCents = row.creditCents - applied;
      cumulative += expectedCents;
      walked.push({ maturesAt: row.maturesAt, expectedCents });
      const atMaturity = await cellPayable(payeeId, row.maturesAt);
      expect(
        { maturesAt: row.maturesAt, cumulativeExpected: cumulative },
      ).toEqual({
        maturesAt: row.maturesAt,
        cumulativeExpected: Math.max(0, atMaturity) - Math.max(0, today),
      });
    }
    return { rows, walked };
  }

  const heldSum = (rows: Array<{ heldCents: number }>) =>
    rows.reduce((acc, r) => acc + r.heldCents, 0);

  test("INVARIANT (A) partial hold: the debt walk alone reproduces the batch; subtracting the hold again would understate by its amount", async () => {
    await insertOrder("order_a", "OPEN");
    await credit({ orderId: "order_a", amountCents: 7_000, availableAt: IMMATURE });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_a:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 3_000,
      currency: "usd",
      disputeId: "dispute_a",
      orderId: "order_a",
    });

    // Today the hold shows up as a −3_000 debt position...
    expect(await cellPayable(PAYEE, AS_OF)).toBe(-3_000);
    // ...and on the night the batch pays 4_000: the walk gives 7_000 − 3_000.
    const { rows, walked } = await expectForecastToMatchBatch(PAYEE);
    expect(walked).toEqual([{ maturesAt: IMMATURE, expectedCents: 4_000 }]);
    // The old "credit − held − debt" would have said 1_000.
    // The annotation says what is under dispute, as written, once.
    expect(heldSum(rows)).toBe(3_000);
  });

  test("INVARIANT (B) positive balance elsewhere: a fully-held immature credit still pays in full on the night", async () => {
    await insertOrder("order_m");
    await insertOrder("order_h", "OPEN");
    await credit({ orderId: "order_m", amountCents: 10_000 });
    await credit({ orderId: "order_h", amountCents: 7_000, availableAt: IMMATURE });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_h:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 7_000,
      currency: "usd",
      disputeId: "dispute_h",
      orderId: "order_h",
    });

    // Tonight pays 3_000 (10_000 matured − 7_000 hold)...
    expect(await cellPayable(PAYEE, AS_OF)).toBe(3_000);
    // ...and the immature 7_000 goes out WHOLE on its date: no debt today,
    // and the hold is already inside tonight's 3_000. Not 0.
    const { rows, walked } = await expectForecastToMatchBatch(PAYEE);
    expect(walked).toEqual([{ maturesAt: IMMATURE, expectedCents: 7_000 }]);
    expect(heldSum(rows)).toBe(7_000);
  });

  test("INVARIANT (C) one order, two maturity dates, one hold: the walk carries the debt to the second date and the hold is annotated ONCE", async () => {
    const LATER = new Date("2026-08-01T00:00:00.000Z");
    await insertOrder("order_c", "OPEN");
    await credit({ orderId: "order_c", amountCents: 4_000, availableAt: IMMATURE });
    await credit({ orderId: "order_c", amountCents: 3_000, availableAt: LATER });
    await repo.hold({
      idempotencyKey: "dispute-hold:dispute_c:payee_1:usd",
      payeeId: PAYEE,
      amountCents: 5_000,
      currency: "usd",
      disputeId: "dispute_c",
      orderId: "order_c",
    });

    expect(await cellPayable(PAYEE, AS_OF)).toBe(-5_000);
    // 5_000 of debt eats the 4_000 tranche whole and 1_000 of the next:
    // 0 on Jul 1, 2_000 on Aug 1 — exactly what the batch moves.
    const { rows, walked } = await expectForecastToMatchBatch(PAYEE);
    expect(walked).toEqual([
      { maturesAt: IMMATURE, expectedCents: 0 },
      { maturesAt: LATER, expectedCents: 2_000 },
    ]);
    // ONE hold, ONE attribution — on the earliest tranche, as written (not
    // clamped to that tranche's 4_000, and not repeated on Aug 1).
    expect(rows.map((r) => r.heldCents)).toEqual([5_000, 0]);
    expect(heldSum(rows)).toBe(5_000);
  });

  // ── The DB-enforced maturity invariant ────────────────────────────────────

  test("the CHECK refuses a SETTLEMENT_CREDIT with NULL availableAt (raw insert, bypassing the adapter)", async () => {
    await expect(
      pool!.query(
        `INSERT INTO "PayeeLedgerEntry"
           ("id","idempotencyKey","payeeId","type","amountCents","currency","sourceKind","sourceId","description")
         VALUES ('bad','bad-key','payee_x','SETTLEMENT_CREDIT',100,'usd','order_split','o','no maturity')`,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "PayeeLedgerEntry_settlement_credit_available_check",
    });

    // Non-credit types are exempt — debits never carry maturity.
    await pool!.query(
      `INSERT INTO "PayeeLedgerEntry"
         ("id","idempotencyKey","payeeId","type","amountCents","currency","sourceKind","sourceId","description")
       VALUES ('ok','ok-key','payee_x','REFUND_DEBIT',100,'usd','refund','r','fine')`,
    );
  });
});
