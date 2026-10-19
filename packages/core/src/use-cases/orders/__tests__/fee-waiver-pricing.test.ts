import { describe, expect, it, vi } from "vitest";

import {
  aggregateItems,
  collectWaivableTicketFees,
  computeOrderAmounts,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "../checkout-helpers";
import { reserveFeeWaiverForCheckout } from "../fee-waiver-checkout";

// A flat 30¢ platform fee + Stripe 2.9% + 30¢. The 30¢ is an arbitrary fixture,
// NOT the live platform fee — these tests exercise the waiver arithmetic, so
// every expectation below is derived from this number rather than from the
// seeded GLOBAL policy. Changing the real fee should not touch this file.
function makeContext(
  overrides: Partial<{
    platformFixedCents: number;
    buyerFeePct: number;
    feeMode: "ABSORB" | "PASS_THROUGH";
    maxPlatformFeeCents: number | null;
    minFeeCents: number;
  }> = {},
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
      feeMode: overrides.feeMode ?? "PASS_THROUGH",
      buyerFeePct: overrides.buyerFeePct ?? 0,
      maxFeeCents: null,
      minFeeCents: overrides.minFeeCents ?? 0,
      maxPlatformFeeCents: overrides.maxPlatformFeeCents ?? null,
      platformFixedCents: overrides.platformFixedCents ?? 30,
      processsorFeePct: 0.029,
      processorFixedCents: 30,
      payoutPct: 0.0025,
      payoutFixedCents: 25,
      monthlyPayoutCents: 200,
      payoutMinimumCents: 1000,
    },
  } as unknown as PayoutTermsContext;
}

const TICKET_TYPE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/**
 * Fixed evaluation instant for `computeOrderAmounts`, which now REQUIRES one
 * (time-based-ticket-pricing FR-003). None of the fixtures below carry a
 * scheduled price change, so every expectation in this file is unchanged from
 * before that parameter existed — this is a call-signature addition, not a
 * behaviour change (NFR-001).
 */
const NOW = new Date("2026-01-01T00:00:00.000Z");


function makeTicketTypes(priceCents: number) {
  return new Map<string, TicketTypeSummary>([
    [
      TICKET_TYPE_ID,
      {
        id: TICKET_TYPE_ID,
        priceCents,
        pricingMode: "FIXED",
        minimumCents: null,
        seatSectionId: null,
        // Explicit, not omitted: these are REQUIRED on TicketTypeSummary
        // (FR-003's compile-time safety net). Letting the `as` cast paper over
        // them would mean the fixtures never exercise the mechanism the whole
        // design leans on. Unscheduled here — no expectation in this file
        // depends on `now`.
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      } as TicketTypeSummary,
    ],
  ]);
}

function itemsOf(qty: number) {
  return aggregateItems([{ ticketTypeId: TICKET_TYPE_ID, qty }] as never);
}

const platformFeeOf = (item: { meta: unknown }) =>
  (item.meta as Record<string, unknown>).platformFeePerTicketCents as number;

describe("fee waiver — order pricing", () => {
  it("is a no-op when no tickets are waived", () => {
    const result = computeOrderAmounts(
      itemsOf(3),
      makeTicketTypes(5000),
      makeContext(),
      { now: NOW },
    );

    expect(result.feesPlatformCents).toBe(90); // 3 × 30¢
    expect(result.feesWaivedCents).toBe(0);
    expect(result.waivedTicketCount).toBe(0);
  });

  it("zeroes the platform fee on the waived tickets only", () => {
    const result = computeOrderAmounts(
      itemsOf(3),
      makeTicketTypes(5000),
      makeContext(),
      { now: NOW, waivedTickets: 2 },
    );

    expect(result.waivedTicketCount).toBe(2);
    expect(result.feesWaivedCents).toBe(60);
    expect(result.feesPlatformCents).toBe(30); // one ticket still pays

    const fees = result.items.map(platformFeeOf).sort();
    expect(fees).toEqual([0, 0, 30]);
  });

  it("drops the buyer's total in PASS_THROUGH", () => {
    const base = computeOrderAmounts(
      itemsOf(2),
      makeTicketTypes(5000),
      makeContext({ feeMode: "PASS_THROUGH" }),
      { now: NOW },
    );
    const waived = computeOrderAmounts(
      itemsOf(2),
      makeTicketTypes(5000),
      makeContext({ feeMode: "PASS_THROUGH" }),
      { now: NOW, waivedTickets: 2 },
    );

    // Buyer funded the fee, so waiving it is a discount to the buyer.
    expect(base.buyerFeesCents).toBe(60);
    expect(waived.buyerFeesCents).toBe(0);
    expect(waived.paymentIntentAmountCents).toBe(
      base.paymentIntentAmountCents - 60,
    );
  });

  it("a policy still saying ABSORB: the waiver lowers the buyer's charge, as in PASS_THROUGH", () => {
    // ABSORB is removed (docs/decisions/absorb-removed.md). Under ABSORB the
    // waiver left the buyer's total alone; a legacy row now prices exactly
    // like PASS_THROUGH.
    const legacy = computeOrderAmounts(
      itemsOf(2),
      makeTicketTypes(5000),
      makeContext({ feeMode: "ABSORB" }),
      { now: NOW, waivedTickets: 2 },
    );
    const passThrough = computeOrderAmounts(
      itemsOf(2),
      makeTicketTypes(5000),
      makeContext({ feeMode: "PASS_THROUGH" }),
      { now: NOW, waivedTickets: 2 },
    );

    expect(legacy).toEqual(passThrough);
    expect(legacy.effectiveFeeMode).toBe("PASS_THROUGH");
    expect(legacy.feesPlatformCents).toBe(0);
    expect(legacy.buyerFeesCents).toBe(0);
  });

  it("shrinks the processor fee, because the gross-up solves on the reduced base", () => {
    const base = computeOrderAmounts(
      itemsOf(4),
      makeTicketTypes(5000),
      makeContext(),
      { now: NOW },
    );
    const waived = computeOrderAmounts(
      itemsOf(4),
      makeTicketTypes(5000),
      makeContext(),
      { now: NOW, waivedTickets: 4 },
    );

    expect(waived.processorFeeCents).toBeLessThan(base.processorFeeCents);
  });

  it("never waives more than the order has tickets", () => {
    const result = computeOrderAmounts(
      itemsOf(2),
      makeTicketTypes(5000),
      makeContext(),
      { now: NOW, waivedTickets: 99 },
    );

    expect(result.waivedTicketCount).toBe(2);
    expect(result.feesPlatformCents).toBe(0);
    expect(result.feesWaivedCents).toBe(60);
  });

  it("stays a no-op on a free order (nothing to waive)", () => {
    const result = computeOrderAmounts(
      itemsOf(2),
      makeTicketTypes(0),
      makeContext({ minFeeCents: 50 }),
      { now: NOW, waivedTickets: 2 },
    );

    expect(result.feesPlatformCents).toBe(0);
    expect(result.feesWaivedCents).toBe(0);
    expect(result.waivedTicketCount).toBe(0);
  });

  it("keeps the per-item platform-fee sum equal to the order total", () => {
    // The invariant guard inside computeOrderAmounts throws if these drift.
    const result = computeOrderAmounts(
      itemsOf(5),
      makeTicketTypes(3300),
      makeContext({ buyerFeePct: 0.05, platformFixedCents: 30 }),
      { now: NOW, waivedTickets: 3 },
    );

    const sum = result.items.reduce((acc, item) => acc + platformFeeOf(item), 0);
    expect(sum).toBe(result.feesPlatformCents);
  });

  it("waives the most expensive tickets first", () => {
    // Two ticket types at different prices => different percentage fees.
    const cheap = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const ticketTypes = new Map<string, TicketTypeSummary>([
      [
        TICKET_TYPE_ID,
        {
          id: TICKET_TYPE_ID,
          priceCents: 10000,
          pricingMode: "FIXED",
          minimumCents: null,
          seatSectionId: null,
          scheduledPriceCents: null,
          scheduledPriceAt: null,
        } as TicketTypeSummary,
      ],
      [
        cheap,
        {
          id: cheap,
          priceCents: 1000,
          pricingMode: "FIXED",
          minimumCents: null,
          seatSectionId: null,
          scheduledPriceCents: null,
          scheduledPriceAt: null,
        } as TicketTypeSummary,
      ],
    ]);

    const items = aggregateItems([
      { ticketTypeId: TICKET_TYPE_ID, qty: 1 },
      { ticketTypeId: cheap, qty: 1 },
    ] as never);

    const result = computeOrderAmounts(
      items,
      ticketTypes,
      makeContext({ buyerFeePct: 0.1, platformFixedCents: 0 }),
      { now: NOW, waivedTickets: 1 },
    );

    // $100 ticket's $10 fee is waived; the $10 ticket's $1 fee survives.
    expect(result.feesWaivedCents).toBe(1000);
    expect(result.feesPlatformCents).toBe(100);
  });
});

describe("collectWaivableTicketFees", () => {
  it("returns fee-bearing tickets, descending", () => {
    const result = computeOrderAmounts(
      itemsOf(3),
      makeTicketTypes(5000),
      makeContext(),
      { now: NOW },
    );
    expect(collectWaivableTicketFees(result)).toEqual([30, 30, 30]);
  });

  it("is empty for a free order, so no allowance is burned", () => {
    const result = computeOrderAmounts(
      itemsOf(3),
      makeTicketTypes(0),
      makeContext(),
      { now: NOW },
    );
    expect(collectWaivableTicketFees(result)).toEqual([]);
  });
});

describe("reserveFeeWaiverForCheckout", () => {
  const event = { id: "event-1", orgId: "org-1", humanId: null };

  function makeTx(feeWaivers: Record<string, unknown>) {
    return { feeWaivers } as never;
  }

  const computation = computeOrderAmounts(
    itemsOf(3),
    makeTicketTypes(5000),
    makeContext(),
    { now: NOW },
  );

  it("does nothing when no allowance applies", async () => {
    const resolveApplicable = vi.fn(async () => []);
    const outcome = await reserveFeeWaiverForCheckout({
      tx: makeTx({ resolveApplicable }),
      event,
      orderId: "order-1",
      buyerHumanId: "buyer-1",
      computation,
      now: new Date(),
    });

    expect(outcome.waivedTickets).toBe(0);
    expect(resolveApplicable).toHaveBeenCalledOnce();
  });

  it("never asks for allowance on a free order", async () => {
    const resolveApplicable = vi.fn(async () => []);
    const freeComputation = computeOrderAmounts(
      itemsOf(2),
      makeTicketTypes(0),
      makeContext(),
      { now: NOW },
    );

    const outcome = await reserveFeeWaiverForCheckout({
      tx: makeTx({ resolveApplicable }),
      event,
      orderId: "order-1",
      buyerHumanId: "buyer-1",
      computation: freeComputation,
      now: new Date(),
    });

    expect(outcome.waivedTickets).toBe(0);
    expect(resolveApplicable).not.toHaveBeenCalled();
  });

  it("spreads across multiple allowances, pricing each against the remaining ladder", async () => {
    const reserve = vi
      .fn()
      // First allowance only has 2 left.
      .mockResolvedValueOnce({
        reservedTickets: 2,
        feeWaivedCents: 60,
        redemptionId: "r1",
      })
      // Second covers the last ticket.
      .mockResolvedValueOnce({
        reservedTickets: 1,
        feeWaivedCents: 30,
        redemptionId: "r2",
      });

    const outcome = await reserveFeeWaiverForCheckout({
      tx: makeTx({
        resolveApplicable: vi.fn(async () => [{ id: "w1" }, { id: "w2" }]),
        reserve,
      }),
      event,
      orderId: "order-1",
      buyerHumanId: "buyer-1",
      computation,
      now: new Date(),
    });

    expect(outcome.waivedTickets).toBe(3);
    expect(outcome.feeWaivedCents).toBe(90);
    expect(outcome.waiverIds).toEqual(["w1", "w2"]);

    // Second reserve sees only the ladder the first one didn't consume.
    expect(reserve.mock.calls[0]![0].waivableTicketFeesCents).toEqual([
      30, 30, 30,
    ]);
    expect(reserve.mock.calls[1]![0].waivableTicketFeesCents).toEqual([30]);
  });

  it("skips an allowance that lost a race and tries the next", async () => {
    const reserve = vi
      .fn()
      .mockResolvedValueOnce({
        reservedTickets: 0,
        feeWaivedCents: 0,
        redemptionId: null,
      })
      .mockResolvedValueOnce({
        reservedTickets: 3,
        feeWaivedCents: 90,
        redemptionId: "r2",
      });

    const outcome = await reserveFeeWaiverForCheckout({
      tx: makeTx({
        resolveApplicable: vi.fn(async () => [{ id: "w1" }, { id: "w2" }]),
        reserve,
      }),
      event,
      orderId: "order-1",
      buyerHumanId: "buyer-1",
      computation,
      now: new Date(),
    });

    expect(outcome.waivedTickets).toBe(3);
    expect(outcome.waiverIds).toEqual(["w2"]);
  });

  it("regression: a failed LOOKUP on the transaction propagates — no swallow that would leave the checkout on an aborted transaction", async () => {
    const boom = new Error("db down");
    await expect(
      reserveFeeWaiverForCheckout({
        tx: makeTx({
          resolveApplicable: vi.fn(async () => {
            throw boom;
          }),
        }),
        event,
        orderId: "order-1",
        buyerHumanId: "buyer-1",
        computation,
        now: new Date(),
      }),
    ).rejects.toBe(boom);
  });

  it("regression: a failed RESERVATION propagates too (the write stays on the transaction, uncaught)", async () => {
    const boom = new Error("deadlock detected");
    await expect(
      reserveFeeWaiverForCheckout({
        tx: makeTx({
          resolveApplicable: vi.fn(async () => [{ id: "w1" }]),
          reserve: vi.fn(async () => {
            throw boom;
          }),
        }),
        event,
        orderId: "order-1",
        buyerHumanId: "buyer-1",
        computation,
        now: new Date(),
      }),
    ).rejects.toBe(boom);
  });

  it("the successful reserve path is unchanged: same lookup, same reserve arguments, same outcome", async () => {
    const at = new Date("2026-09-30T12:00:00.000Z");
    const resolveApplicable = vi.fn(async () => [{ id: "w1" }, { id: "w2" }]);
    const reserve = vi
      .fn()
      .mockResolvedValueOnce({ reservedTickets: 2, feeWaivedCents: 60, redemptionId: "r1" })
      .mockResolvedValueOnce({ reservedTickets: 1, feeWaivedCents: 30, redemptionId: "r2" });

    const outcome = await reserveFeeWaiverForCheckout({
      tx: makeTx({ resolveApplicable, reserve }),
      event,
      orderId: "order-1",
      buyerHumanId: "buyer-1",
      computation,
      now: at,
    });

    expect(resolveApplicable.mock.calls).toEqual([
      [
        {
          buyerHumanId: "buyer-1",
          organizerOrgId: "org-1",
          organizerHumanId: null,
          at,
        },
      ],
    ]);
    expect(reserve.mock.calls).toEqual([
      [{ waiverId: "w1", orderId: "order-1", waivableTicketFeesCents: [30, 30, 30] }],
      [{ waiverId: "w2", orderId: "order-1", waivableTicketFeesCents: [30] }],
    ]);
    expect(outcome).toEqual({
      waivedTickets: 3,
      feeWaivedCents: 90,
      waiverIds: ["w1", "w2"],
    });
  });

  it("only offers the organiser's human id when the event has no org", async () => {
    const resolveApplicable = vi.fn(async () => []);
    await reserveFeeWaiverForCheckout({
      tx: makeTx({ resolveApplicable }),
      event: { id: "event-1", orgId: null, humanId: "human-9" },
      orderId: "order-1",
      buyerHumanId: "buyer-1",
      computation,
      now: new Date(),
    });

    expect(resolveApplicable).toHaveBeenCalledWith(
      expect.objectContaining({
        organizerOrgId: null,
        organizerHumanId: "human-9",
        buyerHumanId: "buyer-1",
      }),
    );
  });
});
