import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The per-ticket "Refund" trigger must not be offered when the server will
 * refuse it: once the buyer refund window has closed (`REFUND_WINDOW_CLOSED`)
 * or for a resale purchase (`RESALE_ORDER_USE_FULL_REFUND` — those refund
 * whole via the full-refund page). Both codes have no catalog copy, so a
 * buyer who reached them saw "Could not load refund quote" + Retry — an
 * outage, not a policy. The gate is sourced from `getRefundEligibility`, the
 * same display query the refund page reads.
 */

const testState = vi.hoisted(() => ({
  orderQuery: {} as Record<string, unknown>,
  ticketsQuery: {} as Record<string, unknown>,
  eligibilityQuery: {} as Record<string, unknown>,
  quoteQuery: {} as Record<string, unknown>,
  resale: false,
  claims: [] as Array<Record<string, unknown>>,
  /** The claims read is still in flight (resale orders only). */
  claimsLoading: false,
  /** The claims read failed. */
  claimsError: false,
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
      // useResaleClaimView reads these only for a RESALE order (the hook
      // ignores them otherwise). They answer like settled reads by default,
      // claims or none, so "reads done, no claims" is expressible.
      entityPages: {
        getMyProfile: {
          useQuery: () => ({
            ...disabledQuery,
            data: { humanId: "h-1" },
            isSuccess: true,
          }),
        },
      },
      claims: {
        list: {
          useQuery: () =>
            testState.claimsLoading
              ? { ...disabledQuery, isLoading: true }
              : testState.claimsError
              ? { ...disabledQuery, isError: true }
              : {
                  ...disabledQuery,
                  data: { items: testState.claims },
                  isSuccess: true,
                },
        },
      },
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

const refundTrigger = () => screen.queryByTestId(`refund-item-${ITEM_ID}`);
const fullRefundLink = () =>
  document.querySelector(`a[href="/my-tickets/${ORDER_ID}/refund"]`);

beforeEach(() => {
  testState.quoteQuery = { data: undefined, error: null, refetch: vi.fn() };
  testState.resale = false;
  testState.claims = [];
  testState.claimsLoading = false;
  testState.claimsError = false;
});

describe("OrderDetail — per-ticket refund gate", () => {
  it("offers the per-ticket refund on an eligible primary order", () => {
    arrange({});
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(refundTrigger()).toBeInTheDocument();
    expect(fullRefundLink()).not.toBeNull();
  });

  it.each([
    "event_started",
    "past_refund_deadline",
    "non_refundable_order",
    "no_refundable_items",
    // Free checkouts / comps: SUCCEEDED, no PaymentIntent, active items.
    "order_not_paid",
    "order_not_found",
    "disputed",
    "disputed_lost",
  ])(
    "hides it when the server would refuse (%s); full refund stays the path",
    (reason) => {
      arrange({ eligibility: { isEligible: false, reason } });
      render(
        <OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />,
      );
      expect(refundTrigger()).not.toBeInTheDocument();
      // Transfer is untouched by the window rule.
      expect(screen.getByTestId(`transfer-item-${ITEM_ID}`)).toBeInTheDocument();
      // The refund page explains the deadline itself.
      expect(fullRefundLink()).not.toBeNull();
    },
  );

  it("hides it for a resale purchase; the full-order refund (which unwinds the listing) stays", () => {
    arrange({
      order: {
        items: [
          {
            ...order().items[0],
            resaleListingId: "55555555-5555-4555-8555-555555555555",
          },
        ],
      },
    });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(refundTrigger()).not.toBeInTheDocument();
    expect(fullRefundLink()).not.toBeNull();
  });

  it("fails closed while eligibility is still loading", () => {
    arrange({ eligibility: null });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(refundTrigger()).not.toBeInTheDocument();
  });

  it("fails open when the eligibility read itself errors", () => {
    arrange({ eligibility: null, eligibilityError: new Error("boom") });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(refundTrigger()).toBeInTheDocument();
  });

  it("hides the per-ticket trigger for a PAID-OUT item on an otherwise eligible order", () => {
    // Mixed order: the order-level reason is `eligible`, but this item's
    // revenue has paid out, so the quote would answer `already_paid_out`.
    arrange({
      order: {
        items: [{ ...order().items[0], paidOutAt: "2026-09-01T00:00:00.000Z" }],
      },
    });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(refundTrigger()).not.toBeInTheDocument();
  });

  it("hides it for order_already_paid_out — buyer refunds stop at payout on the server too", () => {
    arrange({
      eligibility: { isEligible: false, reason: "order_already_paid_out" },
    });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(refundTrigger()).not.toBeInTheDocument();
  });

  it("on a PART_REFUNDED order the display query cannot report the window; a REFUND_WINDOW_CLOSED quote reads as the deadline, not an outage", () => {
    // `getRefundEligibility` returns `already_refunded` for PART_REFUNDED
    // orders before it checks timing, so the trigger legitimately renders...
    arrange({
      order: { status: "PART_REFUNDED" },
      eligibility: { isEligible: false, reason: "already_refunded" },
    });
    // ...and the quote is where the closed window surfaces.
    testState.quoteQuery = {
      data: undefined,
      error: { data: { appCode: "REFUND_WINDOW_CLOSED", code: "FORBIDDEN" } },
      refetch: vi.fn(),
    };
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);

    const trigger = refundTrigger();
    expect(trigger).toBeInTheDocument();
    fireEvent.click(trigger!);

    const message = screen.getByTestId(`refund-item-${ITEM_ID}-closed`);
    expect(message).toHaveTextContent("refund.reasonPastDeadline");
    expect(screen.queryByText("orderDetail.couldNotLoadQuote")).toBeNull();
    // A policy refusal cannot be retried into.
    expect(screen.queryByTestId(`refund-item-${ITEM_ID}-retry`)).toBeNull();
    // The trigger unmounted under the pointer; focus moves to Cancel, which
    // the message describes, so the reason is announced with the focus.
    const cancel = screen.getByTestId(`refund-item-${ITEM_ID}-cancel`);
    expect(cancel).toHaveFocus();
    expect(cancel).toHaveAttribute("aria-describedby", message.id);
    expect(message.id).not.toBe("");
  });

  it("any other quote failure keeps the retry path", () => {
    arrange({});
    testState.quoteQuery = {
      data: undefined,
      error: { data: { code: "INTERNAL_SERVER_ERROR" }, message: "nope" },
      refetch: vi.fn(),
    };
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    fireEvent.click(refundTrigger()!);
    expect(screen.getByText("orderDetail.couldNotLoadQuote")).toBeInTheDocument();
    const retry = screen.getByTestId(`refund-item-${ITEM_ID}-retry`);
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute(
      "aria-describedby",
      screen.getByText("orderDetail.couldNotLoadQuote").id,
    );
  });
});

// Owner rule 2026-09-28: a past event's ticket cannot be transferred or
// resold. `eventEnded` comes from `getMyOrder` (core's `isEventPast`).
describe("OrderDetail — past event closes transfer", () => {
  const transferLink = () =>
    document.querySelector(`a[href="/my-tickets/${ORDER_ID}/transfer"]`);

  it("offers Transfer (and Resell, gate on) while the event is not over", () => {
    testState.resale = true;
    arrange({ order: { eventEnded: false } });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(screen.getByTestId(`transfer-item-${ITEM_ID}`)).toBeInTheDocument();
    expect(transferLink()).not.toBeNull();
    expect(screen.getByTestId(`resell-item-${ITEM_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`transfer-closed-${TICKET_ID}`)).toBeNull();
  });

  it("hides Transfer and Resell once the event has ended, and says why", () => {
    testState.resale = true;
    arrange({ order: { eventEnded: true } });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(screen.queryByTestId(`transfer-item-${ITEM_ID}`)).toBeNull();
    expect(transferLink()).toBeNull();
    expect(screen.queryByTestId(`resell-item-${ITEM_ID}`)).toBeNull();
    expect(screen.getByTestId(`transfer-closed-${TICKET_ID}`)).toHaveTextContent(
      "orderDetail.transferClosedEventEnded",
    );
  });

  it.each(["SCANNED", "LISTED", "INVALID"])(
    "does not offer Transfer for a %s ticket whose item is still active",
    (ticketStatus) => {
      arrange({ order: { eventEnded: false }, ticketStatus });
      render(
        <OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />,
      );
      expect(screen.queryByTestId(`transfer-item-${ITEM_ID}`)).toBeNull();
      expect(transferLink()).toBeNull();
      // Not transferable for a reason other than the event ending: no note.
      expect(screen.queryByTestId(`transfer-closed-${TICKET_ID}`)).toBeNull();
    },
  );

  it("says nothing about transfers for a ticket that was never transferable", () => {
    arrange({
      order: {
        eventEnded: true,
        items: [{ ...order().items[0], refundedAt: "2026-09-01T00:00:00.000Z" }],
      },
    });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(screen.queryByTestId(`transfer-closed-${TICKET_ID}`)).toBeNull();
  });
});

describe("OrderDetail — full refund while a resale claim refund is pending", () => {
  const claim = (overrides: Record<string, unknown> = {}) => ({
    id: "c-1",
    orderId: ORDER_ID,
    orderItemId: ITEM_ID,
    status: "approved",
    refundConfirmed: false,
    ...overrides,
  });

  it("hides the full-refund request; the claim section is what says the refund is on its way", () => {
    arrange({ order: { source: "RESALE" } });
    testState.claims = [claim()];
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(fullRefundLink()).toBeNull();
    expect(screen.getByText("resaleClaim.nextApproved")).toBeInTheDocument();
  });

  it("offers the full-refund request on a RESALE order once the reads settle with no claims", () => {
    arrange({ order: { source: "RESALE" } });
    testState.claims = [];
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(fullRefundLink()).not.toBeNull();
  });

  it("does not flash the full-refund request while the claims are still loading", () => {
    arrange({ order: { source: "RESALE" } });
    testState.claims = [claim()];
    testState.claimsLoading = true;
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(fullRefundLink()).toBeNull();
  });

  it("fails open when the claims read errors: the server still refuses a second refund", () => {
    arrange({ order: { source: "RESALE" } });
    testState.claims = [claim()];
    testState.claimsError = true;
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(fullRefundLink()).not.toBeNull();
  });

  it("offers the full-refund request on a primary order without waiting on the claim reads", () => {
    arrange({});
    testState.claimsLoading = true;
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(fullRefundLink()).not.toBeNull();
  });

  it.each([
    ["undecided", { status: "open" }],
    ["denied", { status: "denied" }],
  ])("keeps the full-refund request when the claim is %s", (_n, o) => {
    arrange({ order: { source: "RESALE" } });
    testState.claims = [claim(o)];
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(fullRefundLink()).not.toBeNull();
  });
});

describe("OrderDetail — tickets that left the buyer", () => {
  function arrangeGone(
    itemOverrides: Record<string, unknown>,
    orderOverrides: Record<string, unknown> = {},
  ) {
    arrange({
      order: {
        ...orderOverrides,
        items: [{ ...order().items[0], ...itemOverrides }],
      },
    });
    testState.ticketsQuery = { data: { tickets: [] }, isLoading: false };
  }

  it("stays neutral for a resale-bought ticket the buyer then gifted", () => {
    arrangeGone(
      {
        transferredAt: "2026-09-02T00:00:00.000Z",
        status: "transferred",
        resaleListingId: "55555555-5555-4555-8555-555555555555",
      },
      // A resale purchase: the claims path runs (settled, no claims), so
      // the only thing hiding the refund card is the departure.
      { source: "RESALE" },
    );
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(
      screen.getByText("orderDetail.ticketsTransferredAway"),
    ).toBeInTheDocument();
    expect(screen.queryByText("orderDetail.noTicketsFound")).toBeNull();
    expect(fullRefundLink()).toBeNull();
  });

  it("says the tickets belong to someone else after a gift transfer", () => {
    arrangeGone({
      transferredAt: "2026-09-02T00:00:00.000Z",
      status: "transferred",
    });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(
      screen.getByText("orderDetail.ticketsTransferredAway"),
    ).toBeInTheDocument();
    expect(fullRefundLink()).toBeNull();
  });

  // getMyOrder returns every order line. Discount and platform-credit lines
  // are always "active" and never transferred; only ticket lines count, as
  // they do in get-refund-eligibility.
  it.each([
    [
      "discount",
      {
        id: "66666666-6666-4666-8666-666666666666",
        qty: 1,
        unitPriceCents: -1000,
        amountCents: -1000,
        kind: "discount",
        ticketTypeId: null,
        resaleListingId: null,
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      },
    ],
    [
      "platform_credit",
      {
        id: "77777777-7777-4777-8777-777777777777",
        qty: 1,
        unitPriceCents: -500,
        amountCents: -500,
        kind: "platform_credit",
        ticketTypeId: null,
        resaleListingId: null,
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      },
    ],
  ])(
    "ignores a %s line beside the departed ticket",
    (_kind, extraLine) => {
      arrange({
        order: {
          items: [
            {
              ...order().items[0],
              transferredAt: "2026-09-02T00:00:00.000Z",
              status: "transferred",
            },
            extraLine,
          ],
        },
      });
      testState.ticketsQuery = { data: { tickets: [] }, isLoading: false };
      render(
        <OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />,
      );
      expect(
        screen.getByText("orderDetail.ticketsTransferredAway"),
      ).toBeInTheDocument();
      expect(fullRefundLink()).toBeNull();
    },
  );

  it("keeps the refund card when only some tickets left", () => {
    // ITEM_ID is still held (its ticket loads); a second ticket was gifted.
    arrange({
      order: {
        items: [
          order().items[0],
          {
            ...order().items[0],
            id: "88888888-8888-4888-8888-888888888888",
            transferredAt: "2026-09-02T00:00:00.000Z",
            status: "transferred",
          },
        ],
      },
    });
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(fullRefundLink()).not.toBeNull();
    expect(
      screen.queryByText("orderDetail.ticketsTransferredAway"),
    ).toBeNull();
    expect(refundTrigger()).not.toBeNull();
  });

  it("leaves a normal order unchanged", () => {
    arrange({});
    render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);
    expect(
      screen.queryByText("orderDetail.ticketsTransferredAway"),
    ).toBeNull();
    expect(fullRefundLink()).not.toBeNull();
  });
});
