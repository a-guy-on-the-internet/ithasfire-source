import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The screen-reader total and the visible total must be the SAME value.
 *
 * Wired exactly as `Checkout.tsx` wires it: ONE `estimateCartTotal` result
 * feeds the summary's rows (`preHoldEstimate`) and the display-total hook,
 * the hook's total is handed back to the summary (`displayTotalCents`), and
 * the SR-only live region prints the hook's announcement.
 *
 * Live defects this pins:
 *  - typing 15000 into a PWYW field passes through a valid 1500; that total
 *    was announced and then KEPT after the screen turned to "—";
 *  - during an API outage (preview / tax / fee-rate queries failing) the
 *    live region said one figure while the summary showed another — the
 *    summary computed its own held-step total from a different tax source.
 */

vi.mock("@th/ui", () => ({
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));
vi.mock("./PromoCodeInput", () => ({
  PromoCodeInput: () => <div data-testid="promo-code-input" />,
}));

import { OrderSummary, type OrderSummaryOrder } from "./OrderSummary";
import {
  TOTAL_ANNOUNCE_SETTLE_MS,
  useCheckoutDisplayTotal,
} from "./useCheckoutDisplayTotal";
import { summarySurfaceOrder } from "./surface-orders";
import {
  expectSummarySumsToTotal,
  summaryRows,
} from "./checkout-row-sums.test-helpers";
import type { CheckoutPhase } from "./useCheckoutState";
import {
  estimateCartTotal,
  type FeeRatesForOrderEstimate,
} from "@/lib/pricing/order-estimate";

const formatPrice = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

const RATES: FeeRatesForOrderEstimate = {
  feeMode: "PASS_THROUGH",
  admissionTaxRateBps: 888,
  taxImpositions: [
    { code: "SALES", label: "Sales tax", jurisdiction: "US/NY", rateBps: 888, base: "TICKET_FACE", collector: "PLATFORM" },
  ],
  processorPct: 0.029,
  processorFixedCents: 30,
  maxPlatformFeeCents: null,
  platformFeeRates: { buyerFeePct: 0.0333, maxFeeCents: 50, minFeeCents: 0, platformFixedCents: 0 },
  perTicketEstimates: [
    { ticketTypeId: "tt-ga", unitPriceCents: 3500, platformFeeCents: 50 },
    { ticketTypeId: "tt-pwyw", unitPriceCents: 500, platformFeeCents: 17 },
  ],
};

type Props = {
  amountCents: number;
  invalid?: boolean;
  discountCents?: number;
  /** Fee rates failed to load (outage): no estimate, no held charge. */
  feeRates?: FeeRatesForOrderEstimate | undefined;
  phase?: CheckoutPhase;
  order?: OrderSummaryOrder | null;
  /** The tax query's data (undefined = it failed). */
  taxEstimate?:
    | {
        taxRateBps?: number | null;
        taxAmountCents?: number | null;
        taxImpositions?: FeeRatesForOrderEstimate["taxImpositions"];
      }
    | undefined;
};

/** Checkout's wiring, minus everything that isn't the total. */
const Harness = ({
  amountCents,
  invalid = false,
  discountCents = 550,
  feeRates = RATES,
  phase = "selecting",
  order = null,
  taxEstimate,
}: Props) => {
  const orderEstimate = estimateCartTotal(
    feeRates,
    [
      { ticketTypeId: "tt-ga", qty: 1, priceCents: 3500 },
      { ticketTypeId: "tt-pwyw", qty: 1, priceCents: 0, chosenAmountCents: amountCents },
    ],
    { discountCents },
  );
  const { displayTotalCents, displayTaxCents, liveAnnouncement } =
    useCheckoutDisplayTotal({
      heldCharge: null,
      totalUnavailable: invalid && !order,
      order,
      phase,
      isDisplaySubtotalKnown: orderEstimate !== null,
      displaySubtotalCents: orderEstimate?.totalCents ?? 0,
      livePromoDiscountCents: discountCents,
      taxEstimate,
      feeMode: "PASS_THROUGH",
      formatPrice,
    });
  return (
    <>
      <div data-testid="live-region" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>
      <OrderSummary
        preHoldEstimate={orderEstimate}
        displayTotalCents={displayTotalCents}
        displayTaxCents={displayTaxCents}
        estimateUnavailable={invalid && !order}
        ticketTypes={[
          { id: "tt-ga", name: "General Admission", priceCents: 3500 },
          {
            id: "tt-pwyw",
            name: "Pay What You Want",
            priceCents: 0,
            chosenAmountCents: amountCents,
            chosenAmountInvalid: invalid,
          },
        ]}
        quantities={{ "tt-ga": 1, "tt-pwyw": 1 }}
        selectedQty={2}
        subtotalCents={orderEstimate?.totalCents ?? 0}
        order={summarySurfaceOrder(order, displayTaxCents)}
        orderId={order ? "order-1" : null}
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={["WELCOME10"]}
        promoDiscountCents={discountCents}
        feeMode="PASS_THROUGH"
        taxRateBps={taxEstimate?.taxRateBps ?? null}
        taxImpositions={taxEstimate?.taxImpositions}
      />
    </>
  );
};

const CURRENCY_FIGURE = /\$\s?[\d,]+(\.\d{2})?/;
// The region announces a total once it has SETTLED (a slider drag must not
// narrate every figure it passes), so reading the announcement lets the
// pending one speak first.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
const announced = () => {
  act(() => {
    vi.advanceTimersByTime(TOTAL_ANNOUNCE_SETTLE_MS);
  });
  return (screen.getByTestId("live-region").textContent ?? "").replace(/^.*:/, "");
};
const visibleTotal = () =>
  screen.getByTestId("order-summary-total-value").textContent ?? "";

describe("Checkout total — the live region only ever says what the screen shows", () => {
  it("regression: GA + PWYW $1,500 announced, then $15,000 (over the cap) → '—' on screen and NO figure in the live region", () => {
    const { rerender } = render(<Harness amountCents={2000} />);
    // Typing passes through a valid $1,500 — announced, and it IS the
    // summary's total row.
    rerender(<Harness amountCents={150_000} />);
    expect(announced()).toBe(visibleTotal());
    expect(visibleTotal()).toMatch(CURRENCY_FIGURE);
    // …and the summary's rows add up to it (equal totals alone prove
    // nothing: both are handed the same number).
    expectSummarySumsToTotal(summaryRows());

    // One more 0: $15,000 is over the cap. The screen shows "—" …
    rerender(<Harness amountCents={1_500_000} invalid />);
    expect(screen.getByText("—")).toBeInTheDocument();
    // … so the live region must not still be saying a dollar figure.
    expect(screen.getByTestId("live-region").textContent ?? "").not.toMatch(CURRENCY_FIGURE);
  });

  it("a slider drag: the summary total follows every amount, the region speaks once — the total the handle stopped on", () => {
    const { rerender } = render(<Harness amountCents={1500} />);
    const region = () => screen.getByTestId("live-region").textContent ?? "";
    const seen: string[] = [];
    for (const amountCents of [1600, 1800, 2100, 2500]) {
      rerender(<Harness amountCents={amountCents} />);
      seen.push(visibleTotal());
      act(() => {
        vi.advanceTimersByTime(TOTAL_ANNOUNCE_SETTLE_MS / 5);
      });
      expect(region()).toBe("");
    }
    // Every move reached the screen...
    expect(new Set(seen).size).toBe(4);
    // ...and only the last one reached the screen reader.
    expect(announced()).toBe(visibleTotal());
    expect(visibleTotal()).toBe(seen[3]);
    expectSummarySumsToTotal(summaryRows());
  });

  it("once the amount is valid again, the shown total is announced", () => {
    const { rerender } = render(<Harness amountCents={150_000} />);
    rerender(<Harness amountCents={1_500_000} invalid />);
    rerender(<Harness amountCents={2500} />);
    expect(announced()).toBe(visibleTotal());
    expect(visibleTotal()).toMatch(CURRENCY_FIGURE);
    expectSummarySumsToTotal(summaryRows());
  });
});

describe("Checkout total — a failed query never splits the live region from the screen", () => {
  it("the promo preview fails (discount drops to 0): the announcement follows the visible total", () => {
    const { rerender } = render(<Harness amountCents={2000} discountCents={550} />);
    rerender(<Harness amountCents={2500} discountCents={550} />);
    expect(announced()).toBe(visibleTotal());
    // The preview for the new cart failed — no discount any more.
    rerender(<Harness amountCents={2500} discountCents={0} />);
    expect(announced()).toBe(visibleTotal());
    expectSummarySumsToTotal(summaryRows());
  });

  it("regression: held, fee rates AND the tax query failed — the summary's total and the announcement are the same number", () => {
    // A held order carrying its own tax figure (the shape step 2 gets back
    // from createCheckout), with every live query down: no fee rates (so no
    // held charge), no tax estimate, no preview discount. The summary used to
    // total it with the order's tax while the hook used the (missing) tax
    // estimate: two different dollar figures on screen and in the region.
    const order: OrderSummaryOrder = {
      amountGrossCents: 5500,
      feesPlatformCents: 100,
      buyerFeesCents: 100,
      processorFeeCents: 199,
      taxAmountCents: 488,
      items: [
        { kind: "ticket", ticketTypeId: "tt-ga", qty: 1, unitPriceCents: 3500, amountCents: 3500 },
        { kind: "ticket", ticketTypeId: "tt-pwyw", qty: 1, unitPriceCents: 2000, amountCents: 2000 },
      ],
    };
    const { rerender } = render(
      <Harness amountCents={2000} phase="held" order={{ ...order, amountGrossCents: 5000 }} feeRates={undefined} discountCents={0} />,
    );
    rerender(
      <Harness amountCents={2000} phase="held" order={order} feeRates={undefined} discountCents={0} taxEstimate={undefined} />,
    );
    expect(visibleTotal()).toMatch(CURRENCY_FIGURE);
    expect(announced()).toBe(visibleTotal());
    expectSummarySumsToTotal(summaryRows());
  });

  it("held, fee rates unavailable, WELCOME10: the Taxes row is the tax inside the announced total — rows summing", () => {
    const order: OrderSummaryOrder = {
      amountGrossCents: 5500,
      feesPlatformCents: 100,
      buyerFeesCents: 100,
      processorFeeCents: 199,
      taxAmountCents: 488,
      items: [
        { kind: "ticket", ticketTypeId: "tt-ga", qty: 1, unitPriceCents: 3500, amountCents: 3500 },
        { kind: "ticket", ticketTypeId: "tt-pwyw", qty: 1, unitPriceCents: 2000, amountCents: 2000 },
      ],
    };
    // The quote's shape: `estimateCheckoutTax` returns every line it applied.
    const tax = { taxRateBps: 888, taxAmountCents: 488, taxImpositions: RATES.taxImpositions };
    // The region announces CHANGES: held first, then the code applies.
    const { rerender } = render(
      <Harness amountCents={2000} phase="held" order={order} feeRates={undefined} discountCents={0} taxEstimate={tax} />,
    );
    rerender(
      <Harness amountCents={2000} phase="held" order={order} feeRates={undefined} discountCents={550} taxEstimate={tax} />,
    );
    expect(announced()).toBe(visibleTotal());
    expect(screen.getByTestId("order-summary-tax-value").textContent).toBe("$4.40");
    expectSummarySumsToTotal(summaryRows());
  });
});
