import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * The org order panel's money: what the buyer paid, line by line, and what
 * the sale credited the event, from `getOrgOrder`'s `charges` and
 * `eventCredit` (the ledger's OrderSplit total beside the rule's figure). It used to show `amountGrossCents` (the ticket money
 * alone) as "Total": a $15 ticket the buyer paid $17.91 for read "Total
 * $15.00". Owner ruling 2026-10-11: the buyer pays the platform fee on top,
 * the organizer is credited the full price, and both figures show their
 * lines so the sum can be checked with a calculator.
 */

const testState = vi.hoisted(() => ({
  orgOrderQuery: {} as Record<string, unknown>,
  quoteQuery: { data: undefined, error: null, isLoading: false } as Record<
    string,
    unknown
  >,
  refundMutation: { mutate: vi.fn(), error: null } as Record<string, unknown>,
  fullRefundMutation: {
    mutate: vi.fn(),
    reset: vi.fn(),
    error: null,
  } as Record<string, unknown>,
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...props }: { children?: ReactNode }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-"))
        safe[key] = value;
    }
    return React.createElement("div", safe, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    "aria-label": ariaLabel,
  }: {
    value?: string;
    onChangeText?: (next: string) => void;
    "aria-label"?: string;
  }) => (
    <input
      value={value ?? ""}
      onChange={(e) => onChangeText?.(e.target.value)}
      aria-label={ariaLabel}
    />
  ),
  Spinner: () => <span>Loading</span>,
  CardSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useFormatters: () => ({}),
  useTranslations:
    () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number, currency: string) =>
    `${currency}:${cents}`,
  fmtDate: () => "Jun 1, 2026",
}));

vi.mock("../OrderStatusBadge", () => ({
  OrderStatusBadge: ({ status }: { status: string }) => (
    <span data-testid="status-badge">{status}</span>
  ),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    orders: {
      getOrgOrder: { useQuery: () => testState.orgOrderQuery },
      orgQuoteItemRefund: { useQuery: () => testState.quoteQuery },
      orgRefundOrderItems: { useMutation: () => testState.refundMutation },
      orgRefundFullOrder: { useMutation: () => testState.fullRefundMutation },
      // The cash refund (door-sales step 9b) is always mounted; inert here.
      orgRefundCashSale: {
        useMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), data: undefined }),
      },
    },
  },
}));

import { OrderDetailPanel } from "../OrderDetailPanel";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "77777777-7777-4777-8777-777777777777";

/** The demo order (psql, 2026-10-12): $15 ticket, buyer paid $17.91. */
function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    eventId: "22222222-2222-4222-8222-222222222222",
    eventTitle: "Launch Party",
    orgName: "Org",
    buyerHumanId: "33333333-3333-4333-8333-333333333333",
    buyerName: "Casey Buyer",
    buyerEmail: "casey@example.com",
    amountGrossCents: 1500,
    feesPlatformCents: 50,
    taxAmountCents: 159,
    currency: "usd",
    status: "SUCCEEDED",
    source: "PRIMARY",
    stripePaymentIntentId: "pi_123",
    stripeTaxCalculationId: null,
    paymentMethodType: "card",
    parentOrderId: null,
    feePolicySnapshot: { feeMode: "PASS_THROUGH", organiserCredit: "FULL_PRICE" },
    billingAddress: null,
    promo: null,
    promoCodes: [],
    paymentChannel: "WEB",
    cashRefundableUntil: null,
    cashAmountPaidCents: null,
    isComp: null,
    isFreeWithCode: null,
    cashSaleDebitCents: null,
    occurredAt: new Date("2026-05-01T12:00:00.000Z"),
    paidOutAt: null,
    disputeStatus: null,
    refundBlockedByDispute: false,
    earlyFraudWarning: null,
    items: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "ticket",
        ticketTypeId: "tt-ga",
        qty: 1,
        unitPriceCents: 1500,
        amountCents: 1500,
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
        ticketCode: "TK-001",
        ticketScannedAt: null,
        seatId: null,
        ticketOwnerName: "Casey Buyer",
      },
    ],
    ticketTypeNames: { "tt-ga": "General Admission" },
    buyerTotalCents: 1791,
    refundBasePaidCents: 1791,
    chargeState: "PAID",
    buyerPaid: true,
    charges: {
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 1500,
      platformFeeCents: 50,
      processingFeeCents: 82,
      taxCents: 159,
      creditCents: 0,
      totalCents: 1791,
    },
    eventCredit: {
      ticketPriceCents: 1500,
      platformFeeTakenCents: 0,
      expectedCreditCents: 1500,
      creditState: "CREDITED",
      creditedCents: 1500,
      payeeCount: 1,
    },
    ...overrides,
  };
}

function renderPanel(order: ReturnType<typeof makeOrder>) {
  testState.orgOrderQuery = {
    data: order,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
  return render(
    <OrderDetailPanel
      orderId={ORDER_ID}
      orgId={ORG_ID}
      canFinance
      onClose={() => {}}
    />,
  );
}

/** The figure printed beside a label (MoneyLine: label span, value span). */
function valueBeside(label: string, index = 0): string | null {
  const labelEl = screen.getAllByText(label)[index]!;
  return labelEl.nextElementSibling?.textContent ?? null;
}

const FREE_CHARGES = {
  buyerFeeMode: "PASS_THROUGH",
  subtotalCents: 1500,
  platformFeeCents: 0,
  processingFeeCents: 82,
  taxCents: 159,
  creditCents: 0,
  totalCents: 1741,
};

describe("OrderDetailPanel — buyer paid and event credit", () => {
  it("shows what the buyer paid, its four lines, and the full-price credit; no bare Total", () => {
    renderPanel(makeOrder());

    expect(valueBeside("admin.odBuyerPaid")).toBe("usd:1791");
    // Ticket price appears twice: the buyer's line and the credit's.
    expect(valueBeside("admin.odTicketPrice", 0)).toBe("usd:1500");
    expect(valueBeside("admin.odPlatformFee")).toBe("usd:50");
    expect(valueBeside("admin.odProcessingFee")).toBe("usd:82");
    expect(valueBeside("admin.odTax")).toBe("usd:159");

    expect(valueBeside("admin.odEventCredit")).toBe("usd:1500");
    expect(valueBeside("admin.odTicketPrice", 1)).toBe("usd:1500");
    // The buyer did pay a platform fee, so "on top" is true here.
    expect(screen.getByText("admin.odFullPriceCredited")).toBeInTheDocument();
    expect(screen.queryByText("admin.odFullPrice")).not.toBeInTheDocument();
    expect(
      screen.queryByText("admin.odPlatformFeeTakenFromPrice"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("admin.odExpectedCredit")).not.toBeInTheDocument();
    expect(
      screen.queryByText("admin.odPayoutTermsDivide"),
    ).not.toBeInTheDocument();

    expect(screen.queryByText("admin.total")).not.toBeInTheDocument();
    // The old standalone fee and tax cells are folded into the lines.
    expect(screen.queryByText("admin.platformFee")).not.toBeInTheDocument();
    expect(screen.queryByText("admin.tax")).not.toBeInTheDocument();
  });

  it("a fee-waived sale does not claim the buyer paid a platform fee on top", () => {
    renderPanel(
      makeOrder({
        feesPlatformCents: 0,
        buyerTotalCents: 1741,
        charges: FREE_CHARGES,
      }),
    );

    expect(screen.queryByText("admin.odPlatformFee")).not.toBeInTheDocument();
    expect(screen.getByText("admin.odFullPrice")).toBeInTheDocument();
    expect(
      screen.queryByText("admin.odFullPriceCredited"),
    ).not.toBeInTheDocument();
  });

  it("a free order ($0, no splits) shows $0 paid and credited $0: no pending credit", () => {
    // The shape getOrgOrder sends for a claimFreeTickets order: no OrderSplit
    // rows and a rule figure of 0, reported CREDITED at $0 with no payees.
    renderPanel(
      makeOrder({
        amountGrossCents: 0,
        feesPlatformCents: 0,
        taxAmountCents: 0,
        stripePaymentIntentId: null,
        buyerTotalCents: 0,
        refundBasePaidCents: 0,
        charges: {
          ...FREE_CHARGES,
          subtotalCents: 0,
          processingFeeCents: 0,
          taxCents: 0,
          totalCents: 0,
        },
        eventCredit: {
          ticketPriceCents: 0,
          platformFeeTakenCents: 0,
          expectedCreditCents: 0,
          creditState: "CREDITED",
          creditedCents: 0,
          payeeCount: 0,
        },
      }),
    );

    expect(valueBeside("admin.odBuyerPaid")).toBe("usd:0");
    expect(valueBeside("admin.odEventCredit")).toBe("usd:0");
    expect(screen.queryByText("admin.odNotCreditedYet")).not.toBeInTheDocument();
    expect(screen.queryByText("admin.odExpectedCredit")).not.toBeInTheDocument();
    expect(screen.getByText("admin.odFullPrice")).toBeInTheDocument();
    expect(
      screen.queryByText("admin.odFullPriceCredited"),
    ).not.toBeInTheDocument();
  });

  it("an order sold before the ruling shows the fee taken from the price", () => {
    renderPanel(
      makeOrder({
        feePolicySnapshot: { feeMode: "PASS_THROUGH" },
        eventCredit: {
          ticketPriceCents: 1500,
          platformFeeTakenCents: 50,
          expectedCreditCents: 1450,
          creditState: "CREDITED",
          creditedCents: 1450,
          payeeCount: 1,
        },
      }),
    );

    expect(valueBeside("admin.odEventCredit")).toBe("usd:1450");
    expect(valueBeside("admin.odPlatformFeeTakenFromPrice")).toBe(
      "\u2212usd:50",
    );
    expect(screen.queryByText("admin.odFullPrice")).not.toBeInTheDocument();
    expect(
      screen.queryByText("admin.odFullPriceCredited"),
    ).not.toBeInTheDocument();
  });

  it("a credit the payout terms divide says so, with the payee count", () => {
    renderPanel(
      makeOrder({
        eventCredit: {
          ticketPriceCents: 1500,
          platformFeeTakenCents: 0,
          expectedCreditCents: 1500,
          creditState: "CREDITED",
          creditedCents: 1500,
          payeeCount: 2,
        },
      }),
    );

    expect(valueBeside("admin.odEventCredit")).toBe("usd:1500");
    expect(
      screen.getByText('admin.odPayoutTermsDivide {"count":2}'),
    ).toBeInTheDocument();
  });

  it("no split written yet: 'Not credited yet', and the rule's figure as the expected credit", () => {
    renderPanel(
      makeOrder({
        eventCredit: {
          ticketPriceCents: 1500,
          platformFeeTakenCents: 0,
          expectedCreditCents: 1500,
          creditState: "NOT_YET",
          creditedCents: null,
          payeeCount: 0,
        },
      }),
    );

    expect(valueBeside("admin.odEventCredit")).toBe("admin.odNotCreditedYet");
    expect(valueBeside("admin.odExpectedCredit")).toBe("usd:1500");
  });

  it("a failed split read says the credit could not be loaded, never 'not credited yet'", () => {
    renderPanel(
      makeOrder({
        eventCredit: {
          ticketPriceCents: 1500,
          platformFeeTakenCents: 0,
          expectedCreditCents: 1500,
          creditState: "UNAVAILABLE",
          creditedCents: null,
          payeeCount: 0,
        },
      }),
    );

    expect(valueBeside("admin.odEventCredit")).toBe(
      "admin.odCreditUnavailable",
    );
    expect(screen.queryByText("admin.odNotCreditedYet")).not.toBeInTheDocument();
    expect(screen.queryByText("admin.odExpectedCredit")).not.toBeInTheDocument();
    // Nor the rule's sentence: beside "could not be loaded" it reads as a figure.
    expect(screen.queryByText("admin.odFullPrice")).not.toBeInTheDocument();
    expect(
      screen.queryByText("admin.odFullPriceCredited"),
    ).not.toBeInTheDocument();
  });

  it("leaves out zero lines and shows no credit when the server sends none (cash)", () => {
    renderPanel(
      makeOrder({
        paymentChannel: "CASH",
        stripePaymentIntentId: null,
        feesPlatformCents: 0,
        buyerTotalCents: 1659,
        cashAmountPaidCents: 1659,
        charges: {
          buyerFeeMode: "ABSORB",
          subtotalCents: 1500,
          platformFeeCents: 0,
          processingFeeCents: 0,
          taxCents: 159,
          creditCents: 0,
          totalCents: 1659,
        },
        eventCredit: null,
      }),
    );

    expect(valueBeside("admin.odBuyerPaid")).toBe("usd:1659");
    expect(screen.queryByText("admin.odPlatformFee")).not.toBeInTheDocument();
    expect(screen.queryByText("admin.odProcessingFee")).not.toBeInTheDocument();
    expect(valueBeside("admin.odTax")).toBe("usd:159");
    expect(screen.queryByText("admin.odEventCredit")).not.toBeInTheDocument();
  });

  it("a legacy cash sale with no lines that add up: the cash figure alone, said plainly", () => {
    renderPanel(
      makeOrder({
        paymentChannel: "CASH",
        stripePaymentIntentId: null,
        buyerTotalCents: 1709,
        cashAmountPaidCents: 1709,
        charges: null,
        eventCredit: null,
      }),
    );

    expect(valueBeside("admin.odBuyerPaid")).toBe("usd:1709");
    expect(screen.getByText("admin.odNoBuyerLines")).toBeInTheDocument();
    expect(screen.queryByText("admin.odTicketPrice")).not.toBeInTheDocument();
  });

  it("shows a platform credit the buyer used as a minus line", () => {
    renderPanel(
      makeOrder({
        buyerTotalCents: 1691,
        charges: {
          buyerFeeMode: "PASS_THROUGH",
          subtotalCents: 1500,
          platformFeeCents: 50,
          processingFeeCents: 82,
          taxCents: 159,
          creditCents: -100,
          totalCents: 1691,
        },
      }),
    );

    expect(valueBeside("admin.odBuyerCredit")).toBe("\u2212usd:100");
    expect(valueBeside("admin.odBuyerPaid")).toBe("usd:1691");
  });

  it.each([
    ["PENDING", "NOT_CHARGED", "admin.odNothingCharged"],
    ["CANCELLED", "NOT_CHARGED", "admin.odNothingCharged"],
    ["PROCESSING", "PROCESSING", "admin.odPaymentProcessing"],
  ])(
    "a %s order heads the figure 'Order total' and says where the payment stands",
    (status, chargeState, caption) => {
      renderPanel(
        makeOrder({ status, chargeState, buyerPaid: false, eventCredit: null }),
      );

      expect(screen.queryByText("admin.odBuyerPaid")).not.toBeInTheDocument();
      expect(valueBeside("admin.odOrderTotal")).toBe("usd:1791");
      expect(screen.getByText(caption)).toBeInTheDocument();
      // The lines still say what the order would cost.
      expect(valueBeside("admin.odPlatformFee")).toBe("usd:50");
    },
  );

  it("a paid order has no payment-state caption", () => {
    renderPanel(makeOrder());

    expect(screen.queryByText("admin.odOrderTotal")).not.toBeInTheDocument();
    expect(screen.queryByText("admin.odNothingCharged")).not.toBeInTheDocument();
    expect(
      screen.queryByText("admin.odPaymentProcessing"),
    ).not.toBeInTheDocument();
  });
});
