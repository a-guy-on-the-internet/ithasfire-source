import { describe, expect, it } from "vitest";

import {
  breakdownRows,
  buyerEmailForSale,
  deriveQuoteState,
  looksLikeEmail,
  maskEmail,
  parseManualRatePercent,
  ratePercentText,
  ratePercentWords,
  readCashShortTotal,
  readManualRateRefusal,
  readTaxRefusal,
  shouldRetryQuote,
  taxLineLabel,
  type CartQuote,
  type ChannelQuote,
  type QuoteQueryView,
} from "../sell-quote";

const channel = (over: Partial<ChannelQuote> = {}): ChannelQuote => ({
  ticketSubtotalCents: 4000,
  discountCents: 0,
  ticketTotalCents: 4000,
  platformFeeCents: 0,
  processingFeeCents: 0,
  taxLines: [],
  taxAmountCents: 0,
  totalCents: 4000,
  ...over,
});

/** A tRPC client error as the till receives it. */
const appError = (appCode: string, meta?: Record<string, unknown>) =>
  Object.assign(new Error(appCode), {
    data: { appCode, httpStatus: 400, ...(meta ? { meta } : {}) },
  });

describe("tax line labels", () => {
  it("prints the rate without trailing zeros", () => {
    expect(ratePercentText(925)).toBe("9.25");
    expect(ratePercentText(300)).toBe("3");
    expect(ratePercentText(950)).toBe("9.5");
    expect(taxLineLabel({ label: "Sales tax", rateBps: 925 })).toBe(
      "Sales tax (9.25%)",
    );
  });
});

describe("breakdownRows", () => {
  const card = channel({
    platformFeeCents: 200,
    processingFeeCents: 168,
    taxLines: [{ code: "SALES", label: "Sales tax", rateBps: 925, amountCents: 404 }],
    totalCents: 4772,
  });
  const cash = channel({
    taxLines: [{ code: "SALES", label: "Sales tax", rateBps: 925, amountCents: 370 }],
    totalCents: 4370,
  });

  it("lays out checkout's rows with cash fees as null (rendered as a dash)", () => {
    expect(breakdownRows({ card, cash })).toEqual([
      { key: "subtotal", label: "Subtotal", card: 4000, cash: 4000 },
      { key: "platform-fee", label: "Platform fee", card: 200, cash: null },
      { key: "processing-fee", label: "Processing fee", card: 168, cash: null },
      { key: "tax-SALES", label: "Sales tax (9.25%)", card: 404, cash: 370 },
    ]);
  });

  it("adds Discount only when a channel has one", () => {
    const rows = breakdownRows({
      card: { ...card, discountCents: 500 },
      cash: { ...cash, discountCents: 500 },
    });
    expect(rows.find((r) => r.key === "discount")).toEqual({
      key: "discount",
      label: "Discount",
      card: 500,
      cash: 500,
    });
  });

  it("renders whatever fee the server returns for cash — it never assumes zero", () => {
    const rows = breakdownRows({ card, cash: { ...cash, platformFeeCents: 200 } });
    expect(rows.find((r) => r.key === "platform-fee")?.cash).toBe(200);
  });

  it("puts one row per tax line and nulls a line a channel lacks", () => {
    const rows = breakdownRows({
      card: {
        ...card,
        taxLines: [
          ...card.taxLines,
          { code: "MPLS_ENT", label: "Entertainment tax", rateBps: 300, amountCents: 120 },
        ],
      },
      cash,
    });
    expect(rows.slice(-2)).toEqual([
      { key: "tax-SALES", label: "Sales tax (9.25%)", card: 404, cash: 370 },
      { key: "tax-MPLS_ENT", label: "Entertainment tax (3%)", card: 120, cash: null },
    ]);
  });

  it("blanks the whole card column for a cash-only cart", () => {
    const rows = breakdownRows({ card: null, cash });
    expect(rows.every((r) => r.card === null)).toBe(true);
  });
});

describe("reading the server's refusals", () => {
  it("reads who may enter a tax rate off TAX_RATE_UNAVAILABLE", () => {
    expect(
      readTaxRefusal(appError("TAX_RATE_UNAVAILABLE", { canEnterManualTaxRate: true })),
    ).toEqual({ canEnterManualTaxRate: true });
    // Missing meta means "ask an Owner, Admin or Editor", never "you may".
    expect(readTaxRefusal(appError("TAX_RATE_UNAVAILABLE"))).toEqual({
      canEnterManualTaxRate: false,
    });
    expect(readTaxRefusal(appError("INSUFFICIENT_CAPACITY"))).toBeNull();
  });

  it("reads the new cash total off CASH_AMOUNT_SHORT", () => {
    expect(
      readCashShortTotal(appError("CASH_AMOUNT_SHORT", { requiredTotalCents: 4395 })),
    ).toBe(4395);
    expect(readCashShortTotal(appError("CASH_AMOUNT_SHORT"))).toBeNull();
    expect(readCashShortTotal(appError("TAX_RATE_UNAVAILABLE"))).toBeNull();
  });

  it("has a line for every manual-rate refusal reason", () => {
    for (const reason of [
      "rate_resolved",
      "no_location",
      "lookup_available",
      "lookup_not_configured",
      "location_changed",
    ]) {
      const refusal = readManualRateRefusal(
        appError("MANUAL_TAX_RATE_NOT_ALLOWED", { reason }),
      );
      expect(refusal?.reason).toBe(reason);
      expect(refusal?.message.length).toBeGreaterThan(20);
    }
    expect(
      readManualRateRefusal(appError("MANUAL_TAX_RATE_NOT_ALLOWED", { reason: "new" })),
    ).toBeNull();
  });
});

describe("the manual tax rate", () => {
  it("takes 0 to 25 with up to two decimals, as basis points", () => {
    expect(parseManualRatePercent("9.25")).toBe(925);
    expect(parseManualRatePercent("9.25%")).toBe(925);
    expect(parseManualRatePercent(" 0 ")).toBe(0);
    expect(parseManualRatePercent("25")).toBe(2500);
    expect(parseManualRatePercent("8.1")).toBe(810);
  });

  it("refuses anything the server would", () => {
    expect(parseManualRatePercent("25.01")).toBeNull();
    expect(parseManualRatePercent("9.255")).toBeNull();
    expect(parseManualRatePercent("-1")).toBeNull();
    expect(parseManualRatePercent("")).toBeNull();
    expect(parseManualRatePercent("nine")).toBeNull();
  });

  it("says the rate in words so a typo reads wrong out loud", () => {
    expect(ratePercentWords(925)).toBe("Nine and a quarter percent");
    expect(ratePercentWords(950)).toBe("Nine and a half percent");
    expect(ratePercentWords(775)).toBe("Seven and three quarters percent");
    expect(ratePercentWords(800)).toBe("Eight percent");
    expect(ratePercentWords(905)).toBe("Nine point zero five percent");
    expect(ratePercentWords(810)).toBe("Eight point one percent");
    expect(ratePercentWords(2500)).toBe("Twenty-five percent");
  });
});

describe("the buyer email", () => {
  it("only catches obvious typos", () => {
    expect(looksLikeEmail("jane@example.com")).toBe(true);
    expect(looksLikeEmail("jane.example.com")).toBe(false);
    expect(looksLikeEmail("jane@")).toBe(false);
  });

  it("sends it trimmed, or not at all", () => {
    expect(buyerEmailForSale("  jane@example.com ")).toBe("jane@example.com");
    expect(buyerEmailForSale("   ")).toBeUndefined();
  });

  it("masks it for the done screen", () => {
    expect(maskEmail("nina@example.com")).toBe("n•••@example.com");
  });
});

describe("the quote on screen", () => {
  const quote: CartQuote = {
    currency: "usd",
    lines: [],
    card: channel({ totalCents: 4772 }),
    cash: channel({ totalCents: 4370 }),
  };
  const settled: QuoteQueryView = {
    hasCart: true,
    asked: true,
    data: quote,
    isPlaceholderData: false,
    isFetching: false,
    isError: false,
    error: null,
  };

  it("is ready only once the answer for this cart has settled", () => {
    expect(deriveQuoteState(settled)).toEqual({ kind: "ready", quote });
  });

  it("is updating while the cart on screen hasn't been asked about yet", () => {
    expect(deriveQuoteState({ ...settled, asked: false })).toEqual({
      kind: "updating",
      last: quote,
    });
  });

  it("is updating while a refetch of the SAME cart is in flight", () => {
    // Back from a tax refusal, or after CASH_AMOUNT_SHORT: the cached answer
    // is what moved, so Charge must wait for the new one.
    expect(deriveQuoteState({ ...settled, isFetching: true }).kind).toBe(
      "updating",
    );
    expect(deriveQuoteState({ ...settled, isPlaceholderData: true }).kind).toBe(
      "updating",
    );
  });

  it("keeps a refusal on screen, with a spinner, while it's retried", () => {
    expect(
      deriveQuoteState({
        ...settled,
        data: undefined,
        isError: true,
        isFetching: true,
        error: appError("TAX_RATE_UNAVAILABLE", { canEnterManualTaxRate: false }),
      }),
    ).toEqual({ kind: "tax-refused", canEnterManualTaxRate: false, retrying: true });
  });

  it("is empty with no cart", () => {
    expect(deriveQuoteState({ ...settled, hasCart: false })).toEqual({
      kind: "empty",
    });
  });
});

describe("retrying a failed quote", () => {
  it("never retries an answer the server decided", () => {
    expect(shouldRetryQuote(0, appError("TAX_RATE_UNAVAILABLE"))).toBe(false);
    expect(shouldRetryQuote(0, appError("TICKET_TYPE_SALES_ENDED"))).toBe(false);
  });

  it("retries a request that got no answer, twice at most", () => {
    const lost = new TypeError("Failed to fetch");
    expect(shouldRetryQuote(0, lost)).toBe(true);
    expect(shouldRetryQuote(1, lost)).toBe(true);
    expect(shouldRetryQuote(2, lost)).toBe(false);
  });
});
