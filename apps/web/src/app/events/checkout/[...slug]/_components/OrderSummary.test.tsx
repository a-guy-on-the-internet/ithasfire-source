import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("./PromoCodeInput", () => ({
  PromoCodeInput: () => <div data-testid="promo-code-input" />,
}));

import { OrderSummary } from "./OrderSummary";
import { formatMoneyCents } from "@/lib/format";
import {
  estimateCartTotal,
  type FeeRatesForOrderEstimate,
} from "@/lib/pricing/order-estimate";

/** A real PASS_THROUGH policy (3.33% capped at 50¢, 2.9% + 30¢, NY 8.88%). */
const passThroughRates = (
  perTicket: Array<{ ticketTypeId: string; unitPriceCents: number; platformFeeCents: number }>,
): FeeRatesForOrderEstimate => ({
  feeMode: "PASS_THROUGH",
  admissionTaxRateBps: 888,
  taxImpositions: [
    { code: "SALES", label: "Sales tax", jurisdiction: "US/NY", rateBps: 888, base: "TICKET_FACE", collector: "PLATFORM" },
  ],
  processorPct: 0.029,
  processorFixedCents: 30,
  maxPlatformFeeCents: null,
  platformFeeRates: { buyerFeePct: 0.0333, maxFeeCents: 50, minFeeCents: 0, platformFixedCents: 0 },
  perTicketEstimates: perTicket,
});

// TODO(money-i18n): currency not in scope at this callsite — using USD default.
const formatPrice = (cents: number) => formatMoneyCents(cents);
const hasTextContent = (text: string) => (_: string, element: Element | null) =>
  element?.textContent === text;

describe("OrderSummary buyer-facing totals", () => {
  it("pre-hold, a line is face × qty — not the all-in unit price (owner ruling 2026-10-01)", () => {
    // The production path: Checkout passes the estimateCartTotal result.
    const estimate = estimateCartTotal(
      passThroughRates([{ ticketTypeId: "ticket-vip", unitPriceCents: 2500, platformFeeCents: 50 }]),
      [{ ticketTypeId: "ticket-vip", qty: 2, priceCents: 2500 }],
    )!;
    render(
      <OrderSummary
        preHoldEstimate={estimate}
        feeMode="PASS_THROUGH"
        ticketTypes={[
          {
            id: "ticket-vip",
            name: "VIP",
            priceCents: 2500,
            buyerUnitTotalCents: 3375,
          },
        ]}
        quantities={{ "ticket-vip": 2 }}
        selectedQty={2}
        subtotalCents={5000}
        order={null}
        orderId={null}
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
      />,
    );

    expect(screen.getByText(hasTextContent("2× VIP"))).toBeInTheDocument();
    // Step 1 shows step 2's rows: the line is 2 × $25.00 face, with fees and
    // tax in their own rows. The old all-in "$33.75 each" is gone — no row
    // below could add up to it.
    expect(screen.getByTestId("order-summary-line-value")).toHaveTextContent("$50.00");
    expect(screen.queryByText("checkout.eachPrice")).not.toBeInTheDocument();
    // …and the rows below it come from the same estimate as the total.
    expect(screen.getByTestId("order-summary-subtotal-value")).toHaveTextContent("$50.00");
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent(
      formatPrice(estimate.totalCents),
    );
  });

  it("uses server-stamped order item pricing for lines once an order exists", () => {
    // Pre-hold estimate says $45.43/ticket all-in ($90.86 line) but the held
    // order stamped 2× $40.00 = $80.00 gross. The line must agree with the
    // server Subtotal/Total — not the stale fee-inclusive estimate.
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          {
            id: "ticket-ga",
            name: "General Admission",
            priceCents: 4000,
            buyerUnitTotalCents: 4543,
          },
        ]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={8000}
        order={{
          amountGrossCents: 8000,
          feesPlatformCents: 400,
          buyerFeesCents: 390,
          processorFeeCents: 285,
          taxAmountCents: 400,
          items: [
            {
              kind: "ticket",
              ticketTypeId: "ticket-ga",
              qty: 2,
              unitPriceCents: 4000,
              amountCents: 8000,
            },
          ],
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        isPostCheckout
      />,
    );

    // Line item + Subtotal both show the server basis ($80.00)
    expect(screen.getAllByText("$80.00")).toHaveLength(2);
    expect(screen.queryByText("$90.86")).not.toBeInTheDocument();
    // Total mirrors the PaymentIntent formula: gross + buyer fees + tax
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent(
      "$87.90",
    );
  });

  it("shows applied credit as its own line and subtracts it from Total", () => {
    // $80.00 gross + $3.90 buyer fees + $4.00 tax − $10.00 credit = $77.90 —
    // the Total must match the PaymentIntent amount the buyer is charged.
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          {
            id: "ticket-ga",
            name: "General Admission",
            priceCents: 4000,
            buyerUnitTotalCents: 4543,
          },
        ]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={8000}
        order={{
          amountGrossCents: 8000,
          feesPlatformCents: 400,
          buyerFeesCents: 390,
          processorFeeCents: 285,
          taxAmountCents: 400,
          creditAppliedCents: 1000,
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        isPostCheckout
      />,
    );

    expect(screen.getByTestId("order-summary-credit-row")).toHaveTextContent(
      "checkout.creditApplied",
    );
    expect(screen.getByTestId("order-summary-credit-value")).toHaveTextContent(
      "−$10.00",
    );
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent(
      "$77.90",
    );
  });

  it("hides the credit line when no credit was applied", () => {
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          {
            id: "ticket-ga",
            name: "General Admission",
            priceCents: 4000,
            buyerUnitTotalCents: 4543,
          },
        ]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={8000}
        order={{
          amountGrossCents: 8000,
          feesPlatformCents: 400,
          buyerFeesCents: 390,
          processorFeeCents: 285,
          taxAmountCents: 400,
          creditAppliedCents: 0,
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        isPostCheckout
      />,
    );

    expect(
      screen.queryByTestId("order-summary-credit-row"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent(
      "$87.90",
    );
  });

  it("falls back to base unit pricing when the order carries no items", () => {
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          {
            id: "ticket-ga",
            name: "General Admission",
            priceCents: 4000,
            buyerUnitTotalCents: 4543,
          },
        ]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={8000}
        order={{
          amountGrossCents: 8000,
          feesPlatformCents: 400,
          buyerFeesCents: 390,
          processorFeeCents: 285,
          taxAmountCents: 400,
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        isPostCheckout
      />,
    );

    // Lines stay on the subtotal basis (2 × $40.00), never the estimate
    expect(screen.getAllByText("$80.00")).toHaveLength(2);
    expect(screen.queryByText("$90.86")).not.toBeInTheDocument();
  });

  it("renders the processor fee as a charged line and adds it to the Total for PASS_THROUGH", () => {
    // gross 3500 + platform 50 + processor 137 = 3687; the processor fee is a
    // real charged line (no "Included" annotation) and part of the Total.
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          {
            id: "ticket-ga",
            name: "General Admission",
            priceCents: 3500,
            buyerUnitTotalCents: 3500,
          },
        ]}
        quantities={{ "ticket-ga": 1 }}
        selectedQty={1}
        subtotalCents={3500}
        order={{
          amountGrossCents: 3500,
          feesPlatformCents: 50,
          buyerFeesCents: 50,
          processorFeeCents: 137,
          taxAmountCents: 0,
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        isPostCheckout
        feeMode="PASS_THROUGH"
      />,
    );

    // Processor fee shown as a normal charged line, no "Included" annotation —
    // and the zero-tax row reads "$0.00", not "Included" (owner ruling).
    expect(screen.getByText("$1.37")).toBeInTheDocument();
    expect(screen.queryByText("checkout.included")).not.toBeInTheDocument();
    expect(screen.getByTestId("order-summary-tax-value")).toHaveTextContent(
      "$0.00",
    );
    // Total = 3500 + 50 (buyer fees) + 137 (processor) = 3687.
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent(
      "$36.87",
    );
  });

  it("keeps the processor fee 'Included' and out of the Total for ABSORB", () => {
    // gross 3500 + buyer fees 50 = 3550; processor 137 is absorbed (excluded).
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          {
            id: "ticket-ga",
            name: "General Admission",
            priceCents: 3500,
            buyerUnitTotalCents: 3500,
          },
        ]}
        quantities={{ "ticket-ga": 1 }}
        selectedQty={1}
        subtotalCents={3500}
        order={{
          amountGrossCents: 3500,
          feesPlatformCents: 50,
          buyerFeesCents: 50,
          processorFeeCents: 137,
          taxAmountCents: 0,
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        isPostCheckout
        feeMode="ABSORB"
      />,
    );

    // Processor fee carries the "Included" annotation and is NOT in the Total.
    // Two "checkout.included" renders: the absorbed platform fee and the
    // processor-fee annotation (mocked translator returns raw keys). The
    // zero-tax row reads "$0.00" instead (owner ruling 2026-10-01).
    expect(screen.getAllByText("checkout.included")).toHaveLength(2);
    expect(screen.getByTestId("order-summary-tax-value")).toHaveTextContent(
      "$0.00",
    );
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent(
      "$35.50",
    );
  });

  it("shows the order-level estimate under the estimatedTotal label pre-order", () => {
    // 2 × $45.00 all-in unit $51.09: the naive line sum is $102.18, but the
    // order-level estimate (aggregate tax + single per-order gross-up) is
    // $101.85 — the row must show the estimate, labeled as an estimate.
    render(
      <OrderSummary
        ticketTypes={[
          {
            id: "ticket-ga",
            name: "General Admission",
            priceCents: 4500,
            buyerUnitTotalCents: 5109,
          },
        ]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={10185}
        preHoldEstimate={{
          grossCents: 9000,
          platformFeeCents: 60,
          taxCents: 799,
          processorFeeCents: 326,
          totalCents: 10_185,
        }}
        feeMode="PASS_THROUGH"
        order={null}
        orderId={null}
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
      />,
    );

    // The total row is the order-level estimate, labelled as one; above it
    // the same rows as step 2 (face Subtotal, fees, tax) add up to it.
    expect(screen.getByText("checkout.estimatedTotal")).toBeInTheDocument();
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent("$101.85");
    expect(screen.getByTestId("order-summary-subtotal-value")).toHaveTextContent("$90.00");
    // Never the naive multiplied all-in $102.18, nor "$51.09 each".
    expect(screen.queryByText("checkout.eachPrice")).not.toBeInTheDocument();
    expect(screen.queryByText("$102.18")).not.toBeInTheDocument();
  });

  it("labels a membership-granted discount with its tier and keeps the typed remainder on the Discount row", () => {
    // $10.00 total discount = $8.00 member benefit (Gold) + $2.00 typed code.
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          {
            id: "ticket-ga",
            name: "General Admission",
            priceCents: 4000,
            buyerUnitTotalCents: 4543,
          },
        ]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={8000}
        order={{
          amountGrossCents: 8000,
          feesPlatformCents: 400,
          buyerFeesCents: 390,
          processorFeeCents: 285,
          taxAmountCents: 400,
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={["EARLYBIRD"]}
        promoDiscountCents={1000}
        memberDiscounts={[{ tierName: "Gold", label: null, discountCents: 800 }]}
        isPostCheckout
      />,
    );

    // Labelled member line (mocked translator returns the raw key for the
    // tier-name variant) with only the member portion.
    expect(
      screen.getByTestId("order-summary-member-discount-row"),
    ).toHaveTextContent("checkout.memberDiscountTier");
    expect(
      screen.getByTestId("order-summary-member-discount-value"),
    ).toHaveTextContent("−$8.00");
    // Generic Discount row keeps only the typed-code remainder.
    expect(
      screen.getByTestId("order-summary-discount-value"),
    ).toHaveTextContent("−$2.00");
    // Total math is unchanged — driven by the full promoDiscountCents.
    // gross 8000 + buyerFees 390 + tax 400 = 8790 (post-discount gross).
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent(
      "$87.90",
    );
  });

  it("hides the generic Discount row when the whole discount is membership-granted", () => {
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          {
            id: "ticket-ga",
            name: "General Admission",
            priceCents: 4000,
            buyerUnitTotalCents: 4543,
          },
        ]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={8000}
        order={{
          amountGrossCents: 8000,
          feesPlatformCents: 400,
          buyerFeesCents: 390,
          processorFeeCents: 285,
          taxAmountCents: 400,
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        promoDiscountCents={800}
        memberDiscounts={[{ tierName: null, label: null, discountCents: 800 }]}
        isPostCheckout
      />,
    );

    // Null tier name → plain "Member discount" label.
    expect(
      screen.getByTestId("order-summary-member-discount-row"),
    ).toHaveTextContent("checkout.memberDiscount");
    expect(
      screen.queryByTestId("order-summary-discount-row"),
    ).not.toBeInTheDocument();
  });

  it("renders plain promo discounts exactly as before when no member discounts exist", () => {
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          {
            id: "ticket-ga",
            name: "General Admission",
            priceCents: 4000,
            buyerUnitTotalCents: 4543,
          },
        ]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={8000}
        order={{
          amountGrossCents: 8000,
          feesPlatformCents: 400,
          buyerFeesCents: 390,
          processorFeeCents: 285,
          taxAmountCents: 400,
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={["EARLYBIRD"]}
        promoDiscountCents={1000}
        isPostCheckout
      />,
    );

    expect(
      screen.queryByTestId("order-summary-member-discount-row"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("order-summary-discount-row")).toHaveTextContent(
      "checkout.discount",
    );
    expect(
      screen.getByTestId("order-summary-discount-value"),
    ).toHaveTextContent("−$10.00");
  });

  it("shows calculatingTotal for the estimate row while the order estimate is null", () => {
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          {
            id: "ticket-ga",
            name: "General Admission",
            priceCents: 4500,
            buyerUnitTotalCents: 5109,
          },
        ]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={0}
        order={null}
        orderId={null}
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
      />,
    );

    expect(screen.getByText("checkout.estimatedTotal")).toBeInTheDocument();
    expect(screen.getByText("checkout.calculatingTotal")).toBeInTheDocument();
  });

  it("shows calculatingTotal when a paid buyer total is still unresolved", () => {
    render(
      <OrderSummary
        ticketTypes={[
          {
            id: "ticket-ga",
            name: "General Admission",
            priceCents: 2500,
            buyerUnitTotalCents: null,
          },
        ]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={5000}
        preHoldEstimate={null}
        order={null}
        orderId={null}
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
      />,
    );

    expect(
      screen.getByText(hasTextContent("2× General Admission")),
    ).toBeInTheDocument();
    // The line is face × qty (known without fee rates); the total — and every
    // fee/tax row — waits for the estimate: "Calculating…", no partial sums.
    expect(screen.getByTestId("order-summary-line-value")).toHaveTextContent("$50.00");
    expect(screen.getAllByText("checkout.calculatingTotal")).toHaveLength(1);
    expect(screen.queryByTestId("order-summary-subtotal-value")).not.toBeInTheDocument();
  });
});

describe("OrderSummary — pay what you want (ADJUSTABLE) lines", () => {
  const PWYW = {
    id: "ticket-pwyw",
    name: "Pay What You Want",
    // Stored list price of every PWYW tier — what the line used to read.
    priceCents: 0,
    buyerUnitTotalCents: 0,
    chosenAmountCents: 1500,
  };

  it("regression: pre-hold the line is chosen × qty and the estimate adds fees + tax, not Free", () => {
    // The production path: the estimateCartTotal result for 2 × $15.
    const estimate = estimateCartTotal(
      passThroughRates([{ ticketTypeId: "ticket-pwyw", unitPriceCents: 500, platformFeeCents: 17 }]),
      [{ ticketTypeId: "ticket-pwyw", qty: 2, priceCents: 0, chosenAmountCents: 1500 }],
    )!;
    render(
      <OrderSummary
        preHoldEstimate={estimate}
        feeMode="PASS_THROUGH"
        ticketTypes={[PWYW]}
        quantities={{ "ticket-pwyw": 2 }}
        selectedQty={2}
        subtotalCents={3000}
        // $30.00 face + 100¢ platform + 266¢ tax + gross-up — from estimateCartTotal.
        order={null}
        orderId={null}
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
      />,
    );

    expect(
      screen.getByText(hasTextContent("2× Pay What You Want")),
    ).toBeInTheDocument();
    expect(screen.getByTestId("order-summary-line-value")).toHaveTextContent("$30.00");
    // The line total is the amount, not "each" of a fee-inclusive unit.
    expect(screen.queryByText("checkout.eachPrice")).not.toBeInTheDocument();
    // $30.00 face + 100¢ platform + 266¢ tax + the processing gross-up.
    expect(estimate).toMatchObject({ grossCents: 3000, platformFeeCents: 100, taxCents: 266 });
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent(
      formatPrice(estimate.totalCents),
    );
    expect(screen.queryByText("common.free")).not.toBeInTheDocument();
  });

  it("after the hold the server's line amount wins over the chosen amount", () => {
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[PWYW]}
        quantities={{ "ticket-pwyw": 1 }}
        selectedQty={1}
        subtotalCents={1500}
        order={{
          amountGrossCents: 1600,
          feesPlatformCents: 50,
          buyerFeesCents: 50,
          processorFeeCents: 80,
          taxAmountCents: 142,
          items: [
            {
              kind: "ticket",
              ticketTypeId: "ticket-pwyw",
              qty: 1,
              unitPriceCents: 1600,
              amountCents: 1600,
            },
          ],
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
      />,
    );
    // Line + Subtotal both read the server basis.
    expect(screen.getAllByText("$16.00")).toHaveLength(2);
    expect(screen.queryByText("$15.00")).not.toBeInTheDocument();
  });
});

describe("OrderSummary — a previewed promo, before and during the hold", () => {
  const GA = { id: "ticket-ga", name: "General Admission", priceCents: 3500, buyerUnitTotalCents: 4008 };

  it("regression: pre-hold, the discount is shown and the estimated total includes it", () => {
    render(
      <OrderSummary
        ticketTypes={[GA]}
        quantities={{ "ticket-ga": 1 }}
        selectedQty={1}
        subtotalCents={3500}
        // estimateCartTotal(…, { discountCents: 350 }): 3500 − 350 + 519 tax
        preHoldEstimate={{
          grossCents: 3500,
          platformFeeCents: 0,
          taxCents: 519,
          processorFeeCents: 0,
          totalCents: 3669,
        }}
        order={null}
        orderId={null}
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={["WELCOME10"]}
        promoDiscountCents={350}
      />,
    );
    // The discount sits where step 2 has it — above the total, which already
    // includes it.
    expect(screen.getByTestId("order-summary-discount-row")).toHaveTextContent("−$3.50");
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent("$36.69");
  });

  it("held: tax, processing and total come from the solved held charge", () => {
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[GA]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={5500}
        heldCharge={{ taxCents: 440, processorFeeCents: 195, totalCents: 5685 }}
        order={{
          amountGrossCents: 5500,
          feesPlatformCents: 100,
          buyerFeesCents: 100,
          // The hold's pre-discount figures — must NOT be what is shown.
          processorFeeCents: 213,
          taxAmountCents: 488,
          items: [],
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={["WELCOME10"]}
        promoDiscountCents={550}
        taxRateBps={888}
        feeMode="PASS_THROUGH"
      />,
    );
    expect(screen.getByTestId("order-summary-tax-value")).toHaveTextContent("$4.40");
    expect(screen.getByText("$1.95")).toBeInTheDocument();
    expect(screen.queryByText("$2.13")).not.toBeInTheDocument();
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent("$56.85");
  });

  it("once the server is authoritative, its stamped numbers win over any held estimate", () => {
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[GA]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={5500}
        heldCharge={{ taxCents: 1, processorFeeCents: 1, totalCents: 1 }}
        order={{
          amountGrossCents: 4950,
          feesPlatformCents: 100,
          buyerFeesCents: 100,
          processorFeeCents: 195,
          taxAmountCents: 440,
          items: [],
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={["WELCOME10"]}
        promoDiscountCents={550}
        feeMode="PASS_THROUGH"
        isPostCheckout
      />,
    );
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent("$56.85");
  });
});

describe("OrderSummary — an invalid PWYW amount is never quoted", () => {
  it("regression: the line asks for a valid amount and the estimate reads '—'", () => {
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          {
            id: "ticket-pwyw",
            name: "Pay What You Want",
            priceCents: 0,
            chosenAmountCents: 1_500_000,
            chosenAmountInvalid: true,
          },
        ]}
        quantities={{ "ticket-pwyw": 1 }}
        selectedQty={1}
        subtotalCents={1_500_000}
        estimateUnavailable
        order={null}
        orderId={null}
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
      />,
    );
    expect(screen.getByText("checkout.pwywEnterValidAmount")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("$15,000.00")).not.toBeInTheDocument();
    expect(screen.queryByText("$16,815.00")).not.toBeInTheDocument();
  });
});


describe("OrderSummary — rows sum to the Total", () => {
  it("regression: ABSORB shows the platform fee as Included, not as a charged row", () => {
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[{ id: "ticket-ga", name: "GA", priceCents: 3500 }]}
        quantities={{ "ticket-ga": 1 }}
        selectedQty={1}
        subtotalCents={3500}
        order={{
          amountGrossCents: 3500,
          feesPlatformCents: 50,
          buyerFeesCents: 0,
          processorFeeCents: 132,
          taxAmountCents: 311,
          items: [],
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        feeMode="ABSORB"
      />,
    );
    expect(
      screen.getByTestId("order-summary-platform-fee-included"),
    ).toHaveTextContent("checkout.included");
    // 35.00 + 3.11 tax — the absorbed fees are not in it.
    expect(screen.getByTestId("order-summary-total-value")).toHaveTextContent(
      "$38.11",
    );
  });

  it("before the hold, member benefits are split out of the Discount row", () => {
    render(
      <OrderSummary
        ticketTypes={[{ id: "ticket-ga", name: "GA", priceCents: 3500, buyerUnitTotalCents: 4008 }]}
        quantities={{ "ticket-ga": 1 }}
        selectedQty={1}
        subtotalCents={3500}
        preHoldEstimate={{
          grossCents: 3500,
          platformFeeCents: 0,
          taxCents: 550,
          processorFeeCents: 0,
          totalCents: 3500,
        }}
        order={null}
        orderId={null}
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={["WELCOME10"]}
        promoDiscountCents={550}
        memberDiscounts={[{ tierName: "Gold", label: null, discountCents: 300 }]}
      />,
    );
    // Same split, same rows as step 2.
    expect(screen.getByTestId("order-summary-member-discount-row")).toHaveTextContent("−$3.00");
    expect(screen.getByTestId("order-summary-discount-row")).toHaveTextContent("−$2.50");
  });
});

describe("OrderSummary — a fee waiver the hold priced is explained", () => {
  const renderHeld = (
    feeMode: "PASS_THROUGH" | "ABSORB",
    meta: Record<string, unknown> = {},
  ) =>
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          { id: "ticket-ga", name: "General Admission", priceCents: 3500, buyerUnitTotalCents: 3500 },
        ]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={7000}
        order={{
          amountGrossCents: 7000,
          feesPlatformCents: 50,
          buyerFeesCents: feeMode === "PASS_THROUGH" ? 50 : 0,
          processorFeeCents: 236,
          taxAmountCents: 0,
          items: [
            { kind: "ticket", ticketTypeId: "ticket-ga", qty: 1, unitPriceCents: 3500, amountCents: 3500, meta },
            { kind: "ticket", ticketTypeId: "ticket-ga", qty: 1, unitPriceCents: 3500, amountCents: 3500, meta: {} },
          ],
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        feeMode={feeMode}
      />,
    );

  it("regression: a waived ticket's fee → 'Fee waiver applied: −$0.50' under the platform fee (step 1 quoted it)", () => {
    renderHeld("PASS_THROUGH", { platformFeeWaivedCents: 50 });
    expect(screen.getByTestId("order-summary-fee-waived")).toHaveTextContent(
      "checkout.platformFeeWaived",
    );
  });

  it("regression: the reservation lost the race (createCheckout: feeWaivedCents 0) → no caption beside the full fee, whatever the held lines say", () => {
    render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          { id: "ticket-ga", name: "General Admission", priceCents: 3500, buyerUnitTotalCents: 3500 },
        ]}
        quantities={{ "ticket-ga": 2 }}
        selectedQty={2}
        subtotalCents={7000}
        order={{
          amountGrossCents: 7000,
          feesPlatformCents: 100,
          buyerFeesCents: 100,
          processorFeeCents: 236,
          taxAmountCents: 0,
          feeWaivedCents: 0,
          items: [
            { kind: "ticket", ticketTypeId: "ticket-ga", qty: 1, unitPriceCents: 3500, amountCents: 3500, meta: { platformFeeWaivedCents: 50 } },
            { kind: "ticket", ticketTypeId: "ticket-ga", qty: 1, unitPriceCents: 3500, amountCents: 3500, meta: {} },
          ],
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        isPostCheckout
        feeMode="PASS_THROUGH"
      />,
    );
    expect(screen.queryByTestId("order-summary-fee-waived")).not.toBeInTheDocument();
  });

  it("no waiver → no caption; ABSORB (the buyer never paid it) → no caption", () => {
    const { unmount } = renderHeld("PASS_THROUGH");
    expect(screen.queryByTestId("order-summary-fee-waived")).not.toBeInTheDocument();
    unmount();
    renderHeld("ABSORB", { platformFeeWaivedCents: 50 });
    expect(screen.queryByTestId("order-summary-fee-waived")).not.toBeInTheDocument();
  });
});

