import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("./PromoCodeInput", () => ({
  PromoCodeInput: () => <div data-testid="promo-code-input" />,
}));

import { OrderSummary, type OrderSummaryProps } from "./OrderSummary";
import {
  shownCartLines,
  shownLineCentsByTicketType,
} from "./checkout-seat-quotes";
import { computePlatformFeePerTicketCents } from "@th/core/lib/pricing/compute-ticket-price-for-agreement";
import {
  estimateCartTotal,
  estimateHeldOrderCharge,
  type FeeRatesForOrderEstimate,
} from "@/lib/pricing/order-estimate";

/**
 * Step 1 (before the hold) shows the SAME rows as step 2, and they add up to
 * the estimated total. Owner ruling 2026-10-01.
 *
 * The old step 1 showed a FIXED line at its all-in unit price ("$40.08"), a
 * PWYW line at the bare amount, no fee or tax rows, and the discount off the
 * face — GA $35 + PWYW $20 + WELCOME10 read $54.58 of rows over a $56.85
 * total. Every figure here comes from a REAL `estimateCartTotal` result.
 */

const formatPrice = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
const cents = (text: string | null | undefined) =>
  Math.round(Number((text ?? "").replace(/[^0-9.]/g, "")) * 100);

const TT_GA = "tt-ga";
const TT_PWYW = "tt-pwyw";

const rates = (
  feeMode: "PASS_THROUGH" | "ABSORB",
  opts: { base?: "TICKET_FACE" | "BUYER_TOTAL"; rateBps?: number; region?: string } = {},
): FeeRatesForOrderEstimate => {
  const passThrough = feeMode === "PASS_THROUGH";
  const base = opts.base ?? "TICKET_FACE";
  const rateBps = opts.rateBps ?? 888;
  return {
    feeMode,
    admissionTaxRateBps: rateBps,
    taxImpositions: [
      {
        code: "SALES",
        label: "Sales tax",
        jurisdiction: `US/${opts.region ?? "NY"}`,
        rateBps,
        base,
        collector: "PLATFORM",
      },
    ],
    processorPct: passThrough ? 0.029 : null,
    processorFixedCents: passThrough ? 30 : null,
    maxPlatformFeeCents: null,
    platformFeeRates: passThrough
      ? { buyerFeePct: 0.0333, maxFeeCents: 50, minFeeCents: 0, platformFixedCents: 0 }
      : null,
    perTicketEstimates: [
      { ticketTypeId: TT_GA, unitPriceCents: 3500, platformFeeCents: passThrough ? 50 : 0 },
      { ticketTypeId: TT_PWYW, unitPriceCents: 500, platformFeeCents: passThrough ? 17 : 0 },
    ],
  };
};

type Cart = { ga: number; pwyw: number; amount: number };

/** Render step 1 exactly as Checkout.tsx feeds it: one estimate object. */
const renderStep1 = (
  feeRates: FeeRatesForOrderEstimate,
  cart: Cart,
  extra: Partial<OrderSummaryProps> & { discountCents?: number } = {},
) => {
  const { discountCents = 0, ...props } = extra;
  const estimate = estimateCartTotal(
    feeRates,
    [
      { ticketTypeId: TT_GA, qty: cart.ga, priceCents: 3500 },
      { ticketTypeId: TT_PWYW, qty: cart.pwyw, priceCents: 0, chosenAmountCents: cart.amount },
    ],
    { discountCents },
  );
  const view = render(
    <OrderSummary
      ticketTypes={[
        { id: TT_GA, name: "General Admission", priceCents: 3500, buyerUnitTotalCents: 4008 },
        { id: TT_PWYW, name: "Pay What You Want", priceCents: 0, chosenAmountCents: cart.amount },
      ]}
      quantities={{ [TT_GA]: cart.ga, [TT_PWYW]: cart.pwyw }}
      selectedQty={cart.ga + cart.pwyw}
      subtotalCents={estimate?.totalCents ?? 0}
      preHoldEstimate={estimate}
      order={null}
      orderId={null}
      countdown={null}
      isExpired={false}
      formatPrice={formatPrice}
      promoCodes={[]}
      promoDiscountCents={discountCents}
      feeMode={feeRates.feeMode}
      taxRateBps={feeRates.admissionTaxRateBps}
      platformFeeRateLabel={feeRates.feeMode === "PASS_THROUGH" ? "3.33%, max $0.50/ticket" : null}
      processorFeeRateLabel={feeRates.feeMode === "PASS_THROUGH" ? "2.9% + $0.30" : null}
      {...props}
    />,
  );
  return { ...view, estimate };
};

/** The figures the summary shows, read off its rows. */
const rows = (root: HTMLElement) => {
  const q = (id: string) => within(root).queryAllByTestId(id);
  const one = (id: string) => (q(id)[0] ? cents(q(id)[0]!.textContent) : 0);
  return {
    lines: q("order-summary-line-value").map((el) => cents(el.textContent)),
    subtotal: one("order-summary-subtotal-value"),
    platform: one("order-summary-platform-fee-value"),
    processing: one("order-summary-processing-fee-value"),
    tax: one("order-summary-tax-value"),
    discounts: [
      ...q("order-summary-member-discount-value"),
      ...q("order-summary-discount-value"),
    ].map((el) => cents(el.textContent)),
    total: cents(within(root).getByTestId("order-summary-total-value").textContent),
  };
};

const expectRowsSumToTotal = (r: ReturnType<typeof rows>) => {
  const lineSum = r.lines.reduce((a, b) => a + b, 0);
  const discount = r.discounts.reduce((a, b) => a + b, 0);
  expect(lineSum).toBe(r.subtotal);
  expect(r.subtotal + r.platform + r.processing + r.tax - discount).toBe(r.total);
};

describe("step 1 — the rows add up to the estimated total", () => {
  it("regression: GA $35 + PWYW $20 + WELCOME10 (NY) — $35.00, $20.00, $55.00, $1.00, $1.95, $4.40, −$5.50, $56.85", () => {
    const { container, estimate } = renderStep1(rates("PASS_THROUGH"), { ga: 1, pwyw: 1, amount: 2000 }, { discountCents: 550 });
    const r = rows(container);
    expect(r).toEqual({
      lines: [3500, 2000],
      subtotal: 5500,
      platform: 100,
      processing: 195,
      tax: 440,
      discounts: [550],
      total: 5685,
    });
    expect(r.total).toBe(estimate!.totalCents);
    expectRowsSumToTotal(r);
    // Labelled "Estimated total" before the hold; the all-in line wording is gone.
    expect(screen.getByText("checkout.estimatedTotal")).toBeInTheDocument();
    expect(screen.queryByText("$40.08")).not.toBeInTheDocument();
  });

  it("qty 3: line totals (3 × $35.00 = $105.00), no '$X each'", () => {
    const { container } = renderStep1(rates("PASS_THROUGH"), { ga: 3, pwyw: 0, amount: 0 });
    const r = rows(container);
    expect(r.lines).toEqual([10_500]);
    expect(screen.queryByText("checkout.eachPrice")).not.toBeInTheDocument();
    expectRowsSumToTotal(r);
  });

  it("BUYER_TOTAL tax (TN): tax on face + fees, and the rows still sum", () => {
    const { container, estimate } = renderStep1(
      rates("PASS_THROUGH", { base: "BUYER_TOTAL", rateBps: 975, region: "TN" }),
      { ga: 1, pwyw: 1, amount: 2000 },
      { discountCents: 550 },
    );
    const r = rows(container);
    expect(r.tax).toBe(estimate!.taxCents);
    expect(r.tax).toBeGreaterThan(Math.round((4950 * 975) / 10_000));
    expectRowsSumToTotal(r);
  });

  it("a member benefit is its own labelled row (with the code remainder on Discount), and the rows sum", () => {
    const { container } = renderStep1(rates("PASS_THROUGH"), { ga: 1, pwyw: 1, amount: 2000 }, {
      discountCents: 1050,
      memberDiscounts: [{ tierName: "Sustaining", label: null, discountCents: 500 }],
    });
    const r = rows(container);
    expect(r.discounts).toEqual([500, 550]);
    expectRowsSumToTotal(r);
  });

  it("ABSORB: platform and processing read 'Included' (dimmed, no figure), out of the sum", () => {
    const { container, estimate } = renderStep1(rates("ABSORB"), { ga: 1, pwyw: 1, amount: 2000 });
    expect(screen.getByTestId("order-summary-platform-fee-included")).toHaveTextContent("checkout.included");
    expect(screen.getByTestId("order-summary-processing-fee-included")).toHaveTextContent("checkout.included");
    // No made-up figure beside "Included": the estimate prices what the buyer
    // pays, so there is no absorbed amount to show before the hold.
    expect(screen.getByTestId("order-summary-platform-fee-included").textContent).not.toMatch(/\$/);
    expect(screen.getByTestId("order-summary-processing-fee-included").textContent).not.toMatch(/\$/);
    const r = rows(container);
    expect(r.platform).toBe(0);
    expect(r.processing).toBe(0);
    expect(r.total).toBe(estimate!.totalCents);
    expectRowsSumToTotal(r);
  });

  it("an invalid amount: the line asks for one, and NO fee, tax or total figure is shown", () => {
    renderStep1(rates("PASS_THROUGH"), { ga: 1, pwyw: 1, amount: 1_500_000 }, {
      estimateUnavailable: true,
      ticketTypes: [
        { id: TT_GA, name: "General Admission", priceCents: 3500 },
        { id: TT_PWYW, name: "Pay What You Want", priceCents: 0, chosenAmountCents: 1_500_000, chosenAmountInvalid: true },
      ],
    });
    expect(screen.getByText("checkout.pwywEnterValidAmount")).toBeInTheDocument();
    // Said UNDER the tier name, so the name keeps the row's width (it was
    // truncated to "1× Pay What Y…" beside the message at 1440).
    expect(screen.getByTestId("order-summary-line-invalid")).toHaveTextContent(
      "checkout.pwywEnterValidAmount",
    );
    expect(screen.getAllByTestId("order-summary-line-value")[1]!.textContent).toBe("");
    expect(screen.getByText("—")).toBeInTheDocument();
    for (const id of [
      "order-summary-subtotal-value",
      "order-summary-platform-fee-value",
      "order-summary-processing-fee-value",
      "order-summary-tax-value",
      "order-summary-total-value",
    ]) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
  });

  it("fee rates unknown: 'Calculating…', no partial rows", () => {
    renderStep1({ ...rates("PASS_THROUGH"), taxImpositions: undefined }, { ga: 1, pwyw: 0, amount: 0 });
    expect(screen.getByText("checkout.calculatingTotal")).toBeInTheDocument();
    expect(screen.queryByTestId("order-summary-subtotal-value")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-summary-tax-value")).not.toBeInTheDocument();
  });
});

describe("step 1 rows === step 2 rows for the same cart", () => {
  it("parity with estimateHeldOrderCharge: subtotal, fees, tax, discount and total match", () => {
    const feeRates = rates("PASS_THROUGH");
    const step1 = renderStep1(feeRates, { ga: 1, pwyw: 1, amount: 2000 }, { discountCents: 550 });
    const r1 = rows(step1.container);
    step1.unmount();

    // Step 2 as Checkout feeds it: the hold's gross and buyer fees, the held
    // charge solved by estimateHeldOrderCharge.
    const est = step1.estimate!;
    const held = estimateHeldOrderCharge(
      feeRates,
      { amountGrossCents: est.grossCents, buyerFeesCents: est.platformFeeCents },
      550,
    )!;
    const step2 = render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[
          { id: TT_GA, name: "General Admission", priceCents: 3500 },
          { id: TT_PWYW, name: "Pay What You Want", priceCents: 0 },
        ]}
        quantities={{ [TT_GA]: 1, [TT_PWYW]: 1 }}
        selectedQty={2}
        subtotalCents={est.grossCents}
        heldCharge={held}
        order={{
          amountGrossCents: est.grossCents,
          feesPlatformCents: est.platformFeeCents,
          buyerFeesCents: est.platformFeeCents,
          processorFeeCents: held.processorFeeCents ?? 0,
          taxAmountCents: held.taxCents,
          items: [
            { kind: "ticket", ticketTypeId: TT_GA, qty: 1, unitPriceCents: 3500, amountCents: 3500 },
            { kind: "ticket", ticketTypeId: TT_PWYW, qty: 1, unitPriceCents: 2000, amountCents: 2000 },
          ],
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        promoDiscountCents={550}
        feeMode="PASS_THROUGH"
        taxRateBps={888}
      />,
    );
    const r2 = rows(step2.container);
    expect(r1).toEqual(r2);
  });

  it("regression: a picked $50 seat on a $35 tier reads $50.00 before the hold, and step 1's rows and total equal step 2's for that seat", () => {
    const feeRates = rates("PASS_THROUGH");
    const SEAT = "seat-p1";
    const ga = { id: TT_GA, priceCents: 3500, pricingMode: "FIXED" as const };
    // As useCheckoutState builds it, from the map's override for the seat.
    const lines = shownCartLines(
      [ga],
      { [TT_GA]: 1 },
      { [TT_GA]: [SEAT] },
      [{ id: SEAT, priceOverride: { priceCents: 5000 } }],
      () => 0,
    );
    // As Checkout feeds it: the estimate from those lines, the line amount on
    // the ticket type.
    const estimate = estimateCartTotal(feeRates, lines);
    const step1 = render(
      <OrderSummary
        ticketTypes={[
          {
            id: TT_GA,
            name: "General Admission",
            priceCents: 3500,
            shownLineCents: shownLineCentsByTicketType(lines)[TT_GA] ?? null,
          },
        ]}
        quantities={{ [TT_GA]: 1 }}
        selectedQty={1}
        subtotalCents={estimate?.totalCents ?? 0}
        preHoldEstimate={estimate}
        order={null}
        orderId={null}
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        promoDiscountCents={0}
        feeMode="PASS_THROUGH"
        taxRateBps={888}
      />,
    );
    const r1 = rows(step1.container);
    step1.unmount();
    expect(r1.lines).toEqual([5000]);
    expect(r1.subtotal).toBe(5000);
    expectRowsSumToTotal(r1);

    // Step 2 holding that seat: the server's line at $50 and the charge
    // estimateHeldOrderCharge solves from it (fee on $50: 3.33% capped at 50¢).
    const seatFeeCents = computePlatformFeePerTicketCents(
      5000,
      feeRates.platformFeeRates!,
    );
    const held = estimateHeldOrderCharge(
      feeRates,
      { amountGrossCents: 5000, buyerFeesCents: seatFeeCents },
      0,
    )!;
    const step2 = render(
      <OrderSummary
        preHoldEstimate={null}
        ticketTypes={[{ id: TT_GA, name: "General Admission", priceCents: 3500 }]}
        quantities={{ [TT_GA]: 1 }}
        selectedQty={1}
        subtotalCents={5000}
        heldCharge={held}
        order={{
          amountGrossCents: 5000,
          feesPlatformCents: seatFeeCents,
          buyerFeesCents: seatFeeCents,
          processorFeeCents: held.processorFeeCents ?? 0,
          taxAmountCents: held.taxCents,
          items: [
            { kind: "ticket", ticketTypeId: TT_GA, qty: 1, unitPriceCents: 5000, amountCents: 5000, meta: { seatId: SEAT } },
          ],
        }}
        orderId="order-1"
        countdown={null}
        isExpired={false}
        formatPrice={formatPrice}
        promoCodes={[]}
        promoDiscountCents={0}
        feeMode="PASS_THROUGH"
        taxRateBps={888}
      />,
    );
    expect(rows(step2.container)).toEqual(r1);
  });
});
