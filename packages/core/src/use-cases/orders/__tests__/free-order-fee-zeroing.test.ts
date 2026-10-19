import { describe, it, expect } from "vitest";

import {
  zeroFeesForFreeOrder,
  type OrderComputation,
} from "../checkout-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// A promo can cancel an order's entire subtotal. That order reaches
// claimFreeTickets carrying a computation built from the UNDISCOUNTED ticket
// prices, so it holds real platform/processor fees. Those must not survive
// onto a $0 order: they would render a fee line on a "free entry" member
// benefit and book platform fees against an order that earned none.
//
// computeOrderAmounts already zeroes the OTHER route to free (items priced at
// $0) inline — it must, so the processor-fee base short-circuits.
// ─────────────────────────────────────────────────────────────────────────────

const TICKET_TYPE_ID = "55555555-5555-4555-8555-555555555555";

function buildComputation(): OrderComputation {
  return {
    amountGrossCents: 2000,
    feesPlatformCents: 374,
    feesWaivedCents: 0,
    waivedTicketCount: 0,
    buyerFeesCents: 374,
    processorPct: 0.029,
    processorFixedCents: 30,
    processorFeeCents: 99,
    effectiveFeeMode: "PASS_THROUGH" as OrderComputation["effectiveFeeMode"],
    paymentIntentAmountCents: 2374,
    nonRefundable: false,
    items: [
      {
        kind: "ticket",
        ticketTypeId: TICKET_TYPE_ID,
        qty: 1,
        unitPriceCents: 1000,
        amountCents: 1000,
        meta: {
          platformFeePerTicketCents: 187,
          buyerTotalCents: 1187,
          buyerUnitTotalCents: 1187,
          processorFeeShareCents: 49,
        },
      },
      {
        kind: "ticket",
        ticketTypeId: TICKET_TYPE_ID,
        qty: 1,
        unitPriceCents: 1000,
        amountCents: 1000,
        meta: {
          platformFeePerTicketCents: 187,
          buyerTotalCents: 1187,
          buyerUnitTotalCents: 1187,
          processorFeeShareCents: 50,
        },
      },
    ],
    ticketLines: [],
  } as unknown as OrderComputation;
}

describe("zeroFeesForFreeOrder", () => {
  it("zeroes every order-level fee", () => {
    const computation = zeroFeesForFreeOrder(buildComputation());

    expect(computation.feesPlatformCents).toBe(0);
    expect(computation.buyerFeesCents).toBe(0);
    expect(computation.processorFeeCents).toBe(0);
    expect(computation.paymentIntentAmountCents).toBe(0);
  });

  it("zeroes per-item fee metadata on every ticket line", () => {
    const computation = zeroFeesForFreeOrder(buildComputation());

    for (const item of computation.items) {
      const meta = item.meta as Record<string, unknown>;
      expect(meta.platformFeePerTicketCents).toBe(0);
      expect(meta.buyerTotalCents).toBe(0);
      expect(meta.buyerUnitTotalCents).toBe(0);
      expect(meta.processorFeeShareCents).toBe(0);
    }
  });

  it("keeps the platform-fee sum invariant intact (items sum to the total)", () => {
    const computation = zeroFeesForFreeOrder(buildComputation());

    const itemFeeSum = computation.items.reduce(
      (sum, item) =>
        sum +
        ((item.meta as Record<string, unknown>)
          .platformFeePerTicketCents as number),
      0,
    );

    expect(itemFeeSum).toBe(computation.feesPlatformCents);
  });

  it("leaves the gross amount alone — the caller owns the discounted total", () => {
    const computation = zeroFeesForFreeOrder(buildComputation());

    // The helper only touches fees. amountGrossCents is still the pre-discount
    // figure here; claimFreeTickets persists amountGrossAfterDiscount instead.
    expect(computation.amountGrossCents).toBe(2000);
  });

  it("preserves fee-waiver bookkeeping, which is a separate fact", () => {
    const waived = buildComputation();
    waived.feesWaivedCents = 187;
    waived.waivedTicketCount = 1;

    const computation = zeroFeesForFreeOrder(waived);

    expect(computation.feesWaivedCents).toBe(187);
    expect(computation.waivedTicketCount).toBe(1);
  });

  it("is idempotent — re-running on an already-free computation is a no-op", () => {
    const once = zeroFeesForFreeOrder(buildComputation());
    const twice = zeroFeesForFreeOrder(once);

    expect(twice.feesPlatformCents).toBe(0);
    expect(twice.buyerFeesCents).toBe(0);
    expect(twice.processorFeeCents).toBe(0);
  });
});
