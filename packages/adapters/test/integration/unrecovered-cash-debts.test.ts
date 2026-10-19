import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import type { PayeeLedgerUnrecoveredCashDebt } from "@th/ports/repos/payee-ledger";

import { makePayeeLedgerRepo } from "../../src/db/prisma/payee-ledger";

/**
 * `payeeLedger.listUnrecoveredCashDebts` on real Postgres (door-sales spec
 * 2026-10-07, FR-013): door cash-sale debt that later credits have not
 * recovered, older than the cutoff. Recovery is FIFO over the cell's debits
 * (oldest paid first), reversals netted against the debit they reverse.
 *
 * Every scenario lives on its own payee, so one read sees them all and each
 * assertion is about one cell. Rows are written directly with back-dated
 * `createdAt` (the repo writers stamp `now()`); the amounts and links are the
 * ones the writers produce.
 */
describe("Prisma adapters integration – unrecovered cash-sale debt", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const NOW = new Date("2026-10-08T12:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;
  const CUTOFF = new Date(NOW.getTime() - 30 * DAY);
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

  let seq = 0;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (err) {
      runtimeError = err instanceof Error ? err : new Error(String(err));
    }
  }, 600_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pg?.stop();
  }, 120_000);

  beforeEach(async () => {
    if (!prisma) return;
    await prisma.payeeLedgerEntry.updateMany({ data: { relatedEntryId: null } });
    await prisma.payeeLedgerEntry.deleteMany();
    await prisma.payeeLedgerBalance.deleteMany();
    await prisma.payee.deleteMany();
    await prisma.organization.deleteMany();
  });

  function requireRuntime() {
    if (runtimeError) throw runtimeError;
    if (!prisma) throw new Error("prisma client not initialised");
    return prisma;
  }

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  async function makePayee(
    label: string,
    opts: { stripeAccountId?: string; payoutsEnabled?: boolean } = {},
  ) {
    const p = requireRuntime();
    const org = await p.organization.create({
      data: { name: `Org ${label}`, slug: `org-${label}` },
    });
    const payee = await p.payee.create({
      data: {
        subjectType: "ORGANIZATION",
        subjectId: org.id,
        stripeAccountId: opts.stripeAccountId ?? null,
        payoutsEnabled: opts.payoutsEnabled ?? false,
      },
    });
    return { payeeId: payee.id, orgId: org.id };
  }

  type EntryType =
    | "SETTLEMENT_CREDIT"
    | "CASH_SALE_DEBIT"
    | "CASH_SALE_DEBIT_REVERSAL"
    | "REFUND_DEBIT"
    | "TRANSFER_REVERSAL_CREDIT"
    | "DISPUTE_DEBIT"
    | "DISPUTE_RELEASE"
    | "PAYOUT";

  async function entry(
    payeeId: string,
    type: EntryType,
    amountCents: number,
    createdAt: Date,
    opts: { currency?: string; availableAt?: Date; relatedEntryId?: string } = {},
  ): Promise<string> {
    seq += 1;
    const row = await requireRuntime().payeeLedgerEntry.create({
      data: {
        idempotencyKey: `test:${type}:${seq}`,
        payeeId,
        type,
        amountCents,
        currency: opts.currency ?? "usd",
        sourceKind: "test",
        sourceId: `src-${seq}`,
        description: type,
        createdAt,
        availableAt:
          type === "SETTLEMENT_CREDIT" ? (opts.availableAt ?? createdAt) : null,
        relatedEntryId: opts.relatedEntryId ?? null,
      },
    });
    return row.id;
  }

  const cash = (payeeId: string, cents: number, at: Date, currency?: string) =>
    entry(payeeId, "CASH_SALE_DEBIT", cents, at, { currency });
  const credit = (
    payeeId: string,
    cents: number,
    at: Date,
    opts: { currency?: string; availableAt?: Date } = {},
  ) => entry(payeeId, "SETTLEMENT_CREDIT", cents, at, opts);

  async function readAll(limit = 200) {
    const repo = makePayeeLedgerRepo(requireRuntime());
    return repo.listUnrecoveredCashDebts({ now: NOW, olderThan: CUTOFF, limit });
  }

  function cellOf(
    items: PayeeLedgerUnrecoveredCashDebt[],
    payeeId: string,
    currency = "usd",
  ) {
    return items.find((i) => i.payeeId === payeeId && i.currency === currency);
  }

  test("a cash debit fully recovered by later credits is not listed", async () => {
    const before = await makePayee("before");
    await credit(before.payeeId, 800, daysAgo(45));
    await cash(before.payeeId, 500, daysAgo(40));

    const after = await makePayee("after");
    await cash(after.payeeId, 500, daysAgo(40));
    await credit(after.payeeId, 500, daysAgo(10));

    const { items, total } = await readAll();
    expect(cellOf(items, before.payeeId)).toBeUndefined();
    expect(cellOf(items, after.payeeId)).toBeUndefined();
    expect(total).toBe(0);
  });

  test("partially recovered: FIFO pays the oldest cash debit, the remainder of the next one is listed with ITS date", async () => {
    const { payeeId, orgId } = await makePayee("partial", {
      stripeAccountId: "acct_partial",
      payoutsEnabled: true,
    });
    await cash(payeeId, 300, daysAgo(50));
    await cash(payeeId, 400, daysAgo(40));
    await credit(payeeId, 500, daysAgo(20));
    // A recent cash sale: unrecovered, but not overdue.
    await cash(payeeId, 100, daysAgo(5));

    const { items } = await readAll();
    // D = 800 − 500 = 300: the newest debit (5d, 100) is all unpaid, the
    // 40-day one keeps 200 of its 400, the 50-day one is paid.
    expect(cellOf(items, payeeId)).toEqual({
      payeeId,
      subjectType: "ORGANIZATION",
      subjectId: orgId,
      orgName: "Org partial",
      orgSlug: "org-partial",
      currency: "usd",
      unrecoveredCashDebtCents: 300,
      overdueCashDebtCents: 200,
      oldestUnrecoveredAt: daysAgo(40),
      hasStripeAccount: true,
      payoutsEnabled: true,
      payableCents: -300,
    });
  });

  test("a reversed cash debit is not listed, and its reversal does not pay an older debit", async () => {
    const reversedOnly = await makePayee("reversed-only");
    const d = await cash(reversedOnly.payeeId, 500, daysAgo(40));
    await entry(reversedOnly.payeeId, "CASH_SALE_DEBIT_REVERSAL", 500, daysAgo(39), {
      relatedEntryId: d,
    });

    const netted = await makePayee("netted");
    await cash(netted.payeeId, 500, daysAgo(45));
    const refunded = await cash(netted.payeeId, 500, daysAgo(35));
    await entry(netted.payeeId, "CASH_SALE_DEBIT_REVERSAL", 500, daysAgo(34), {
      relatedEntryId: refunded,
    });

    const { items } = await readAll();
    expect(cellOf(items, reversedOnly.payeeId)).toBeUndefined();
    // Spent FIFO, the reversal would have paid the 45-day debit and left the
    // refunded 35-day one "owed". Netted, the 45-day sale is what is owed.
    expect(cellOf(items, netted.payeeId)).toMatchObject({
      unrecoveredCashDebtCents: 500,
      overdueCashDebtCents: 500,
      oldestUnrecoveredAt: daysAgo(45),
    });
  });

  test("a cash debit 29 days old is not overdue; 31 days old is", async () => {
    const young = await makePayee("young");
    await cash(young.payeeId, 700, daysAgo(29));
    const old = await makePayee("old");
    await cash(old.payeeId, 700, daysAgo(31));

    const { items } = await readAll();
    expect(cellOf(items, young.payeeId)).toBeUndefined();
    expect(cellOf(items, old.payeeId)).toMatchObject({
      overdueCashDebtCents: 700,
      oldestUnrecoveredAt: daysAgo(31),
    });
  });

  test("a cash-only payee (no Stripe account) is listed and flagged", async () => {
    const { payeeId } = await makePayee("cash-only");
    await cash(payeeId, 250, daysAgo(60));
    await cash(payeeId, 150, daysAgo(33));

    const { items } = await readAll();
    expect(cellOf(items, payeeId)).toMatchObject({
      unrecoveredCashDebtCents: 400,
      overdueCashDebtCents: 400,
      oldestUnrecoveredAt: daysAgo(60),
      hasStripeAccount: false,
      payoutsEnabled: false,
      payableCents: -400,
    });
  });

  test("currencies are separate cells: a CAD credit does not recover USD cash debt", async () => {
    const { payeeId } = await makePayee("multi");
    await cash(payeeId, 300, daysAgo(40), "usd");
    await cash(payeeId, 200, daysAgo(40), "cad");
    await credit(payeeId, 500, daysAgo(20), { currency: "cad" });
    const both = await makePayee("both");
    await cash(both.payeeId, 300, daysAgo(40), "usd");
    await cash(both.payeeId, 200, daysAgo(40), "cad");

    const { items } = await readAll();
    expect(cellOf(items, payeeId, "usd")).toMatchObject({ overdueCashDebtCents: 300 });
    expect(cellOf(items, payeeId, "cad")).toBeUndefined();
    expect(cellOf(items, both.payeeId, "usd")).toMatchObject({ overdueCashDebtCents: 300 });
    expect(cellOf(items, both.payeeId, "cad")).toMatchObject({ overdueCashDebtCents: 200 });
  });

  test("non-cash debt is not cash debt: a card-refund clawback or a newer refund debit never lists cash", async () => {
    // Negative balance with no cash debit at all.
    const refundOnly = await makePayee("refund-only");
    await entry(refundOnly.payeeId, "REFUND_DEBIT", 1_000, daysAgo(40));

    // Cash recovered, then a NEWER refund clawback is the whole deficit.
    const newerRefund = await makePayee("newer-refund");
    await cash(newerRefund.payeeId, 300, daysAgo(60));
    await credit(newerRefund.payeeId, 300, daysAgo(50));
    await entry(newerRefund.payeeId, "REFUND_DEBIT", 1_000, daysAgo(40));

    // The refund debit is OLDER: FIFO pays it first, the cash stays owed.
    const olderRefund = await makePayee("older-refund");
    await entry(olderRefund.payeeId, "REFUND_DEBIT", 1_000, daysAgo(60));
    await cash(olderRefund.payeeId, 300, daysAgo(40));
    await credit(olderRefund.payeeId, 1_000, daysAgo(20));

    const { items } = await readAll();
    expect(cellOf(items, refundOnly.payeeId)).toBeUndefined();
    expect(cellOf(items, newerRefund.payeeId)).toBeUndefined();
    expect(cellOf(items, olderRefund.payeeId)).toMatchObject({
      unrecoveredCashDebtCents: 300,
      overdueCashDebtCents: 300,
      payableCents: -300,
    });
  });

  test("a reversed clawback (transfer reversal) or a released dispute debit does not pay the cash debt", async () => {
    const transferBack = await makePayee("transfer-back");
    await cash(transferBack.payeeId, 300, daysAgo(40));
    const refund = await entry(transferBack.payeeId, "REFUND_DEBIT", 900, daysAgo(35));
    await entry(transferBack.payeeId, "TRANSFER_REVERSAL_CREDIT", 900, daysAgo(34), {
      relatedEntryId: refund,
    });

    const disputeWon = await makePayee("dispute-won");
    await cash(disputeWon.payeeId, 300, daysAgo(40));
    const dispute = await entry(disputeWon.payeeId, "DISPUTE_DEBIT", 900, daysAgo(35));
    await entry(disputeWon.payeeId, "DISPUTE_RELEASE", 900, daysAgo(34), {
      relatedEntryId: dispute,
    });

    const { items } = await readAll();
    expect(cellOf(items, transferBack.payeeId)).toMatchObject({ overdueCashDebtCents: 300 });
    expect(cellOf(items, disputeWon.payeeId)).toMatchObject({ overdueCashDebtCents: 300 });
  });

  test("an unmatured credit has recovered nothing yet; a payout is a debit in the FIFO walk", async () => {
    const unmatured = await makePayee("unmatured");
    await cash(unmatured.payeeId, 500, daysAgo(40));
    await credit(unmatured.payeeId, 500, daysAgo(35), {
      availableAt: new Date(NOW.getTime() + 5 * DAY),
    });

    // Paid out in full, then a cash sale: the cash is the deficit.
    const paidOut = await makePayee("paid-out", { stripeAccountId: "acct_paid" });
    await credit(paidOut.payeeId, 1_000, daysAgo(60));
    await entry(paidOut.payeeId, "PAYOUT", 1_000, daysAgo(55));
    await cash(paidOut.payeeId, 200, daysAgo(40));

    // Cash netted out of a payout (payout = credit − cash): recovered.
    const netted = await makePayee("netted-payout", { stripeAccountId: "acct_net" });
    await cash(netted.payeeId, 200, daysAgo(60));
    await credit(netted.payeeId, 1_000, daysAgo(55));
    await entry(netted.payeeId, "PAYOUT", 800, daysAgo(50));

    const { items } = await readAll();
    expect(cellOf(items, unmatured.payeeId)).toMatchObject({ overdueCashDebtCents: 500 });
    expect(cellOf(items, paidOut.payeeId)).toMatchObject({
      overdueCashDebtCents: 200,
      hasStripeAccount: true,
    });
    expect(cellOf(items, netted.payeeId)).toBeUndefined();
  });

  test("payableCents includes the rollup's pending holds; the cash debt does not", async () => {
    const { payeeId } = await makePayee("held");
    await cash(payeeId, 400, daysAgo(40));
    await requireRuntime().payeeLedgerBalance.create({
      data: { payeeId, currency: "usd", ledgerPendingHoldCents: 100 },
    });

    const { items } = await readAll();
    expect(cellOf(items, payeeId)).toMatchObject({
      unrecoveredCashDebtCents: 400,
      overdueCashDebtCents: 400,
      payableCents: -500,
    });
  });

  test("keyset pagination walks every cell once, largest overdue first, with the total on page one", async () => {
    const amounts = [900, 700, 700, 500, 300];
    for (const [i, cents] of amounts.entries()) {
      const { payeeId } = await makePayee(`page-${i}`);
      await cash(payeeId, cents, daysAgo(40 + i));
    }
    const repo = makePayeeLedgerRepo(requireRuntime());

    const seen: PayeeLedgerUnrecoveredCashDebt[] = [];
    let cursor: string | null = null;
    let firstTotal: number | null = null;
    let pages = 0;
    do {
      const page = await repo.listUnrecoveredCashDebts({
        now: NOW,
        olderThan: CUTOFF,
        limit: 2,
        cursor,
      });
      if (firstTotal === null) firstTotal = page.total;
      seen.push(...page.items);
      cursor = page.pageInfo.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(firstTotal).toBe(5);
    expect(pages).toBe(3);
    expect(seen.map((s) => s.overdueCashDebtCents)).toEqual([900, 700, 700, 500, 300]);
    expect(new Set(seen.map((s) => s.payeeId)).size).toBe(5);

    // A garbage cursor restarts from the top rather than throwing.
    const restarted = await repo.listUnrecoveredCashDebts({
      now: NOW,
      olderThan: CUTOFF,
      limit: 2,
      cursor: "not-a-cursor",
    });
    expect(restarted.items.map((s) => s.overdueCashDebtCents)).toEqual([900, 700]);
  });

  test("refuses a TransactionClient (its own budgeted transaction only)", async () => {
    const p = requireRuntime();
    await expect(
      p.$transaction((tx) =>
        makePayeeLedgerRepo(tx as unknown as PrismaClient).listUnrecoveredCashDebts({
          now: NOW,
          olderThan: CUTOFF,
        }),
      ),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
