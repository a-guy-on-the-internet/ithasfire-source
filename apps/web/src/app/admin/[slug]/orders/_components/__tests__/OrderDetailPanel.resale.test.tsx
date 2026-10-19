import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-item refunds refuse a RESALE order (`RESALE_ORDER_USE_FULL_REFUND`):
 * only the full refund performs the resale unwind. So on a RESALE order the
 * panel must not offer the item path at all — no checkboxes, no select-all,
 * no quote — and must offer `orders.orgRefundFullOrder` instead, with the
 * same required audit note. A PRIMARY order is untouched.
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
  useTranslations: () => (key: string) => key,
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

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    eventId: "22222222-2222-4222-8222-222222222222",
    eventTitle: "Launch Party",
    orgName: "Org",
    buyerHumanId: "33333333-3333-4333-8333-333333333333",
    buyerName: "Casey Buyer",
    buyerEmail: "casey@example.com",
    amountGrossCents: 5000,
    feesPlatformCents: 500,
    taxAmountCents: 0,
    currency: "usd",
    status: "SUCCEEDED",
    source: "PRIMARY",
    stripePaymentIntentId: "pi_123",
    stripeTaxCalculationId: null,
    paymentMethodType: "card",
    parentOrderId: null,
    feePolicySnapshot: null,
    billingAddress: null,
    promo: null,
    occurredAt: new Date("2026-05-01T12:00:00.000Z"),
    paidOutAt: null,
    disputeStatus: null,
    refundBlockedByDispute: false,
    items: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "ticket",
        ticketTypeId: "tt-ga",
        qty: 1,
        unitPriceCents: 5000,
        amountCents: 5000,
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
    // getOrgOrder's money read for this order: no per-item buyer totals and
    // a Stripe charge, so the buyer paid gross + the platform fee.
    buyerTotalCents: 5500,
    refundBasePaidCents: 5500,
    chargeState: "PAID",
    buyerPaid: true,
    charges: {
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 5000,
      platformFeeCents: 500,
      processingFeeCents: 0,
      taxCents: 0,
      creditCents: 0,
      totalCents: 5500,
    },
    eventCredit: {
      ticketPriceCents: 5000,
      platformFeeTakenCents: 500,
      expectedCreditCents: 4500,
      creditState: "CREDITED",
      creditedCents: 4500,
      payeeCount: 1,
    },
    ...overrides,
  };
}

function renderPanel(
  order: ReturnType<typeof makeOrder>,
  { canFinance = true }: { canFinance?: boolean } = {},
) {
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
      canFinance={canFinance}
      onClose={() => {}}
    />,
  );
}

const wholeOrderButton = () =>
  screen.queryByRole("button", { name: "admin.refundWholeOrder" });
const selectAllButton = () =>
  screen.queryByRole("button", { name: "admin.selectAllRefundable" });
const confirmButton = () =>
  screen.getByRole("button", { name: "admin.confirmFullRefund" });
const noteField = () =>
  screen.getByRole("textbox", { name: "admin.refundNoteRequired" });

beforeEach(() => {
  testState.quoteQuery = { data: undefined, error: null, isLoading: false };
  testState.refundMutation = { mutate: vi.fn(), error: null };
  testState.fullRefundMutation = {
    mutate: vi.fn(),
    reset: vi.fn(),
    error: null,
  };
});

describe("OrderDetailPanel — RESALE order refunds whole", () => {
  it("hides the per-item path and offers the whole-order action", () => {
    renderPanel(makeOrder({ source: "RESALE" }));

    expect(selectAllButton()).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /admin\.quoteRefund/ }),
    ).not.toBeInTheDocument();
    expect(wholeOrderButton()).toBeInTheDocument();
    expect(screen.getByText("admin.resaleRefundExplainer")).toBeInTheDocument();
    // One explanation: the generic "nothing eligible" line must not also show.
    expect(screen.queryByText("admin.noTicketsEligible")).not.toBeInTheDocument();
  });

  it("goes straight to confirm (no org quote) and shows the paid total", () => {
    renderPanel(makeOrder({ source: "RESALE" }));

    fireEvent.click(wholeOrderButton()!);

    expect(confirmButton()).toBeInTheDocument();
    expect(testState.fullRefundMutation.reset).toHaveBeenCalled();
    // What the buyer paid is the magnitude the admin commits to, named as
    // that (not "Total", and not the ticket money alone), with the processing
    // fee the refund keeps back. It renders in the money block too, so
    // assert the confirm card added a second instance.
    expect(screen.getAllByText("admin.odBuyerPaid")).toHaveLength(2);
    expect(screen.getAllByText("usd:5500")).toHaveLength(2);
    expect(
      screen.getByText("admin.odRefundLessProcessingFee"),
    ).toBeInTheDocument();
    expect(screen.queryByText("admin.total")).not.toBeInTheDocument();
    expect(screen.queryByText("admin.refundQuote")).not.toBeInTheDocument();
  });

  it("the confirm names the refund's own base, even where the display breakdown departs from it", () => {
    // A legacy order whose breakdown total (5000) differs from
    // computeExpectedPaymentAmount (5500), the figure refunds start from.
    renderPanel(
      makeOrder({
        source: "RESALE",
        buyerTotalCents: 5000,
        refundBasePaidCents: 5500,
      }),
    );

    fireEvent.click(wholeOrderButton()!);

    const [blockLabel, confirmLabel] = screen.getAllByText("admin.odBuyerPaid");
    // Money block: the display total; confirm card: the refund base.
    expect(blockLabel!.nextElementSibling?.textContent).toBe("usd:5000");
    expect(confirmLabel!.nextElementSibling?.textContent).toBe("usd:5500");
  });

  it("blocks confirm until the note is at least 3 characters, then calls orgRefundFullOrder", () => {
    renderPanel(makeOrder({ source: "RESALE" }));
    fireEvent.click(wholeOrderButton()!);

    expect(confirmButton()).toBeDisabled();

    fireEvent.change(noteField(), { target: { value: "no" } });
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByText("admin.refundNoteTooShort")).toBeInTheDocument();
    fireEvent.click(confirmButton());
    expect(testState.fullRefundMutation.mutate).not.toHaveBeenCalled();

    fireEvent.change(noteField(), {
      target: { value: "  Buyer asked before the show  " },
    });
    expect(confirmButton()).toBeEnabled();
    fireEvent.click(confirmButton());

    expect(testState.fullRefundMutation.mutate).toHaveBeenCalledTimes(1);
    expect(testState.fullRefundMutation.mutate).toHaveBeenCalledWith({
      orgId: ORG_ID,
      orderId: ORDER_ID,
      note: "Buyer asked before the show",
    });
    // The item mutation is never the resale path.
    expect(testState.refundMutation.mutate).not.toHaveBeenCalled();
    expect(screen.getByText("admin.processingRefund")).toBeInTheDocument();
  });

  it("cancel returns to the action without calling the mutation", () => {
    renderPanel(makeOrder({ source: "RESALE" }));
    fireEvent.click(wholeOrderButton()!);
    fireEvent.click(screen.getByRole("button", { name: "admin.cancel" }));

    expect(wholeOrderButton()).toBeInTheDocument();
    expect(testState.fullRefundMutation.mutate).not.toHaveBeenCalled();
  });

  it("surfaces the mutation error through the shared formatter", () => {
    testState.fullRefundMutation = {
      mutate: vi.fn(),
      reset: vi.fn(),
      error: new Error("Order already refunded"),
    };
    renderPanel(makeOrder({ source: "RESALE" }));

    expect(screen.getByText("Order already refunded")).toBeInTheDocument();
  });

  it.each(["PART_REFUNDED", "REFUNDED", "CANCELLED"] as const)(
    "hides the whole-order action for a %s resale order (refundFullOrder refuses it)",
    (status) => {
      renderPanel(makeOrder({ source: "RESALE", status }));
      expect(wholeOrderButton()).not.toBeInTheDocument();
      expect(selectAllButton()).not.toBeInTheDocument();
    },
  );

  it("hides the whole-order action while a dispute blocks refunds", () => {
    renderPanel(
      makeOrder({
        source: "RESALE",
        disputeStatus: "OPEN",
        refundBlockedByDispute: true,
      }),
    );
    expect(wholeOrderButton()).not.toBeInTheDocument();
  });

  it("hides the whole-order action from admins without finance", () => {
    renderPanel(makeOrder({ source: "RESALE" }), { canFinance: false });
    expect(wholeOrderButton()).not.toBeInTheDocument();
    expect(
      screen.queryByText("admin.resaleRefundExplainer"),
    ).not.toBeInTheDocument();
  });
});

describe("OrderDetailPanel — PRIMARY order keeps the item path", () => {
  it("offers select-all and never the whole-order action", () => {
    renderPanel(makeOrder({ source: "PRIMARY" }));

    expect(selectAllButton()).toBeInTheDocument();
    expect(wholeOrderButton()).not.toBeInTheDocument();
    expect(
      screen.queryByText("admin.resaleRefundExplainer"),
    ).not.toBeInTheDocument();
  });
});
