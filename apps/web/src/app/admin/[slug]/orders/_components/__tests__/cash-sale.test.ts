import { describe, expect, it } from "vitest";

import { cashPaymentLabel, cashRefundAffordance } from "../cash-sale";

/**
 * The panel offers the cash refund exactly when `orgRefundCashSale` would
 * take it: a SUCCEEDED CASH order, an Owner, Admin or Finance member, and
 * `now` at or before `cashRefundableUntil` (the close is inclusive, as
 * `cashRefundWindowClosesAt` documents).
 *
 * The rule takes the role as one boolean. `OrdersTable` passes `canFinance`
 * for it, and `OrdersTable.test.tsx` pins which role gets which value.
 */

const UNTIL = new Date("2026-10-17T23:00:00.000Z");
const base = {
  paymentChannel: "CASH" as const,
  status: "SUCCEEDED",
  cashRefundableUntil: UNTIL,
  canRefundCash: true,
  now: new Date("2026-10-12T12:00:00.000Z"),
};

describe("cashRefundAffordance", () => {
  it("is open for a role that may refund here (Owner, Admin, Finance) before the window closes", () => {
    expect(cashRefundAffordance(base)).toBe("open");
  });

  it("is still open AT the close instant (inclusive)", () => {
    expect(cashRefundAffordance({ ...base, now: new Date(UNTIL) })).toBe(
      "open",
    );
  });

  it("is closed one millisecond after", () => {
    expect(
      cashRefundAffordance({
        ...base,
        now: new Date(UNTIL.getTime() + 1),
      }),
    ).toBe("closed");
  });

  it("accepts the close as an ISO string (tRPC without a transformer)", () => {
    expect(
      cashRefundAffordance({ ...base, cashRefundableUntil: UNTIL.toISOString() }),
    ).toBe("open");
  });

  it("shows nothing to a role that cannot refund here (Editor, Viewer, Scanner)", () => {
    expect(cashRefundAffordance({ ...base, canRefundCash: false })).toBe("none");
    expect(
      cashRefundAffordance({
        ...base,
        canRefundCash: false,
        now: new Date(UNTIL.getTime() + 1),
      }),
    ).toBe("none");
  });

  it.each(["WEB", "POS"] as const)(
    "shows nothing for a %s order (card flow untouched)",
    (paymentChannel) => {
      expect(cashRefundAffordance({ ...base, paymentChannel })).toBe("none");
    },
  );

  it.each(["REFUNDED", "PENDING", "CANCELLED", "PART_REFUNDED"])(
    "shows nothing for a %s cash order",
    (status) => {
      expect(cashRefundAffordance({ ...base, status })).toBe("none");
    },
  );

  it("shows nothing when the server sent no window", () => {
    expect(cashRefundAffordance({ ...base, cashRefundableUntil: null })).toBe(
      "none",
    );
  });
});

describe("cashPaymentLabel", () => {
  // The server classifies the sale (`classifyCashSale`); the panel only
  // reads its flags.
  it("names a paid sale as cash", () => {
    expect(
      cashPaymentLabel({ isComp: false, isFreeWithCode: false, promoCodes: [] }),
    ).toEqual({ kind: "cash" });
  });

  it("names a sale made free by a code 'free with' that code, never a comp", () => {
    expect(
      cashPaymentLabel({
        isComp: false,
        isFreeWithCode: true,
        promoCodes: ["FRIENDS", "VIP"],
      }),
    ).toEqual({ kind: "freeWithCode", codes: "FRIENDS, VIP" });
  });

  it("names only the Comp button's sale a comp", () => {
    expect(
      cashPaymentLabel({ isComp: true, isFreeWithCode: false, promoCodes: [] }),
    ).toEqual({ kind: "comp" });
  });

  it("does not guess a comp from $0: neither flag set is a cash sale", () => {
    expect(
      cashPaymentLabel({ isComp: null, isFreeWithCode: null, promoCodes: [] }),
    ).toEqual({ kind: "cash" });
  });
});
