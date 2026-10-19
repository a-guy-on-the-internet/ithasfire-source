import { describe, expect, it, vi } from "vitest";

import { buildPayoutHistorySql, makePayoutItemsRepo } from "../payout-items";
import type { PrismaClientOrTx } from "../types";

function makePrisma(overrides: {
  payoutItemFindMany?: ReturnType<typeof vi.fn>;
  payoutItemFindUnique?: ReturnType<typeof vi.fn>;
  payoutItemCreate?: ReturnType<typeof vi.fn>;
  payoutItemUpdate?: ReturnType<typeof vi.fn>;
  payoutItemGroupBy?: ReturnType<typeof vi.fn>;
  payeeLedgerEntryFindMany?: ReturnType<typeof vi.fn>;
  orderFindMany?: ReturnType<typeof vi.fn>;
  orderItemFindMany?: ReturnType<typeof vi.fn>;
  /**
   * The junction writer. Post-cutover NOTHING may call it — payout items link
   * no settlements (spec 2026-08-10 §7) — so it is kept here purely so the
   * tests can assert it stays untouched.
   */
  payoutItemSettlementCreateMany?: ReturnType<typeof vi.fn>;
}) {
  return {
    payoutItem: {
      findMany: overrides.payoutItemFindMany ?? vi.fn(async () => []),
      findUnique: overrides.payoutItemFindUnique ?? vi.fn(async () => null),
      create: overrides.payoutItemCreate ?? vi.fn(async () => ({})),
      update: overrides.payoutItemUpdate ?? vi.fn(async () => ({})),
      groupBy: overrides.payoutItemGroupBy ?? vi.fn(async () => []),
    },
    payoutItemSettlement: {
      createMany:
        overrides.payoutItemSettlementCreateMany ?? vi.fn(async () => ({})),
    },
    payeeLedgerEntry: {
      findMany: overrides.payeeLedgerEntryFindMany ?? vi.fn(async () => []),
    },
    order: {
      findMany: overrides.orderFindMany ?? vi.fn(async () => []),
    },
    orderItem: {
      findMany: overrides.orderItemFindMany ?? vi.fn(async () => []),
    },
  } as unknown as PrismaClientOrTx;
}

const NOW = new Date("2026-03-05T06:00:00Z");

const ROW = {
  id: "pi-1",
  payoutId: "payout-1",
  payeeId: "payee-1",
  currency: "usd",
  amountCents: 5000,
  connectAccountFeeCents: 200,
  recoveredDebtCents: 0,
  reserveHeldCents: 0,
  reserveReleasedCents: 0,
  stripeTransferId: null,
  status: "pending",
  failedAt: null,
  failureReason: null,
  transferredAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("makePayoutItemsRepo", () => {
  it("persists the withholding columns and writes NO settlement linkage", async () => {
    const create = vi.fn(async () => ({ ...ROW, reserveHeldCents: 300 }));
    const junctionCreateMany = vi.fn(async () => ({}));
    const repo = makePayoutItemsRepo(
      makePrisma({
        payoutItemCreate: create,
        payoutItemSettlementCreateMany: junctionCreateMany,
      }),
    );

    const record = await repo.create({
      payoutId: "payout-1",
      payeeId: "payee-1",
      currency: "usd",
      amountCents: 5000,
      connectAccountFeeCents: 200,
      reserveHeldCents: 300,
      reserveReleasedCents: 150,
      plannedCreditEntryIds: ["credit-1", "credit-2"],
      plannedOrderItemIds: ["oi-1"],
      plannedNetCents: 4650,
      payoutLedgerKey: "payout:deadbeef",
    });

    // `recoveredDebtCents` is NOT written: debt is a negative payable, not a
    // withholding (spec 2026-08-10 §2), so the column keeps its DB default.
    expect(create).toHaveBeenCalledWith({
      data: {
        payoutId: "payout-1",
        payeeId: "payee-1",
        currency: "usd",
        // GROSS — the PAYABLE CLAIMED; deductions live in their own columns.
        amountCents: 5000,
        connectAccountFeeCents: 200,
        reserveHeldCents: 300,
        reserveReleasedCents: 150,
        // THE DURABLE PLAN — frozen before a cent moves, because every input
        // to it drifts the moment a transfer lands.
        plannedCreditEntryIds: ["credit-1", "credit-2"],
        plannedOrderItemIds: ["oi-1"],
        plannedNetCents: 4650,
        payoutLedgerKey: "payout:deadbeef",
      },
    });
    // The frozen junction table is never written again.
    expect(junctionCreateMany).not.toHaveBeenCalled();
    expect(record.amountCents).toBe(5000);
    expect(record.connectAccountFeeCents).toBe(200);
    expect(record.transferredAt).toBeNull();
  });

  it("defaults omitted withholdings to 0 and never touches the junction in createMany", async () => {
    const create = vi.fn(async () => ({ ...ROW, connectAccountFeeCents: 0 }));
    const junctionCreateMany = vi.fn(async () => ({}));
    const repo = makePayoutItemsRepo(
      makePrisma({
        payoutItemCreate: create,
        payoutItemSettlementCreateMany: junctionCreateMany,
      }),
    );

    await repo.createMany([
      {
        payoutId: "payout-1",
        payeeId: "payee-1",
        currency: "usd",
        amountCents: 5000,
      },
    ]);

    expect(create).toHaveBeenCalledWith({
      data: {
        payoutId: "payout-1",
        payeeId: "payee-1",
        currency: "usd",
        amountCents: 5000,
        connectAccountFeeCents: 0,
        reserveHeldCents: 0,
        reserveReleasedCents: 0,
        plannedCreditEntryIds: [],
        plannedOrderItemIds: [],
        plannedNetCents: 0,
        payoutLedgerKey: null,
      },
    });
    expect(junctionCreateMany).not.toHaveBeenCalled();
  });

  it("stamps transferredAt (and the transfer id) on markTransferred", async () => {
    const update = vi.fn(async () => ({}));
    const repo = makePayoutItemsRepo(makePrisma({ payoutItemUpdate: update }));

    await repo.markTransferred("pi-1", "tr_1", NOW);

    // `transferredAt` is the month-attribution timestamp for Stripe's
    // active-account fee: the fee is billed for the month the payout LANDS.
    expect(update).toHaveBeenCalledWith({
      where: { id: "pi-1" },
      data: { stripeTransferId: "tr_1", status: "transferred", transferredAt: NOW },
    });
  });

  it("accepts a null transfer id for the zero-net (fully withheld) path", async () => {
    const update = vi.fn(async () => ({}));
    const repo = makePayoutItemsRepo(makePrisma({ payoutItemUpdate: update }));

    await repo.markTransferred("pi-1", null, NOW);

    expect(update).toHaveBeenCalledWith({
      where: { id: "pi-1" },
      data: { stripeTransferId: null, status: "transferred", transferredAt: NOW },
    });
  });

  it("keys the period lookup on transferredAt with a createdAt fallback for legacy rows", async () => {
    const findMany = vi.fn(async () => [
      { payeeId: "payee-1" },
      { payeeId: "payee-3" },
    ]);
    const repo = makePayoutItemsRepo(
      makePrisma({ payoutItemFindMany: findMany }),
    );

    const from = new Date("2026-03-01T00:00:00.000Z");
    const to = new Date("2026-03-05T06:00:00.000Z");
    const result = await repo.payeeIdsWithTransferredPayoutInPeriod({
      payeeIds: ["payee-1", "payee-2", "payee-3"],
      from,
      to,
    });

    // `status: "transferred"` is load-bearing: a pending or failed item moved
    // no money, so Stripe never billed the active-account fee for it and it
    // must not suppress a later deduction. `stripeTransferId: { not: null }`
    // excludes zero-net (fully withheld) items for the same reason — they
    // completed without a Stripe payout, so the account never went active.
    // The window keys on transferredAt (when the payout LANDED — what Stripe
    // bills against), falling back to createdAt only for rows predating the
    // column.
    expect(findMany).toHaveBeenCalledWith({
      where: {
        payeeId: { in: ["payee-1", "payee-2", "payee-3"] },
        status: "transferred",
        stripeTransferId: { not: null },
        OR: [
          { transferredAt: { gte: from, lte: to } },
          { transferredAt: null, createdAt: { gte: from, lte: to } },
        ],
      },
      select: { payeeId: true },
      distinct: ["payeeId"],
    });
    expect(result).toEqual(new Set(["payee-1", "payee-3"]));
  });

  it("short-circuits the period lookup when there are no payees", async () => {
    const findMany = vi.fn(async () => []);
    const repo = makePayoutItemsRepo(
      makePrisma({ payoutItemFindMany: findMany }),
    );

    expect(
      await repo.payeeIdsWithTransferredPayoutInPeriod({
        payeeIds: [],
        from: new Date(0),
        to: new Date(),
      }),
    ).toEqual(new Set());
    expect(findMany).not.toHaveBeenCalled();
  });

  it("lists transferred items with reserve activity (held OR released), bounded by payeeIds only", async () => {
    const rows = [
      {
        id: "pi-1",
        payoutId: "payout-1",
        payeeId: "payee-1",
        currency: "usd",
        reserveHeldCents: 500,
        reserveReleasedCents: 0,
      },
    ];
    const findMany = vi.fn(async () => rows);
    const repo = makePayoutItemsRepo(
      makePrisma({ payoutItemFindMany: findMany }),
    );

    const result = await repo.listTransferredWithReserveActivity({
      payeeIds: ["payee-1", "payee-2"],
    });

    // The reserve crash-sweep feed. Like the debt sweep: transferred rows
    // only, no time bound (a window would let an orphaned RESERVE_HOLD age
    // out — the payee's deferred money would silently never mature).
    expect(findMany).toHaveBeenCalledWith({
      where: {
        payeeId: { in: ["payee-1", "payee-2"] },
        status: "transferred",
        OR: [
          { reserveHeldCents: { gt: 0 } },
          { reserveReleasedCents: { gt: 0 } },
        ],
      },
      select: {
        id: true,
        payoutId: true,
        payeeId: true,
        currency: true,
        reserveHeldCents: true,
        reserveReleasedCents: true,
      },
      orderBy: { createdAt: "asc" },
    });
    expect(result).toEqual(rows);
  });

  it("short-circuits the reserve-activity listing when there are no payees", async () => {
    const findMany = vi.fn(async () => []);
    const repo = makePayoutItemsRepo(
      makePrisma({ payoutItemFindMany: findMany }),
    );

    expect(
      await repo.listTransferredWithReserveActivity({ payeeIds: [] }),
    ).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("earliest payout per payee reads BOTH eras and takes the earlier", async () => {
    // Pre-cutover items reach orders through the PayoutItemSettlement
    // junction; post-cutover items link no settlements at all and reach
    // orders through their durable plan. Reading only the junction — which
    // nothing writes any more — would make every post-cutover payee read as
    // "no history" forever and pin them at the seasoning curve's
    // maximum-risk bracket (1000 bps on every membership payout, never
    // graduating).
    const legacyRow = {
      payeeId: "payee-1",
      transferredAt: new Date("2026-02-01T00:00:00Z"),
      createdAt: new Date("2026-02-01T00:05:00Z"),
    };
    const plannedRows = [
      {
        // Same payee, EARLIER post-cutover payout → must win.
        payeeId: "payee-1",
        transferredAt: new Date("2026-01-10T00:00:00Z"),
        createdAt: new Date("2026-01-10T00:00:00Z"),
        plannedCreditEntryIds: ["credit-1"],
      },
      {
        // Post-cutover only — invisible to the junction query entirely.
        payeeId: "payee-2",
        transferredAt: null,
        createdAt: new Date("2026-01-15T00:00:00Z"),
        plannedCreditEntryIds: ["credit-2"],
      },
      {
        // Its credits trace to a TICKETING order → not this kind.
        payeeId: "payee-3",
        transferredAt: new Date("2026-01-01T00:00:00Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
        plannedCreditEntryIds: ["credit-3"],
      },
    ];
    let call = 0;
    const findMany = vi.fn(async () => {
      call++;
      return call === 1 ? [legacyRow] : plannedRows;
    });
    const ledgerFindMany = vi.fn(async () => [
      { id: "credit-1", orderId: "order-m1" },
      { id: "credit-2", orderId: "order-m2" },
      { id: "credit-3", orderId: "order-t1" },
    ]);
    // Only the membership orders come back from the kind filter.
    const orderFindMany = vi.fn(async () => [
      { id: "order-m1" },
      { id: "order-m2" },
    ]);
    const repo = makePayoutItemsRepo(
      makePrisma({
        payoutItemFindMany: findMany,
        payeeLedgerEntryFindMany: ledgerFindMany,
        orderFindMany,
      }),
    );

    const result = await repo.earliestTransferredPayoutAtByPayee({
      payeeIds: ["payee-1", "payee-2", "payee-3", "payee-4"],
      orderKind: "MEMBERSHIP",
    });

    // ERA 1 — the junction query, unchanged.
    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: {
        payeeId: { in: ["payee-1", "payee-2", "payee-3", "payee-4"] },
        status: "transferred",
        settlements: {
          some: {
            settlement: {
              lines: { some: { order: { kind: "MEMBERSHIP" } } },
            },
          },
        },
      },
      select: { payeeId: true, transferredAt: true, createdAt: true },
    });
    // ERA 2 — the durable plan.
    expect(findMany).toHaveBeenNthCalledWith(2, {
      where: {
        payeeId: { in: ["payee-1", "payee-2", "payee-3", "payee-4"] },
        status: "transferred",
        payoutLedgerKey: { not: null },
      },
      select: {
        payeeId: true,
        transferredAt: true,
        createdAt: true,
        plannedCreditEntryIds: true,
      },
    });
    expect(orderFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["order-m1", "order-m2", "order-t1"] }, kind: "MEMBERSHIP" },
      select: { id: true },
    });

    // payee-1: the post-cutover payout is EARLIER than the legacy one.
    expect(result.get("payee-1")).toEqual(new Date("2026-01-10T00:00:00Z"));
    // payee-2: post-cutover only, transferredAt null → createdAt fallback.
    expect(result.get("payee-2")).toEqual(new Date("2026-01-15T00:00:00Z"));
    // payee-3: ticketing-only credits → not membership history.
    expect(result.has("payee-3")).toBe(false);
    // payee-4: nothing at all.
    expect(result.has("payee-4")).toBe(false);
  });

  it("lists transferred items needing a ledger heal — planned rows only, no time bound, anti-joined against written PAYOUT entries", async () => {
    const rows = [
      {
        id: "pi-1",
        payoutId: "payout-1",
        payeeId: "payee-1",
        currency: "usd",
        amountCents: 10_000,
        plannedCreditEntryIds: ["credit-1"],
        plannedOrderItemIds: ["oi-1"],
        plannedNetCents: 9_800,
        payoutLedgerKey: "payout:abc",
        stripeTransferId: "tr_1",
      },
    ];
    const findMany = vi.fn(async () => rows);
    const ledgerFindMany = vi.fn(async () => []);
    const repo = makePayoutItemsRepo(
      makePrisma({
        payoutItemFindMany: findMany,
        payeeLedgerEntryFindMany: ledgerFindMany,
      }),
    );

    const result = await repo.listTransferredNeedingLedgerHeal({
      payeeIds: ["payee-1"],
    });

    // `payoutLedgerKey: { not: null }` selects post-cutover rows (pre-cutover
    // items carry no plan and have nothing to replay). No time bound: an
    // orphan that ages out is a payable that pays the same money twice.
    expect(findMany).toHaveBeenCalledWith({
      where: {
        payeeId: { in: ["payee-1"] },
        status: "transferred",
        payoutLedgerKey: { not: null },
      },
      select: {
        id: true,
        payoutId: true,
        payeeId: true,
        currency: true,
        amountCents: true,
        plannedCreditEntryIds: true,
        plannedOrderItemIds: true,
        plannedNetCents: true,
        payoutLedgerKey: true,
        stripeTransferId: true,
      },
      orderBy: { createdAt: "asc" },
    });
    // The anti-join probe: which of these keys already have their PAYOUT
    // entry written? (`PayeeLedgerEntry.idempotencyKey` is unique and IS the
    // item's payoutLedgerKey.)
    expect(ledgerFindMany).toHaveBeenCalledWith({
      where: { idempotencyKey: { in: ["payout:abc"] } },
      select: { idempotencyKey: true },
    });
    expect(result).toEqual(rows);
  });

  it("the heal feed EXCLUDES items whose PAYOUT entry already exists — history must not replay nightly", async () => {
    const healed = {
      id: "pi-healed",
      payoutId: "payout-1",
      payeeId: "payee-1",
      currency: "usd",
      amountCents: 5_000,
      plannedCreditEntryIds: ["credit-1"],
      plannedOrderItemIds: ["oi-1"],
      plannedNetCents: 5_000,
      payoutLedgerKey: "payout:healed",
      stripeTransferId: "tr_1",
    };
    const unhealed = {
      id: "pi-unhealed",
      payoutId: "payout-2",
      payeeId: "payee-1",
      currency: "usd",
      amountCents: 7_000,
      plannedCreditEntryIds: ["credit-2"],
      plannedOrderItemIds: ["oi-2"],
      plannedNetCents: 7_000,
      payoutLedgerKey: "payout:unhealed",
      stripeTransferId: "tr_2",
    };
    const findMany = vi.fn(async () => [healed, unhealed]);
    // The healed item's PAYOUT debit is on the ledger; the unhealed one's is
    // missing — the crash the sweep exists for.
    const ledgerFindMany = vi.fn(async () => [
      { idempotencyKey: "payout:healed" },
    ]);
    const repo = makePayoutItemsRepo(
      makePrisma({
        payoutItemFindMany: findMany,
        payeeLedgerEntryFindMany: ledgerFindMany,
      }),
    );

    const result = await repo.listTransferredNeedingLedgerHeal({
      payeeIds: ["payee-1"],
    });

    expect(result).toEqual([unhealed]);
  });

  it("the heal feed KEEPS a debit-present item whose planned order items lost their paidOutAt stamp", async () => {
    const stampsLost = {
      id: "pi-stamps-lost",
      payoutId: "payout-1",
      payeeId: "payee-1",
      currency: "usd",
      amountCents: 5_000,
      plannedCreditEntryIds: ["credit-1"],
      plannedOrderItemIds: ["oi-1", "oi-2"],
      plannedNetCents: 5_000,
      payoutLedgerKey: "payout:stamps-lost",
      stripeTransferId: "tr_1",
    };
    const fullyStamped = {
      id: "pi-squared",
      payoutId: "payout-2",
      payeeId: "payee-1",
      currency: "usd",
      amountCents: 7_000,
      plannedCreditEntryIds: ["credit-2"],
      plannedOrderItemIds: ["oi-3"],
      plannedNetCents: 7_000,
      payoutLedgerKey: "payout:squared",
      stripeTransferId: "tr_2",
    };
    const findMany = vi.fn(async () => [stampsLost, fullyStamped]);
    // BOTH debits landed…
    const ledgerFindMany = vi.fn(async () => [
      { idempotencyKey: "payout:stamps-lost" },
      { idempotencyKey: "payout:squared" },
    ]);
    // …but oi-2 was never stamped: a crash between the debit and the stamps.
    const orderItemFindMany = vi.fn(async () => [{ id: "oi-2" }]);
    const repo = makePayoutItemsRepo(
      makePrisma({
        payoutItemFindMany: findMany,
        payeeLedgerEntryFindMany: ledgerFindMany,
        orderItemFindMany,
      }),
    );

    const result = await repo.listTransferredNeedingLedgerHeal({
      payeeIds: ["payee-1"],
    });

    // The stamp probe queries ONLY debit-present items' planned order items,
    // filtered to the unstamped (`paidOutAt: null`) rows.
    expect(orderItemFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["oi-1", "oi-2", "oi-3"] }, paidOutAt: null },
      select: { id: true },
    });
    // The stamps-lost item is fed back for a replay (idempotent by the
    // markItemsPaidOut write-once guard); the fully-squared one is not.
    expect(result).toEqual([stampsLost]);
  });

  it("lists stale PENDING items with a plan older than the cutoff", async () => {
    const rows = [
      {
        id: "pi-stale",
        payeeId: "payee-1",
        currency: "usd",
        payoutLedgerKey: "payout:abc",
      },
    ];
    const findMany = vi.fn(async () => rows);
    const repo = makePayoutItemsRepo(
      makePrisma({ payoutItemFindMany: findMany }),
    );

    const cutoff = new Date("2026-03-04T06:00:00Z");
    const result = await repo.listPendingWithPlanOlderThan(cutoff);

    // `status: "pending"` + a plan + older than the caller's cutoff: the shape of a
    // run that died between the claim commit and markTransferred. No payee
    // bound on purpose — the crashed item's payee may have no live payable.
    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: "pending",
        payoutLedgerKey: { not: null },
        createdAt: { lt: cutoff },
      },
      select: {
        id: true,
        payeeId: true,
        currency: true,
        payoutLedgerKey: true,
      },
      orderBy: { createdAt: "asc" },
    });
    expect(result).toEqual(rows);
  });

  it("skips the anti-join probe entirely when no transferred rows match", async () => {
    const findMany = vi.fn(async () => []);
    const ledgerFindMany = vi.fn(async () => []);
    const repo = makePayoutItemsRepo(
      makePrisma({
        payoutItemFindMany: findMany,
        payeeLedgerEntryFindMany: ledgerFindMany,
      }),
    );

    expect(
      await repo.listTransferredNeedingLedgerHeal({ payeeIds: ["payee-1"] }),
    ).toEqual([]);
    expect(ledgerFindMany).not.toHaveBeenCalled();
  });

  it("getById maps the row and returns null for a missing id", async () => {
    const findUnique = vi.fn(async ({ where }: any) =>
      where.id === "pi-1" ? { ...ROW } : null,
    );
    const repo = makePayoutItemsRepo(
      makePrisma({ payoutItemFindUnique: findUnique }),
    );

    const record = await repo.getById("pi-1");
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "pi-1" } });
    expect(record).toMatchObject({
      id: "pi-1",
      payeeId: "payee-1",
      amountCents: 5000,
      status: "pending",
    });

    expect(await repo.getById("pi-missing")).toBeNull();
  });

  it("short-circuits the ledger-heal listing when there are no payees", async () => {
    const findMany = vi.fn(async () => []);
    const repo = makePayoutItemsRepo(
      makePrisma({ payoutItemFindMany: findMany }),
    );

    expect(
      await repo.listTransferredNeedingLedgerHeal({ payeeIds: [] }),
    ).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("resolves ledger-era transfers by planned order-item overlap — transferred, transfer-bearing rows only", async () => {
    const rows = [
      {
        id: "pi-1",
        stripeTransferId: "tr_1",
        payeeId: "payee-1",
        currency: "usd",
        plannedOrderItemIds: ["oi-1", "oi-2"],
        amountCents: 10_000,
        plannedNetCents: 9_800,
      },
    ];
    const findMany = vi.fn(async () => rows);
    const repo = makePayoutItemsRepo(
      makePrisma({ payoutItemFindMany: findMany }),
    );

    const result = await repo.listTransferredByPlannedOrderItemIds([
      "oi-1",
      "oi-9",
    ]);

    // `hasSome` is the scalar-list overlap operator: any planned order item
    // matching makes the payout item a reversal candidate. Pending/failed
    // items moved no money and fully-withheld items (`stripeTransferId`
    // null) completed WITHOUT a Stripe transfer — in both cases there is
    // nothing on Stripe to reverse, hence the two filters.
    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: "transferred",
        stripeTransferId: { not: null },
        plannedOrderItemIds: { hasSome: ["oi-1", "oi-9"] },
      },
      select: {
        id: true,
        stripeTransferId: true,
        payeeId: true,
        currency: true,
        plannedOrderItemIds: true,
        amountCents: true,
        plannedNetCents: true,
      },
      orderBy: { createdAt: "asc" },
    });
    expect(result).toEqual([
      {
        payoutItemId: "pi-1",
        stripeTransferId: "tr_1",
        payeeId: "payee-1",
        currency: "usd",
        plannedOrderItemIds: ["oi-1", "oi-2"],
        amountCents: 10_000,
        // The exact cents handed to Stripe (post-withholding) — surfaced so
        // callers can SEE that a payee-share reversal may exceed what is
        // still reversible; they deliberately do not preclamp with it.
        netAmountCents: 9_800,
      },
    ]);
  });

  it("short-circuits the planned-order-item lookup when no order items are given", async () => {
    const findMany = vi.fn(async () => []);
    const repo = makePayoutItemsRepo(
      makePrisma({ payoutItemFindMany: findMany }),
    );

    expect(await repo.listTransferredByPlannedOrderItemIds([])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("short-circuits the earliest-payout lookup when there are no payees", async () => {
    const findMany = vi.fn(async () => []);
    const repo = makePayoutItemsRepo(
      makePrisma({ payoutItemFindMany: findMany }),
    );

    expect(
      await repo.earliestTransferredPayoutAtByPayee({
        payeeIds: [],
        orderKind: "TICKETING",
      }),
    ).toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("buildPayoutHistorySql — cursor binding", () => {
  // THE PROCESS-INDEPENDENT GATE for the keyset cursor.
  //
  // `occurredAt` is `COALESCE(transferredAt, scheduledFor)`, both
  // TIMESTAMP(3) WITHOUT time zone. Binding a JS `Date` is a silent
  // row-skipper: node-pg renders a Date in the NODE PROCESS's zone with an
  // explicit offset — measured, a UTC instant of 05:00 serialises as
  // "2026-09-07T22:00:00.000-07:00" under TZ=US/Pacific — and
  // `'...-07:00'::timestamp` DROPS the offset, landing on 22:00. The page
  // boundary moves hours earlier and every row in the gap is skipped; the
  // UI's dedupe hides the symmetric duplicate case, so "Load more" looks
  // like it works while adding nothing.
  //
  // An integration test cannot be the gate for this: on a UTC box the
  // offset is zero and the bug is invisible, so the assertion would pass
  // for the wrong reason in CI. Asserting the BOUND VALUE is deterministic
  // everywhere.
  const cursorFor = (occurredAt: string, id: string) =>
    Buffer.from(JSON.stringify({ occurredAt, id }), "utf8").toString(
      "base64url",
    );

  it("binds the cursor instant as an ISO STRING, never a Date", () => {
    const sql = buildPayoutHistorySql({
      status: "all",
      limit: 25,
      cursor: {
        occurredAt: "2026-09-08T05:00:00.000Z",
        id: "pi_1",
      },
    });

    expect(sql.values).toContain("2026-09-08T05:00:00.000Z");
    expect(sql.values.some((v) => v instanceof Date)).toBe(false);
  });

  it("casts through timestamptz AT TIME ZONE UTC, not a bare ::timestamp", () => {
    const sql = buildPayoutHistorySql({
      status: "all",
      limit: 25,
      cursor: { occurredAt: "2026-09-08T05:00:00.000Z", id: "pi_1" },
    });

    expect(sql.text).toContain("::timestamptz AT TIME ZONE 'UTC'");
  });

  it("emits no cursor predicate at all on page one", () => {
    const sql = buildPayoutHistorySql({
      status: "all",
      limit: 25,
      cursor: null,
    });
    expect(sql.text).not.toContain("timestamptz");
  });

  it("parameterises the status filter rather than interpolating it", () => {
    const sql = buildPayoutHistorySql({
      status: "failed",
      limit: 25,
      cursor: null,
    });
    expect(sql.values).toContain("failed");
    // A quoted literal, specifically: the bare word also appears in the
    // `pi."failedAt"` column name, so `not.toContain("failed")` would be a
    // false positive on an unrelated identifier.
    expect(sql.text).not.toContain("'failed'");
    expect(sql.text).toContain('pi."status" = $');
  });

  it("round-trips a cursor the adapter itself would have emitted", () => {
    const encoded = cursorFor("2026-09-08T05:00:00.000Z", "pi_1");
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as { occurredAt: string; id: string };
    const sql = buildPayoutHistorySql({
      status: "all",
      limit: 2,
      cursor: decoded,
    });
    expect(sql.values).toContain("2026-09-08T05:00:00.000Z");
    expect(sql.values).toContain("pi_1");
  });
});

describe("buildPayoutHistorySql — payee narrowing", () => {
  // The organiser-facing payouts view is THIS statement narrowed to one
  // payee, never a second query. These assertions are the process-independent
  // half of that guarantee: an integration test proves the rows, this proves
  // the bytes — in particular that the narrowing is BOUND, lands in the base
  // CTE (so the keyset cursor and COUNT(*) OVER () describe the filtered
  // set), and composes with `status` instead of clobbering it.

  it("emits no payee predicate at all when payeeIds is omitted — every payee", () => {
    const sql = buildPayoutHistorySql({ status: "all", limit: 25, cursor: null });

    // The bare column name appears twice in the statement regardless (the
    // base SELECT list and the Payee join), so the assertion has to name the
    // PREDICATE or it is a false positive on an identifier.
    expect(sql.text).not.toContain('pi."payeeId" = ANY');
    expect(sql.text).not.toContain("WHERE");
  });

  it("binds the payee ids as a text[] parameter, never interpolated", () => {
    const sql = buildPayoutHistorySql({
      status: "all",
      limit: 25,
      cursor: null,
      payeeIds: ["payee_1", "payee_2"],
    });

    expect(sql.text).toContain('WHERE pi."payeeId" = ANY($');
    expect(sql.text).toContain("::text[]");
    expect(sql.values).toContainEqual(["payee_1", "payee_2"]);
    // Not spliced into the statement text — the whole point of binding.
    expect(sql.text).not.toContain("payee_1");
  });

  it("an EXPLICIT empty array still emits the predicate — no payees, no rows", () => {
    // THE failure mode this test exists for: coalescing `[]` to "no filter"
    // would turn "this org has no payee yet" into "show them the entire
    // platform's payouts". The predicate must survive and bind the empty
    // array, which Postgres evaluates as false for every row.
    const sql = buildPayoutHistorySql({
      status: "all",
      limit: 25,
      cursor: null,
      payeeIds: [],
    });

    expect(sql.text).toContain('pi."payeeId" = ANY($');
    expect(sql.values).toContainEqual([]);
  });

  it("ANDs the payee filter with the status filter in ONE base WHERE", () => {
    const sql = buildPayoutHistorySql({
      status: "failed",
      limit: 25,
      cursor: null,
      payeeIds: ["payee_1"],
    });

    expect(sql.text).toContain(
      'WHERE pi."status" = $1 AND pi."payeeId" = ANY($2::text[])',
    );
    // Exactly one WHERE in the base CTE (the cursor adds its own in `page`,
    // and there is no cursor here) — a second `WHERE` keyword would be a
    // syntax error, and a dropped predicate the silent version of it.
    expect(sql.text.match(/WHERE/g)).toHaveLength(1);
    expect(sql.values.slice(0, 2)).toEqual(["failed", ["payee_1"]]);
  });

  it("keeps the filter in `base`, so the cursor pages the FILTERED set", () => {
    const sql = buildPayoutHistorySql({
      status: "all",
      limit: 2,
      cursor: { occurredAt: "2026-09-08T05:00:00.000Z", id: "pi_1" },
      payeeIds: ["payee_1"],
    });

    // The payee predicate must precede the cursor predicate: the first lives
    // in `base`, the second in `page` which selects FROM base. Reversed, the
    // page's COUNT(*) OVER () would count every payee's rows and the section
    // total would be the platform's, shown to one organiser.
    const payeeAt = sql.text.indexOf('pi."payeeId" = ANY');
    const cursorAt = sql.text.indexOf('b."occurredAt"');
    expect(payeeAt).toBeGreaterThan(-1);
    expect(cursorAt).toBeGreaterThan(payeeAt);
  });
});
