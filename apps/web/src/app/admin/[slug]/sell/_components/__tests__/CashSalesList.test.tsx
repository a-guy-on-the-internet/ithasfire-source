import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pickDomProps } from "@/test-support/pick-dom-props";

/**
 * Sell → Cash taken tonight → Cash sales (owner ruling 2026-10-08: Editors
 * refund cash door sales here). Who sees Refund, paging, the refund call and
 * what it re-reads, and refusals shown on the row.
 */

const testState = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  refetch: vi.fn(),
  fetch: vi.fn(),
  invalidateTill: vi.fn(),
  mutate: vi.fn(),
  mutation: { isPending: false, variables: undefined } as Record<
    string,
    unknown
  >,
}));

vi.mock("tamagui", () => ({
  XStack: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pickDomProps(rest)}>{children}</div>
  ),
  YStack: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pickDomProps(rest)}>{children}</div>
  ),
}));

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
    ...rest
  }: { children?: ReactNode; onPress?: () => void } & Record<string, unknown>) => (
    <button onClick={onPress} {...pickDomProps(rest)}>
      {children}
    </button>
  ),
  Spinner: () => <span>loading</span>,
  Text: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <span {...pickDomProps(rest)}>{children}</span>
  ),
  TextInput: ({
    value,
    onChangeText,
    ...rest
  }: {
    value?: string;
    onChangeText?: (v: string) => void;
  } & Record<string, unknown>) => (
    <input
      value={value}
      onChange={(e) => onChangeText?.(e.target.value)}
      {...pickDomProps(rest)}
    />
  ),
  useTranslations: () => (key: string) => key,
}));

vi.mock("lucide-react", () => ({
  AlertTriangle: () => null,
  CheckCircle: () => null,
}));

vi.mock("@/lib/format", () => ({
  formatCents: (cents: number) => `$${(cents / 100).toFixed(2)}`,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      pos: {
        eventCashSales: { fetch: testState.fetch },
        cashTillReport: { invalidate: testState.invalidateTill },
      },
    }),
    pos: {
      eventCashSales: { useQuery: () => testState.query },
    },
    orders: {
      orgRefundCashSale: {
        useMutation: () => ({ ...testState.mutation, mutate: testState.mutate }),
      },
    },
  },
}));

import { CashSalesList } from "../CashSalesList";
import type { EventCashSale, EventCashSalesPage } from "../cash-sales-list";

const ORG_ID = "77777777-7777-4777-8777-777777777777";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
// Far future / past relative to the real clock the component reads.
const OPEN_UNTIL = new Date("2099-01-08T05:59:59.000Z");
const CLOSED_AT = new Date("2020-01-08T05:59:59.000Z");

function sale(id: string, overrides: Partial<EventCashSale> = {}): EventCashSale {
  return {
    orderId: id,
    soldAt: new Date(),
    ticketCount: 1,
    amountPaidCents: 4900,
    promoCode: null,
    isComp: false,
    isFreeWithCode: false,
    status: "SUCCEEDED",
    refundedAt: null,
    ...overrides,
  };
}

function page(overrides: Partial<EventCashSalesPage> = {}): EventCashSalesPage {
  return {
    items: [sale("a")],
    nextCursor: null,
    refundableUntil: OPEN_UNTIL,
    canRefund: true,
    refundWindowApplies: true,
    ...overrides,
  };
}

function setPage(data: EventCashSalesPage, dataUpdatedAt = 1) {
  testState.query = {
    data,
    isLoading: false,
    error: null,
    dataUpdatedAt,
    refetch: testState.refetch,
  };
  testState.refetch.mockResolvedValue({ data, dataUpdatedAt: dataUpdatedAt + 1 });
}

const renderList = (onRefunded?: (id: string) => void) =>
  render(
    <CashSalesList
      orgId={ORG_ID}
      eventId={EVENT_ID}
      currency="usd"
      onRefunded={onRefunded}
    />,
  );

const refundButtons = () =>
  screen.queryAllByRole("button", { name: /^Refund the .* sale, / });

beforeEach(() => {
  testState.refetch = vi.fn();
  testState.fetch = vi.fn();
  testState.invalidateTill = vi.fn();
  testState.mutate = vi.fn();
  testState.mutation = { isPending: false, variables: undefined };
  setPage(page());
});

describe("CashSalesList — who sees Refund", () => {
  it("an Owner/Admin/Editor sees Refund on a SUCCEEDED sale inside the window", () => {
    renderList();
    expect(refundButtons()).toHaveLength(1);
    expect(screen.getByText(/Refunds stay open until/)).toBeInTheDocument();
  });

  it("a Scanner sees the list but no Refund, and who can", () => {
    setPage(page({ canRefund: false }));
    renderList();
    expect(screen.getAllByTestId("cash-sale-row")).toHaveLength(1);
    expect(refundButtons()).toHaveLength(0);
    expect(
      screen.getByText("An Owner, Admin or Editor can refund a sale here."),
    ).toBeInTheDocument();
  });

  it("after the window: no Refund, and the closed line points to support", () => {
    setPage(page({ refundableUntil: CLOSED_AT }));
    renderList();
    expect(refundButtons()).toHaveLength(0);
    expect(screen.getByText(/Contact support to refund a sale\./)).toBeInTheDocument();
  });

  it("platform staff keep Refund after the window", () => {
    setPage(page({ refundableUntil: CLOSED_AT, refundWindowApplies: false }));
    renderList();
    expect(refundButtons()).toHaveLength(1);
  });

  it("a refunded sale shows Refunded, no button, and no buyer details", () => {
    setPage(
      page({
        items: [
          sale("a", { status: "REFUNDED", refundedAt: new Date() }),
          sale("b", { isComp: true, amountPaidCents: 0 }),
          sale("c", {
            isFreeWithCode: true,
            promoCode: "FRIENDS100",
            amountPaidCents: 0,
          }),
        ],
      }),
    );
    renderList();
    const rows = screen.getAllByTestId("cash-sale-row");
    // The status sits on its own line, so no separator dot is left at a wrap.
    expect(
      within(rows[0]!).getByTestId("cash-sale-closed").textContent,
    ).toMatch(/^Refunded \d/);
    expect(rows[0]!.textContent).not.toMatch(/·\s*Refunded/);
    expect(rows[1]!.textContent).toMatch(/1 ticket · Comp/);
    expect(rows[2]!.textContent).toMatch(/1 ticket · Free with FRIENDS100/);
    expect(within(rows[0]!).queryAllByRole("button")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/@/);
  });

  it("a $0 comp or free sale offers Void, not Refund", () => {
    setPage(
      page({
        items: [
          sale("b", { isComp: true, amountPaidCents: 0 }),
          sale("c", {
            isFreeWithCode: true,
            promoCode: "FRIENDS100",
            amountPaidCents: 0,
          }),
          sale("d", {
            isComp: true,
            amountPaidCents: 0,
            status: "REFUNDED",
            refundedAt: new Date(),
          }),
        ],
      }),
    );
    renderList();
    expect(refundButtons()).toHaveLength(0);
    const voids = screen.getAllByRole("button", { name: /^Void the / });
    expect(voids.map((b) => b.textContent)).toEqual(["Void", "Void"]);
    expect(voids[0]!.getAttribute("aria-label")).toMatch(/ comp$/);
    expect(voids[1]!.getAttribute("aria-label")).toMatch(/ free sale$/);
    const rows = screen.getAllByTestId("cash-sale-row");
    expect(
      within(rows[2]!).getByTestId("cash-sale-closed").textContent,
    ).toMatch(/^Voided \d/);
  });
});

describe("CashSalesList — paging", () => {
  it("loads the next page by cursor and appends it", async () => {
    setPage(page({ nextCursor: "c1" }));
    testState.fetch.mockResolvedValueOnce(page({ items: [sale("b")], nextCursor: null }));
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("cash-sale-row")).toHaveLength(2),
    );
    expect(testState.fetch).toHaveBeenCalledWith(
      { orgId: ORG_ID, eventId: EVENT_ID, cursor: "c1", limit: 25 },
      { staleTime: 0 },
    );
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("shows an empty line when the event has no cash sales", () => {
    setPage(page({ items: [] }));
    renderList();
    expect(
      screen.getByText("No cash sales recorded for this event yet."),
    ).toBeInTheDocument();
  });
});

describe("CashSalesList — refund", () => {
  it("confirms with the amount, sends the trimmed note, then re-reads the list and the till", () => {
    const onRefunded = vi.fn();
    renderList(onRefunded);
    fireEvent.click(refundButtons()[0]!);
    expect(
      screen.getByText(
        "Hand back $49.00. Their tickets stop working and go back on sale.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Note (optional)" }), {
      target: { value: "  wrong night  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refund $49.00" }));

    expect(testState.mutate).toHaveBeenCalledTimes(1);
    const [payload, handlers] = testState.mutate.mock.calls[0]!;
    expect(payload).toEqual({ orgId: ORG_ID, orderId: "a", note: "wrong night" });

    act(() => {
      handlers.onSuccess({
        orderId: "a",
        refundedTicketCount: 1,
        amountReturnedCents: 4900,
        feeAndTaxNoLongerOwedCents: 400,
        alreadyRefunded: false,
      });
    });
    expect(testState.refetch).toHaveBeenCalled();
    expect(testState.invalidateTill).toHaveBeenCalledWith({ eventId: EVENT_ID });
    expect(onRefunded).toHaveBeenCalledWith("a");
    expect(screen.getByRole("status").textContent).toBe(
      "Refunded. Hand $49.00 back to the buyer.",
    );
    // Until the re-read lands the row still reads SUCCEEDED; it must not
    // offer Refund beside the line that says it was refunded.
    const row = screen.getAllByTestId("cash-sale-row")[0]!;
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
  });

  it("a $0 comp confirms as a void and sends no empty note", () => {
    setPage(page({ items: [sale("a", { isComp: true, amountPaidCents: 0 })] }));
    renderList();
    fireEvent.click(screen.getByRole("button", { name: /^Void the .* comp$/ }));
    expect(
      screen.getByText(
        "Void this comp? Their tickets stop working and go back on sale.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Void comp" }));
    expect(testState.mutate.mock.calls[0]![0]).toEqual({
      orgId: ORG_ID,
      orderId: "a",
    });
    const handlers = testState.mutate.mock.calls[0]![1];
    act(() => {
      handlers.onSuccess({
        orderId: "a",
        refundedTicketCount: 1,
        amountReturnedCents: 0,
        feeAndTaxNoLongerOwedCents: 0,
        alreadyRefunded: false,
      });
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Voided. Their tickets no longer work.",
    );
  });

  it("a free sale's confirm names it as one", () => {
    setPage(
      page({
        items: [
          sale("a", { isFreeWithCode: true, promoCode: "X", amountPaidCents: 0 }),
        ],
      }),
    );
    renderList();
    fireEvent.click(screen.getByRole("button", { name: /^Void the .* free sale$/ }));
    expect(
      screen.getByText(
        "Void this free sale? Their tickets stop working and go back on sale.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Void free sale" })).toBeInTheDocument();
  });

  it("two presses in the same tick send one refund", () => {
    renderList();
    fireEvent.click(refundButtons()[0]!);
    const confirm = screen.getByRole("button", { name: "Refund $49.00" });
    // isPending is still false here (the mock never flips it), as it is in
    // the tick before React re-renders.
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(testState.mutate).toHaveBeenCalledTimes(1);
    // Once the call settles, a press goes through again.
    act(() => {
      testState.mutate.mock.calls[0]![1].onSettled();
    });
    fireEvent.click(confirm);
    expect(testState.mutate).toHaveBeenCalledTimes(2);
  });

  it("does not submit twice while a refund is in flight", () => {
    testState.mutation = { isPending: true, variables: { orderId: "a" } };
    renderList();
    // Every row's Refund is disabled while one is pending.
    expect(refundButtons()[0]).toBeDisabled();
  });

  it("re-reads after a reload of loaded pages, keeping the operator's place", async () => {
    setPage(page({ nextCursor: "c1" }));
    testState.fetch.mockResolvedValue(page({ items: [sale("b")], nextCursor: null }));
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("cash-sale-row")).toHaveLength(2),
    );
    fireEvent.click(refundButtons()[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Refund $49.00" }));
    const handlers = testState.mutate.mock.calls[0]![1];
    act(() => {
      handlers.onSuccess({
        orderId: "b",
        refundedTicketCount: 1,
        amountReturnedCents: 4900,
        feeAndTaxNoLongerOwedCents: 0,
        alreadyRefunded: false,
      });
    });
    // Page 1 refetched, then page 2 read again from page 1's cursor.
    await waitFor(() => expect(testState.fetch).toHaveBeenCalledTimes(2));
    expect(testState.fetch.mock.calls[1]![0]).toEqual({
      orgId: ORG_ID,
      eventId: EVENT_ID,
      cursor: "c1",
      limit: 25,
    });
  });

  it("shows a closed-window refusal on the row and re-reads", () => {
    renderList();
    fireEvent.click(refundButtons()[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Refund $49.00" }));
    const handlers = testState.mutate.mock.calls[0]![1];
    act(() => {
      handlers.onError(
        Object.assign(new Error("cash_refund_window_closed"), {
          data: { appCode: "CASH_REFUND_WINDOW_CLOSED" },
        }),
      );
    });
    const row = screen.getAllByTestId("cash-sale-row")[0]!;
    expect(row.querySelector('[role="alert"]')).not.toBeNull();
    expect(testState.refetch).toHaveBeenCalled();
  });

  it("shows a role refusal on the row without a re-read", () => {
    renderList();
    fireEvent.click(refundButtons()[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Refund $49.00" }));
    const handlers = testState.mutate.mock.calls[0]![1];
    act(() => {
      handlers.onError(
        Object.assign(new Error("INSUFFICIENT_ROLE"), {
          data: { appCode: "INSUFFICIENT_ROLE" },
        }),
      );
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(testState.refetch).not.toHaveBeenCalled();
  });
});
