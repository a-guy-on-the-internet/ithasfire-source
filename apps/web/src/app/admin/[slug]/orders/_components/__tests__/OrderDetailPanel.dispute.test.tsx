import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORDER_DISPUTED_LOST_REFUND_BLOCKED_MESSAGE,
  ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE,
} from "@/lib/format-error-message";

/**
 * The refund affordance must refuse UP FRONT when the order's charge is under
 * dispute — Stripe will reject the refund (`charge_disputed`), and the server
 * now refuses before calling Stripe. Waiting for that server error would mean
 * quoting, writing a note, confirming, and only then learning it can't happen.
 */

const testState = vi.hoisted(() => ({
  orgOrderQuery: {} as Record<string, unknown>,
  quoteQuery: { data: undefined, error: null, isLoading: false } as Record<
    string,
    unknown
  >,
  refundMutation: { mutate: vi.fn(), error: null } as Record<string, unknown>,
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
  TextInput: () => <input />,
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
      orgRefundFullOrder: {
        useMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), error: null }),
      },
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

beforeEach(() => {
  testState.quoteQuery = { data: undefined, error: null, isLoading: false };
  testState.refundMutation = { mutate: vi.fn(), error: null };
});

describe("OrderDetailPanel — dispute refund block", () => {
  it("refuses up front: no refund affordance, the dispute sentence inline", () => {
    renderPanel(
      makeOrder({ disputeStatus: "OPEN", refundBlockedByDispute: true }),
    );

    // Explained, not just hidden — the sentence itself, not any live region
    // (the dispute banner also renders for this fixture).
    expect(
      screen.getByText(ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE),
    ).toBeInTheDocument();
    // The refund flow starts by selecting refundable items; none are offered.
    expect(
      screen.queryByRole("button", { name: "admin.selectAllRefundable" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "admin.quoteRefund" }),
    ).not.toBeInTheDocument();
    // And the generic "nothing eligible" line does NOT also render — one
    // explanation, the specific one.
    expect(screen.queryByText("admin.noTicketsEligible")).not.toBeInTheDocument();
  });

  it("uses the permanent wording for a LOST dispute (no 'once the dispute closes')", () => {
    renderPanel(
      makeOrder({ disputeStatus: "LOST", refundBlockedByDispute: true }),
    );

    expect(
      screen.getByText(ORDER_DISPUTED_LOST_REFUND_BLOCKED_MESSAGE),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "admin.selectAllRefundable" }),
    ).not.toBeInTheDocument();
  });

  it("offers the refund affordance for the same order when no dispute blocks it", () => {
    renderPanel(
      makeOrder({ disputeStatus: "WON", refundBlockedByDispute: false }),
    );

    expect(
      screen.getByRole("button", { name: "admin.selectAllRefundable" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE),
    ).not.toBeInTheDocument();
  });

  it("does not show the finance-only explanation to admins who cannot refund anyway", () => {
    testState.orgOrderQuery = {
      data: makeOrder({ disputeStatus: "OPEN", refundBlockedByDispute: true }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
    render(
      <OrderDetailPanel
        orderId={ORDER_ID}
        orgId={ORG_ID}
        canFinance={false}
        onClose={() => {}}
      />,
    );

    expect(
      screen.queryByText(ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE),
    ).not.toBeInTheDocument();
  });
});

describe("OrderDetailPanel — dispute banner (keyed on disputeStatus, not order.status)", () => {
  it.each(["OPEN", "UNDER_REVIEW"] as const)(
    "shows the existing under-dispute copy for %s even though order.status is SUCCEEDED",
    (disputeStatus) => {
      renderPanel(
        makeOrder({ status: "SUCCEEDED", disputeStatus, refundBlockedByDispute: true }),
      );
      const banner = screen.getByRole("note", { name: "Order under dispute" });
      expect(banner).toHaveTextContent("admin.disputeBanner");
      expect(banner).toHaveTextContent("admin.disputeDescription");
      expect(banner).toHaveTextContent("admin.viewDisputeInStripe");
    },
  );

  it("shows Dispute lost for LOST", () => {
    renderPanel(
      makeOrder({ disputeStatus: "LOST", refundBlockedByDispute: true }),
    );
    const banner = screen.getByRole("note", { name: "Dispute lost" });
    expect(banner).toHaveTextContent("Dispute lost");
    expect(banner).toHaveTextContent(
      "The disputed amount has been deducted from your payouts. The card network's dispute fee is not passed on to you. This order can't be refunded.",
    );
    // The platform bears the network fee for ticketing disputes; never claim
    // it was taken from the organiser.
    expect(banner).not.toHaveTextContent("dispute fee have been taken back");
  });

  it("shows Dispute won with no further action for WON, and the refund affordance is back", () => {
    renderPanel(
      makeOrder({ disputeStatus: "WON", refundBlockedByDispute: false }),
    );
    const banner = screen.getByRole("note", { name: "Dispute won" });
    expect(banner).toHaveTextContent("No further action is needed");
    expect(
      screen.getByRole("button", { name: "admin.selectAllRefundable" }),
    ).toBeInTheDocument();
  });

  it.each(["WARNING_OPEN", "WARNING_UNDER_REVIEW", "WARNING_CLOSED", "NEEDS_TRIAGE", null] as const)(
    "renders no banner for %s",
    (disputeStatus) => {
      renderPanel(makeOrder({ disputeStatus, refundBlockedByDispute: false }));
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
    },
  );

  it("does not link to the platform dispute desk (the DTO carries no dispute id)", () => {
    renderPanel(
      makeOrder({ disputeStatus: "OPEN", refundBlockedByDispute: true }),
    );
    expect(
      screen.queryByRole("link", { name: /dispute/i }),
    ).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("/platform/disputes");
  });
});
