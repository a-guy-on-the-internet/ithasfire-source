import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeOrdersRepo } from "../../src/db/prisma/orders";
import { makePayeeLedgerRepo } from "../../src/db/prisma/payee-ledger";

/**
 * Door orders on a cancelled event (code review 2026-10-07), on real
 * Postgres:
 *
 *  - `orders.markRefundedIfSucceeded` — the cash refund's claim: exactly one
 *    of two racing refunds wins;
 *  - `orders.listCancelledEventIdsWithOpenDoorOrders` — the door sweep's scan;
 *  - `payeeLedger.listUnreversedCashSaleDebitsOnCancelledEvents` — the
 *    verify-ledger invariant: a CASH_SALE_DEBIT on a CANCELLED event with no
 *    reversal, past the grace cutoff.
 *
 * Full schema (`prisma migrate deploy`), so the relation filter and the raw
 * SQL run against the shipped tables and enums.
 */
describe("Prisma adapters integration – door orders on cancelled events", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const CUTOFF = new Date("2026-10-07T12:00:00.000Z");
  const BEFORE = new Date("2026-10-07T11:00:00.000Z");
  const AFTER = new Date("2026-10-07T12:20:00.000Z");

  let buyerId: string;
  let orgId: string;
  let payeeId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const buyer = await prisma.human.create({
        data: { name: "Walk-up", status: "ACTIVE" },
      });
      buyerId = buyer.id;
      const org = await prisma.organization.create({
        data: { name: "Door Collective", slug: "door-collective" },
      });
      orgId = org.id;
      const payee = await prisma.payee.create({
        data: { subjectType: "ORGANIZATION", subjectId: orgId },
      });
      payeeId = payee.id;
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
    await prisma.payeeLedgerEntry.deleteMany();
    await prisma.payeeLedgerBalance.deleteMany();
    await prisma.order.deleteMany();
    await prisma.event.deleteMany();
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

  async function makeEvent(
    status: "PUBLISHED" | "CANCELLED" | "DRAFT",
    updatedAt?: Date,
  ) {
    const p = requireRuntime();
    const ev = await p.event.create({
      data: {
        title: `Show ${status}`,
        orgId,
        status,
        startsAt: new Date("2026-10-01T01:00:00.000Z"),
        endsAt: new Date("2026-10-01T04:00:00.000Z"),
        timezone: "America/Chicago",
      },
    });
    if (updatedAt) {
      // `updatedAt` is @updatedAt; set it the way a past cancellation left it.
      await p.$executeRaw`UPDATE public."Event" SET "updatedAt" = ${updatedAt} WHERE "id" = ${ev.id}`;
    }
    return ev.id;
  }

  async function makeOrder(
    eventId: string,
    paymentChannel: "CASH" | "POS" | "WEB",
    status: "SUCCEEDED" | "PENDING" | "REFUNDED" | "CANCELLED",
    opts: { occurredAt?: Date; stripePaymentIntentId?: string } = {},
  ) {
    const order = await requireRuntime().order.create({
      data: {
        eventId,
        buyerHumanId: buyerId,
        amountGrossCents: 5_000,
        currency: "usd",
        status,
        paymentChannel,
        feePolicySnapshot: {},
        ...(opts.occurredAt ? { occurredAt: opts.occurredAt } : {}),
        ...(opts.stripePaymentIntentId
          ? { stripePaymentIntentId: opts.stripePaymentIntentId }
          : {}),
      },
    });
    return order.id;
  }

  /** A paid door cash sale as the priced door writes it: order + debit. */
  async function pricedCashSale(eventId: string, opts: { occurredAt?: Date } = {}) {
    const id = await makeOrder(eventId, "CASH", "SUCCEEDED", opts);
    await debit(id);
    return id;
  }

  async function debit(orderId: string, amountCents = 872) {
    await makePayeeLedgerRepo(requireRuntime()).cashSaleDebit({
      idempotencyKey: `cash-sale-debit:${orderId}`,
      payeeId,
      amountCents,
      currency: "usd",
      orderId,
      description: "Cash sale fee + tax",
      sourceKind: "pos_cash_sale",
      sourceId: orderId,
    });
  }

  async function reverse(orderId: string) {
    await makePayeeLedgerRepo(requireRuntime()).cashSaleDebitReversal({
      idempotencyKey: `cash-sale-debit-reversal:${orderId}`,
      debitIdempotencyKey: `cash-sale-debit:${orderId}`,
      description: "Cash sale refunded",
      sourceKind: "pos_cash_refund",
      sourceId: orderId,
    });
  }

  // ── markRefundedIfSucceeded ────────────────────────────────────────────

  test("markRefundedIfSucceeded: SUCCEEDED → REFUNDED once; a second claim loses", async () => {
    const p = requireRuntime();
    const repo = makeOrdersRepo(p);
    const eventId = await makeEvent("PUBLISHED");
    const orderId = await makeOrder(eventId, "CASH", "SUCCEEDED");

    expect(await repo.markRefundedIfSucceeded(orderId)).toBe(true);
    expect(await repo.markRefundedIfSucceeded(orderId)).toBe(false);
    const row = await p.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(row.status).toBe("REFUNDED");
  });

  test("markRefundedIfSucceeded: two concurrent claims in separate transactions — exactly one wins", async () => {
    const p = requireRuntime();
    const eventId = await makeEvent("PUBLISHED");
    const orderId = await makeOrder(eventId, "CASH", "SUCCEEDED");

    const results = await Promise.all(
      [0, 1].map(() =>
        p.$transaction((tx) =>
          makeOrdersRepo(tx as unknown as PrismaClient).markRefundedIfSucceeded(
            orderId,
          ),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("markRefundedIfSucceeded: a PENDING, CANCELLED or unknown order is not claimed", async () => {
    const p = requireRuntime();
    const repo = makeOrdersRepo(p);
    const eventId = await makeEvent("PUBLISHED");
    const pending = await makeOrder(eventId, "CASH", "PENDING");
    const cancelled = await makeOrder(eventId, "CASH", "CANCELLED");

    expect(await repo.markRefundedIfSucceeded(pending)).toBe(false);
    expect(await repo.markRefundedIfSucceeded(cancelled)).toBe(false);
    expect(
      await repo.markRefundedIfSucceeded("00000000-0000-4000-8000-000000000000"),
    ).toBe(false);
    expect(
      (await p.order.findUniqueOrThrow({ where: { id: pending } })).status,
    ).toBe("PENDING");
  });

  // ── listCancelledEventIdsWithOpenDoorOrders ────────────────────────────

  test("the sweep's scan: a cancelled event with an unreversed-debit cash sale or a PENDING door card sale, once each", async () => {
    const repo = makeOrdersRepo(requireRuntime());
    const withCash = await makeEvent("CANCELLED");
    await pricedCashSale(withCash);
    await pricedCashSale(withCash);
    const withPos = await makeEvent("CANCELLED");
    await makeOrder(withPos, "POS", "PENDING");

    // Not the sweep's: settled door orders, online orders, live events.
    const settled = await makeEvent("CANCELLED");
    await makeOrder(settled, "CASH", "REFUNDED");
    await makeOrder(settled, "POS", "CANCELLED");
    await makeOrder(settled, "POS", "SUCCEEDED");
    await makeOrder(settled, "WEB", "PENDING");
    await makeOrder(settled, "WEB", "SUCCEEDED");
    // A reversed debit is settled too.
    const reversed = await pricedCashSale(settled);
    await reverse(reversed);
    const live = await makeEvent("PUBLISHED");
    await pricedCashSale(live);
    await makeOrder(live, "POS", "PENDING");

    const ids = await repo.listCancelledEventIdsWithOpenDoorOrders({ limit: 50 });
    expect(ids.sort()).toEqual([withCash, withPos].sort());
  });

  test("the sweep's scan NEVER lists an old cancellation: cash sales with no debit (before the door was priced) and comps", async () => {
    const repo = makeOrdersRepo(requireRuntime());
    const old = await makeEvent("CANCELLED");
    await makeOrder(old, "CASH", "SUCCEEDED");
    await makeOrder(old, "CASH", "SUCCEEDED");

    expect(await repo.listCancelledEventIdsWithOpenDoorOrders({ limit: 50 })).toEqual(
      [],
    );
  });

  test("the sweep's scan is oldest-first by the open order, and skips quarantined orders", async () => {
    const repo = makeOrdersRepo(requireRuntime());
    const newer = await makeEvent("CANCELLED");
    await pricedCashSale(newer, { occurredAt: new Date("2026-10-05T20:00:00Z") });
    const older = await makeEvent("CANCELLED");
    await pricedCashSale(older, { occurredAt: new Date("2026-10-01T20:00:00Z") });
    const stuckOnly = await makeEvent("CANCELLED");
    const stuck = await makeOrder(stuckOnly, "POS", "PENDING", {
      occurredAt: new Date("2026-09-01T20:00:00Z"),
    });

    expect(await repo.listCancelledEventIdsWithOpenDoorOrders({ limit: 50 })).toEqual(
      [stuckOnly, older, newer],
    );
    // The stuck sale quarantined: its event no longer holds the head slot.
    expect(
      await repo.listCancelledEventIdsWithOpenDoorOrders({
        limit: 1,
        excludeOrderIds: [stuck],
      }),
    ).toEqual([older]);
  });

  test("the sweep's scan honours its limit", async () => {
    const repo = makeOrdersRepo(requireRuntime());
    for (let i = 0; i < 3; i++) {
      const ev = await makeEvent("CANCELLED");
      await pricedCashSale(ev);
    }
    expect(
      await repo.listCancelledEventIdsWithOpenDoorOrders({ limit: 2 }),
    ).toHaveLength(2);
  });

  // ── listSucceededCashOrderIdsForEvent ──────────────────────────────────

  test("the cash candidates: SUCCEEDED CASH orders only, keyset-paged by id; the debit-only scope drops old sales and comps", async () => {
    const repo = makeOrdersRepo(requireRuntime());
    const ev = await makeEvent("CANCELLED");
    const priced = [await pricedCashSale(ev), await pricedCashSale(ev)];
    const oldStyle = await makeOrder(ev, "CASH", "SUCCEEDED");
    const reversed = await pricedCashSale(ev);
    await reverse(reversed);
    // Not cash, or not SUCCEEDED: never candidates.
    await makeOrder(ev, "WEB", "SUCCEEDED");
    await makeOrder(ev, "POS", "SUCCEEDED");
    await makeOrder(ev, "CASH", "REFUNDED");
    const other = await makeEvent("CANCELLED");
    await pricedCashSale(other);

    const all = [...priced, oldStyle, reversed].sort();
    // Paged two at a time, the way the phase reads them.
    const paged: string[] = [];
    let afterId: string | null = null;
    for (;;) {
      const page: string[] = await repo.listSucceededCashOrderIdsForEvent({
        eventId: ev,
        unreversedCashSaleDebitOnly: false,
        afterId,
        limit: 2,
      });
      paged.push(...page);
      if (page.length < 2) break;
      afterId = page[page.length - 1]!;
    }
    // Every candidate exactly once (the database's collation orders the
    // ids; compare as sets).
    expect(new Set(paged).size).toBe(paged.length);
    expect([...paged].sort()).toEqual(all);

    expect(
      (
        await repo.listSucceededCashOrderIdsForEvent({
          eventId: ev,
          unreversedCashSaleDebitOnly: true,
          limit: 50,
        })
      ).sort(),
    ).toEqual([...priced].sort());
  });

  // ── listOpenDoorCardSalesOnCancelledEvents ─────────────────────────────

  test("the door card invariant: a paid-unrefunded or PENDING door card sale on a cancelled event past the cutoff is flagged", async () => {
    const repo = makeOrdersRepo(requireRuntime());
    const cancelled = await makeEvent("CANCELLED", BEFORE);
    const paid = await makeOrder(cancelled, "POS", "SUCCEEDED", {
      stripePaymentIntentId: "pi_door_paid",
    });
    const pending = await makeOrder(cancelled, "POS", "PENDING", {
      stripePaymentIntentId: "pi_door_pending",
    });
    // Settled or not a door card sale: not flagged.
    await makeOrder(cancelled, "POS", "REFUNDED", { stripePaymentIntentId: "pi_r" });
    await makeOrder(cancelled, "POS", "CANCELLED", { stripePaymentIntentId: "pi_c" });
    await makeOrder(cancelled, "WEB", "SUCCEEDED", { stripePaymentIntentId: "pi_web" });
    await makeOrder(cancelled, "CASH", "SUCCEEDED");
    // A live event's card sale is just a sale.
    const live = await makeEvent("PUBLISHED", BEFORE);
    await makeOrder(live, "POS", "SUCCEEDED", { stripePaymentIntentId: "pi_live" });
    // Cancelled after the cutoff: not yet.
    const recent = await makeEvent("CANCELLED", AFTER);
    await makeOrder(recent, "POS", "SUCCEEDED", { stripePaymentIntentId: "pi_recent" });

    const scan = await repo.listOpenDoorCardSalesOnCancelledEvents(CUTOFF, 20);
    expect(scan.total).toBe(2);
    expect(scan.rows.map((r) => r.orderId).sort()).toEqual([paid, pending].sort());
    expect(scan.rows.find((r) => r.orderId === paid)).toEqual({
      orderId: paid,
      eventId: cancelled,
      status: "SUCCEEDED",
      paymentIntentId: "pi_door_paid",
      currency: "usd",
      amountGrossCents: 5_000,
    });

    const capped = await repo.listOpenDoorCardSalesOnCancelledEvents(CUTOFF, 1);
    expect(capped.total).toBe(2);
    expect(capped.rows).toHaveLength(1);
  });

  // ── listUnreversedCashSaleDebitsOnCancelledEvents ──────────────────────


  test("the invariant: an unreversed cash debit on a cancelled event past the cutoff is flagged, with its sample", async () => {
    const ledger = makePayeeLedgerRepo(requireRuntime());
    const cancelled = await makeEvent("CANCELLED", BEFORE);
    const flagged = await makeOrder(cancelled, "CASH", "SUCCEEDED");
    await debit(flagged, 872);
    // Reversed: settled, not flagged.
    const reversed = await makeOrder(cancelled, "CASH", "REFUNDED");
    await debit(reversed);
    await reverse(reversed);

    // A live event's cash debit is owed, not a violation.
    const live = await makeEvent("PUBLISHED", BEFORE);
    await debit(await makeOrder(live, "CASH", "SUCCEEDED"));

    const scan = await ledger.listUnreversedCashSaleDebitsOnCancelledEvents(
      CUTOFF,
      20,
    );
    expect(scan).toEqual({
      total: 1,
      rows: [
        {
          orderId: flagged,
          eventId: cancelled,
          payeeId,
          currency: "usd",
          cashSaleDebitCents: 872,
        },
      ],
    });
  });

  test("the invariant's grace: an event cancelled after the cutoff is not flagged yet", async () => {
    const ledger = makePayeeLedgerRepo(requireRuntime());
    const justCancelled = await makeEvent("CANCELLED", AFTER);
    await debit(await makeOrder(justCancelled, "CASH", "SUCCEEDED"));

    expect(
      await ledger.listUnreversedCashSaleDebitsOnCancelledEvents(CUTOFF, 20),
    ).toEqual({ total: 0, rows: [] });
  });

  test("the invariant's sample cap: total counts every violation, rows are capped", async () => {
    const ledger = makePayeeLedgerRepo(requireRuntime());
    const cancelled = await makeEvent("CANCELLED", BEFORE);
    for (let i = 0; i < 3; i++) {
      await debit(await makeOrder(cancelled, "CASH", "SUCCEEDED"));
    }

    const scan = await ledger.listUnreversedCashSaleDebitsOnCancelledEvents(
      CUTOFF,
      2,
    );
    expect(scan.total).toBe(3);
    expect(scan.rows).toHaveLength(2);
  });
});
