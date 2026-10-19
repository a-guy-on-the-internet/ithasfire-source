import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Door cash sales in the org order panel (door-sales step 9b): an Owner,
 * Admin or Finance member gets "Refund cash sale" until `cashRefundableUntil`
 * (inclusive), then a line saying the window closed and support can still do
 * it. A viewer without `canRefundCash` sees neither, and the panel reads that
 * flag, not `canFinance`. Editors cannot open Orders: they refund from Sell →
 * Cash taken tonight (owner ruling 2026-10-08). The refund runs
 * `orders.orgRefundCashSale` through a confirm step, the order is re-read
 * after it, and card orders keep their own flow.
 */

type MutationOptions = {
  onSuccess?: (data: unknown) => void;
  onError?: (err: unknown) => void;
  onSettled?: () => void;
};

const testState = vi.hoisted(() => ({
  orgOrderQuery: {} as Record<string, unknown>,
  refetch: (() => {}) as unknown as ReturnType<typeof vi.fn>,
  cashMutation: {} as Record<string, unknown>,
  cashOptions: {} as MutationOptions,
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
  // Echo the values so the assertions can see what was interpolated.
  useTranslations:
    () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number, currency: string) =>
    `${currency}:${cents}`,
  fmtDate: (_fmt: unknown, d: unknown) =>
    `date(${new Date(d as string).toISOString()})`,
  fmtDateShort: (_fmt: unknown, d: unknown) =>
    `day(${new Date(d as string).toISOString().slice(0, 10)})`,
}));

vi.mock("@/components/layout/PagePrimitives/buttons", () => ({
  ButtonOutline: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
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
      orgQuoteItemRefund: {
        useQuery: () => ({ data: undefined, error: null, isLoading: false }),
      },
      orgRefundOrderItems: {
        useMutation: () => ({ mutate: vi.fn(), error: null }),
      },
      orgRefundFullOrder: {
        useMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), error: null }),
      },
      orgRefundCashSale: {
        useMutation: (options: MutationOptions) => {
          testState.cashOptions = options;
          return testState.cashMutation;
        },
      },
    },
  },
}));

import { OrderDetailPanel } from "../OrderDetailPanel";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "77777777-7777-4777-8777-777777777777";
// Far in the future / past relative to the test clock (real `new Date()`).
const OPEN_UNTIL = new Date("2099-01-08T05:59:59.000Z");
const CLOSED_AT = new Date("2020-01-08T05:59:59.000Z");

function makeCashOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    eventId: "22222222-2222-4222-8222-222222222222",
    eventTitle: "Low Tide Revue",
    orgName: "Org",
    buyerHumanId: "33333333-3333-4333-8333-333333333333",
    buyerName: null,
    buyerEmail: null,
    // Gross is the face net of discount; tax sits beside it, as
    // `recordCashSale` writes it. The buyer handed over 4000 + 370.
    amountGrossCents: 4000,
    feesPlatformCents: 0,
    taxAmountCents: 370,
    currency: "usd",
    // getOrgOrder's money read: the cash handed over, in lines; a cash sale
    // credits the organizer nothing on the platform (it holds the cash).
    buyerTotalCents: 4370,
    refundBasePaidCents: 4370,
    chargeState: "PAID",
    buyerPaid: true,
    charges: {
      buyerFeeMode: "ABSORB",
      subtotalCents: 4000,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxCents: 370,
      creditCents: 0,
      totalCents: 4370,
    },
    eventCredit: null,
    status: "SUCCEEDED",
    source: "PRIMARY",
    stripePaymentIntentId: null,
    stripeTaxCalculationId: null,
    paymentMethodType: null,
    parentOrderId: null,
    feePolicySnapshot: null,
    billingAddress: null,
    promo: null,
    promoCodes: [],
    paymentChannel: "CASH",
    cashRefundableUntil: OPEN_UNTIL,
    // Server-classified (getOrgOrder, CASH only): what the buyer paid, which
    // the refund hands back, and the CASH_SALE_DEBIT it reverses.
    cashAmountPaidCents: 4370,
    isComp: false,
    isFreeWithCode: false,
    cashSaleDebitCents: 370,
    occurredAt: new Date("2026-10-10T02:12:00.000Z"),
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
        unitPriceCents: 4000,
        amountCents: 4000,
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
        ticketCode: "TK-001",
        ticketScannedAt: new Date("2026-10-10T02:12:00.000Z"),
        seatId: null,
        ticketOwnerName: null,
      },
    ],
    ticketTypeNames: { "tt-ga": "General Admission" },
    ...overrides,
  };
}

function renderPanel(
  order: ReturnType<typeof makeCashOrder>,
  // Default: an Owner, Admin or Finance member. Every role the server serves
  // Orders to (ORG_FINANCE_ROLES) may also refund cash.
  {
    canFinance = true,
    canRefundCash = true,
  }: { canFinance?: boolean; canRefundCash?: boolean } = {},
) {
  testState.orgOrderQuery = {
    data: order,
    isLoading: false,
    error: null,
    refetch: testState.refetch,
  };
  return render(
    <OrderDetailPanel
      orderId={ORDER_ID}
      orgId={ORG_ID}
      canFinance={canFinance}
      canRefundCash={canRefundCash}
      onClose={() => {}}
    />,
  );
}

const startButton = () =>
  screen.queryByRole("button", { name: "admin.odCashRefundTitle" });

beforeEach(() => {
  testState.refetch = vi.fn();
  testState.cashOptions = {};
  testState.cashMutation = {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    data: undefined,
  };
});

describe("OrderDetailPanel — cash refund gating", () => {
  it("offers 'Refund cash sale' to an Owner, Admin or Finance member inside the window", () => {
    // The flags OrdersTable passes for all three roles, FINANCE included.
    renderPanel(makeCashOrder(), { canFinance: true, canRefundCash: true });
    expect(startButton()).toBeInTheDocument();
    expect(
      screen.getByText(
        `admin.odCashRefundWindowOpen {"date":"date(${OPEN_UNTIL.toISOString()})"}`,
      ),
    ).toBeInTheDocument();
  });

  it("shows nothing to a role that cannot refund cash", () => {
    renderPanel(makeCashOrder(), { canFinance: false, canRefundCash: false });
    expect(startButton()).not.toBeInTheDocument();
    expect(screen.queryByTestId("cash-refund")).not.toBeInTheDocument();
  });

  it("reads `canRefundCash`, not `canFinance`, and never puts a cash order on the card path", () => {
    renderPanel(makeCashOrder(), { canFinance: true, canRefundCash: false });
    expect(startButton()).not.toBeInTheDocument();
    expect(screen.queryByTestId("cash-refund")).not.toBeInTheDocument();
    // Nor the card item path: a cash order has no PaymentIntent to refund.
    expect(
      screen.queryByRole("button", { name: /admin\.selectAllRefundable/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("admin.noTicketsEligible")).not.toBeInTheDocument();
  });

  it("after the window: the closed line and a support link, no button", () => {
    renderPanel(makeCashOrder({ cashRefundableUntil: CLOSED_AT }));
    expect(startButton()).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'admin.odCashRefundWindowClosed {"date":"day(2020-01-08)"}',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "admin.odContactSupport" }),
    ).toHaveAttribute("href", "/contact");
  });

  it("shows nothing once the cash order is refunded", () => {
    renderPanel(makeCashOrder({ status: "REFUNDED" }));
    expect(screen.queryByTestId("cash-refund")).not.toBeInTheDocument();
  });

  it("leaves a card order on its own flow", () => {
    renderPanel(
      makeCashOrder({
        paymentChannel: "WEB",
        cashRefundableUntil: null,
        stripePaymentIntentId: "pi_123",
      }),
      { canFinance: true, canRefundCash: true },
    );
    expect(startButton()).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /admin\.selectAllRefundable/ }),
    ).toBeInTheDocument();
  });
});

describe("OrderDetailPanel — cash refund confirm", () => {
  it("confirms with the amount, the tax no longer owed and an optional note", () => {
    renderPanel(makeCashOrder());
    fireEvent.click(startButton()!);

    expect(testState.cashMutation.reset).toHaveBeenCalled();
    expect(
      screen.getByText('admin.odCashRefundBody {"amount":"usd:4370"}'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('admin.odCashRefundDebitNote {"amount":"usd:370"}'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "admin.noteOptional" }), {
      target: { value: "  Wrong night  " },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: 'admin.odCashRefundConfirm {"amount":"usd:4370"}',
      }),
    );

    expect(testState.cashMutation.mutate).toHaveBeenCalledWith({
      orgId: ORG_ID,
      orderId: ORDER_ID,
      note: "Wrong night",
    });
  });

  it("two presses in the same tick send one refund", () => {
    renderPanel(makeCashOrder());
    fireEvent.click(startButton()!);
    const confirm = screen.getByRole("button", {
      name: 'admin.odCashRefundConfirm {"amount":"usd:4370"}',
    });
    // isPending is still false (as in the tick before React re-renders).
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(testState.cashMutation.mutate).toHaveBeenCalledTimes(1);
    // Once the call settles, a press goes through again.
    act(() => {
      testState.cashOptions.onSettled?.();
    });
    fireEvent.click(confirm);
    expect(testState.cashMutation.mutate).toHaveBeenCalledTimes(2);
  });

  it("sends no note when it is left blank", () => {
    renderPanel(makeCashOrder());
    fireEvent.click(startButton()!);
    fireEvent.click(
      screen.getByRole("button", {
        name: 'admin.odCashRefundConfirm {"amount":"usd:4370"}',
      }),
    );
    expect(testState.cashMutation.mutate).toHaveBeenCalledWith({
      orgId: ORG_ID,
      orderId: ORDER_ID,
    });
  });

  it("reads the amount and the debit from the server, fee included on an older sale", () => {
    // A sale from before 2026-10-08: the debit held fee + tax, and the buyer
    // paid the fee too. The panel does no arithmetic of its own.
    renderPanel(
      makeCashOrder({
        feesPlatformCents: 250,
        cashAmountPaidCents: 4620,
        cashSaleDebitCents: 620,
      }),
    );
    fireEvent.click(startButton()!);
    expect(
      screen.getByText('admin.odCashRefundDebitNote {"amount":"usd:620"}'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: 'admin.odCashRefundConfirm {"amount":"usd:4620"}',
      }),
    ).toBeInTheDocument();
  });

  it("a $0 sale has no cash to hand back and no debit line", () => {
    renderPanel(
      makeCashOrder({
        amountGrossCents: 0,
        taxAmountCents: 0,
        cashAmountPaidCents: 0,
        cashSaleDebitCents: 0,
        isComp: true,
      }),
    );
    fireEvent.click(startButton()!);
    expect(screen.getByText("admin.odCashRefundBodyZero")).toBeInTheDocument();
    expect(screen.queryByText(/odCashRefundDebitNote/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "admin.odCashRefundConfirmZero" }),
    ).toBeInTheDocument();
  });

  it("cancel goes back without refunding", () => {
    renderPanel(makeCashOrder());
    fireEvent.click(startButton()!);
    fireEvent.click(screen.getByRole("button", { name: "admin.cancel" }));
    expect(startButton()).toBeInTheDocument();
    expect(testState.cashMutation.mutate).not.toHaveBeenCalled();
  });

  it("re-reads the order after a refund and says how much to hand back", () => {
    testState.cashMutation = {
      ...testState.cashMutation,
      data: {
        orderId: ORDER_ID,
        refundedTicketCount: 1,
        amountReturnedCents: 4370,
        feeAndTaxNoLongerOwedCents: 370,
        alreadyRefunded: false,
      },
    };
    renderPanel(makeCashOrder());
    act(() => testState.cashOptions.onSuccess?.(testState.cashMutation.data));
    expect(testState.refetch).toHaveBeenCalled();
    expect(
      screen.getByText('admin.odCashRefundDone {"amount":"usd:4370"}'),
    ).toBeInTheDocument();
    // Until the re-read lands the order still says SUCCEEDED; the button
    // must not sit beside "Refunded" in that gap.
    expect(startButton()).not.toBeInTheDocument();
  });

  it("a closed window refusal shows the copy and re-reads the order", () => {
    renderPanel(makeCashOrder());
    fireEvent.click(startButton()!);
    act(() =>
      testState.cashOptions.onError?.(
        Object.assign(new Error("cash_refund_window_closed"), {
          data: { appCode: "CASH_REFUND_WINDOW_CLOSED" },
        }),
      ),
    );
    // The copy itself is resolved against the real catalogs in
    // cash-sale.test.ts; here the mocked `t` echoes keys.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(testState.refetch).toHaveBeenCalled();
  });

  it("a not-refundable refusal keeps its message after the re-read hides the action", () => {
    const view = renderPanel(makeCashOrder());
    fireEvent.click(startButton()!);
    act(() =>
      testState.cashOptions.onError?.(new Error("order_not_refundable")),
    );
    expect(testState.refetch).toHaveBeenCalled();
    // The re-read shows someone else already refunded it: no action left.
    testState.orgOrderQuery = {
      ...testState.orgOrderQuery,
      data: makeCashOrder({ status: "REFUNDED" }),
    };
    view.rerender(
      <OrderDetailPanel
        orderId={ORDER_ID}
        orgId={ORG_ID}
        canFinance
        canRefundCash
        onClose={() => {}}
      />,
    );
    expect(startButton()).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("a role refusal shows the copy without a re-read", () => {
    renderPanel(makeCashOrder());
    fireEvent.click(startButton()!);
    act(() =>
      testState.cashOptions.onError?.(
        Object.assign(new Error("INSUFFICIENT_ROLE"), {
          data: { appCode: "INSUFFICIENT_ROLE" },
        }),
      ),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(testState.refetch).not.toHaveBeenCalled();
  });
});

describe("OrderDetailPanel — cash payment method", () => {
  it.each([
    [{}, "admin.odCashAtDoor"],
    [{ amountGrossCents: 0, cashAmountPaidCents: 0, isComp: true }, "admin.odComp"],
    [
      {
        amountGrossCents: 0,
        cashAmountPaidCents: 0,
        isFreeWithCode: true,
        promoCodes: ["FRIENDS"],
      },
      'admin.odFreeWithCode {"code":"FRIENDS"}',
    ],
    // $0 with no code and not made with the Comp button: the server says
    // neither comp nor free-with-code, so it is a cash sale.
    [{ amountGrossCents: 0, cashAmountPaidCents: 0 }, "admin.odCashAtDoor"],
  ])("labels %o as %s", (overrides, label) => {
    renderPanel(makeCashOrder(overrides));
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
