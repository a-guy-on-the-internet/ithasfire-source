import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * The order page's status badge names every order status. A PROCESSING order
 * (a US bank debit that has not cleared and can still fail) used to show the
 * raw enum "PROCESSING"; it reads "Payment processing" in the warning tone.
 *
 * Mock prelude mirrors `OrderDetail.address-locked.test.tsx`.
 */

const testState = vi.hoisted(() => ({
  orderQuery: {} as Record<string, unknown>,
  ticketsQuery: {} as Record<string, unknown>,
  eligibilityQuery: {} as Record<string, unknown>,
  quoteQuery: {} as Record<string, unknown>,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("qrcode.react", () => ({ QRCodeSVG: () => null }));
vi.mock("@/app/_print/print-hide.css", () => ({}));

vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    ArrowLeft: Icon,
    RefreshCw: Icon,
    Repeat: Icon,
    Send: Icon,
    Calendar: Icon,
    Lock: Icon,
    MapPin: Icon,
    Printer: Icon,
    Wallet: Icon,
  };
});

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...props }: { children?: ReactNode }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (
        key === "role" ||
        key === "id" ||
        key === "data-testid" ||
        key.startsWith("aria-")
      )
        safe[key] = value;
    }
    return React.createElement("div", safe, children);
  };
  return {
    XStack: Stack,
    YStack: Stack,
    Card: Stack,
    Stack,
    Spinner: () => <span>Loading</span>,
    styled: () => Stack,
    useMedia: () => ({ xs: false }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Passthrough = ({
    children,
    role,
    id,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    role?: string;
    id?: string;
    "data-testid"?: string;
  }) => (
    <div role={role} id={id} data-testid={testId}>
      {children}
    </div>
  );
  const Button = React.forwardRef<
    HTMLButtonElement,
    {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      "data-testid"?: string;
      "aria-describedby"?: string;
    }
  >(function Button(
    { children, onPress, disabled, "data-testid": testId, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onPress}
        disabled={disabled}
        data-testid={testId}
        aria-describedby={rest["aria-describedby"]}
      >
        {children}
      </button>
    );
  });
  return {
    Button,
    Text: Passthrough,
    Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
      <span data-tone={tone}>{children}</span>
    ),
    ButtonGroup: Passthrough,
    Ticket: ({ testId }: { testId?: string }) => <div data-testid={testId} />,
    MenuButton: ({ testId, label }: { testId?: string; label: string }) => (
      <button type="button" data-testid={testId}>
        {label}
      </button>
    ),
    useFormatters: () => ({ dateTime: () => "FORMATTED_DATE" }),
    // Echo params so the reveal date can be asserted on.
    useTranslations:
      () => (key: string, params?: Record<string, unknown>) =>
        params ? `${key} ${JSON.stringify(params)}` : key,
  };
});

vi.mock("@th/types/order-identifier", () => ({
  formatOrderCode: (id: string) => id,
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number, currency: string) =>
    `${currency}:${cents}`,
}));

vi.mock("@/components/support/SupportWidget", () => ({
  useSupportChatAvailable: () => false,
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: { resale: false } }),
}));
vi.mock("@/lib/tickets/printable-tickets", () => ({
  selectPrintableTickets: () => [],
}));

vi.mock("@/trpc", () => {
  const noopMutation = () => ({ mutate: vi.fn(), isPending: false, error: null });
  const disabledQuery = {
    data: undefined,
    isLoading: false,
    isError: false,
    isSuccess: false,
    error: null,
  };
  return {
    trpc: {
      useUtils: () => ({
        orders: {
          getMyOrder: { invalidate: vi.fn() },
          listMyOrderTickets: { invalidate: vi.fn() },
          listMyOrders: { invalidate: vi.fn() },
          getRefundEligibility: { invalidate: vi.fn() },
        },
      }),
      orders: {
        getMyOrder: { useQuery: () => testState.orderQuery },
        listMyOrderTickets: { useQuery: () => testState.ticketsQuery },
        getRefundEligibility: { useQuery: () => testState.eligibilityQuery },
        quoteItemRefund: { useQuery: () => testState.quoteQuery },
        refundOrderItems: { useMutation: noopMutation },
      },
      walletPasses: { generate: { useMutation: noopMutation } },
      // useResaleClaimView reads these on every order page; both queries are
      // disabled for an ordinary (non-resale) order, so they return no data.
      entityPages: { getMyProfile: { useQuery: () => disabledQuery } },
      claims: { list: { useQuery: () => disabledQuery } },
    },
  };
});

import { OrderDetail } from "../OrderDetail";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_ID = "33333333-3333-4333-8333-333333333333";

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    status: "SUCCEEDED",
    amountGrossCents: 5000,
    feesPlatformCents: 500,
    buyerTotalCents: 5700,
    taxAmountCents: 0,
    charges: {
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 5000,
      platformFeeCents: 500,
      processingFeeCents: 200,
      taxCents: 0,
      creditCents: 0,
      totalCents: 5700,
    },
    currency: "usd",
    eventId: "44444444-4444-4444-8444-444444444444",
    eventName: "Test Event",
    eventStartsAt: "2026-12-01T19:00:00.000Z",
    eventVenue: "Somewhere",
    organiserName: "Org",
    organiserContactEmail: null,
    items: [
      {
        id: ITEM_ID,
        qty: 1,
        unitPriceCents: 5000,
        amountCents: 5000,
        kind: "ticket",
        ticketTypeId: "tt-1",
        resaleListingId: null,
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      },
    ],
    stripePaymentIntentId: "pi_123",
    ticketTypeNames: { "tt-1": "GA" },
    occurredAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function eligibility(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID,
    isEligible: true,
    reason: "eligible",
    eventStartsAt: "2026-12-01T19:00:00.000Z",
    refundDeadline: "2026-12-01T19:00:00.000Z",
    feeBreakdown: null,
    hasTransferredItems: false,
    refundableItemCount: 1,
    totalItemCount: 1,
    ...overrides,
  };
}

function arrange(opts: {
  order?: Record<string, unknown>;
  eligibility?: Record<string, unknown> | null;
  eligibilityError?: unknown;
}) {
  testState.orderQuery = {
    data: order(opts.order),
    isLoading: false,
    error: null,
  };
  testState.ticketsQuery = {
    data: {
      tickets: [
        {
          id: TICKET_ID,
          code: "ABC123",
          status: "VALID",
          scannedAt: null,
          orderItemId: ITEM_ID,
          ticketTypeId: "tt-1",
        },
      ],
    },
    isLoading: false,
  };
  testState.eligibilityQuery = {
    data: opts.eligibility === null ? undefined : eligibility(opts.eligibility),
    error: opts.eligibilityError ?? null,
  };
}

describe("OrderDetail — order status badge", () => {
  it("PROCESSING reads 'Payment processing' in the warning tone, never the raw enum", () => {
    arrange({ order: { status: "PROCESSING" } });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);

    const badge = screen.getByText("myTickets.paymentProcessing");
    expect(badge).toHaveAttribute("data-tone", "warning");
    expect(screen.queryByText("PROCESSING")).not.toBeInTheDocument();
  });

  it("SUCCEEDED still reads Confirmed in the success tone", () => {
    arrange({ order: { status: "SUCCEEDED" } });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);

    expect(screen.getByText("myTickets.confirmed")).toHaveAttribute(
      "data-tone",
      "success",
    );
  });
});
