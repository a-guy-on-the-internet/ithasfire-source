import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * The desktop summary and the mobile tray, wired as Checkout wires them: the
 * display-total hook's ONE total and ONE tax figure, the surface orders from
 * `surface-orders.ts`, the held charge. Equal totals prove nothing on their
 * own — both surfaces are handed the same number — so every case also checks
 * that each surface's ROWS add up to the total it displays.
 */

vi.mock("@th/ui", () => ({
  Spinner: () => <span />,
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));
vi.mock("./PromoCodeInput", () => ({
  PromoCodeInput: () => <div data-testid="promo-code-input" />,
}));

import { OrderSummary, type OrderSummaryMemberDiscount } from "./OrderSummary";
import { MobileCTABar } from "./MobileCTABar";
import { useCheckoutDisplayTotal } from "./useCheckoutDisplayTotal";
import { summarySurfaceOrder, traySurfaceOrder } from "./surface-orders";
import type { CheckoutPhase } from "./useCheckoutState";
import {
  expectSummarySumsToTotal,
  expectTraySumsToButton,
  summaryRows,
  trayRows,
} from "./checkout-row-sums.test-helpers";
import {
  estimateCartTotal,
  estimateHeldOrderCharge,
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

const TICKET_TYPES = [
  { id: "tt-ga", name: "General Admission", priceCents: 3500 },
  { id: "tt-pwyw", name: "Pay What You Want", priceCents: 0, chosenAmountCents: 2000 },
];
const QUANTITIES = { "tt-ga": 1, "tt-pwyw": 1 };
const POST_CHECKOUT = new Set<CheckoutPhase>(["paying", "confirming", "confirmed", "done"]);

/** The held lines (per unit), as updateOrderItems writes them. */
const LINES = [
  { kind: "ticket", ticketTypeId: "tt-ga", qty: 1, unitPriceCents: 3500, amountCents: 3500 },
  { kind: "ticket", ticketTypeId: "tt-pwyw", qty: 1, unitPriceCents: 2000, amountCents: 2000 },
];

type HarnessOrder = {
  amountGrossCents: number;
  feesPlatformCents: number;
  buyerFeesCents: number;
  processorFeeCents: number;
  taxAmountCents?: number;
  creditAppliedCents?: number;
  items: typeof LINES;
};

/**
 * The held order: GA $35 + PWYW $20, pre-discount. It carries the hold's
 * own UNDISCOUNTED tax ($4.88) and simple-markup processing fee ($1.99) —
 * the figures that must not leak onto a surface once a discount applies.
 */
const HELD: HarnessOrder = {
  amountGrossCents: 5500,
  feesPlatformCents: 100,
  buyerFeesCents: 100,
  processorFeeCents: 199,
  taxAmountCents: 488,
  items: LINES,
};

type HarnessProps = {
  phase: CheckoutPhase;
  order: HarnessOrder | null;
  discountCents: number;
  memberDiscounts?: OrderSummaryMemberDiscount[];
  /** Fee rates loaded? (false = outage: no held charge, no step-1 estimate) */
  feeRates?: FeeRatesForOrderEstimate | null;
  taxEstimate?: {
    taxRateBps: number;
    taxAmountCents: number;
    taxImpositions?: FeeRatesForOrderEstimate["taxImpositions"];
  } | null;
};

/** Checkout's wiring of the two surfaces, minus everything else. */
const Harness = ({
  phase,
  order,
  discountCents,
  memberDiscounts = [],
  feeRates = RATES,
  // What `estimateCheckoutTax` returns: the amount, the rate and its lines.
  taxEstimate = {
    taxRateBps: 888,
    taxAmountCents: 488,
    taxImpositions: RATES.taxImpositions,
  },
}: HarnessProps) => {
  const isPostCheckout = POST_CHECKOUT.has(phase);
  const preHoldEstimate = feeRates
    ? estimateCartTotal(
        feeRates,
        [
          { ticketTypeId: "tt-ga", qty: 1, priceCents: 3500 },
          { ticketTypeId: "tt-pwyw", qty: 1, priceCents: 0, chosenAmountCents: 2000 },
        ],
        { discountCents },
      )
    : null;
  const heldCharge =
    order && !isPostCheckout
      ? estimateHeldOrderCharge(
          feeRates,
          { ...order, feeMode: "PASS_THROUGH" },
          discountCents,
        )
      : null;
  const { displayTotalCents, displayTaxCents, displayTotalLabel } =
    useCheckoutDisplayTotal({
      heldCharge,
      order,
      phase,
      isDisplaySubtotalKnown: preHoldEstimate != null,
      displaySubtotalCents: preHoldEstimate?.totalCents ?? 0,
      livePromoDiscountCents: discountCents,
      taxEstimate,
      feeMode: "PASS_THROUGH",
      formatPrice,
    });
  return (
    <>
      <OrderSummary
        preHoldEstimate={preHoldEstimate}
        displayTotalCents={displayTotalCents}
        displayTaxCents={displayTaxCents}
        heldCharge={heldCharge}
        ticketTypes={TICKET_TYPES}
        quantities={QUANTITIES}
        selectedQty={2}
        subtotalCents={preHoldEstimate?.totalCents ?? 0}
        order={summarySurfaceOrder(order, displayTaxCents)}
        orderId={order ? "order-1" : null}
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={discountCents > 0 ? ["WELCOME10"] : []}
        promoDiscountCents={discountCents}
        memberDiscounts={memberDiscounts}
        feeMode="PASS_THROUGH"
        taxRateBps={taxEstimate?.taxRateBps ?? null}
        isPostCheckout={isPostCheckout}
      />
      <MobileCTABar
        totalLabel={displayTotalLabel}
        ticketTypes={TICKET_TYPES}
        quantities={QUANTITIES}
        formatPrice={formatPrice}
        subtotalCents={preHoldEstimate?.totalCents ?? 0}
        order={traySurfaceOrder(order, displayTaxCents, heldCharge)}
        preHoldEstimate={preHoldEstimate}
        feeMode="PASS_THROUGH"
        taxRateBps={taxEstimate?.taxRateBps ?? null}
        isPostCheckout={isPostCheckout}
        promoDiscountCents={discountCents}
        memberDiscounts={memberDiscounts}
      />
    </>
  );
};

const openTray = () =>
  fireEvent.click(screen.getByRole("button", { expanded: false, hidden: true }));

/** Both surfaces' rows add up, and they show the same total and tax. */
const expectSurfacesAgreeAndSum = () => {
  openTray();
  const summary = summaryRows();
  const tray = trayRows();
  expectSummarySumsToTotal(summary);
  expectTraySumsToButton(tray);
  expect(tray.button).toBe(summary.total);
  expect(tray.tax).toBe(summary.tax);
  expect(tray.subtotal).toBe(summary.subtotal);
  return { summary, tray };
};

/** createCheckout's answer for HELD with WELCOME10: gross AFTER the discount. */
const charged = (taxAmountCents: number): HarnessOrder => ({
  amountGrossCents: 4950,
  feesPlatformCents: 100,
  buyerFeesCents: 100,
  processorFeeCents: 195,
  taxAmountCents,
  creditAppliedCents: 0,
  items: LINES,
});

describe("summary ⇄ tray — the rows of each add up to the total it shows", () => {
  it("step 1 (estimate), WELCOME10: $56.85 on both, rows summing", () => {
    render(<Harness phase="selecting" order={null} discountCents={550} />);
    const { summary } = expectSurfacesAgreeAndSum();
    expect(summary.total).toBe(5685);
  });

  it("held, fee rates loaded, member benefit + code: the solved charge on both", () => {
    render(
      <Harness
        phase="held"
        order={HELD}
        discountCents={1050}
        memberDiscounts={[{ tierName: "Gold", label: null, discountCents: 500 }]}
      />,
    );
    const { summary, tray } = expectSurfacesAgreeAndSum();
    expect(tray.discounts).toEqual([500, 550]);
    expect(summary.subtotal).toBe(5500);
  });

  it("regression: held, fee rates UNAVAILABLE, WELCOME10 — the tray's tax is the summary's ($4.40, not the hold's $4.88), both summing", () => {
    render(<Harness phase="held" order={HELD} discountCents={550} feeRates={null} />);
    const { summary, tray } = expectSurfacesAgreeAndSum();
    expect(summary.tax).toBe(440);
    expect(tray.tax).toBe(440);
    expect(screen.queryByText("$4.88")).not.toBeInTheDocument();
  });

  it("post-checkout, WELCOME10: both add the discount back onto the Subtotal, rows summing to the charge", () => {
    render(<Harness phase="paying" order={charged(440)} discountCents={550} />);
    const { summary, tray } = expectSurfacesAgreeAndSum();
    expect(summary.subtotal).toBe(5500);
    expect(tray.subtotal).toBe(5500);
    expect(summary.total).toBe(4950 + 100 + 195 + 440);
  });

  it("regression: post-checkout with a stamped $0 tax — both rows read $0.00, never the cached $4.88 estimate", () => {
    render(<Harness phase="paying" order={charged(0)} discountCents={550} />);
    const { summary } = expectSurfacesAgreeAndSum();
    expect(screen.getByTestId("order-summary-tax-value")).toHaveTextContent("$0.00");
    expect(screen.getByTestId("mobile-cta-tax-value")).toHaveTextContent("$0.00");
    expect(screen.queryByText("$4.88")).not.toBeInTheDocument();
    expect(summary.total).toBe(4950 + 100 + 195);
  });

  it("regression: a held $0 total reads the button's label ('Free') in the summary too", () => {
    render(<Harness phase="held" order={{ ...HELD, buyerFeesCents: 0, feesPlatformCents: 0 }} discountCents={5500} />);
    openTray();
    expect(screen.getByTestId("mobile-cta-total-value").textContent).toBe("common.free");
    expect(screen.getByTestId("order-summary-total-value").textContent).toBe("common.free");
  });
});

describe("summary ⇄ tray — a zero-tax event reads $0.00, never 'Included' (owner ruling 2026-10-01)", () => {
  const ZERO_TAX: FeeRatesForOrderEstimate = {
    ...RATES,
    admissionTaxRateBps: 0,
    taxImpositions: [],
  };
  const noTax = { taxRateBps: 0, taxAmountCents: 0 };
  const expectZeroTaxRows = () => {
    openTray();
    expect(screen.getByTestId("order-summary-tax-value")).toHaveTextContent("$0.00");
    expect(screen.getByTestId("mobile-cta-tax-value")).toHaveTextContent("$0.00");
    // The tax rows say no "Included" (the fee rows are PASS_THROUGH figures).
    expect(screen.queryByText("checkout.included")).not.toBeInTheDocument();
    expectSummarySumsToTotal(summaryRows());
    expectTraySumsToButton(trayRows());
  };

  it("step 1 (estimate)", () => {
    render(<Harness phase="selecting" order={null} discountCents={0} feeRates={ZERO_TAX} taxEstimate={noTax} />);
    expectZeroTaxRows();
  });

  it("step 2 (held)", () => {
    render(
      <Harness
        phase="held"
        order={{ ...HELD, taxAmountCents: 0 }}
        discountCents={0}
        feeRates={ZERO_TAX}
        taxEstimate={noTax}
      />,
    );
    expectZeroTaxRows();
  });

  it("post-checkout (payment step)", () => {
    render(<Harness phase="paying" order={charged(0)} discountCents={550} taxEstimate={noTax} />);
    expectZeroTaxRows();
  });

  it("the rate label stays where there is a rate (8.88%) — the figure is what changed", () => {
    render(<Harness phase="held" order={HELD} discountCents={550} />);
    openTray();
    expect(screen.getAllByText("(8.88%)").length).toBe(2);
  });
});
