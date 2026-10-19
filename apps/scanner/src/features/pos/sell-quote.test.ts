import { describe, expect, it } from "vitest";

import {
  COLUMN_RESERVE_CENTS,
  columnReserveText,
  sharedColumnWidth,
  breakdownRows,
  buyerEmailForSale,
  cashDueSummary,
  deriveQuoteState,
  emailBlocksSale,
  maskEmail,
  ratePercentText,
  readCashShortTotal,
  readTaxRefusal,
  shouldRetryQuote,
  taxLineLabel,
  taxRefusalNextStep,
  type CartQuote,
  type ChannelQuote,
  type QuoteQueryView,
} from "./sell-quote";

const GA = "22222222-2222-2222-2222-222222222222";

/** What the server sent as an error, as the tRPC client surfaces it. */
const serverError = (appCode: string, meta?: Record<string, unknown>) =>
  Object.assign(new Error(appCode), {
    data: { appCode, httpStatus: 400, ...(meta ? { meta } : {}) },
  });

const salesTax = (amountCents: number) => ({
  code: "SALES",
  label: "Sales tax",
  rateBps: 925,
  amountCents,
});

/** Board S2: 2 × GA at $20. Card $47.72, cash $43.70. */
const CARD: ChannelQuote = {
  ticketSubtotalCents: 4_000,
  discountCents: 0,
  ticketTotalCents: 4_000,
  platformFeeCents: 200,
  processingFeeCents: 168,
  taxLines: [salesTax(404)],
  taxAmountCents: 404,
  totalCents: 4_772,
};
const CASH: ChannelQuote = {
  ticketSubtotalCents: 4_000,
  discountCents: 0,
  ticketTotalCents: 4_000,
  platformFeeCents: 0,
  processingFeeCents: 0,
  taxLines: [salesTax(370)],
  taxAmountCents: 370,
  totalCents: 4_370,
};
const QUOTE: CartQuote = {
  eventId: "11111111-1111-1111-1111-111111111111",
  currency: "usd",
  isComp: false,
  lines: [{ ticketTypeId: GA, qty: 2, unitPriceCents: 2_000, amountCents: 4_000 }],
  feesWaivedCents: 0,
  card: CARD,
  cash: CASH,
};

describe("breakdownRows — the Card | Cash columns (board S2)", () => {
  it("lays out subtotal, both fees and one row per tax line, with '—' for cash fees", () => {
    expect(breakdownRows(QUOTE)).toEqual([
      { key: "subtotal", label: "Subtotal", card: 4_000, cash: 4_000 },
      { key: "platform-fee", label: "Platform fee", card: 200, cash: null },
      { key: "processing-fee", label: "Processing fee", card: 168, cash: null },
      { key: "tax-SALES", label: "Sales tax (9.25%)", card: 404, cash: 370 },
    ]);
  });

  it("adds a Discount row only when a channel carries one", () => {
    const discounted = {
      card: { ...CARD, discountCents: 1_000 },
      cash: { ...CASH, discountCents: 1_000 },
    };
    expect(breakdownRows(discounted).map((r) => r.key)).toContain("discount");
    expect(breakdownRows(QUOTE).map((r) => r.key)).not.toContain("discount");
  });

  it("leaves the whole card column empty when a card can't take the cart", () => {
    const rows = breakdownRows({ card: null, cash: CASH });
    expect(rows.every((r) => r.card === null)).toBe(true);
  });

  it("matches tax lines across channels by code", () => {
    const city = { code: "CITY", label: "City tax", rateBps: 300, amountCents: 120 };
    const rows = breakdownRows({
      card: { ...CARD, taxLines: [salesTax(404), city] },
      cash: CASH,
    });
    expect(rows.find((r) => r.key === "tax-CITY")).toEqual({
      key: "tax-CITY",
      label: "City tax (3%)",
      card: 120,
      cash: null,
    });
  });
});

describe("rate labels", () => {
  it("prints basis points as the shortest percent", () => {
    expect(ratePercentText(925)).toBe("9.25");
    expect(ratePercentText(950)).toBe("9.5");
    expect(ratePercentText(300)).toBe("3");
    expect(ratePercentText(905)).toBe("9.05");
    expect(taxLineLabel({ label: "Sales tax", rateBps: 925 })).toBe(
      "Sales tax (9.25%)",
    );
  });
});

describe("cashDueSummary (board S3)", () => {
  it("names the lines, the ticket total and the tax, and says no fees", () => {
    expect(cashDueSummary(QUOTE, new Map([[GA, "General admission"]]))).toBe(
      "2 × General admission · $40.00 + $3.70 sales tax · no fees",
    );
  });

  it("drops the tax part when there is none", () => {
    const untaxed = { ...QUOTE, cash: { ...CASH, taxLines: [], taxAmountCents: 0 } };
    expect(cashDueSummary(untaxed, new Map([[GA, "GA"]]))).toBe(
      "2 × GA · $40.00 · no fees",
    );
  });
});

describe("refusals", () => {
  it("reads TAX_RATE_UNAVAILABLE by role: Editor+ may enter a rate, a Scanner may not", () => {
    expect(
      readTaxRefusal(serverError("TAX_RATE_UNAVAILABLE", { canEnterManualTaxRate: true })),
    ).toEqual({ canEnterManualTaxRate: true });
    expect(
      readTaxRefusal(serverError("TAX_RATE_UNAVAILABLE", { canEnterManualTaxRate: false })),
    ).toEqual({ canEnterManualTaxRate: false });
    // Missing meta means "ask someone who can".
    expect(readTaxRefusal(serverError("TAX_RATE_UNAVAILABLE"))).toEqual({
      canEnterManualTaxRate: false,
    });
    expect(readTaxRefusal(serverError("TICKET_TYPE_SOLD_OUT"))).toBeNull();
  });

  it("tells a Scanner to ask an editor and an Editor to enter the rate on the web", () => {
    expect(taxRefusalNextStep(false)).toMatch(/^Ask an Owner, Admin or Editor/);
    expect(taxRefusalNextStep(false)).toContain("web Sell screen");
    expect(taxRefusalNextStep(true)).toMatch(/^You can enter the tax rate/);
  });

  it("reads the server's new cash total off CASH_AMOUNT_SHORT", () => {
    expect(
      readCashShortTotal(serverError("CASH_AMOUNT_SHORT", { requiredTotalCents: 4_400 })),
    ).toBe(4_400);
    expect(
      readCashShortTotal(serverError("CASH_AMOUNT_SHORT", { requiredTotalCents: "4400" })),
    ).toBeNull();
    expect(readCashShortTotal(serverError("TAX_RATE_UNAVAILABLE"))).toBeNull();
  });

  it("retries a quote only when no answer came back", () => {
    expect(shouldRetryQuote(0, serverError("TAX_RATE_UNAVAILABLE"))).toBe(false);
    expect(shouldRetryQuote(0, new TypeError("Network request failed"))).toBe(true);
    expect(shouldRetryQuote(2, new TypeError("Network request failed"))).toBe(false);
  });
});

describe("deriveQuoteState — the quote gates Charge", () => {
  const view = (over: Partial<QuoteQueryView>): QuoteQueryView => ({
    hasCart: true,
    asked: true,
    data: QUOTE,
    isPlaceholderData: false,
    isFetching: false,
    isError: false,
    error: null,
    ...over,
  });

  it("is ready only once the answer for THIS cart has settled", () => {
    expect(deriveQuoteState(view({}))).toEqual({ kind: "ready", quote: QUOTE });
  });

  it("is updating while the debounce (or a promo preview) hasn't asked for this cart", () => {
    expect(deriveQuoteState(view({ asked: false })).kind).toBe("updating");
  });

  it("is updating while the previous cart's answer is the placeholder", () => {
    expect(deriveQuoteState(view({ isPlaceholderData: true })).kind).toBe("updating");
  });

  it("is updating while a refetch for the SAME cart is in flight", () => {
    // Back from a tax refusal, or after CASH_AMOUNT_SHORT: Charge must not
    // freeze the old number while the new one is on its way.
    expect(deriveQuoteState(view({ isFetching: true })).kind).toBe("updating");
  });

  it("is empty with no cart", () => {
    expect(deriveQuoteState(view({ hasCart: false })).kind).toBe("empty");
  });

  it("is tax-refused, carrying the role's answer, when the lookup is down", () => {
    expect(
      deriveQuoteState(
        view({
          data: undefined,
          isError: true,
          error: serverError("TAX_RATE_UNAVAILABLE", { canEnterManualTaxRate: false }),
        }),
      ),
    ).toEqual({ kind: "tax-refused", canEnterManualTaxRate: false, retrying: false });
  });

  it("is a plain error for any other refusal", () => {
    expect(
      deriveQuoteState(
        view({ data: undefined, isError: true, error: serverError("TICKET_TYPE_NOT_FOUND") }),
      ).kind,
    ).toBe("error");
  });
});

describe("buyer email", () => {
  it("blocks only an obvious typo, and sends blank as nothing", () => {
    expect(emailBlocksSale("")).toBe(false);
    expect(emailBlocksSale("  ")).toBe(false);
    expect(emailBlocksSale("jane.gmail.com")).toBe(true);
    expect(emailBlocksSale("jane@gmail.com")).toBe(false);
    expect(buyerEmailForSale("  ")).toBeUndefined();
    expect(buyerEmailForSale(" jane@x.com ")).toBe("jane@x.com");
  });

  it("masks the address on the done screen", () => {
    expect(maskEmail("nora@example.com")).toBe("n•••@example.com");
  });
});

describe("columnReserveText", () => {
  it("is a three-digit-dollar figure, so the columns are sized before a quote lands", () => {
    expect(COLUMN_RESERVE_CENTS).toBe(88_888);
    expect(columnReserveText("usd")).toBe("$888.88");
  });
});

describe("sharedColumnWidth", () => {
  const base = { min: 76, gap: 8 };

  it("holds the reserve when the label keeps at least one reserve's width", () => {
    // 375pt screen, default text: row 335, reserve ~91.
    expect(
      sharedColumnWidth({ ...base, cells: [60, 70], reserve: 91, rowWidth: 335 }),
    ).toBe(91);
  });

  it("drops the reserve when it would squeeze the label (narrow row or large text)", () => {
    // 375pt screen at 1.35x text: reserve ~123 leaves the label 73.
    expect(
      sharedColumnWidth({ ...base, cells: [100, 110], reserve: 123, rowWidth: 335 }),
    ).toBe(110);
    // 320pt screen: row 280.
    expect(
      sharedColumnWidth({ ...base, cells: [60], reserve: 91, rowWidth: 280 }),
    ).toBe(76);
  });

  it("never lets the reserve shrink a column the real figures need", () => {
    expect(
      sharedColumnWidth({ ...base, cells: [130], reserve: 91, rowWidth: 335 }),
    ).toBe(130);
  });

  it("ignores the reserve until both it and the row have been measured", () => {
    expect(
      sharedColumnWidth({ ...base, cells: [], reserve: 91, rowWidth: null }),
    ).toBe(76);
    expect(
      sharedColumnWidth({ ...base, cells: [80], reserve: null, rowWidth: 335 }),
    ).toBe(80);
  });
});
