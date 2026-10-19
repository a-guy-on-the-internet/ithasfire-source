import React from "react";
import { render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * The order the confirmation totals: the page's own — only when it IS the
 * confirmed order — else `orders.getMyOrder`'s charged figures. Its rows must
 * add up to its Total on every path (credit; an old ABSORB order whose buyer
 * breakdown still carries a processing fee), and a failed load is
 * "unavailable", never a stuck loading state or an estimate.
 */

const server = vi.hoisted(() => ({
  myOrder: undefined as unknown,
  isError: false,
  queried: [] as unknown[],
}));
vi.mock("@/trpc", () => ({
  trpc: {
    orders: {
      getMyOrder: {
        useQuery: (input: unknown, options: { enabled?: boolean }) => {
          if (options.enabled) server.queried.push(input);
          return {
            data: options.enabled && !server.isError ? server.myOrder : undefined,
            isError: options.enabled ? server.isError : false,
          };
        },
      },
    },
  },
}));
vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  useFormatters: () => ({ dateTime: () => "date" }),
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number) => `$${(cents / 100).toFixed(2)}`,
}));

import { computeBuyerChargeBreakdown } from "@th/core/lib/orders/buyer-charge-breakdown";

import { useConfirmedOrder, type ConfirmedOrder } from "./useConfirmedOrder";
import type { ConfirmedPayment } from "./confirmed-payment";
import { OrderConfirmation } from "./OrderConfirmation";

const ORDER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ITEMS = [
  { kind: "ticket", ticketTypeId: "tt-ga", qty: 1, unitPriceCents: 3500, amountCents: 3500 },
  { kind: "ticket", ticketTypeId: "tt-ga", qty: 1, unitPriceCents: 3500, amountCents: 3500 },
];
const myOrder = (charges: Record<string, unknown>, status = "SUCCEEDED") => ({
  charges,
  items: ITEMS,
  status,
});
const CHARGES = {
  subtotalCents: 7000,
  platformFeeCents: 100,
  processingFeeCents: 230,
  taxCents: 622,
  creditCents: 0,
  totalCents: 7952,
  buyerFeeMode: "PASS_THROUGH",
};

const PAGE_ORDER: ConfirmedOrder = {
  id: ORDER_ID,
  amountGrossCents: 7000,
  feesPlatformCents: 100,
  buyerFeesCents: 100,
  processorFeeCents: 230,
  taxAmountCents: 622,
  feeMode: "PASS_THROUGH",
};

const view = (
  pageOrder: ConfirmedOrder | null,
  sessionPayment?: ConfirmedPayment,
) =>
  renderHook(() =>
    useConfirmedOrder({
      isConfirmed: true,
      orderId: ORDER_ID,
      pageOrder,
      sessionPayment,
    }),
  ).result.current;

/** Render the confirmation and read its rows. */
function rowsSum(order: ConfirmedOrder) {
  render(
    <OrderConfirmation
      orderId={ORDER_ID}
      eventName="Sixth Street"
      eventSlug="sixth-street"
      eventDate={new Date("2026-11-01T02:00:00Z")}
      currency="usd"
      ticketTypes={[{ id: "tt-ga", name: "GA", priceCents: 3500 }]}
      quantities={{ "tt-ga": 2 }}
      order={{ ...order, processorFeeCents: order.processorFeeCents ?? 0 }}
      payment="paid"
    />,
  );
  const cents = (id: string) => {
    const el = screen.queryByTestId(id);
    return el ? Math.round(Number((el.textContent ?? "").replace(/[^0-9.]/g, "")) * 100) : 0;
  };
  return {
    subtotal: cents("order-confirmation-subtotal-value"),
    platform: cents("order-confirmation-platform-fee-value"),
    tax: cents("order-confirmation-tax-value"),
    discount: cents("order-confirmation-discount-value"),
  };
}

describe("useConfirmedOrder — which order the confirmation totals", () => {
  it("the page's order when it IS the confirmed order — the server is not asked", () => {
    server.queried.length = 0;
    server.isError = false;
    server.myOrder = undefined;
    const v = view(PAGE_ORDER);
    expect(v).toMatchObject({
      status: "ready",
      order: PAGE_ORDER,
      quantities: null,
      // No confirm answer passed in: unknown, never "paid".
      payment: "unknown",
    });
    expect(server.queried).toEqual([]);
  });

  it("regression: a page order for ANOTHER order (a stale snapshot) is not trusted — the confirmed one is fetched", () => {
    server.queried.length = 0;
    server.isError = false;
    server.myOrder = undefined;
    const v = view({ ...PAGE_ORDER, id: OTHER_ID });
    expect(v.status).toBe("loading");
    expect(server.queried).toEqual([{ orderId: ORDER_ID }]);
  });

  it("regression: getMyOrder FAILS → 'unavailable' (not stuck loading, and no estimate)", () => {
    server.isError = true;
    const v = view(null);
    expect(v.status).toBe("unavailable");
    server.isError = false;
  });
});

describe("useConfirmedOrder — server-loaded rows add up to the Total", () => {
  it("regression: with platform CREDIT the confirmation shows it and still sums to charges.totalCents", () => {
    server.myOrder = myOrder({
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 7000,
      platformFeeCents: 100,
      processingFeeCents: 230,
      taxCents: 622,
      creditCents: -1000,
      totalCents: 6952,
    });
    const v = view(null);
    if (v.status !== "ready") throw new Error(`not ready: ${v.status}`);
    expect(v.order.creditAppliedCents).toBe(1000);
    rowsSum(v.order);
    expect(screen.getByText("$69.52")).toBeInTheDocument();
    expect(screen.getByText("−$10.00")).toBeInTheDocument();
  });

  it("regression: an OLD ABSORB order whose buyer breakdown still carries a processing fee — counted, so the rows sum to charges.totalCents", () => {
    server.myOrder = myOrder({
      buyerFeeMode: "ABSORB",
      subtotalCents: 7000,
      platformFeeCents: 0,
      processingFeeCents: 233,
      taxCents: 622,
      creditCents: 0,
      totalCents: 7855,
    });
    const v = view(null);
    if (v.status !== "ready") throw new Error(`not ready: ${v.status}`);
    expect(v.order.feeMode).toBe("PASS_THROUGH");
    const r = rowsSum(v.order);
    expect(screen.getByText("$78.55")).toBeInTheDocument();
    expect(r.subtotal + r.platform + 233 + r.tax - r.discount).toBe(7855);
  });

  it("regression: an OLD ABSORB order (no item meta, Stripe-paid) whose only buyer fee is the platform fee — a paid row, not 'Included', so the rows sum to the Total", () => {
    // The real breakdown: no per-item buyer totals on a Stripe-paid order, so
    // the captured charge decides, and the platform fee gets its share first.
    const charges = computeBuyerChargeBreakdown({
      amountGrossCents: 7000,
      feesPlatformCents: 100,
      taxAmountCents: 622,
      stripePaymentIntentId: "pi_legacy",
      feePolicySnapshot: { feeMode: "ABSORB" },
      items: ITEMS.map((item) => ({ ...item, meta: {} })),
    });
    expect(charges).toMatchObject({
      buyerFeeMode: "ABSORB",
      platformFeeCents: 100,
      processingFeeCents: 0,
      totalCents: 7722,
    });
    server.myOrder = myOrder(charges);
    const v = view(null);
    if (v.status !== "ready") throw new Error(`not ready: ${v.status}`);
    expect(v.order.feeMode).toBe("PASS_THROUGH");
    const r = rowsSum(v.order);
    // The fee the Total counts is printed as paid, never dimmed "Included".
    expect(screen.queryByTestId("order-confirmation-platform-fee-included")).toBeNull();
    expect(r.platform).toBe(100);
    expect(screen.getByText("$77.22")).toBeInTheDocument();
    // Processing is $0.00 here: subtotal + platform + tax is the Total.
    expect(r.subtotal + r.platform + r.tax - r.discount).toBe(7722);
  });
});

describe("useConfirmedOrder — whether the money moved", () => {
  // `confirmPayment` writes PROCESSING and answers `processing` for a
  // PaymentIntent still `processing`; the webhook later moves the order to
  // SUCCEEDED or cancels it. Only SUCCEEDED (or a `confirmed` answer) is paid.
  it.each([
    ["SUCCEEDED", "paid"],
    ["PROCESSING", "processing"],
    ["PENDING", "unknown"],
    ["CANCELLED", "unknown"],
    ["REFUNDED", "unknown"],
  ] as const)(
    "a %s order loaded from the server reads payment %s",
    (status, payment) => {
      server.isError = false;
      server.myOrder = myOrder(CHARGES, status);
      expect(view(null)).toMatchObject({ status: "ready", payment });
    },
  );

  it("a server-loaded order's status wins over the session's answer", () => {
    server.isError = false;
    server.myOrder = myOrder(CHARGES, "CANCELLED");
    expect(view(null, "paid")).toMatchObject({
      status: "ready",
      payment: "unknown",
    });
  });

  it.each(["paid", "processing", "unknown"] as const)(
    "with the page's order, the session's answer (%s) is the payment, with no second read",
    (sessionPayment) => {
      server.queried.length = 0;
      server.isError = false;
      server.myOrder = myOrder(CHARGES, "SUCCEEDED");
      expect(view(PAGE_ORDER, sessionPayment)).toMatchObject({
        status: "ready",
        // The page's own figures total the screen.
        order: PAGE_ORDER,
        payment: sessionPayment,
      });
      expect(server.queried).toEqual([]);
    },
  );
});
