import { describe, expect, it } from "vitest";

import {
  cashSheetView,
  cashShortCopy,
  cashFractions,
  centsToInput,
  currencySymbol,
  describeDoneSale,
  parseCashInput,
  quickCashAmounts,
  sanitizeCashInput,
  type DoneSale,
} from "./cash-tender";

describe("the cash received field", () => {
  it("parses typed dollars to integer cents without float drift", () => {
    expect(parseCashInput("43.70")).toBe(4_370);
    expect(parseCashInput("43.7")).toBe(4_370);
    expect(parseCashInput("19.99")).toBe(1_999);
    expect(parseCashInput("60")).toBe(6_000);
    expect(parseCashInput("")).toBe(0);
    expect(parseCashInput(".")).toBe(0);
    expect(parseCashInput(".5")).toBe(50);
  });

  it("keeps digits and one point with two decimals at most", () => {
    expect(sanitizeCashInput("$4a3.709")).toBe("43.70");
    expect(sanitizeCashInput("1.2.3")).toBe("1.23");
  });

  it("round-trips an amount through the field", () => {
    expect(centsToInput(4_370)).toBe("43.70");
    expect(centsToInput(0)).toBe("0.00");
    expect(parseCashInput(centsToInput(1_005))).toBe(1_005);
  });

  it("offers the bills a buyer hands over: $43.70 → $50, $60, $100 (board S3)", () => {
    expect(quickCashAmounts(4_370)).toEqual([5_000, 6_000, 10_000]);
    expect(quickCashAmounts(2_000)).toEqual([3_000, 4_000, 10_000]);
    expect(quickCashAmounts(9_500)).toEqual([10_000, 11_000, 20_000]);
    expect(quickCashAmounts(0)).toEqual([]);
  });
});

describe("the event's currency", () => {
  it("takes the symbol from the server's currency, as every amount is formatted", () => {
    expect(currencySymbol("usd")).toBe("$");
    expect(currencySymbol("eur")).toBe("€");
    expect(currencySymbol("cad")).toBe("CA$");
  });

  it("takes as many decimals as the currency has", () => {
    // JPY has none: "1500" is ¥1,500, and nothing after a point is kept.
    expect(cashFractions("jpy")).toBe(0);
    expect(sanitizeCashInput("1500.5", 0)).toBe("1500");
    expect(parseCashInput("1500", 0)).toBe(1500);
    expect(centsToInput(1500, 0)).toBe("1500");
    expect(cashFractions("usd")).toBe(2);
  });
});

describe("change and short (board S3)", () => {
  it("works out the change once the amount covers the due total", () => {
    expect(cashSheetView(4_370, 6_000)).toEqual({
      covers: true,
      changeCents: 1_630,
      shortCents: 0,
    });
    expect(cashSheetView(4_370, 4_370).changeCents).toBe(0);
  });

  it("keeps Confirm off while the amount is short, and says by how much", () => {
    expect(cashSheetView(4_370, 4_000)).toEqual({
      covers: false,
      changeCents: 0,
      shortCents: 370,
    });
    expect(cashShortCopy(4_370, 4_000, "usd")).toBe(
      "$3.70 short. Cash due is $43.70; you entered $40.00. Confirm stays off until the amount covers it.",
    );
  });

  it("a total that went UP after CASH_AMOUNT_SHORT turns the typed amount short", () => {
    // The operator typed the old exact total; the server's new one is higher.
    const view = cashSheetView(4_400, parseCashInput("43.70"));
    expect(view.covers).toBe(false);
    expect(view.shortCents).toBe(30);
  });
});

describe("describeDoneSale (board D1)", () => {
  const sale = (over: Partial<DoneSale>): DoneSale => ({
    orderId: "55555555-5555-5555-5555-555555555555",
    tender: "cash",
    amountCents: 4_370,
    ticketCount: 2,
    discountCents: 0,
    promoCodes: [],
    changeCents: 0,
    autoAdmitted: true,
    seatLabels: [],
    buyerEmail: null,
    ...over,
  });

  it("paid cash with change: 'Change' is the SERVER's change figure", () => {
    const words = describeDoneSale(sale({ changeCents: 1_630 }), "usd");
    expect(words.headline).toBe("$43.70");
    expect(words.summary).toBe("Paid cash — 2 tickets");
    expect(words.giveBack).toBe("Change $16.30");
    expect(words.footnote).toBeNull();
  });

  it("no change line when nothing is owed back", () => {
    expect(describeDoneSale(sale({}), "usd").giveBack).toBeNull();
  });

  it("card: paid by card, receipt masked", () => {
    const words = describeDoneSale(
      sale({ tender: "card", amountCents: 4_772, buyerEmail: "nora@example.com" }),
      "usd",
    );
    expect(words.headline).toBe("$47.72");
    expect(words.summary).toBe("Paid by card — 2 tickets");
    expect(words.receipt).toBe("Receipt sent to n•••@example.com");
  });

  it("a code that takes the cart to $0 is 'Free with CODE', a SALE, never 'Comped'", () => {
    const words = describeDoneSale(
      sale({ amountCents: 0, discountCents: 4_000, promoCodes: ["FRIENDS100"] }),
      "usd",
    );
    expect(words.headline).toBe("$0.00");
    expect(words.summary).toBe("Free with FRIENDS100 — 2 tickets");
    expect(words.footnote).toBe("Counted as a sale, not a comp");
  });

  it("only the Comp action reads 'Comped'", () => {
    const words = describeDoneSale(
      sale({ tender: "comp", amountCents: 0, ticketCount: 1 }),
      "usd",
    );
    expect(words.headline).toBe("Comped");
    expect(words.summary).toBe("Guest list — 1 ticket");
    expect(words.footnote).toBe("No fee, no tax");
  });
});
