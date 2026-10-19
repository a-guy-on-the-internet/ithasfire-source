import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The owner ruled (2026-10-10) that refunding a ticket already scanned in
 * means the person has left, so the refund confirm step says so whenever a
 * ticket the pending refund takes back was scanned. What it says about the
 * ticket depends on the path, because the server does different things:
 *  - per-item (PRIMARY order): the selected tickets are voided and go back
 *    on sale (0b387d5d5), counted among the selected ones;
 *  - whole-order (RESALE order): the ticket is NOT voided, it returns to the
 *    seller, so that card has its own string and never says "back on sale".
 * No scanned ticket in the refund, no notice. Both confirm steps re-read the
 * order as they open, so a scan made after the panel loaded still shows.
 */

const testState = vi.hoisted(() => ({
  orgOrderQuery: {} as Record<string, unknown>,
  quoteQuery: { data: undefined, error: null, isLoading: false } as Record<
    string,
    unknown
  >,
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    onPress,
    ...props
  }: {
    children?: ReactNode;
    onPress?: () => void;
  }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-"))
        safe[key] = value;
    }
    // Ticket rows select on press; forwarded so a test can pick one ticket.
    if (onPress) safe.onClick = onPress;
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
      orgRefundOrderItems: {
        useMutation: () => ({ mutate: vi.fn(), error: null }),
      },
      orgRefundFullOrder: {
        useMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), error: null }),
      },
      orgRefundCashSale: {
        useMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), data: undefined }),
      },
    },
  },
}));

import { OrderDetailPanel } from "../OrderDetailPanel";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "77777777-7777-4777-8777-777777777777";
const SCANNED_AT = new Date("2026-06-01T02:00:00.000Z");

type ItemOverrides = {
  status?: string;
  ticketScannedAt?: Date | null;
  refundedAt?: Date | null;
  transferredAt?: Date | null;
};

function makeItem(n: number, overrides: ItemOverrides = {}) {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`,
    kind: "ticket",
    ticketTypeId: "tt-ga",
    qty: 1,
    unitPriceCents: 5000,
    amountCents: 5000,
    paidOutAt: null,
    refundedAt: null,
    transferredAt: null,
    status: "active",
    ticketCode: `TK-00${n}`,
    ticketScannedAt: null,
    seatId: null,
    ticketOwnerName: null,
    ...overrides,
  };
}

function makeOrder(
  items: ReturnType<typeof makeItem>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id: ORDER_ID,
    eventId: "22222222-2222-4222-8222-222222222222",
    eventTitle: "Launch Party",
    orgName: "Org",
    buyerHumanId: "33333333-3333-4333-8333-333333333333",
    buyerName: "Casey Buyer",
    buyerEmail: "casey@example.com",
    amountGrossCents: 5000 * items.length,
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
    items,
    ticketTypeNames: { "tt-ga": "General Admission" },
    buyerTotalCents: 5000 * items.length + 500,
    refundBasePaidCents: 5000 * items.length + 500,
    chargeState: "PAID",
    buyerPaid: true,
    charges: {
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 5000 * items.length,
      platformFeeCents: 500,
      processingFeeCents: 0,
      taxCents: 0,
      creditCents: 0,
      totalCents: 5000 * items.length + 500,
    },
    eventCredit: {
      ticketPriceCents: 5000 * items.length,
      platformFeeTakenCents: 500,
      expectedCreditCents: 5000 * items.length - 500,
      creditState: "CREDITED",
      creditedCents: 5000 * items.length - 500,
      payeeCount: 1,
    },
    ...overrides,
  };
}

function renderPanel(order: ReturnType<typeof makeOrder>) {
  const refetch = vi.fn();
  testState.orgOrderQuery = {
    data: order,
    isLoading: false,
    error: null,
    refetch,
  };
  // The quote the confirm card lists; the notice reads the order, not this.
  testState.quoteQuery = {
    data: {
      hasTransferReversals: false,
      currency: "usd",
      totalRefundableCents: 5000,
      items: [],
    },
    error: null,
    isLoading: false,
  };
  const view = render(
    <OrderDetailPanel
      orderId={ORDER_ID}
      orgId={ORG_ID}
      canFinance
      onClose={() => {}}
    />,
  );
  return { ...view, refetch };
}

/** Select every refundable ticket, then open the per-item confirm step. */
function quoteAll() {
  fireEvent.click(
    screen.getByRole("button", { name: /admin\.selectAllRefundable/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: /admin\.quoteRefund/ }));
}

/** Select one ticket by its row, then open the per-item confirm step. */
function quoteOnly(ticketCode: string) {
  fireEvent.click(screen.getByText(ticketCode));
  fireEvent.click(screen.getByRole("button", { name: /admin\.quoteRefund/ }));
}

const ONE = "admin.refundScannedInOne";
const several = (count: number) =>
  `admin.refundScannedInSeveral ${JSON.stringify({ count })}`;
const RESALE = "admin.refundScannedInResale";
const anyNotice = () => screen.queryByText(/admin\.refundScannedIn/);

beforeEach(() => {
  testState.quoteQuery = { data: undefined, error: null, isLoading: false };
});

describe("OrderDetailPanel — per-item refund of scanned-in tickets", () => {
  it("says the person has left when the one ticket being refunded was scanned in", () => {
    renderPanel(makeOrder([makeItem(1, { ticketScannedAt: SCANNED_AT })]));
    expect(anyNotice()).not.toBeInTheDocument();

    quoteAll();

    expect(
      screen.getByRole("button", { name: "admin.confirmRefund" }),
    ).toBeInTheDocument();
    expect(screen.getByText(ONE)).toBeInTheDocument();
  });

  it("counts the scanned tickets among the several being refunded", () => {
    renderPanel(
      makeOrder([
        makeItem(1, { ticketScannedAt: SCANNED_AT }),
        makeItem(2),
        makeItem(3, { ticketScannedAt: SCANNED_AT }),
      ]),
    );

    quoteAll();

    expect(screen.getByText(several(2))).toBeInTheDocument();
    expect(screen.queryByText(ONE)).not.toBeInTheDocument();
  });

  it("uses the counted form when one of several refunded tickets was scanned in", () => {
    renderPanel(
      makeOrder([makeItem(1, { ticketScannedAt: SCANNED_AT }), makeItem(2)]),
    );

    quoteAll();

    expect(screen.getByText(several(1))).toBeInTheDocument();
  });

  it("counts only the selected tickets, not every scanned ticket on the order", () => {
    renderPanel(
      makeOrder([
        makeItem(1, { ticketScannedAt: SCANNED_AT }),
        makeItem(2),
        makeItem(3, { ticketScannedAt: SCANNED_AT }),
      ]),
    );

    quoteOnly("TK-003");

    expect(screen.getByText(ONE)).toBeInTheDocument();
  });

  it("shows no notice when the selected ticket was not scanned, even beside scanned ones", () => {
    renderPanel(
      makeOrder([makeItem(1, { ticketScannedAt: SCANNED_AT }), makeItem(2)]),
    );

    quoteOnly("TK-002");

    expect(
      screen.getByRole("button", { name: "admin.confirmRefund" }),
    ).toBeInTheDocument();
    expect(anyNotice()).not.toBeInTheDocument();
  });

  it("shows no notice when no ticket was scanned", () => {
    renderPanel(makeOrder([makeItem(1), makeItem(2)]));

    quoteAll();

    expect(
      screen.getByRole("button", { name: "admin.confirmRefund" }),
    ).toBeInTheDocument();
    expect(anyNotice()).not.toBeInTheDocument();
  });

  it("re-reads the order when the confirm step opens, so a scan made since the panel loaded shows", () => {
    const { refetch, rerender } = renderPanel(makeOrder([makeItem(1)]));
    expect(refetch).not.toHaveBeenCalled();

    quoteAll();

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(anyNotice()).not.toBeInTheDocument();

    // The re-read lands: the ticket was scanned after the panel opened.
    testState.orgOrderQuery = {
      ...testState.orgOrderQuery,
      data: makeOrder([makeItem(1, { ticketScannedAt: SCANNED_AT })]),
    };
    rerender(
      <OrderDetailPanel
        orderId={ORDER_ID}
        orgId={ORG_ID}
        canFinance
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(ONE)).toBeInTheDocument();
  });

  it("ignores a scanned ticket that was already refunded", () => {
    renderPanel(
      makeOrder([
        makeItem(1, {
          status: "refunded",
          refundedAt: SCANNED_AT,
          ticketScannedAt: SCANNED_AT,
        }),
        makeItem(2),
      ]),
    );

    quoteAll();

    expect(anyNotice()).not.toBeInTheDocument();
  });
});

describe("OrderDetailPanel — whole-order (resale) refund of a scanned-in ticket", () => {
  const startWholeOrderRefund = () =>
    fireEvent.click(
      screen.getByRole("button", { name: "admin.refundWholeOrder" }),
    );

  it("says the ticket goes back to the seller, never that it goes back on sale", () => {
    renderPanel(
      makeOrder([makeItem(1, { ticketScannedAt: SCANNED_AT })], {
        source: "RESALE",
      }),
    );
    expect(anyNotice()).not.toBeInTheDocument();

    startWholeOrderRefund();

    expect(
      screen.getByRole("button", { name: "admin.confirmFullRefund" }),
    ).toBeInTheDocument();
    expect(screen.getByText(RESALE)).toBeInTheDocument();
    // A resale refund does not void the ticket, so the per-item strings
    // ("stops working and goes back on sale") would be false here.
    expect(screen.queryByText(ONE)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/admin\.refundScannedInSeveral/),
    ).not.toBeInTheDocument();
  });

  it("shows no notice when the ticket was not scanned", () => {
    renderPanel(makeOrder([makeItem(1)], { source: "RESALE" }));

    startWholeOrderRefund();

    expect(
      screen.getByRole("button", { name: "admin.confirmFullRefund" }),
    ).toBeInTheDocument();
    expect(anyNotice()).not.toBeInTheDocument();
  });

  it("re-reads the order when the confirm step opens", () => {
    const { refetch } = renderPanel(
      makeOrder([makeItem(1)], { source: "RESALE" }),
    );
    expect(refetch).not.toHaveBeenCalled();

    startWholeOrderRefund();

    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
