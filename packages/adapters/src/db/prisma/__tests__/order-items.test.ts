import { describe, expect, it, vi } from "vitest";

import { makeOrderItemsRepo } from "../order-items";
import type { PrismaClientOrTx } from "../types";

function makePrisma(overrides: {
  orderItemUpdateMany?: ReturnType<typeof vi.fn>;
  orderItemUpdate?: ReturnType<typeof vi.fn>;
  orderItemFindMany?: ReturnType<typeof vi.fn>;
}) {
  return {
    orderItem: {
      updateMany: overrides.orderItemUpdateMany ?? vi.fn(async () => ({ count: 0 })),
      update: overrides.orderItemUpdate ?? vi.fn(async () => ({})),
      findMany: overrides.orderItemFindMany ?? vi.fn(async () => []),
    },
  } as unknown as PrismaClientOrTx;
}

const NOW = new Date("2026-03-05T06:00:00Z");

describe("makeOrderItemsRepo", () => {
  it("markItemsPaidOut stamps ONLY items not yet stamped — replays cannot restamp history", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const repo = makeOrderItemsRepo(
      makePrisma({ orderItemUpdateMany: updateMany }),
    );

    await repo.markItemsPaidOut(["oi-1", "oi-2"], NOW);

    // `paidOutAt: null` is load-bearing: the payout batch's ledger-heal sweep
    // may legitimately replay this write for a transferred item, and without
    // the guard every replay would restamp `paidOutAt` to the replay date —
    // corrupting the record of when the money actually moved.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["oi-1", "oi-2"] }, paidOutAt: null },
      data: { paidOutAt: NOW },
    });
  });

  // ── Money audit 2026-09-08 #19 ────────────────────────────────────────────
  // The flip to `transferred` is decided by a read and applied by this write,
  // with nothing holding the row in between under READ COMMITTED. The two
  // TRANSFER paths opt into a compare-and-swap; every REFUND caller keeps the
  // unconditional write, because by the time they reach here Stripe has
  // already moved the money and they must not be able to fail late.
  it("updateStatus with an expectedStatus is a CAS — updateMany carrying the status predicate", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const update = vi.fn(async () => ({}));
    const repo = makeOrderItemsRepo(
      makePrisma({ orderItemUpdateMany: updateMany, orderItemUpdate: update }),
    );

    const applied = await repo.updateStatus(
      "oi-1",
      "transferred",
      NOW,
      undefined,
      undefined,
      { expectedStatus: "active" },
    );

    expect(applied).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "oi-1", status: "active" },
      data: {
        status: "transferred",
        transferredAt: NOW,
        refundedTaxCents: null,
        refundedPlatformFeeCents: null,
      },
    });
    // `update` targets a unique row and cannot carry the predicate, so it must
    // not be the query that runs here.
    expect(update).not.toHaveBeenCalled();
  });

  it("updateStatus reports a lost CAS instead of overwriting the winner", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const repo = makeOrderItemsRepo(
      makePrisma({ orderItemUpdateMany: updateMany }),
    );

    const applied = await repo.updateStatus(
      "oi-1",
      "transferred",
      NOW,
      undefined,
      undefined,
      { expectedStatus: "active" },
    );

    expect(applied).toBe(false);
  });

  it("updateStatus WITHOUT an expectedStatus stays the unconditional update it has always been", async () => {
    const update = vi.fn(async () => ({}));
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const repo = makeOrderItemsRepo(
      makePrisma({ orderItemUpdate: update, orderItemUpdateMany: updateMany }),
    );

    const applied = await repo.updateStatus("oi-1", "refunded", NOW, 247, 500);

    // Byte-for-byte the pre-CAS query: same `update`, same `where`, same data.
    // A refund that has already paid the buyer back must never be turned into
    // a no-op by a predicate.
    expect(applied).toBe(true);
    expect(update).toHaveBeenCalledWith({
      where: { id: "oi-1" },
      data: {
        status: "refunded",
        refundedAt: NOW,
        refundedTaxCents: 247,
        refundedPlatformFeeCents: 500,
      },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("updateStatus records the tax portion of the refund it was given", async () => {
    const update = vi.fn(async () => ({}));
    const repo = makeOrderItemsRepo(makePrisma({ orderItemUpdate: update }));

    await repo.updateStatus("oi-1", "refunded", NOW, 247);

    expect(update).toHaveBeenCalledWith({
      where: { id: "oi-1" },
      data: {
        status: "refunded",
        refundedAt: NOW,
        refundedTaxCents: 247,
        refundedPlatformFeeCents: null,
      },
    });
  });

  it("updateStatus records the platform-fee portion of the refund alongside the tax portion", async () => {
    const update = vi.fn(async () => ({}));
    const repo = makeOrderItemsRepo(makePrisma({ orderItemUpdate: update }));

    // ABSORB item: face 1000, platform fee 33. The refund gives the 33 back
    // (docs/decisions/absorb-refund-returns-platform-fee.md); the stamp says so.
    await repo.updateStatus("oi-1", "refunded", NOW, 0, 33);

    expect(update).toHaveBeenCalledWith({
      where: { id: "oi-1" },
      data: {
        status: "refunded",
        refundedAt: NOW,
        refundedTaxCents: 0,
        refundedPlatformFeeCents: 33,
      },
    });
  });

  it("updateStatus keeps a measured ZERO platform-fee share as 0, not NULL", async () => {
    const update = vi.fn(async () => ({}));
    const repo = makeOrderItemsRepo(makePrisma({ orderItemUpdate: update }));

    // A fee-waived / free-fee order refunds 0¢ of platform fee. That is a
    // measured value; collapsing it to NULL would make the P&L consumer
    // withhold the net for "missing coverage" on an order it fully knows.
    await repo.updateStatus("oi-1", "refunded", NOW, 0, 0);

    expect(update).toHaveBeenCalledWith({
      where: { id: "oi-1" },
      data: expect.objectContaining({ refundedPlatformFeeCents: 0 }),
    });
  });

  it("updateStatus writes NULL, not 0, when a refund path attributes nothing", async () => {
    const update = vi.fn(async () => ({}));
    const repo = makeOrderItemsRepo(makePrisma({ orderItemUpdate: update }));

    // Whole-order paths (event cancellation, Stripe-dashboard reconciliation)
    // pass no share. NULL means "not attributed" and must stay tellable apart
    // from a measured zero — the tax rollup sums the two differently.
    await repo.updateStatus("oi-1", "refunded", NOW);

    expect(update).toHaveBeenCalledWith({
      where: { id: "oi-1" },
      data: {
        status: "refunded",
        refundedAt: NOW,
        refundedTaxCents: null,
        refundedPlatformFeeCents: null,
      },
    });
  });

  it("bulkUpdateStatus cannot attribute per item, so it writes NULL", async () => {
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const repo = makeOrderItemsRepo(
      makePrisma({ orderItemUpdateMany: updateMany }),
    );

    await repo.bulkUpdateStatus(["oi-1", "oi-2"], "refunded", NOW);

    // One amount cannot describe N different shares. Writing the NULL rather
    // than omitting the key keeps this method from inheriting a stale
    // attribution if any path ever leaves one on a non-refunded row.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["oi-1", "oi-2"] } },
      data: {
        status: "refunded",
        refundedAt: NOW,
        refundedTaxCents: null,
        refundedPlatformFeeCents: null,
      },
    });
  });

  it("updateStatus clears the attribution when an item leaves refunded", async () => {
    const update = vi.fn(async () => ({}));
    const repo = makeOrderItemsRepo(makePrisma({ orderItemUpdate: update }));

    // A resale unwind restores an item to active. Leaving a stale
    // `refundedTaxCents` behind would keep netting tax out of the rollup for a
    // refund that no longer stands.
    await repo.updateStatus("oi-1", "active", NOW);

    expect(update).toHaveBeenCalledWith({
      where: { id: "oi-1" },
      data: {
        status: "active",
        refundedAt: null,
        transferredAt: null,
        refundedTaxCents: null,
        refundedPlatformFeeCents: null,
      },
    });
  });
  // ── Seat history ──────────────────────────────────────────────────────────
  // A voided ticket MUST give up `Ticket.seatId` (it is @unique, and a dead
  // row holding it fails the next buyer's mint after they are charged), which
  // erases the only record of which seat the order sold. The item keeps it.

  it("recordReleasedSeats MERGES the seat into meta, keeping every other key", async () => {
    const findMany = vi.fn(async () => [
      { id: "oi-1", meta: { buyerTotalCents: 5500, seatIds: ["seat-c8"] } },
    ]);
    const update = vi.fn(async () => ({}));
    const repo = makeOrderItemsRepo(
      makePrisma({ orderItemFindMany: findMany, orderItemUpdate: update }),
    );

    await repo.recordReleasedSeats([
      { orderItemId: "oi-1", seatId: "seat-c8" },
    ]);

    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ["oi-1"] } },
      select: { id: true, meta: true },
    });
    // A blind write would drop `buyerTotalCents`, which the refund math reads.
    expect(update).toHaveBeenCalledWith({
      where: { id: "oi-1" },
      data: {
        meta: {
          buyerTotalCents: 5500,
          seatIds: ["seat-c8"],
          releasedSeatId: "seat-c8",
        },
      },
    });
  });

  it("recordReleasedSeats copes with a null/absent meta", async () => {
    const findMany = vi.fn(async () => [{ id: "oi-1", meta: null }]);
    const update = vi.fn(async () => ({}));
    const repo = makeOrderItemsRepo(
      makePrisma({ orderItemFindMany: findMany, orderItemUpdate: update }),
    );

    await repo.recordReleasedSeats([
      { orderItemId: "oi-1", seatId: "seat-c8" },
    ]);

    expect(update).toHaveBeenCalledWith({
      where: { id: "oi-1" },
      data: { meta: { releasedSeatId: "seat-c8" } },
    });
  });

  it("recordReleasedSeats short-circuits on an empty list", async () => {
    const findMany = vi.fn(async () => []);
    const update = vi.fn(async () => ({}));
    const repo = makeOrderItemsRepo(
      makePrisma({ orderItemFindMany: findMany, orderItemUpdate: update }),
    );

    await repo.recordReleasedSeats([]);

    expect(findMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
