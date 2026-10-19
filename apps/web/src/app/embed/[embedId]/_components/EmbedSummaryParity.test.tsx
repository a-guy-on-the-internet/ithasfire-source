import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * The embed's order summary (sidebar) and its mobile tray show main
 * checkout's rows — face × qty lines, Subtotal, Platform, Processing, Taxes —
 * from ONE `estimateCartTotal` result before the order exists, and from the
 * stamped order after. Each surface's rows must add up to the total it shows.
 * They used to print the all-in "$40.08" / "$51.09 each", which nothing below
 * could add up to.
 */

vi.mock("@th/ui", () => ({
  Spinner: () => <span />,
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));

import { EmbedOrderSummarySidebar } from "./EmbedOrderSummarySidebar";
import { EmbedMobileCTABar } from "./EmbedMobileCTABar";
import { embedEstimateItems, embedShownLineCents } from "./embed-pwyw";
import { buyerTaxRateBps, formatCurrency } from "./embed-helpers";
import { embedLinesFromOrder } from "./EmbedSummaryRows";
import type { CartItem, EmbedOrderFees } from "./embed-types";
import {
  estimateCartTotal,
  type FeeRatesForOrderEstimate,
} from "@/lib/pricing/order-estimate";

const money = (text: string | null | undefined) =>
  Math.round(Number((text ?? "").replace(/[^0-9.]/g, "")) * 100);
const fmt = (cents: number) => formatCurrency(cents, "usd");
// The rows print EXACT money: a zero-tax event reads "$0.00" (owner ruling
// 2026-10-01), even though the embed's price labels trim whole amounts.
const ZERO = "$0.00";

const rates = (
  feeMode: "PASS_THROUGH" | "ABSORB",
  rateBps = 888,
): FeeRatesForOrderEstimate => {
  const passThrough = feeMode === "PASS_THROUGH";
  return {
    feeMode,
    admissionTaxRateBps: rateBps,
    taxImpositions:
      rateBps > 0
        ? [
            {
              code: "SALES",
              label: "Sales tax",
              jurisdiction: "US/NY",
              rateBps,
              base: "TICKET_FACE",
              collector: "PLATFORM",
            },
          ]
        : [],
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

const GA = { id: "tt-ga", name: "General Admission", priceCents: 3500, pricingMode: "FIXED" as const };
const PWYW = {
  id: "tt-pwyw",
  name: "Pay What You Want",
  priceCents: 0,
  pricingMode: "ADJUSTABLE" as const,
  minimumCents: 500,
  suggestedCents: 1500,
};
// The LINE ticket types as EmbedCheckout builds them (PWYW at the amount).
const lineTypes = (amountCents: number) => [GA, { ...PWYW, priceCents: amountCents }];

const CART: CartItem[] = [
  { ticketTypeId: "tt-ga", qty: 1 },
  { ticketTypeId: "tt-pwyw", qty: 1, donationAmountCents: 2000 },
];

function rowsOf(prefix: string) {
  const one = (id: string) => {
    const el = screen.queryByTestId(`${prefix}-${id}`);
    return el ? money(el.textContent) : 0;
  };
  return {
    lines: screen.getAllByTestId(`${prefix}-line-value`).map((el) => money(el.textContent)),
    subtotal: one("subtotal-value"),
    platform: one("platform-fee-value"),
    processing: one("processing-fee-value"),
    tax: one("tax-value"),
    discount: one("discount-value"),
    total: money(screen.getByTestId(`${prefix}-total-value`).textContent),
  };
}
function expectRowsSum(r: ReturnType<typeof rowsOf>) {
  expect(r.lines.reduce((a, b) => a + b, 0)).toBe(r.subtotal);
  expect(r.subtotal + r.platform + r.processing + r.tax - r.discount).toBe(r.total);
}

function renderBoth({
  feeMode,
  rateBps = 888,
  orderFees = null,
}: {
  feeMode: "PASS_THROUGH" | "ABSORB";
  rateBps?: number;
  orderFees?: EmbedOrderFees | null;
}) {
  const estimate = estimateCartTotal(rates(feeMode, rateBps), embedEstimateItems(CART, [GA, PWYW]))!;
  const totalCents = orderFees
    ? orderFees.amountGrossCents +
      orderFees.buyerFeesCents +
      (feeMode === "PASS_THROUGH" ? orderFees.processorFeeCents : 0) +
      orderFees.taxAmountCents
    : estimate.totalCents;
  const tickets = CART.map((item) => {
    const tt = lineTypes(2000).find((t) => t.id === item.ticketTypeId)!;
    return { id: tt.id, name: tt.name, priceCents: tt.priceCents, qty: item.qty };
  });
  render(
    <>
      <EmbedOrderSummarySidebar
        cart={CART}
        eventDetail={{
          event: { title: "Sixth Street", startsAt: new Date("2026-11-01T02:00:00Z"), currency: "usd" },
          ticketTypes: lineTypes(2000),
        } as never}
        orderFees={orderFees}
        preOrderEstimate={estimate}
        displayTotalCents={totalCents}
        displayTotalLabel={fmt(totalCents)}
        currency="usd"
        platformFeeRateLabel="3.33%, max $0.50/ticket"
        processorFeeRateLabel="2.9% + $0.30"
        taxRateBps={buyerTaxRateBps(rates(feeMode, rateBps))}
        feeMode={feeMode}
        countdown={null}
        isHoldExpired={false}
      />
      <EmbedMobileCTABar
        totalLabel={fmt(totalCents)}
        tickets={tickets}
        currency="usd"
        order={orderFees}
        preOrderEstimate={estimate}
        platformFeeRateLabel="3.33%, max $0.50/ticket"
        processorFeeRateLabel="2.9% + $0.30"
        taxRateBps={buyerTaxRateBps(rates(feeMode, rateBps))}
        feeMode={feeMode}
        countdown={null}
        isExpired={false}
      />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { expanded: false, hidden: true }));
  return { estimate, totalCents };
}

describe("embed summary ⇄ tray — main checkout's rows, summing to the total", () => {
  it("regression: step 1, PASS_THROUGH, GA $35 + PWYW $20: lines at face, the fee and tax rows, summing to the estimate's total — on both surfaces", () => {
    const { estimate } = renderBoth({ feeMode: "PASS_THROUGH" });
    const sidebar = rowsOf("embed-summary");
    const tray = rowsOf("embed-tray");
    expect(sidebar.lines).toEqual([3500, 2000]);
    expect(sidebar.total).toBe(estimate.totalCents);
    expectRowsSum(sidebar);
    expectRowsSum(tray);
    expect(tray).toEqual(sidebar);
    // No all-in "$40.08"-style line anywhere.
    expect(screen.queryByText(/each/)).toBeNull();
  });

  it("ABSORB: platform and processing read Included (no figure before the order); rows still sum", () => {
    renderBoth({ feeMode: "ABSORB" });
    expectRowsSum(rowsOf("embed-summary"));
    expectRowsSum(rowsOf("embed-tray"));
    for (const id of [
      "embed-summary-platform-fee-included",
      "embed-tray-processing-fee-included",
    ]) {
      expect(screen.getByTestId(id).textContent).not.toMatch(/\$/);
    }
  });

  it("owner ruling: a zero-tax event reads Taxes $0.00 — with cents — on both, step 1", () => {
    renderBoth({ feeMode: "PASS_THROUGH", rateBps: 0 });
    expect(screen.getByTestId("embed-summary-tax-value").textContent).toBe(ZERO);
    expect(screen.getByTestId("embed-tray-tax-value").textContent).toBe(ZERO);
    expectRowsSum(rowsOf("embed-summary"));
  });

  it("after the order: the stamped figures, the zero Taxes figure, rows summing to the charge", () => {
    renderBoth({
      feeMode: "PASS_THROUGH",
      orderFees: {
        amountGrossCents: 5500,
        feesPlatformCents: 100,
        buyerFeesCents: 100,
        processorFeeCents: 195,
        feeMode: "PASS_THROUGH",
        taxAmountCents: 0,
      } as EmbedOrderFees,
    });
    expect(screen.getByTestId("embed-summary-tax-value").textContent).toBe(ZERO);
    expectRowsSum(rowsOf("embed-summary"));
    expectRowsSum(rowsOf("embed-tray"));
  });

  it("the Taxes row carries the rate like main checkout's (8.88%); zero tax shows no rate, just $0.00", () => {
    renderBoth({ feeMode: "PASS_THROUGH" });
    expect(screen.getAllByText("(8.88%)").length).toBe(2);
    cleanup();
    renderBoth({ feeMode: "PASS_THROUGH", rateBps: 0 });
    expect(screen.queryByText("(8.88%)")).toBeNull();
    expect(screen.getByTestId("embed-summary-tax-value").textContent).toBe(ZERO);
  });

  it("the capped platform-fee label is what the rows show", () => {
    renderBoth({ feeMode: "PASS_THROUGH" });
    expect(screen.getAllByText("(3.33%, max $0.50/ticket)").length).toBe(2);
  });

  it("regression: after the order, a 10% promo — the server's gross is post-discount, so a Discount row closes the gap: Subtotal + fees + tax − discount = the charge", () => {
    renderBoth({
      feeMode: "PASS_THROUGH",
      orderFees: {
        // GA $35 + PWYW $20 = $55.00 at face; WELCOME10 takes $5.50.
        amountGrossCents: 4950,
        feesPlatformCents: 100,
        buyerFeesCents: 100,
        processorFeeCents: 190,
        feeMode: "PASS_THROUGH",
        taxAmountCents: 440,
      } as EmbedOrderFees,
    });
    for (const prefix of ["embed-summary", "embed-tray"]) {
      const r = rowsOf(prefix);
      expect(r.subtotal).toBe(5500);
      expect(r.discount).toBe(550);
      expect(r.total).toBe(4950 + 100 + 190 + 440);
      expectRowsSum(r);
    }
  });

  it("every breakdown row prints exact money (no '$35' beside '$1.95')", () => {
    renderBoth({ feeMode: "PASS_THROUGH" });
    const lines = screen.getAllByTestId("embed-summary-line-value").map((el) => el.textContent);
    expect(lines).toEqual(["$35.00", "$20.00"]);
    expect(screen.getByTestId("embed-summary-subtotal-value").textContent).toBe("$55.00");
  });
});

describe("embed summary ⇄ tray — a picked seat with a price override", () => {
  // GA $35 tier; seat s1 shown at its $10 override, s2 plain.
  const SEATED: CartItem[] = [
    {
      ticketTypeId: "tt-ga",
      qty: 2,
      seatIds: ["s1", "s2"],
      seatSectionId: "sec-a",
      seatQuotes: [{ seatId: "s1", unitPriceCents: 1000 }],
    },
  ];

  function renderSeated(orderFees: EmbedOrderFees | null) {
    cleanup();
    const estimate = estimateCartTotal(
      rates("PASS_THROUGH"),
      embedEstimateItems(SEATED, [GA]),
    )!;
    const lineCents = embedShownLineCents(SEATED, [GA]);
    const totalCents = orderFees
      ? orderFees.amountGrossCents +
        orderFees.buyerFeesCents +
        orderFees.processorFeeCents +
        orderFees.taxAmountCents
      : estimate.totalCents;
    render(
      <>
        <EmbedOrderSummarySidebar
          cart={SEATED}
          eventDetail={{
            event: { title: "Sixth Street", startsAt: new Date("2026-11-01T02:00:00Z"), currency: "usd" },
            ticketTypes: [GA],
          } as never}
          lineCentsByTicketType={lineCents}
          orderFees={orderFees}
          preOrderEstimate={estimate}
          displayTotalCents={totalCents}
          displayTotalLabel={fmt(totalCents)}
          currency="usd"
          taxRateBps={buyerTaxRateBps(rates("PASS_THROUGH"))}
          feeMode="PASS_THROUGH"
          countdown={null}
          isHoldExpired={false}
        />
        <EmbedMobileCTABar
          totalLabel={fmt(totalCents)}
          tickets={[
            { id: GA.id, name: GA.name, priceCents: GA.priceCents, qty: 2, lineCents: lineCents[GA.id] },
          ]}
          currency="usd"
          order={orderFees}
          preOrderEstimate={estimate}
          taxRateBps={buyerTaxRateBps(rates("PASS_THROUGH"))}
          feeMode="PASS_THROUGH"
          countdown={null}
          isExpired={false}
        />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false, hidden: true }));
    return estimate;
  }

  it("step 1: the line reads $10 + $35, not 2 × $35, and the rows sum to the estimate", () => {
    const estimate = renderSeated(null);
    expect(estimate.grossCents).toBe(4500);
    for (const prefix of ["embed-summary", "embed-tray"]) {
      const r = rowsOf(prefix);
      expect(r.lines).toEqual([4500]);
      expect(r.subtotal).toBe(4500);
      expect(r.total).toBe(estimate.totalCents);
      expectRowsSum(r);
    }
  });

  it("regression: after the order, a cheaper override seat is not shown as a Discount", () => {
    // The server charged the seat its $10: gross $45. Lines priced at the
    // tier ($70) used to read as a $25 "discount" the buyer never got.
    renderSeated({
      amountGrossCents: 4500,
      feesPlatformCents: 83,
      buyerFeesCents: 83,
      processorFeeCents: 165,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 400,
    } as EmbedOrderFees);
    for (const prefix of ["embed-summary", "embed-tray"]) {
      const r = rowsOf(prefix);
      expect(r.discount).toBe(0);
      expect(r.subtotal).toBe(4500);
      expectRowsSum(r);
    }
  });
});

describe("embed summary ⇄ tray — after the order, the lines are the server's", () => {
  it("regression: a plain seat given a $50 override before Continue, plus a $20 code: the server's $50 line and the $20 Discount, on both", () => {
    cleanup();
    // The buyer picked plain seat s2 ($35 tier, no quote); the organizer set
    // it to $50 before Continue, so the server charged $50 unquoted (FR-004),
    // then took $20 off with a code.
    const cart: CartItem[] = [
      { ticketTypeId: "tt-ga", qty: 1, seatIds: ["s2"], seatSectionId: "sec-a" },
    ];
    const orderFees = {
      amountGrossCents: 3000,
      feesPlatformCents: 50,
      buyerFeesCents: 50,
      processorFeeCents: 120,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 266,
    } as EmbedOrderFees;
    const orderLines = embedLinesFromOrder([
      {
        ticketTypeId: "tt-ga",
        name: "General Admission",
        qty: 1,
        unitPriceCents: 5000,
        lineCents: 5000,
      },
    ]);
    const totalCents = 3000 + 50 + 120 + 266;
    const estimate = estimateCartTotal(rates("PASS_THROUGH"), embedEstimateItems(cart, [GA]))!;
    render(
      <>
        <EmbedOrderSummarySidebar
          cart={cart}
          eventDetail={{
            event: { title: "Sixth Street", startsAt: new Date("2026-11-01T02:00:00Z"), currency: "usd" },
            ticketTypes: [GA],
          } as never}
          lineCentsByTicketType={embedShownLineCents(cart, [GA])}
          orderLines={orderLines}
          orderFees={orderFees}
          preOrderEstimate={estimate}
          displayTotalCents={totalCents}
          displayTotalLabel={fmt(totalCents)}
          currency="usd"
          feeMode="PASS_THROUGH"
          countdown={null}
          isHoldExpired={false}
        />
        <EmbedMobileCTABar
          totalLabel={fmt(totalCents)}
          tickets={[{ id: GA.id, name: GA.name, priceCents: GA.priceCents, qty: 1, lineCents: 3500 }]}
          currency="usd"
          order={orderFees}
          orderLines={orderLines}
          preOrderEstimate={estimate}
          feeMode="PASS_THROUGH"
          countdown={null}
          isExpired={false}
        />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false, hidden: true }));
    for (const prefix of ["embed-summary", "embed-tray"]) {
      const r = rowsOf(prefix);
      expect(r.lines).toEqual([5000]);
      expect(r.subtotal).toBe(5000);
      expect(r.discount).toBe(2000);
      expect(r.total).toBe(totalCents);
      expectRowsSum(r);
    }
  });

  it("no lines read back: the cart lines stay", () => {
    expect(embedLinesFromOrder([])).toBeNull();
    expect(embedLinesFromOrder(undefined)).toBeNull();
  });
});
