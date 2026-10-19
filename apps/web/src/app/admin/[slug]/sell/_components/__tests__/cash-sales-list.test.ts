import { describe, expect, it } from "vitest";

import {
  cashRefundWindowState,
  cashSaleAction,
  cashSaleClosedLabel,
  cashSaleKindLabel,
  cashSaleRefundable,
  mergeCashSalePages,
  type EventCashSale,
} from "../cash-sales-list";

/**
 * Sell → Cash taken tonight offers Refund on a row exactly when
 * `orgRefundCashSale` would take it — the rule `pos.eventCashSales`
 * documents: `status === "SUCCEEDED" && canRefund && (!refundWindowApplies
 * || now <= refundableUntil)`.
 */

const UNTIL = new Date("2026-10-17T23:00:00.000Z");
const BEFORE = new Date("2026-10-12T12:00:00.000Z");
const AFTER = new Date(UNTIL.getTime() + 1);

const editor = { canRefund: true, refundWindowApplies: true, refundableUntil: UNTIL };
const scanner = { canRefund: false, refundWindowApplies: true, refundableUntil: UNTIL };
const staff = { canRefund: true, refundWindowApplies: false, refundableUntil: UNTIL };

function sale(overrides: Partial<EventCashSale> = {}): EventCashSale {
  return {
    orderId: "11111111-1111-4111-8111-111111111111",
    soldAt: new Date("2026-10-10T02:12:00.000Z"),
    ticketCount: 1,
    amountPaidCents: 4900,
    promoCode: null,
    isComp: false,
    isFreeWithCode: false,
    status: "SUCCEEDED",
    refundedAt: null,
    ...overrides,
  };
}

describe("cashSaleRefundable", () => {
  it("is offered to an Owner/Admin/Editor before the window closes", () => {
    expect(cashSaleRefundable(sale(), editor, BEFORE)).toBe(true);
  });

  it("is still offered AT the close instant (inclusive)", () => {
    expect(cashSaleRefundable(sale(), editor, new Date(UNTIL))).toBe(true);
  });

  it("is not offered one millisecond after", () => {
    expect(cashSaleRefundable(sale(), editor, AFTER)).toBe(false);
  });

  it("is never offered to a Scanner", () => {
    expect(cashSaleRefundable(sale(), scanner, BEFORE)).toBe(false);
  });

  it("is offered to platform staff after the window (not held to it)", () => {
    expect(cashSaleRefundable(sale(), staff, AFTER)).toBe(true);
  });

  it.each(["REFUNDED", "PART_REFUNDED"] as const)(
    "is not offered on a %s sale",
    (status) => {
      expect(cashSaleRefundable(sale({ status }), editor, BEFORE)).toBe(false);
    },
  );

  it("reads the close from an ISO string too", () => {
    expect(
      cashSaleRefundable(
        sale(),
        { ...editor, refundableUntil: UNTIL.toISOString() },
        BEFORE,
      ),
    ).toBe(true);
  });
});

describe("cashRefundWindowState", () => {
  it.each([
    [editor, BEFORE, "open"],
    [editor, AFTER, "closed"],
    [scanner, BEFORE, "cannot"],
    [staff, AFTER, "unlimited"],
  ] as const)("%o at %s is %s", (page, now, state) => {
    expect(cashRefundWindowState(page, now)).toBe(state);
  });
});

describe("cashSaleKindLabel", () => {
  it("says Comp only for the Comp button's sale", () => {
    expect(cashSaleKindLabel(sale({ isComp: true, amountPaidCents: 0 }))).toBe(
      "Comp",
    );
  });

  it("says 'Free with <CODE>' for a sale a code made $0", () => {
    expect(
      cashSaleKindLabel(
        sale({ isFreeWithCode: true, promoCode: "FRIENDS100", amountPaidCents: 0 }),
      ),
    ).toBe("Free with FRIENDS100");
  });

  it("names the code on a paid sale that used one", () => {
    expect(cashSaleKindLabel(sale({ promoCode: "HALF" }))).toBe("HALF");
  });

  it("says nothing extra for a plain paid sale", () => {
    expect(cashSaleKindLabel(sale())).toBeNull();
  });
});

describe("mergeCashSalePages", () => {
  it("keeps server order and drops a row a shifted keyset repeated", () => {
    const a = sale({ orderId: "a" });
    const b = sale({ orderId: "b" });
    const c = sale({ orderId: "c" });
    expect(
      mergeCashSalePages([{ items: [a, b] }, { items: [b, c] }, undefined]).map(
        (row) => row.orderId,
      ),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("cashSaleAction", () => {
  it("refunds a paid sale", () => {
    expect(cashSaleAction(sale())).toEqual({ verb: "refund" });
  });

  it("voids a comp", () => {
    expect(cashSaleAction(sale({ isComp: true, amountPaidCents: 0 }))).toEqual({
      verb: "void",
      noun: "comp",
    });
  });

  it("voids any other $0 sale as a free sale", () => {
    expect(
      cashSaleAction(sale({ isFreeWithCode: true, amountPaidCents: 0 })),
    ).toEqual({ verb: "void", noun: "free sale" });
  });
});

describe("cashSaleClosedLabel", () => {
  const now = new Date("2026-10-10T03:00:00.000Z");
  it("says Refunded for a paid sale and Voided for a $0 one", () => {
    expect(cashSaleClosedLabel(sale({ refundedAt: null }), now)).toBe("Refunded");
    expect(
      cashSaleClosedLabel(sale({ amountPaidCents: 0, refundedAt: null }), now),
    ).toBe("Voided");
  });

  it("adds the time when the server sends one", () => {
    expect(
      cashSaleClosedLabel(sale({ refundedAt: new Date(now) }), now),
    ).toMatch(/^Refunded \d/);
  });
});
