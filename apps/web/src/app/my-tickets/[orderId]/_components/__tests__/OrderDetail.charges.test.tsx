import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The order page's price breakdown. It renders `getMyOrder().charges` and
 * nothing else, so the lines always add to Total paid, and an ABSORB buyer
 * (charged face + tax) never sees a platform or processing fee, even though
 * the order still records `feesPlatformCents` as the organiser's cost.
 */

const testState = vi.hoisted(() => ({
  orderQuery: {} as Record<string, unknown>,
  ticketsQuery: {} as Record<string, unknown>,
  eligibilityQuery: {} as Record<string, unknown>,
  quoteQuery: {} as Record<string, unknown>,
  resale: false,
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
    Badge: Passthrough,
    ButtonGroup: Passthrough,
    Ticket: ({ testId }: { testId?: string }) => <div data-testid={testId} />,
    MenuButton: ({ testId, label }: { testId?: string; label: string }) => (
      <button type="button" data-testid={testId}>
        {label}
      </button>
    ),
    useFormatters: () => ({ dateTime: () => "date" }),
    useTranslations: () => (key: string) => key,
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
  useFeatureGates: () => ({ gates: { resale: testState.resale } }),
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
  ticketStatus?: string;
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
          status: opts.ticketStatus ?? "VALID",
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

beforeEach(() => {
  testState.quoteQuery = { data: undefined, error: null, refetch: vi.fn() };
  testState.resale = false;
});

/** Cents shown for a translated row label, via the `usd:<cents>` format mock. */
function rowCents(labelKey: string): number | null {
  const label = screen.queryByText(labelKey);
  if (!label) return null;
  const row = label.parentElement!;
  const value = Array.from(row.children).find((el) => el !== label);
  const m = /usd:(-?\d+)/.exec(value?.textContent ?? "");
  if (!m) throw new Error(`no amount next to ${labelKey}`);
  return Number(m[1]) * ((value?.textContent ?? "").startsWith("−") ? -1 : 1);
}

const LINE_KEYS = [
  "orderDetail.subtotal",
  "orderDetail.platformFee",
  "orderDetail.tax",
  "orderDetail.processingFee",
  "orderDetail.creditApplied",
];

function expectLinesAddToTotal() {
  const total = rowCents("orderDetail.totalPaid");
  expect(total).not.toBeNull();
  const sum = LINE_KEYS.reduce((acc, key) => acc + (rowCents(key) ?? 0), 0);
  expect(sum).toBe(total);
}

describe("OrderDetail — price lines", () => {
  it("PASS_THROUGH: shows the platform and processing fees, and they add up", () => {
    arrange({
      order: {
        amountGrossCents: 1000,
        feesPlatformCents: 33,
        taxAmountCents: 89,
        buyerTotalCents: 1186,
        charges: {
          buyerFeeMode: "PASS_THROUGH",
          subtotalCents: 1000,
          platformFeeCents: 33,
          processingFeeCents: 64,
          taxCents: 89,
          creditCents: 0,
          totalCents: 1186,
        },
      },
    });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);

    expect(rowCents("orderDetail.platformFee")).toBe(33);
    expect(rowCents("orderDetail.processingFee")).toBe(64);
    expect(rowCents("orderDetail.tax")).toBe(89);
    expect(rowCents("orderDetail.totalPaid")).toBe(1186);
    expectLinesAddToTotal();
  });

  it("ABSORB: no platform or processing fee; $10.00 + $0.89 = $10.89", () => {
    arrange({
      order: {
        amountGrossCents: 1000,
        // Recorded: the organiser's cost. Must NOT reach the buyer.
        feesPlatformCents: 33,
        taxAmountCents: 89,
        buyerTotalCents: 1089,
        charges: {
          buyerFeeMode: "ABSORB",
          subtotalCents: 1000,
          platformFeeCents: 0,
          processingFeeCents: 0,
          taxCents: 89,
          creditCents: 0,
          totalCents: 1089,
        },
      },
    });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);

    expect(screen.queryByText("orderDetail.platformFee")).toBeNull();
    expect(screen.queryByText("orderDetail.processingFee")).toBeNull();
    expect(screen.queryByText("usd:33")).toBeNull();
    expect(rowCents("orderDetail.subtotal")).toBe(1000);
    expect(rowCents("orderDetail.totalPaid")).toBe(1089);
    expectLinesAddToTotal();
  });

  it("free order: subtotal and total are zero, no fee rows", () => {
    arrange({
      order: {
        amountGrossCents: 0,
        feesPlatformCents: 0,
        buyerTotalCents: 0,
        charges: {
          buyerFeeMode: "PASS_THROUGH",
          subtotalCents: 0,
          platformFeeCents: 0,
          processingFeeCents: 0,
          taxCents: 0,
          creditCents: 0,
          totalCents: 0,
        },
      },
    });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);

    expect(screen.queryByText("orderDetail.platformFee")).toBeNull();
    expect(screen.queryByText("orderDetail.processingFee")).toBeNull();
    expect(rowCents("orderDetail.totalPaid")).toBe(0);
    expectLinesAddToTotal();
  });

  it("refunded order: the lines still add to what was paid", () => {
    arrange({
      order: {
        status: "REFUNDED",
        buyerTotalCents: 4900,
        charges: {
          buyerFeeMode: "ABSORB",
          subtotalCents: 4500,
          platformFeeCents: 0,
          processingFeeCents: 0,
          taxCents: 400,
          creditCents: 0,
          totalCents: 4900,
        },
        items: [
          {
            ...order().items[0],
            status: "refunded",
            refundedAt: "2026-09-02T00:00:00.000Z",
          },
        ],
      },
      eligibility: { isEligible: false, reason: "already_refunded" },
      ticketStatus: "REFUNDED",
    });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);

    expect(screen.queryByText("orderDetail.platformFee")).toBeNull();
    expect(rowCents("orderDetail.totalPaid")).toBe(4900);
    expectLinesAddToTotal();
  });

  it("a platform credit is its own negative line", () => {
    arrange({
      order: {
        buyerTotalCents: 686,
        charges: {
          buyerFeeMode: "PASS_THROUGH",
          subtotalCents: 1000,
          platformFeeCents: 33,
          processingFeeCents: 64,
          taxCents: 89,
          creditCents: -500,
          totalCents: 686,
        },
      },
    });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);

    expect(rowCents("orderDetail.creditApplied")).toBe(-500);
    expectLinesAddToTotal();
  });
});
