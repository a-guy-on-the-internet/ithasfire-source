import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  Spinner: () => <span />,
  // Echo the key, so assertions can tell catalog copy from a literal.
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));

import { MobileCTABar } from "./MobileCTABar";
import { expectTraySumsToButton, trayRows } from "./checkout-row-sums.test-helpers";
import {
  estimateCartTotal,
  type FeeRatesForOrderEstimate,
} from "@/lib/pricing/order-estimate";

const formatPrice = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

const GA = { id: "tt-ga", name: "General Admission", priceCents: 3500 };
const PWYW = {
  id: "tt-pwyw",
  name: "Pay What You Want",
  priceCents: 0,
  chosenAmountCents: 2000,
};

/** The live drive's held cart: $55.00, WELCOME10 −$5.50, total $56.85. */
const HELD = {
  amountGrossCents: 5500,
  feesPlatformCents: 100,
  buyerFeesCents: 100,
  processorFeeCents: 195,
  taxAmountCents: 440,
  items: [
    { kind: "ticket", ticketTypeId: "tt-ga", qty: 1, unitPriceCents: 3500, amountCents: 3500 },
    { kind: "ticket", ticketTypeId: "tt-pwyw", qty: 1, unitPriceCents: 2000, amountCents: 2000 },
  ],
};

// The bar is `display: none` outside its phone-width @media rule, which jsdom
// does not evaluate — so the toggle is queried with `hidden: true`.
const open = () =>
  fireEvent.click(
    screen.getByRole("button", { expanded: false, hidden: true }),
  );

describe("MobileCTABar — the tray's rows sum to its button", () => {
  it("regression: with WELCOME10 the tray shows the −$5.50 discount row", () => {
    render(
      <MobileCTABar
        preHoldEstimate={null}
        totalLabel="$56.85"
        ticketTypes={[GA, PWYW]}
        quantities={{ "tt-ga": 1, "tt-pwyw": 1 }}
        formatPrice={formatPrice}
        subtotalCents={5500}
        order={HELD}
        feeMode="PASS_THROUGH"
        promoDiscountCents={550}
        memberDiscounts={[]}
      />,
    );
    open();
    expect(screen.getByTestId("mobile-cta-discount-row")).toHaveTextContent(
      "−$5.50",
    );
    // 35 + 20 + 1.00 + 1.95 + 4.40 − 5.50 = 56.85
  });

  it("member benefits get labelled lines; the code remainder stays on Discount", () => {
    render(
      <MobileCTABar
        preHoldEstimate={null}
        totalLabel="$56.85"
        ticketTypes={[GA]}
        quantities={{ "tt-ga": 1 }}
        formatPrice={formatPrice}
        subtotalCents={3500}
        order={HELD}
        feeMode="PASS_THROUGH"
        promoDiscountCents={550}
        memberDiscounts={[{ tierName: "Gold", label: null, discountCents: 300 }]}
      />,
    );
    open();
    expect(
      screen.getByTestId("mobile-cta-member-discount-row"),
    ).toHaveTextContent("checkout.memberDiscountTier:Gold");
    expect(screen.getByTestId("mobile-cta-discount-row")).toHaveTextContent(
      "−$2.50",
    );
  });

  it("ABSORB: the platform fee is shown as Included, not as a charged row", () => {
    render(
      <MobileCTABar
        preHoldEstimate={null}
        totalLabel="$53.90"
        ticketTypes={[GA]}
        quantities={{ "tt-ga": 1 }}
        formatPrice={formatPrice}
        subtotalCents={3500}
        order={{ ...HELD, buyerFeesCents: 0 }}
        feeMode="ABSORB"
      />,
    );
    open();
    expect(
      within(screen.getByTestId("mobile-cta-platform-fee-included")).getByText(
        "checkout.included",
      ),
    ).toBeInTheDocument();
  });

  it("an invalid PWYW amount is never quoted on its line", () => {
    render(
      <MobileCTABar
        preHoldEstimate={null}
        totalLabel="—"
        ticketTypes={[{ ...PWYW, chosenAmountCents: 1_500_000, chosenAmountInvalid: true }]}
        quantities={{ "tt-pwyw": 1 }}
        formatPrice={formatPrice}
        subtotalCents={0}
        order={null}
      />,
    );
    open();
    expect(screen.getByText("checkout.pwywEnterValidAmount")).toBeInTheDocument();
    expect(screen.queryByText("$15,000.00")).not.toBeInTheDocument();
  });
});

describe("MobileCTABar — a fee waiver the hold priced is explained", () => {
  it("regression: the tray says the fee waiver applied, with the amount", () => {
    render(
      <MobileCTABar
        preHoldEstimate={null}
        totalLabel="$56.35"
        ticketTypes={[GA, PWYW]}
        quantities={{ "tt-ga": 1, "tt-pwyw": 1 }}
        formatPrice={formatPrice}
        subtotalCents={5500}
        order={{
          ...HELD,
          feesPlatformCents: 50,
          buyerFeesCents: 50,
          items: [
            { ...HELD.items[0]!, meta: { platformFeeWaivedCents: 50 } },
            HELD.items[1]!,
          ],
        }}
        feeMode="PASS_THROUGH"
      />,
    );
    open();
    expect(screen.getByTestId("mobile-cta-fee-waived")).toHaveTextContent(
      "checkout.platformFeeWaived:$0.50",
    );
  });
});


describe("MobileCTABar — step 1 tray: the same rows, adding up to the button", () => {
  // GA $35 + PWYW $20, NY 8.88% — every figure from a REAL estimateCartTotal.
  const rates = (feeMode: "PASS_THROUGH" | "ABSORB"): FeeRatesForOrderEstimate => {
    const passThrough = feeMode === "PASS_THROUGH";
    return {
      feeMode,
      admissionTaxRateBps: 888,
      taxImpositions: [
        { code: "SALES", label: "Sales tax", jurisdiction: "US/NY", rateBps: 888, base: "TICKET_FACE", collector: "PLATFORM" },
      ],
      processorPct: passThrough ? 0.029 : null,
      processorFixedCents: passThrough ? 30 : null,
      maxPlatformFeeCents: null,
      platformFeeRates: passThrough
        ? { buyerFeePct: 0.0333, maxFeeCents: 50, minFeeCents: 0, platformFixedCents: 0 }
        : null,
      perTicketEstimates: [
        { ticketTypeId: "tt-ga", unitPriceCents: 3500, platformFeeCents: passThrough ? 50 : 0 },
        { ticketTypeId: "tt-pwyw", unitPriceCents: 500, platformFeeCents: passThrough ? 17 : 0 },
      ],
    };
  };
  const estimateFor = (feeMode: "PASS_THROUGH" | "ABSORB", discountCents: number) =>
    estimateCartTotal(
      rates(feeMode),
      [
        { ticketTypeId: "tt-ga", qty: 1, priceCents: 3500 },
        { ticketTypeId: "tt-pwyw", qty: 1, priceCents: 0, chosenAmountCents: 2000 },
      ],
      { discountCents },
    )!;
  const renderTray = (
    feeMode: "PASS_THROUGH" | "ABSORB",
    discountCents: number,
    memberDiscounts: Array<{ tierName: string | null; label: string | null; discountCents: number }> = [],
  ) => {
    const estimate = estimateFor(feeMode, discountCents);
    render(
      <MobileCTABar
        totalLabel={formatPrice(estimate.totalCents)}
        ticketTypes={[{ ...GA, buyerUnitTotalCents: 4008 }, PWYW]}
        quantities={{ "tt-ga": 1, "tt-pwyw": 1 }}
        formatPrice={formatPrice}
        subtotalCents={estimate.totalCents}
        order={null}
        preHoldEstimate={estimate}
        feeMode={feeMode}
        taxRateBps={888}
        platformFeeRateLabel={feeMode === "PASS_THROUGH" ? "3.33%, max $0.50/ticket" : null}
        processorFeeRateLabel={feeMode === "PASS_THROUGH" ? "2.9% + $0.30" : null}
        promoDiscountCents={discountCents}
        memberDiscounts={memberDiscounts}
      />,
    );
    open();
    return estimate;
  };

  it("regression: lines at face, Subtotal, fee and tax rows, the discount — summing to the button's $56.85", () => {
    renderTray("PASS_THROUGH", 550);
    const r = trayRows();
    expect(r).toEqual({
      lines: [3500, 2000],
      subtotal: 5500,
      platform: 100,
      processing: 195,
      tax: 440,
      discounts: [550],
      button: 5685,
    });
    expectTraySumsToButton(r);
    expect(screen.queryByText("$40.08")).not.toBeInTheDocument();
  });

  it("regression: the tray's labels match the summary's — Subtotal, Taxes (8.88%), rate labels via the catalog key", () => {
    renderTray("PASS_THROUGH", 550);
    expect(screen.getByText("checkout.subtotal")).toBeInTheDocument();
    expect(screen.getByText("(8.88%)")).toBeInTheDocument();
    expect(screen.getByText("checkout.feeRateLabel:3.33%, max $0.50/ticket")).toBeInTheDocument();
    expect(screen.getByText("checkout.feeRateLabel:2.9% + $0.30")).toBeInTheDocument();
  });

  it("ABSORB: platform and processing read 'Included' with no figure; the rows still sum to the button", () => {
    const estimate = renderTray("ABSORB", 0);
    expect(screen.getByTestId("mobile-cta-platform-fee-included").textContent).not.toMatch(/\$/);
    expect(screen.getByTestId("mobile-cta-processing-fee-included").textContent).not.toMatch(/\$/);
    const r = trayRows();
    expect(r.button).toBe(estimate.totalCents);
    expectTraySumsToButton(r);
  });

  it("a member benefit and a code: labelled member row + the code remainder on Discount; the rows sum to the button", () => {
    renderTray("PASS_THROUGH", 1050, [{ tierName: "Gold", label: null, discountCents: 500 }]);
    const r = trayRows();
    expect(r.discounts).toEqual([500, 550]);
    expectTraySumsToButton(r);
  });

  it("no estimate (calculating, or an invalid amount): no fee, tax or discount rows", () => {
    render(
      <MobileCTABar
        totalLabel="—"
        ticketTypes={[GA, PWYW]}
        quantities={{ "tt-ga": 1, "tt-pwyw": 1 }}
        formatPrice={formatPrice}
        subtotalCents={0}
        order={null}
        preHoldEstimate={null}
        feeMode="PASS_THROUGH"
        promoDiscountCents={550}
      />,
    );
    open();
    expect(screen.queryByTestId("mobile-cta-platform-fee-value")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-cta-tax-value")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-cta-discount-row")).not.toBeInTheDocument();
  });
});
