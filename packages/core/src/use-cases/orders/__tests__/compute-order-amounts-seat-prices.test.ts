import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";

import {
  aggregateItems,
  computeOrderAmounts,
  heldSeatIdForItem,
  holdSeatsForCheckout,
  readSeatPriceOverrides,
  unseatedSeatPrices,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "../checkout-helpers";

/**
 * `computeOrderAmounts` with per-seat prices (seat-price-overrides spec
 * FR-001/FR-002/D-005), plus the read and lock helpers around it. The
 * createCheckout-level acceptance cases (A-001..A-008) live in
 * seat-price-overrides.test.ts; these pin the money function's invariants.
 *
 * Policy: 5% + 50¢ platform fee per ticket (a $30 ticket → 200¢, $50 → 300¢,
 * $10 → 100¢; a $0 ticket pays no fee, owner ruling 2026-10-10), processor
 * 2.9% + 30¢.
 */
function makeContext(
  overrides: Partial<{ maxPlatformFeeCents: number | null }> = {},
): PayoutTermsContext {
  return {
    agreement: {
      id: "agreement-1",
      kind: "PRIMARY",
      status: "ACTIVE",
      feeMode: null,
      feePolicyId: "policy-1",
      version: 1,
    },
    lines: [
      {
        id: "line-1",
        agreementId: "agreement-1",
        payeeId: "payee-1",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    ],
    feePolicy: {
      id: "policy-1",
      version: 1,
      feeMode: "PASS_THROUGH",
      buyerFeePct: 0.05,
      maxFeeCents: null,
      minFeeCents: 0,
      maxPlatformFeeCents: overrides.maxPlatformFeeCents ?? null,
      platformFixedCents: 50,
      processsorFeePct: 0.029,
      processorFixedCents: 30,
      payoutPct: 0,
      payoutFixedCents: 0,
      monthlyPayoutCents: 0,
      payoutMinimumCents: 0,
    },
  } as unknown as PayoutTermsContext;
}

const NOW = new Date("2026-01-01T00:00:00.000Z");
const GA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const RES = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const PWYW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const SECTION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const EVENT = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const S1 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const S2 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const S3 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd3";

function tt(
  id: string,
  priceCents: number,
  extra: Partial<TicketTypeSummary> = {},
): [string, TicketTypeSummary] {
  return [
    id,
    {
      id,
      priceCents,
      pricingMode: "FIXED",
      minimumCents: null,
      seatSectionId: null,
      scheduledPriceCents: null,
      scheduledPriceAt: null,
      salesOpenAt: null,
      salesCloseAt: null,
      ...extra,
    },
  ];
}

const TICKET_TYPES = new Map<string, TicketTypeSummary>([
  tt(GA, 3000),
  tt(RES, 3000, { seatSectionId: SECTION }),
  tt(PWYW, 0, {
    pricingMode: "ADJUSTABLE",
    minimumCents: 500,
    seatSectionId: SECTION,
  }),
]);

const fee = (oi: { meta?: unknown }) =>
  (oi.meta as Record<string, number>).platformFeePerTicketCents;

describe("computeOrderAmounts — per-seat lines", () => {
  it("prices each seat at its own override, keeps request order, and stamps the seat it priced", () => {
    const items = aggregateItems([
      { ticketTypeId: RES, qty: 3, seatIds: [S1, S2, S3] },
    ]);
    const out = computeOrderAmounts(items, TICKET_TYPES, makeContext(), {
      now: NOW,
      seatPrices: new Map([
        [S1, 5000],
        [S2, null],
        [S3, 5000],
      ]),
    });

    expect(out.items.map((oi) => oi.unitPriceCents)).toEqual([5000, 3000, 5000]);
    expect(out.items.map((oi) => (oi.meta as { seatId: string }).seatId)).toEqual(
      [S1, S2, S3],
    );
    expect(out.items.map(fee)).toEqual([300, 200, 300]);
    expect(out.amountGrossCents).toBe(13000);
    expect(out.feesPlatformCents).toBe(800);
    expect(out.buyerFeesCents).toBe(800);
    // One ticketLines entry per (type, price), first-seen order, each
    // qty × unit === gross, together summing to the type's gross.
    expect(out.ticketLines).toEqual([
      { ticketTypeId: RES, qty: 2, unitPriceCents: 5000, lineGrossCents: 10000 },
      { ticketTypeId: RES, qty: 1, unitPriceCents: 3000, lineGrossCents: 3000 },
    ]);
  });

  it("an unoverridden seated item is ONE line, exactly as an unseated one of the same price", () => {
    const seated = computeOrderAmounts(
      aggregateItems([{ ticketTypeId: RES, qty: 2, seatIds: [S1, S2] }]),
      TICKET_TYPES,
      makeContext(),
      {
        now: NOW,
        seatPrices: new Map([
          [S1, null],
          [S2, null],
        ]),
      },
    );
    const unseated = computeOrderAmounts(
      aggregateItems([{ ticketTypeId: RES, qty: 2 }]),
      TICKET_TYPES,
      makeContext(),
      { now: NOW, seatPrices: new Map() },
    );

    expect(seated.ticketLines).toEqual(unseated.ticketLines);
    expect(seated.paymentIntentAmountCents).toBe(
      unseated.paymentIntentAmountCents,
    );
    expect(seated.processorFeeCents).toBe(unseated.processorFeeCents);
    expect(seated.items.map((oi) => oi.unitPriceCents)).toEqual([3000, 3000]);
  });

  it("an override of 0 is a $0 line, never the tier price (D-002)", () => {
    const out = computeOrderAmounts(
      aggregateItems([{ ticketTypeId: RES, qty: 2, seatIds: [S1, S2] }]),
      TICKET_TYPES,
      makeContext(),
      {
        now: NOW,
        seatPrices: new Map([
          [S1, 0],
          [S2, null],
        ]),
      },
    );
    expect(out.items.map((oi) => oi.unitPriceCents)).toEqual([0, 3000]);
    expect(out.amountGrossCents).toBe(3000);
  });

  it("an ADJUSTABLE tier ignores the seat override: the buyer's amount stands (D-004)", () => {
    const out = computeOrderAmounts(
      aggregateItems([
        {
          ticketTypeId: PWYW,
          qty: 1,
          seatIds: [S1],
          donationAmountCents: 1234,
        },
      ]),
      TICKET_TYPES,
      makeContext(),
      { now: NOW, seatPrices: new Map([[S1, 9999]]) },
    );
    expect(out.items[0]!.unitPriceCents).toBe(1234);
  });

  it("a seat id missing from seatPrices THROWS, never falls back to the tier price (FR-002)", () => {
    expect(() =>
      computeOrderAmounts(
        aggregateItems([{ ticketTypeId: RES, qty: 2, seatIds: [S1, S2] }]),
        TICKET_TYPES,
        makeContext(),
        { now: NOW, seatPrices: new Map([[S1, null]]) },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INTERNAL",
        message: expect.stringContaining("seat_price_missing"),
      }),
    );
  });

  it("the order-level fee cap stays integral across mixed per-seat fees", () => {
    const out = computeOrderAmounts(
      aggregateItems([
        { ticketTypeId: GA, qty: 1 },
        { ticketTypeId: RES, qty: 2, seatIds: [S1, S2] },
      ]),
      TICKET_TYPES,
      makeContext({ maxPlatformFeeCents: 555 }),
      {
        now: NOW,
        seatPrices: new Map([
          [S1, 5000],
          [S2, 1000],
        ]),
      },
    );
    // Pre-cap fees 200 + 300 + 100 = 600, capped to 555.
    expect(out.feesPlatformCents).toBe(555);
    const fees = out.items.map(fee);
    expect(fees.every(Number.isInteger)).toBe(true);
    expect(fees.reduce((s, f) => s + f, 0)).toBe(555);
    expect(out.amountGrossCents).toBe(9000);
  });

  it("the waiver ladder ranks by per-seat fee and waives the priciest seats first", () => {
    const items = aggregateItems([
      { ticketTypeId: GA, qty: 1 },
      { ticketTypeId: RES, qty: 2, seatIds: [S1, S2] },
    ]);
    const seatPrices = new Map([
      [S1, 1000],
      [S2, 5000],
    ]);
    const out = computeOrderAmounts(items, TICKET_TYPES, makeContext(), {
      now: NOW,
      seatPrices,
      waivedTickets: 2,
    });
    // Fees before the waiver: GA 200, S1 100, S2 300 → waive S2 then GA.
    expect(out.items.map(fee)).toEqual([0, 100, 0]);
    expect(out.feesWaivedCents).toBe(500);
    expect(out.feesPlatformCents).toBe(100);
  });
});

describe("unseatedSeatPrices (the door and the seed)", () => {
  it("returns an empty map for an unseated cart", () => {
    expect(
      unseatedSeatPrices(aggregateItems([{ ticketTypeId: GA, qty: 2 }])).size,
    ).toBe(0);
  });

  it("refuses a cart that names seats instead of pricing it at the tier price", () => {
    expect(() =>
      unseatedSeatPrices(
        aggregateItems([{ ticketTypeId: RES, qty: 1, seatIds: [S1] }]),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});

describe("readSeatPriceOverrides", () => {
  it("maps each requested seat to its override cents, null for none, without a locking read", async () => {
    const findPriceOverridesByIds = vi.fn(async () => [
      { id: S1, priceOverride: { priceCents: 5000, reason: null } },
      { id: S2, priceOverride: null },
    ]);
    const findByIdsForUpdate = vi.fn();
    const tx = {
      seats: { findPriceOverridesByIds, findByIdsForUpdate },
    } as unknown as TxRepos;

    const prices = await readSeatPriceOverrides(tx, {
      eventId: EVENT,
      items: aggregateItems([
        { ticketTypeId: GA, qty: 1 },
        { ticketTypeId: RES, qty: 2, seatIds: [S1, S2] },
      ]),
    });

    expect([...prices]).toEqual([
      [S1, 5000],
      [S2, null],
    ]);
    expect(findPriceOverridesByIds).toHaveBeenCalledWith({
      seatIds: [S1, S2],
      eventId: EVENT,
    });
    expect(findByIdsForUpdate).not.toHaveBeenCalled();
  });

  it("does not touch the repo when no seat is requested", async () => {
    const findPriceOverridesByIds = vi.fn();
    const tx = { seats: { findPriceOverridesByIds } } as unknown as TxRepos;
    const prices = await readSeatPriceOverrides(tx, {
      eventId: EVENT,
      items: aggregateItems([{ ticketTypeId: GA, qty: 1 }]),
    });
    expect(prices.size).toBe(0);
    expect(findPriceOverridesByIds).not.toHaveBeenCalled();
  });

  it("refuses a seat the event does not have (SEAT_NOT_FOUND)", async () => {
    const tx = {
      seats: { findPriceOverridesByIds: vi.fn(async () => []) },
    } as unknown as TxRepos;
    await expect(
      readSeatPriceOverrides(tx, {
        eventId: EVENT,
        items: aggregateItems([{ ticketTypeId: RES, qty: 1, seatIds: [S1] }]),
      }),
    ).rejects.toMatchObject({ code: "SEAT_NOT_FOUND" });
  });
});

describe("holdSeatsForCheckout — the priced override must be the locked override", () => {
  function makeTx(lockedOverride: { priceCents: number } | null) {
    const updateStatuses = vi.fn();
    const tx = {
      seats: {
        releaseExpiredHolds: vi.fn(async () => 0),
        findByIdsForUpdate: vi.fn(async () => [
          {
            id: S1,
            seatSectionId: SECTION,
            eventId: EVENT,
            status: "AVAILABLE",
            label: "A1",
            row: "A",
            number: 1,
            priceOverride: lockedOverride,
          },
        ]),
        updateStatuses,
      },
      tickets: { findBySeatIds: vi.fn(async () => []) },
    } as unknown as TxRepos;
    return { tx, updateStatuses };
  }

  const params = (seatPrices: Map<string, number | null>) => ({
    eventId: EVENT,
    items: aggregateItems([{ ticketTypeId: RES, qty: 1, seatIds: [S1] }]),
    ticketTypeMap: TICKET_TYPES,
    now: NOW,
    ttlSeconds: 900,
    seatPrices,
  });

  it("holds the seat when they agree", async () => {
    const { tx, updateStatuses } = makeTx({ priceCents: 5000 });
    const holds = await holdSeatsForCheckout(tx, params(new Map([[S1, 5000]])));
    expect(holds.get(RES)?.seatIds).toEqual([S1]);
    expect(updateStatuses).toHaveBeenCalledTimes(1);
  });

  it("refuses seat_price_changed BEFORE flipping anything HELD when they differ", async () => {
    const { tx, updateStatuses } = makeTx({ priceCents: 6000 });
    await expect(
      holdSeatsForCheckout(tx, params(new Map([[S1, 5000]]))),
    ).rejects.toEqual({
      code: "conflict",
      message: "seat_price_changed",
      seatId: S1,
    });
    expect(updateStatuses).not.toHaveBeenCalled();
  });

  it("treats 0 and absent as different prices", async () => {
    const { tx } = makeTx({ priceCents: 0 });
    await expect(
      holdSeatsForCheckout(tx, params(new Map([[S1, null]]))),
    ).rejects.toMatchObject({ message: "seat_price_changed" });
  });

  it("throws when a locked seat was never priced", async () => {
    const { tx, updateStatuses } = makeTx(null);
    await expect(
      holdSeatsForCheckout(tx, params(new Map())),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(updateStatuses).not.toHaveBeenCalled();
  });
});

describe("heldSeatIdForItem", () => {
  const hold = { seatIds: [S1, S2], expiresAt: NOW };

  it("uses the seat the item was priced for, regardless of position", () => {
    expect(heldSeatIdForItem({ seatId: S2 }, hold, 0)).toBe(S2);
  });

  it("falls back to position for an auto-assigned line", () => {
    expect(heldSeatIdForItem({}, hold, 1)).toBe(S2);
  });

  it("refuses a priced seat that is not held", () => {
    expect(() => heldSeatIdForItem({ seatId: S3 }, hold, 0)).toThrow(
      expect.objectContaining({ code: "INTERNAL" }),
    );
  });
});
