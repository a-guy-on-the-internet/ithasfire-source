import { describe, expect, it } from "vitest";

import {
  buildDoorSaleReceipt,
  isDoorSaleOrder,
} from "../_shared/door-sale-receipt";

/**
 * The door buyer's itemised receipt (spec 2026-10-07 door-sales FR-011),
 * read from the order as recorded. The full card / cash / comp / promo
 * receipts are pinned end to end in pos/__tests__/door-buyer-email.test.ts;
 * these are the edges.
 */

const GA = "33333333-3333-4333-8333-333333333333";

function ticket(face: number, fee: number, processorShare = 0) {
  return {
    kind: "ticket" as const,
    ticketTypeId: GA,
    qty: 1,
    unitPriceCents: face,
    amountCents: face,
    meta: {
      platformFeePerTicketCents: fee,
      buyerTotalCents: face + fee + processorShare,
      buyerUnitTotalCents: face + fee + processorShare,
    },
  };
}

const names = new Map([[GA, "General admission"]]);

describe("buildDoorSaleReceipt", () => {
  it("no tax line at all (a no-tax state) still shows Taxes $0.00, as online checkout does", () => {
    const r = buildDoorSaleReceipt({
      order: {
        paymentChannel: "CASH",
        amountGrossCents: 5000,
        feesPlatformCents: 600,
        taxAmountCents: 0,
        items: [ticket(2500, 300), ticket(2500, 300)] as never,
      },
      taxLines: [],
      ticketTypeNames: names,
    });
    expect(r).toEqual({
      lineItems: [
        { label: "General admission × 2", amountCents: 5000 },
        { label: "Platform fee", amountCents: 600 },
        { label: "Taxes", amountCents: 0 },
      ],
      totalCents: 5600,
      paymentMethod: "Cash",
      complimentary: false,
    });
  });

  it("an ORGANISER-collected line is disclosed nowhere on the buyer's receipt (it was not charged)", () => {
    const r = buildDoorSaleReceipt({
      order: {
        paymentChannel: "POS",
        amountGrossCents: 2500,
        feesPlatformCents: 300,
        taxAmountCents: 250,
        items: [ticket(2500, 300, 100)] as never,
      },
      taxLines: [
        { label: "Sales tax", rateBps: 888, amountCents: 250, collector: "PLATFORM" },
        { label: "Local levy", rateBps: 100, amountCents: 25, collector: "ORGANISER" },
      ],
      ticketTypeNames: names,
    });
    expect(r.lineItems).toEqual([
      { label: "General admission × 1", amountCents: 2500 },
      { label: "Platform fee", amountCents: 300 },
      { label: "Processing fee", amountCents: 100 },
      { label: "Sales tax (8.88%)", amountCents: 250 },
    ]);
    expect(r.totalCents).toBe(3150);
    expect(r.paymentMethod).toBe("Card");
    expect(r.complimentary).toBe(false);
  });

  it("refuses (INTERNAL) a receipt whose lines would not add up to what was paid, rather than guess", () => {
    expect(() =>
      buildDoorSaleReceipt({
        order: {
          paymentChannel: "CASH",
          amountGrossCents: 2500,
          feesPlatformCents: 300,
          // Tax on the order, but its lines are missing.
          taxAmountCents: 250,
          items: [ticket(2500, 300)] as never,
        },
        taxLines: [],
        ticketTypeNames: names,
      }),
    ).toThrow(expect.objectContaining({ code: "INTERNAL" }));
  });

  it("an unnamed ticket type reads as 'Ticket'", () => {
    const r = buildDoorSaleReceipt({
      order: {
        paymentChannel: "CASH",
        amountGrossCents: 2500,
        feesPlatformCents: 0,
        taxAmountCents: 0,
        items: [{ ...ticket(2500, 0), meta: { comp: false, buyerTotalCents: 2500 } }] as never,
      },
      taxLines: [],
      ticketTypeNames: new Map(),
    });
    expect(r.lineItems[0]).toEqual({ label: "Ticket × 1", amountCents: 2500 });
  });
});

describe("buildDoorSaleReceipt: comp", () => {
  it("every ticket line comped: $0 lines, Complimentary, flagged as a gift", () => {
    const r = buildDoorSaleReceipt({
      order: {
        paymentChannel: "CASH",
        amountGrossCents: 0,
        feesPlatformCents: 0,
        taxAmountCents: 0,
        items: [
          {
            kind: "ticket",
            ticketTypeId: GA,
            qty: 2,
            unitPriceCents: 0,
            amountCents: 0,
            meta: { comp: true },
          },
        ] as never,
      },
      taxLines: [],
      ticketTypeNames: names,
    });
    expect(r).toEqual({
      lineItems: [{ label: "General admission × 2", amountCents: 0 }],
      totalCents: 0,
      paymentMethod: "Complimentary",
      complimentary: true,
    });
  });
});

describe("isDoorSaleOrder", () => {
  it.each([
    ["POS", true],
    ["CASH", true],
    ["WEB", false],
  ] as const)("%s → %s", (paymentChannel, expected) => {
    expect(isDoorSaleOrder({ paymentChannel })).toBe(expected);
  });
});
