import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makePayoutItemsRepo } from "../../src/db/prisma/payout-items";

/**
 * Runtime proof for the ledger-era transfer-reversal lookup: the
 * `plannedOrderItemIds: { hasSome }` overlap query must actually work against
 * a REAL Postgres scalar-list column — a mocked Prisma client cannot verify
 * the operator semantics that the post-payout refund fix depends on.
 */
describe("Prisma adapters integration – payout-items planned-order-item lookup", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let payeeId: string;
  let payoutId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const payee = await prisma.payee.create({
        data: { subjectType: "ORGANIZATION", subjectId: "org-reversal-test" },
      });
      payeeId = payee.id;

      const payout = await prisma.payout.create({
        data: { scheduledFor: new Date("2026-08-15T00:00:00.000Z") },
      });
      payoutId = payout.id;

      // A transferred ledger-era item covering oi-1/oi-2…
      await prisma.payoutItem.create({
        data: {
          payoutId,
          payeeId,
          currency: "usd",
          amountCents: 10_000,
          plannedOrderItemIds: ["oi-1", "oi-2"],
          plannedNetCents: 9_800,
          payoutLedgerKey: "payout:test:covered",
          stripeTransferId: "tr_covered_1",
          status: "transferred",
          transferredAt: new Date("2026-08-15T01:00:00.000Z"),
        },
      });

      // …a transferred item for an UNRELATED order item…
      const otherPayout = await prisma.payout.create({
        data: { scheduledFor: new Date("2026-08-15T00:00:00.000Z") },
      });
      await prisma.payoutItem.create({
        data: {
          payoutId: otherPayout.id,
          payeeId,
          currency: "usd",
          amountCents: 4_000,
          plannedOrderItemIds: ["oi-unrelated"],
          plannedNetCents: 4_000,
          payoutLedgerKey: "payout:test:unrelated",
          stripeTransferId: "tr_unrelated_1",
          status: "transferred",
          transferredAt: new Date("2026-08-15T01:00:00.000Z"),
        },
      });

      // …a fully-withheld item (no Stripe transfer to reverse)…
      const withheldPayout = await prisma.payout.create({
        data: { scheduledFor: new Date("2026-08-15T00:00:00.000Z") },
      });
      await prisma.payoutItem.create({
        data: {
          payoutId: withheldPayout.id,
          payeeId,
          currency: "usd",
          amountCents: 2_000,
          plannedOrderItemIds: ["oi-1"],
          plannedNetCents: 0,
          payoutLedgerKey: "payout:test:withheld",
          stripeTransferId: null,
          status: "transferred",
          transferredAt: new Date("2026-08-15T01:00:00.000Z"),
        },
      });

      // …and a pending item whose transfer never executed.
      const pendingPayout = await prisma.payout.create({
        data: { scheduledFor: new Date("2026-08-16T00:00:00.000Z") },
      });
      await prisma.payoutItem.create({
        data: {
          payoutId: pendingPayout.id,
          payeeId,
          currency: "usd",
          amountCents: 3_000,
          plannedOrderItemIds: ["oi-2"],
          plannedNetCents: 3_000,
          payoutLedgerKey: "payout:test:pending",
          status: "pending",
        },
      });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error(
        "payout-items planned-order-item integration setup failed:",
        error,
      );
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("hasSome overlap returns only transferred, transfer-bearing items covering the requested order items", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makePayoutItemsRepo(prisma);

    const matches = await repo.listTransferredByPlannedOrderItemIds([
      "oi-1",
      "oi-3",
    ]);

    // Only the covered item: the unrelated item shares no order item, the
    // fully-withheld item has no transfer to reverse, and the pending item
    // moved no money.
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      stripeTransferId: "tr_covered_1",
      payeeId,
      plannedOrderItemIds: ["oi-1", "oi-2"],
      amountCents: 10_000,
      netAmountCents: 9_800,
    });
  });

  test("no overlap → empty result", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const repo = makePayoutItemsRepo(prisma);
    expect(
      await repo.listTransferredByPlannedOrderItemIds(["oi-nothing"]),
    ).toEqual([]);
  });
});
