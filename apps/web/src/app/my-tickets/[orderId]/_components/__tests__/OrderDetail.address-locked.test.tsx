import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ticket holder whose event (or its venue) hides the address sees the
 * COARSE area label and a notice saying when the address arrives, and nothing
 * that routes anywhere. While locked, `eventVenue` is only an area label
 * ("Nashville, TN"), so a Google Maps link on it would send the holder to a
 * neighbourhood centroid dressed up as directions.
 *
 * Mock prelude mirrors `OrderDetail.refund-gate.test.tsx`.
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
    Badge: Passthrough,
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

const mapsLinks = () =>
  Array.from(document.querySelectorAll("a")).filter((a) =>
    (a.getAttribute("href") ?? "").includes("google.com/maps"),
  );
const notice = () =>
  screen.queryByTestId("order-detail-address-locked-notice");

const renderOrder = () =>
  render(<OrderDetail orderId={ORDER_ID} supportEmail="help@example.com" />);

beforeEach(() => {
  testState.quoteQuery = { data: undefined, error: null, refetch: vi.fn() };
});

describe("OrderDetail — locked address", () => {
  it("leaves an unlocked address as the maps link it always was", () => {
    arrange({
      order: {
        eventVenue: "12 Elm St, Nashville, TN",
        eventAddressLocked: false,
        eventAddressRevealAt: null,
        eventAddressNeverShared: false,
      },
    });
    renderOrder();

    const links = mapsLinks();
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toContain(
      encodeURIComponent("12 Elm St, Nashville, TN"),
    );
    expect(notice()).toBeNull();
  });

  it("says when the address will be shared, with no maps link", () => {
    arrange({
      order: {
        eventVenue: "Nashville, TN",
        eventAddressLocked: true,
        eventAddressRevealAt: "2026-11-30T19:00:00.000Z",
        eventAddressNeverShared: false,
      },
    });
    renderOrder();

    expect(mapsLinks()).toHaveLength(0);
    expect(screen.getByTestId("order-detail-venue").textContent).toBe(
      "Nashville, TN",
    );
    expect(notice()!.textContent).toBe(
      'orderDetail.addressLocked.revealOn {"date":"FORMATTED_DATE"}',
    );
  });

  it("says the organizer is not sharing it when they chose never to", () => {
    arrange({
      order: {
        eventVenue: "Nashville, TN",
        eventAddressLocked: true,
        eventAddressRevealAt: null,
        eventAddressNeverShared: true,
      },
    });
    renderOrder();

    expect(mapsLinks()).toHaveLength(0);
    expect(notice()!.textContent).toBe("orderDetail.addressLocked.never");
  });

  it("tells the holder to ask the organizer when the venue hasn't confirmed the event", () => {
    arrange({
      order: {
        eventVenue: "Nashville, TN",
        eventAddressLocked: true,
        eventAddressLockReason: "venueUnconfirmed",
        eventAddressRevealAt: null,
        eventAddressNeverShared: false,
      },
    });
    renderOrder();

    expect(mapsLinks()).toHaveLength(0);
    expect(notice()!.textContent).toBe(
      "orderDetail.addressLocked.venueUnconfirmed",
    );
  });

  it("says the address couldn't be loaded when the venue's record is unavailable — no date, no 'ask the organizer'", () => {
    arrange({
      order: {
        eventVenue: "Nashville, TN",
        eventAddressLocked: true,
        eventAddressLockReason: "placeUnavailable",
        // Even with a reveal date on the event, the date would be a promise
        // the outage can't keep.
        eventAddressRevealAt: "2026-11-30T19:00:00.000Z",
        eventAddressNeverShared: false,
      },
    });
    renderOrder();

    expect(mapsLinks()).toHaveLength(0);
    expect(notice()!.textContent).toBe("orderDetail.addressLocked.unavailable");
  });

  it("a non-holder (unpaid, refunded, transferred away) gets the plain 'not shared yet' line", () => {
    arrange({
      order: {
        status: "PENDING",
        eventVenue: "Nashville, TN",
        eventAddressLocked: true,
        eventAddressLockReason: "notHolder",
        eventAddressRevealAt: null,
        eventAddressNeverShared: false,
      },
    });
    renderOrder();

    expect(mapsLinks()).toHaveLength(0);
    expect(notice()!.textContent).toBe("orderDetail.addressLocked.pending");
  });

  it("falls back to 'not shared yet' when there is no date", () => {
    arrange({
      order: {
        eventVenue: "Nashville, TN",
        eventAddressLocked: true,
        eventAddressRevealAt: null,
        eventAddressNeverShared: false,
      },
    });
    renderOrder();

    expect(mapsLinks()).toHaveLength(0);
    expect(notice()!.textContent).toBe("orderDetail.addressLocked.pending");
  });

  it("still tells the holder why there is no address when not even an area label exists", () => {
    arrange({
      order: {
        eventVenue: null,
        eventAddressLocked: true,
        eventAddressRevealAt: null,
        eventAddressNeverShared: false,
      },
    });
    renderOrder();

    expect(mapsLinks()).toHaveLength(0);
    expect(screen.queryByTestId("order-detail-venue")).toBeNull();
    expect(notice()!.textContent).toBe("orderDetail.addressLocked.pending");
  });
});
