import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  useTranslations:
    () =>
    (key: string, values?: Record<string, string>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));

import {
  TOTAL_ANNOUNCE_SETTLE_MS,
  useCheckoutDisplayTotal,
} from "./useCheckoutDisplayTotal";
import { formatMoneyCents } from "@/lib/format";

// TODO(money-i18n): currency not in scope at this callsite — using USD default.
const formatPrice = (cents: number) => formatMoneyCents(cents);

const SALES_888_FACE = {
  code: "SALES",
  label: "Sales tax",
  jurisdiction: "US/NY",
  rateBps: 888,
  base: "TICKET_FACE" as const,
  collector: "PLATFORM" as const,
};

/** 55403: Minnesota sales tax on the buyer total + the city's 3% on the face. */
const MINNEAPOLIS_LINES = [
  {
    code: "SALES",
    label: "Sales tax",
    jurisdiction: "US/MN",
    rateBps: 903,
    base: "BUYER_TOTAL" as const,
    collector: "PLATFORM" as const,
  },
  {
    code: "MPLS_ENTERTAINMENT",
    label: "Minneapolis entertainment tax",
    jurisdiction: "US/MN/Minneapolis",
    rateBps: 300,
    base: "TICKET_FACE" as const,
    collector: "PLATFORM" as const,
  },
];

const baseArgs = {
  isDisplaySubtotalKnown: true,
  displaySubtotalCents: 9086,
  livePromoDiscountCents: 0,
  taxEstimate: null,
  formatPrice,
};

describe("useCheckoutDisplayTotal server-authoritative branch", () => {
  it("subtracts applied credit so the pay label matches the PaymentIntent amount", () => {
    // gross 8000 + buyerFees 390 + tax 400 − credit 1000 = 7790
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        phase: "paying",
        order: {
          amountGrossCents: 8000,
          buyerFeesCents: 390,
          taxAmountCents: 400,
          creditAppliedCents: 1000,
        },
      }),
    );

    expect(result.current.displayTotalCents).toBe(7790);
    expect(result.current.payButtonLabel).toBe("checkout.payAmount:$77.90");
  });

  it("is unchanged when no credit was applied", () => {
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        phase: "paying",
        order: {
          amountGrossCents: 8000,
          buyerFeesCents: 390,
          taxAmountCents: 400,
        },
      }),
    );

    expect(result.current.displayTotalCents).toBe(8790);
  });

  it("clamps to zero when credit covers the whole charge", () => {
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        phase: "paying",
        order: {
          amountGrossCents: 8000,
          buyerFeesCents: 390,
          taxAmountCents: 400,
          creditAppliedCents: 99_999,
        },
      }),
    );

    expect(result.current.displayTotalCents).toBe(0);
    expect(result.current.displayTotalLabel).toBe("common.free");
  });
});

describe("useCheckoutDisplayTotal processor fee (feeMode)", () => {
  it("includes the processor fee in the server-authoritative total for PASS_THROUGH", () => {
    // gross 3500 + buyerFees 50 + processor 137 + tax 0 = 3687
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        phase: "paying",
        feeMode: "PASS_THROUGH",
        order: {
          amountGrossCents: 3500,
          buyerFeesCents: 50,
          taxAmountCents: 0,
          processorFeeCents: 137,
        },
      }),
    );

    expect(result.current.displayTotalCents).toBe(3687);
  });

  it("subtracts credit after adding the PASS_THROUGH processor fee", () => {
    // gross 3500 + buyerFees 50 + processor 137 + tax 0 − credit 500 = 3187
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        phase: "paying",
        feeMode: "PASS_THROUGH",
        order: {
          amountGrossCents: 3500,
          buyerFeesCents: 50,
          taxAmountCents: 0,
          processorFeeCents: 137,
          creditAppliedCents: 500,
        },
      }),
    );

    expect(result.current.displayTotalCents).toBe(3187);
  });

  it("excludes the processor fee from the total for ABSORB", () => {
    // gross 3500 + buyerFees 0 + tax 0 = 3500 (processor 137 NOT added)
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        phase: "paying",
        feeMode: "ABSORB",
        order: {
          amountGrossCents: 3500,
          buyerFeesCents: 0,
          taxAmountCents: 0,
          processorFeeCents: 137,
        },
      }),
    );

    expect(result.current.displayTotalCents).toBe(3500);
  });
});

describe("useCheckoutDisplayTotal — the promo discount is priced ONCE", () => {
  it("regression: pre-hold, the estimate already carries the discount — not subtracted again", () => {
    // `displaySubtotalCents` is estimateCartTotal(…, { discountCents: 550 }).
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        order: null,
        phase: "selecting",
        displaySubtotalCents: 5685,
        livePromoDiscountCents: 550,
        feeMode: "PASS_THROUGH",
      }),
    );
    expect(result.current.displayTotalCents).toBe(5685);
  });

  it("held: the solved held charge IS the total", () => {
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        order: {
          amountGrossCents: 5500,
          buyerFeesCents: 100,
          processorFeeCents: 213,
          taxAmountCents: 488,
          creditAppliedCents: 0,
        },
        phase: "held",
        livePromoDiscountCents: 550,
        feeMode: "PASS_THROUGH",
        heldCharge: { totalCents: 5685, taxCents: 440 },
      }),
    );
    expect(result.current.displayTotalCents).toBe(5685);
    expect(result.current.displayTaxCents).toBe(440);
  });
});

describe("useCheckoutDisplayTotal — ONE tax figure (displayTaxCents)", () => {
  it("regression: post-checkout, a stamped $0 tax stays $0 — a cached estimate never replaces it", () => {
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        order: {
          amountGrossCents: 4950,
          buyerFeesCents: 100,
          processorFeeCents: 190,
          taxAmountCents: 0,
          creditAppliedCents: 0,
        },
        phase: "paying",
        livePromoDiscountCents: 550,
        taxEstimate: { taxRateBps: 888, taxAmountCents: 488 },
        feeMode: "PASS_THROUGH",
      }),
    );
    expect(result.current.displayTaxCents).toBe(0);
    expect(result.current.displayTotalCents).toBe(4950 + 100 + 190);
  });

  it("held, fee rates unavailable, WELCOME10: the tax on the discounted base, and it is the tax inside the total", () => {
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        order: {
          amountGrossCents: 5500,
          buyerFeesCents: 100,
          processorFeeCents: 190,
          creditAppliedCents: 0,
        },
        phase: "held",
        heldCharge: null,
        livePromoDiscountCents: 550,
        taxEstimate: {
          taxRateBps: 888,
          taxAmountCents: 488,
          taxImpositions: [SALES_888_FACE],
        },
        feeMode: "PASS_THROUGH",
      }),
    );
    expect(result.current.displayTaxCents).toBe(440);
    expect(result.current.displayTotalCents).toBe(4950 + 100 + 190 + 440);
  });

  it("held, fee rates unavailable, Minneapolis + promo: each line on its own base — never the summed rate on the face", () => {
    // $25 face, $5 off. Minnesota sales tax 9.03% on the buyer total
    // (discounted face + platform fee + processing), Minneapolis 3% on the
    // discounted face. The old flat recompute charged 12.03% of $20 = $2.41.
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        order: {
          amountGrossCents: 2500,
          buyerFeesCents: 100,
          processorFeeCents: 110,
          creditAppliedCents: 0,
        },
        phase: "held",
        heldCharge: null,
        livePromoDiscountCents: 500,
        taxEstimate: {
          taxRateBps: 1203,
          taxAmountCents: 316,
          taxImpositions: MINNEAPOLIS_LINES,
        },
        feeMode: "PASS_THROUGH",
      }),
    );
    const sales = Math.round(((2000 + 100 + 110) * 903) / 10_000); // 200
    const city = Math.round((2000 * 300) / 10_000); // 60
    expect(result.current.displayTaxCents).toBe(sales + city);
    expect(result.current.displayTaxCents).not.toBe(
      Math.round((2000 * 1203) / 10_000),
    );
    expect(result.current.displayTotalCents).toBe(
      2000 + 100 + 110 + sales + city,
    );
  });

  it("held, fee rates unavailable, quote without impositions: the hold's own tax, never a guessed rate", () => {
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        order: {
          amountGrossCents: 2500,
          buyerFeesCents: 100,
          processorFeeCents: 110,
          taxAmountCents: 316,
          creditAppliedCents: 0,
        },
        phase: "held",
        heldCharge: null,
        livePromoDiscountCents: 500,
        taxEstimate: { taxRateBps: 1203, taxAmountCents: 316 },
        feeMode: "PASS_THROUGH",
      }),
    );
    expect(result.current.displayTaxCents).toBe(316);
  });

  it("before a hold there is no order tax (the step-1 estimate carries its own)", () => {
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({ ...baseArgs, order: null, phase: "selecting" }),
    );
    expect(result.current.displayTaxCents).toBeNull();
  });
});

/** Let a pending total announcement speak. */
const settle = () =>
  act(() => {
    vi.advanceTimersByTime(TOTAL_ANNOUNCE_SETTLE_MS);
  });

describe("useCheckoutDisplayTotal — an invalid PWYW amount has no total", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("regression: pre-hold, the total is '—' and nothing is announced", () => {
    const { result } = renderHook(() =>
      useCheckoutDisplayTotal({
        ...baseArgs,
        order: null,
        phase: "selecting",
        // What an over-cap $15,000 amount would price to.
        displaySubtotalCents: 1_681_500,
        totalUnavailable: true,
      }),
    );
    expect(result.current.displayTotalCents).toBeNull();
    expect(result.current.displayTotalLabel).toBe("—");
    expect(result.current.payButtonLabel).toBe("—");
    expect(result.current.liveAnnouncement).toBe("");
  });

  it("once the amount is valid again, the total is announced — even if it equals the last one", () => {
    const { result, rerender } = renderHook(
      ({ unavailable }: { unavailable: boolean }) =>
        useCheckoutDisplayTotal({
          ...baseArgs,
          order: null,
          phase: "selecting",
          displaySubtotalCents: 1765,
          totalUnavailable: unavailable,
        }),
      { initialProps: { unavailable: false } },
    );
    // The initial total is not announced (by design) …
    expect(result.current.liveAnnouncement).toBe("");
    rerender({ unavailable: true });
    expect(result.current.displayTotalLabel).toBe("—");
    rerender({ unavailable: false });
    expect(result.current.displayTotalLabel).toBe("$17.65");
    settle();
    expect(result.current.liveAnnouncement).toBe("checkout.totalUpdated:$17.65");
  });
});

describe("useCheckoutDisplayTotal — a $0 total is announced as Free", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("regression: dropping to $0 announces 'Free', never the last dollar figure", () => {
    const { result, rerender } = renderHook(
      ({ subtotal }: { subtotal: number }) =>
        useCheckoutDisplayTotal({
          ...baseArgs,
          order: null,
          phase: "selecting",
          displaySubtotalCents: subtotal,
        }),
      { initialProps: { subtotal: 1000 } },
    );
    rerender({ subtotal: 3808 });
    settle();
    expect(result.current.liveAnnouncement).toBe("checkout.totalUpdated:$38.08");
    rerender({ subtotal: 0 });
    expect(result.current.displayTotalLabel).toBe("common.free");
    settle();
    expect(result.current.liveAnnouncement).toBe(
      "checkout.totalUpdated:common.free",
    );
  });
});

describe("useCheckoutDisplayTotal — the announcement waits for the total to settle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const renderTotal = () =>
    renderHook(
      ({ subtotal }: { subtotal: number }) =>
        useCheckoutDisplayTotal({
          ...baseArgs,
          order: null,
          phase: "selecting",
          displaySubtotalCents: subtotal,
        }),
      { initialProps: { subtotal: 1000 } },
    );

  it("a slider drag: the visible total follows every move, the live region speaks once, with the figure it stopped on", () => {
    const { result, rerender } = renderTotal();
    for (const subtotal of [1100, 1250, 1400, 1650]) {
      rerender({ subtotal });
      act(() => {
        vi.advanceTimersByTime(TOTAL_ANNOUNCE_SETTLE_MS / 5);
      });
      // The screen follows the handle...
      expect(result.current.displayTotalLabel).toBe(formatPrice(subtotal));
      // ...the live region does not narrate it.
      expect(result.current.liveAnnouncement).toBe("");
    }
    settle();
    expect(result.current.liveAnnouncement).toBe("checkout.totalUpdated:$16.50");
  });

  it("a drag that ends where it started announces nothing", () => {
    const { result, rerender } = renderTotal();
    rerender({ subtotal: 1500 });
    rerender({ subtotal: 1000 });
    settle();
    expect(result.current.liveAnnouncement).toBe("");
  });

  it("an invalid amount empties the live region at once, without waiting", () => {
    const { result, rerender } = renderHook(
      ({ unavailable, subtotal }: { unavailable: boolean; subtotal: number }) =>
        useCheckoutDisplayTotal({
          ...baseArgs,
          order: null,
          phase: "selecting",
          displaySubtotalCents: subtotal,
          totalUnavailable: unavailable,
        }),
      { initialProps: { unavailable: false, subtotal: 1000 } },
    );
    rerender({ unavailable: false, subtotal: 2000 });
    settle();
    expect(result.current.liveAnnouncement).toBe("checkout.totalUpdated:$20.00");
    rerender({ unavailable: true, subtotal: 2000 });
    expect(result.current.liveAnnouncement).toBe("");
  });
});
