import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pickDomProps } from "@/test-support/pick-dom-props";

/**
 * SellView — what the till charges, and how it tells cash from comp.
 *
 * A door card sale charges what online checkout charges: ticket price plus
 * platform fee, tax and processing fee (door-sales spec 2026-10-07, FR-002).
 * Cash charges ticket + tax and no fee (owner ruling 2026-10-08). Both totals
 * come from `pos.quoteCart`; the till never adds anything up itself. So the
 * cash fallback from an open card sale must record the quote's CASH total —
 * the number the Cash tile charges — never the card sale's amount.
 *
 * Child components are stubbed to plain buttons that call SellView's own
 * handlers; everything under test is SellView's wiring.
 */

const ids = vi.hoisted(() => ({
  EVENT_ID: "00000000-0000-4000-8000-0000000000e1",
  ORG_ID: "00000000-0000-4000-8000-0000000000a1",
  TT_GA: "00000000-0000-4000-8000-0000000000a2",
  READER_ID: "00000000-0000-4000-8000-0000000000c1",
  ORDER_ID: "00000000-0000-4000-8000-0000000000f1",
}));
const { TT_GA, READER_ID, ORDER_ID } = ids;
/** Two $45 tickets: the face, which is NOT what either tender charges. */
const CART_FACE_CENTS = 9000;
/** The quote's card total: face + platform fee + processing fee + tax. */
const CARD_TOTAL_CENTS = 10_917;
/** The quote's cash total: face + tax, no fee. */
const CASH_TOTAL_CENTS = 9_833;

const channel = (totalCents: number, fees: boolean) => ({
  ticketSubtotalCents: 9000,
  discountCents: 0,
  ticketTotalCents: 9000,
  platformFeeCents: fees ? 450 : 0,
  processingFeeCents: fees ? 384 : 0,
  taxLines: [],
  taxAmountCents: 0,
  totalCents,
});
const QUOTE = {
  eventId: "00000000-0000-4000-8000-0000000000e1",
  currency: "usd",
  isComp: false,
  lines: [],
  feesWaivedCents: 0,
  card: channel(CARD_TOTAL_CENTS, true),
  cash: channel(CASH_TOTAL_CENTS, false),
};

const m = vi.hoisted(() => ({
  /** What `pos.quoteCart.useQuery` answers; tests replace it. */
  quote: { current: null as unknown },
  /** The options SellView passed to `pos.quoteCart.useQuery`. */
  quoteOptions: { current: null as null | { retry?: unknown } },
  /** The `meta` each sale mutation was created with, by procedure name. */
  mutationMeta: {} as Record<string, unknown>,
  /** The catalogue `pos.listSellableItems` answers; tests replace it. */
  ticketTypes: { current: [] as unknown[] },
  startSale: vi.fn(),
  processOnReader: vi.fn(),
  cancelSale: vi.fn(),
  recordCashSale: vi.fn(),
  /** `utils.client.pos.completeSale.query`: what the server says an order is now (uncached). */
  completeSaleFetch: vi.fn(),
  /** What the `pos.completeSale` POLL answers; tests replace it. */
  poll: { current: undefined as unknown },
  toastDanger: vi.fn(),
  toastWarning: vi.fn(),
  /** Props CashTillPanel was last rendered with (null when unmounted). */
  tillPanel: { current: null as null | { checking?: boolean } },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "door-org" }),
}));

// The quote is asked for 250ms after the last cart edit; these tests are
// about what happens once it answers.
vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

vi.mock("@/trpc", async () => {
  const { SCANNER_TERMS_VERSION } =
    await vi.importActual<typeof import("@th/types")>("@th/types");
  const { EVENT_ID, ORG_ID, READER_ID } = ids;
  const query = (data: unknown) => () => ({
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  const mutation =
    (fn: ReturnType<typeof vi.fn>, name = "") =>
    (options?: { meta?: unknown }) => {
      if (name) m.mutationMeta[name] = options?.meta;
      return { mutateAsync: fn, isPending: false };
    };
  return {
    trpc: {
      useUtils: () => ({
        pos: {
          listSellableItems: { invalidate: vi.fn() },
          cashTillReport: { invalidate: vi.fn() },
          eventCashSales: { invalidate: vi.fn() },
        },
        client: { pos: { completeSale: { query: m.completeSaleFetch } } },
      }),
      events: {
        listEventOwnerEntities: {
          useQuery: query({
            owners: [
              { kind: "org", orgId: ORG_ID, orgSlug: "door-org", role: "OWNER" },
            ],
          }),
        },
        setManualTaxRate: { useMutation: mutation(vi.fn()) },
        listMine: {
          useQuery: query({
            items: [
              {
                id: EVENT_ID,
                title: "Door Night",
                startsAt: new Date(Date.now() + 60 * 60 * 1000),
              },
            ],
          }),
        },
      },
      scanner: {
        getSessionContext: {
          useQuery: query({
            operator: {
              scannerTermsAckAt: new Date("2026-01-01T00:00:00Z"),
              scannerTermsAckVersion: SCANNER_TERMS_VERSION,
            },
          }),
        },
      },
      pos: {
        listSellableItems: {
          useQuery: () => ({
            data: { currency: "usd", ticketTypes: m.ticketTypes.current },
            isLoading: false,
            isError: false,
            error: null,
            refetch: vi.fn(),
          }),
        },
        listReaders: {
          useQuery: query({
            readers: [
              { id: READER_ID, label: "Front door", status: "online", busy: false },
            ],
          }),
        },
        completeSale: {
          useQuery: () => ({
            data: m.poll.current,
            isLoading: false,
            isError: false,
            error: null,
            refetch: vi.fn(),
          }),
        },
        quoteCart: {
          useQuery: (_input: unknown, options: { retry?: unknown }) => {
            m.quoteOptions.current = options;
            return m.quote.current;
          },
        },
        startSale: { useMutation: mutation(m.startSale, "startSale") },
        processOnReader: { useMutation: mutation(m.processOnReader, "processOnReader") },
        cancelReaderAction: { useMutation: mutation(vi.fn()) },
        cancelSale: { useMutation: mutation(m.cancelSale, "cancelSale") },
        recordCashSale: { useMutation: mutation(m.recordCashSale, "recordCashSale") },
        refundRecentSale: { useMutation: mutation(vi.fn()) },
        refundCashSale: { useMutation: mutation(vi.fn()) },
      },
    },
  };
});

vi.mock("tamagui", () => ({
  XStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  YStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@th/ui", () => {
  return {
    // Forwards `disabled`, `aria-*` and `data-*` (TRAPS.md: a hand-rolled
    // mock that drops them lets an assertion pass against nothing).
    Button: ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
    } & Record<string, unknown>) => (
      <button onClick={onPress} {...pickDomProps(rest)}>
        {children}
      </button>
    ),
    Modal: Object.assign(
      ({ open, children }: { open: boolean; children?: ReactNode }) =>
        open ? <div>{children}</div> : null,
      {
        Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
        Header: ({ title }: { title?: ReactNode }) => <div>{title}</div>,
        Body: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
        Footer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      },
    ),
    Spinner: () => null,
    StyledSelect: () => null,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    useNotify: () => ({
      toast: { danger: m.toastDanger, success: vi.fn(), warning: m.toastWarning },
    }),
    useTranslations: () => (key: string) => key,
  };
});

// ── Children: plain buttons wired to SellView's own handlers ───────────────
vi.mock("../SellCatalogue", () => ({
  SellCatalogue: ({
    items,
    quote,
    onStep,
    onCharge,
    onCompInstead,
    onClear,
  }: {
    items: Array<{ ticketTypeId: string }>;
    quote: { kind: string };
    onStep: (item: unknown, delta: number) => void;
    onCharge: () => void;
    onCompInstead: () => void;
    onClear: () => void;
  }) => (
    <div data-testid="catalogue" data-quote={quote.kind}>
      <button onClick={() => onStep(items[0], 2)}>add two</button>
      <button onClick={onCharge}>charge</button>
      <button onClick={onCompInstead}>comp instead</button>
      <button onClick={onClear}>clear sale</button>
    </div>
  ),
}));
vi.mock("../TenderChoice", () => ({
  TenderChoice: ({
    onCard,
    onCash,
    onComp,
    onBuyerEmailChange,
    cashTotalCents,
    cardTotalCents,
    cashTotalChanged,
    lockedTender,
    lockReason,
    mayAlreadyBeRecorded,
    onCheckTill,
    ticketCount,
  }: {
    onCard: () => void;
    onCash: () => void;
    onComp: () => void;
    onBuyerEmailChange: (v: string) => void;
    cashTotalCents: number | null;
    cardTotalCents: number | null;
    cashTotalChanged: boolean;
    lockedTender: string | null;
    lockReason: string | null;
    mayAlreadyBeRecorded: boolean;
    onCheckTill: () => void;
    ticketCount: number;
  }) => (
    <div
      data-testid="tender"
      data-cash-total={String(cashTotalCents)}
      data-card-total={String(cardTotalCents)}
      data-cash-changed={String(cashTotalChanged)}
      data-locked={String(lockedTender)}
      data-lock-reason={String(lockReason)}
      data-may-be-recorded={String(mayAlreadyBeRecorded)}
      data-ticket-count={ticketCount}
    >
      <button onClick={onCard}>card</button>
      <button onClick={onCash}>cash</button>
      <button onClick={onComp}>comp</button>
      <button onClick={() => onBuyerEmailChange("  jane@example.com ")}>
        type email
      </button>
      <button onClick={onCheckTill}>check till</button>
    </div>
  ),
}));
vi.mock("../ManualTaxRateDialog", () => ({
  ManualTaxRateDialog: ({ onClose }: { onClose: () => void }) => (
    <button onClick={onClose}>close tax dialog</button>
  ),
}));
vi.mock("../SaleStates", () => ({
  SupportNotice: ({
    children,
    testId,
  }: {
    children?: ReactNode;
    testId?: string;
  }) => <div data-testid={testId}>{children}</div>,
  ReaderWaitingView: ({
    amountCents,
    quotedCents,
  }: {
    amountCents: number;
    quotedCents: number | null;
  }) => (
    <div
      data-testid="waiting"
      data-amount={amountCents}
      data-quoted={String(quotedCents)}
    >
      waiting
    </div>
  ),
  ReaderOpenSaleView: ({
    onTakeCash,
    onAbandon,
    cashAmountCents,
  }: {
    onTakeCash: () => void;
    onAbandon: () => void;
    cashAmountCents: number;
  }) => (
    <div data-testid="open-sale">
      <button onClick={onTakeCash} data-cash-amount-cents={cashAmountCents}>
        take cash instead
      </button>
      <button onClick={onAbandon}>abandon sale</button>
    </div>
  ),
  SaleDoneView: ({
    tender,
    buyerEmail,
    amountCents,
    changeCents,
    onNextSale,
  }: {
    tender: string;
    buyerEmail: string | null;
    amountCents: number;
    changeCents: number;
    onNextSale: () => void;
  }) => (
    <div
      data-testid="done"
      data-tender={tender}
      data-email={String(buyerEmail)}
      data-amount={amountCents}
      data-change={changeCents}
    >
      sale done
      <button onClick={onNextSale}>next sale</button>
    </div>
  ),
}));
vi.mock("../CashTillPanel", () => ({
  CashTillPanel: (props: { checking?: boolean }) => {
    m.tillPanel.current = props;
    return <div data-testid="till" data-checking={String(props.checking)} />;
  },
}));
vi.mock("../LastSaleBar", () => ({
  LastSaleBar: () => <div data-testid="last-sale-bar" />,
}));
vi.mock("../ScannerTermsGate", () => ({ ScannerTermsGate: () => null }));

import { SellView } from "../SellView";
import { shouldRetryQuote } from "../sell-quote";

const GA_TIER = {
  ticketTypeId: TT_GA,
  name: "GA",
  unitPriceCents: 4500,
  pricingMode: "FIXED",
  minimumCents: null,
  suggestedCents: null,
  capacityRemaining: 50,
  sellability: {
    available: true,
    reason: "on_sale",
    opensAt: null,
    closedAt: null,
  },
};

/**
 * What `recordCashSale` answers. By default the server charges exactly what
 * was collected (`changeCents` 0); pass `chargedCents` below the collected
 * amount for a sale that came out lower than the quote.
 */
const cashSaleResult = (
  collectedCents: number,
  isComp = false,
  chargedCents = collectedCents,
) => ({
  orderId: "00000000-0000-4000-8000-0000000000f2",
  amountCents: chargedCents,
  amountCollectedCents: collectedCents,
  changeCents: collectedCents - chargedCents,
  ticketCount: 2,
  isComp,
  autoAdmitted: true,
  seatLabels: [],
  discountCents: 0,
});

/** No response at all: a dropped connection, a closed laptop. */
const lostResponse = () => new TypeError("Failed to fetch");

const readyQuote = (data: unknown = QUOTE) => ({
  data,
  isError: false,
  error: null,
  isFetching: false,
  isPlaceholderData: false,
  refetch: vi.fn(),
});

/** A tRPC client error as the till receives it. */
const appError = (appCode: string, meta?: Record<string, unknown>) =>
  Object.assign(new Error(appCode), {
    data: { appCode, httpStatus: 400, ...(meta ? { meta } : {}) },
  });

/**
 * Press a button and let the handler's promise settle inside `act`. The
 * mocked mutations resolve on the microtask queue, so one await is enough.
 */
async function pressElement(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
}
const press = (text: string) => pressElement(screen.getByText(text));

async function ringUpTwoTickets() {
  render(<SellView />);
  fireEvent.click(await screen.findByText("add two"));
  fireEvent.click(screen.getByText("charge"));
}

describe("SellView — cash fallback from an open card sale", () => {
  beforeEach(() => {
    m.poll.current = undefined;
    vi.clearAllMocks();
    m.ticketTypes.current = [GA_TIER];
    m.quote.current = readyQuote();
    m.startSale.mockResolvedValue({
      orderId: ORDER_ID,
      clientSecret: "cs_x",
      amountCents: CARD_TOTAL_CENTS,
      discountCents: 0,
      currency: "usd",
    });
    // The reader never takes it: the sale stays open ("card-open").
    m.processOnReader.mockRejectedValue(new Error("reader unreachable"));
    m.cancelSale.mockResolvedValue({ ok: true });
    m.recordCashSale.mockImplementation(
      (input: { amountCollectedCents: number; comp?: boolean }) =>
        Promise.resolve(cashSaleResult(input.amountCollectedCents, input.comp === true)),
    );
  });

  it("records the quote's CASH total, not the card sale's fee-and-tax total", async () => {
    await ringUpTwoTickets();
    fireEvent.click(await screen.findByText("card"));
    const takeCash = await screen.findByText("take cash instead");
    expect(m.startSale).toHaveBeenCalledTimes(1);
    // The button's label ("Take $98.33 in cash") names the same amount it records.
    expect(takeCash.getAttribute("data-cash-amount-cents")).toBe(
      String(CASH_TOTAL_CENTS),
    );

    await pressElement(takeCash);

    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(1));
    // The open card order is voided first, then cash is taken.
    expect(m.cancelSale).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      posReaderId: READER_ID,
    });
    const input = m.recordCashSale.mock.calls[0]![0] as {
      amountCollectedCents: number;
      comp: boolean;
      items: unknown;
    };
    expect(input.amountCollectedCents).toBe(CASH_TOTAL_CENTS);
    expect(input.amountCollectedCents).not.toBe(CARD_TOTAL_CENTS);
    expect(input.amountCollectedCents).not.toBe(CART_FACE_CENTS);
    expect(input.comp).toBe(false);
    expect(input.items).toEqual([{ ticketTypeId: TT_GA, qty: 2 }]);
  });

  it("matches what the Cash tile charges for the same cart", async () => {
    await ringUpTwoTickets();
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });

    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(1));
    expect(m.recordCashSale.mock.calls[0]![0]).toMatchObject({
      amountCollectedCents: CASH_TOTAL_CENTS,
      comp: false,
    });
  });

  /** What `completeSale` reads back for the open card order. */
  const cardOrder = (status: string) => ({
    orderId: ORDER_ID,
    status,
    paymentChannel: "POS_CARD",
    amountCents: CARD_TOTAL_CENTS,
    discountCents: 0,
    promoCodes: [],
    isComp: false,
    ticketCount: 2,
  });

  async function openCardSale() {
    await ringUpTwoTickets();
    fireEvent.click(await screen.findByText("card"));
    await screen.findByTestId("open-sale");
  }

  it("never takes cash when the cancel finds the card already paid", async () => {
    // The buyer tapped just before the operator gave up on the reader: the
    // cancel answers ORDER_NOT_PENDING because the order is SUCCEEDED.
    m.cancelSale.mockRejectedValueOnce(appError("ORDER_NOT_PENDING"));
    m.completeSaleFetch.mockResolvedValueOnce(cardOrder("SUCCEEDED"));
    await openCardSale();

    await press("take cash instead");

    const done = await screen.findByTestId("done");
    expect(m.completeSaleFetch).toHaveBeenCalledWith({ orderId: ORDER_ID });
    expect(m.recordCashSale).not.toHaveBeenCalled();
    expect(done.getAttribute("data-tender")).toBe("card");
    expect(done.getAttribute("data-amount")).toBe(String(CARD_TOTAL_CENTS));
    expect(m.toastWarning).toHaveBeenCalledTimes(1);

    // And it is the Last sale, so a mistaken double can be refunded.
    fireEvent.click(screen.getByText("next sale"));
    expect(await screen.findByTestId("last-sale-bar")).toBeTruthy();
  });

  it("takes cash once the server confirms the card sale was cancelled", async () => {
    m.cancelSale.mockRejectedValueOnce(appError("ORDER_NOT_PENDING"));
    m.completeSaleFetch.mockResolvedValueOnce(cardOrder("CANCELLED"));
    await openCardSale();

    await press("take cash instead");

    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(1));
    expect(m.recordCashSale.mock.calls[0]![0]).toMatchObject({
      amountCollectedCents: CASH_TOTAL_CENTS,
      comp: false,
    });
  });

  it("stays put, and says so, when the card sale is in any other state", async () => {
    m.cancelSale.mockRejectedValueOnce(appError("ORDER_NOT_PENDING"));
    m.completeSaleFetch.mockResolvedValueOnce(cardOrder("DISPUTED"));
    await openCardSale();

    await press("take cash instead");

    // (The reader's dispatch failure toasted once already, to get here.)
    await waitFor(() =>
      expect(m.toastDanger).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sell-card-unclear" }),
      ),
    );
    expect(m.recordCashSale).not.toHaveBeenCalled();
    expect(screen.getByTestId("open-sale")).toBeTruthy();
  });

  it("stays put when the check itself fails", async () => {
    m.cancelSale.mockRejectedValueOnce(appError("ORDER_NOT_PENDING"));
    m.completeSaleFetch.mockRejectedValueOnce(lostResponse());
    await openCardSale();

    await press("take cash instead");

    // (The reader's dispatch failure toasted once already, to get here.)
    await waitFor(() =>
      expect(m.toastDanger).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sell-card-unclear" }),
      ),
    );
    expect(m.recordCashSale).not.toHaveBeenCalled();
    expect(screen.getByTestId("open-sale")).toBeTruthy();
  });

  it("shows the paid card sale instead of clearing it when Abandon finds it paid", async () => {
    m.cancelSale.mockRejectedValueOnce(appError("ORDER_NOT_PENDING"));
    m.completeSaleFetch.mockResolvedValueOnce(cardOrder("SUCCEEDED"));
    await openCardSale();

    await press("abandon sale");

    const done = await screen.findByTestId("done");
    expect(done.getAttribute("data-tender")).toBe("card");
    expect(m.recordCashSale).not.toHaveBeenCalled();
  });

  it("never clears a sale Abandon finds paid but not finalised", async () => {
    // The payment went through; the webhook hasn't finalised the order, so
    // the void is refused as ORDER_NOT_PROCESSABLE and the order reads PENDING.
    m.cancelSale.mockRejectedValueOnce(
      appError("ORDER_NOT_PROCESSABLE", {
        reason: "pi_terminal_not_canceled",
        paymentIntentStatus: "succeeded",
      }),
    );
    m.completeSaleFetch.mockResolvedValueOnce(cardOrder("PENDING"));
    await openCardSale();

    await press("abandon sale");

    await waitFor(() => expect(m.completeSaleFetch).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(m.toastWarning).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sell-card-unclear" }),
      ),
    );
    // Still on the open sale, where the poll will settle it. No reset.
    expect(screen.getByTestId("open-sale")).toBeTruthy();
    expect(screen.queryByTestId("catalogue")).toBeNull();
    expect(m.recordCashSale).not.toHaveBeenCalled();
  });

  it("shows the card sale when Abandon's check finds it paid after ORDER_NOT_PROCESSABLE", async () => {
    m.cancelSale.mockRejectedValueOnce(appError("ORDER_NOT_PROCESSABLE"));
    m.completeSaleFetch.mockResolvedValueOnce(cardOrder("SUCCEEDED"));
    await openCardSale();

    await press("abandon sale");

    const done = await screen.findByTestId("done");
    expect(done.getAttribute("data-tender")).toBe("card");
  });

  it("doesn't re-show a sale the poll already finished once the till has moved on", async () => {
    let rejectCancel: (err: unknown) => void = () => {};
    m.cancelSale.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCancel = reject;
        }),
    );
    m.completeSaleFetch.mockResolvedValueOnce(cardOrder("SUCCEEDED"));
    const view = render(<SellView />);
    fireEvent.click(await screen.findByText("add two"));
    fireEvent.click(screen.getByText("charge"));
    await press("card");
    await screen.findByTestId("open-sale");

    // Abandon is pressed; the cancel is still in flight...
    fireEvent.click(screen.getByText("abandon sale"));
    // ...when the poll sees the sale finalise and shows it.
    m.poll.current = cardOrder("SUCCEEDED");
    view.rerender(<SellView />);
    await screen.findByTestId("done");
    // The operator moves on to the next buyer.
    fireEvent.click(screen.getByText("next sale"));
    await screen.findByTestId("catalogue");

    // Now the cancel's answer and the check arrive, late.
    await act(async () => {
      rejectCancel(appError("ORDER_NOT_PENDING"));
      await Promise.resolve();
    });
    await waitFor(() => expect(m.completeSaleFetch).toHaveBeenCalledTimes(1));
    // Let the check's answer land and any state it sets render.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByTestId("catalogue")).toBeTruthy();
    expect(screen.queryByTestId("done")).toBeNull();
    expect(m.toastWarning).not.toHaveBeenCalled();
  });

  it("treats an order that is gone as closed", async () => {
    m.cancelSale.mockRejectedValueOnce(appError("ORDER_NOT_FOUND"));
    await openCardSale();

    await press("take cash instead");

    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(1));
    expect(m.completeSaleFetch).not.toHaveBeenCalled();
  });
});

describe("SellView — the quote is the only source of a total", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.ticketTypes.current = [GA_TIER];
    m.quote.current = readyQuote();
    m.recordCashSale.mockImplementation(
      (input: { amountCollectedCents: number; comp?: boolean }) =>
        Promise.resolve(cashSaleResult(input.amountCollectedCents, input.comp === true)),
    );
  });

  it("hands the tender screen the quote's card and cash totals", async () => {
    await ringUpTwoTickets();
    const tender = await screen.findByTestId("tender");
    expect(tender.getAttribute("data-card-total")).toBe(String(CARD_TOTAL_CENTS));
    expect(tender.getAttribute("data-cash-total")).toBe(String(CASH_TOTAL_CENTS));
  });

  it("won't leave the cart while the quote is still on its way", async () => {
    m.quote.current = {
      ...readyQuote(QUOTE),
      isPlaceholderData: true,
      isFetching: true,
    };
    await ringUpTwoTickets();
    expect(screen.queryByTestId("tender")).toBeNull();
  });

  it("won't leave the cart when the tax lookup refused the quote", async () => {
    m.quote.current = {
      data: undefined,
      isError: true,
      error: appError("TAX_RATE_UNAVAILABLE", { canEnterManualTaxRate: true }),
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    };
    await ringUpTwoTickets();
    expect(screen.queryByTestId("tender")).toBeNull();
  });

  it("comps ONLY through the explicit comp flag, and carries the buyer email", async () => {
    await ringUpTwoTickets();
    fireEvent.click(await screen.findByText("type email"));
    fireEvent.click(screen.getByText("comp"));
    await act(async () => {
      fireEvent.click(await screen.findByText("Comp them"));
    });

    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(1));
    expect(m.recordCashSale.mock.calls[0]![0]).toMatchObject({
      comp: true,
      amountCollectedCents: 0,
      buyerEmail: "jane@example.com",
    });
    const done = await screen.findByTestId("done");
    expect(done.getAttribute("data-tender")).toBe("comp");
    expect(done.getAttribute("data-email")).toBe("jane@example.com");
  });

  it("omits a blank buyer email rather than sending an empty string", async () => {
    await ringUpTwoTickets();
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });
    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(1));
    expect(m.recordCashSale.mock.calls[0]![0]).not.toHaveProperty("buyerEmail");
  });

  it("on CASH_AMOUNT_SHORT shows the server's new cash total and does NOT retry by itself", async () => {
    m.recordCashSale.mockRejectedValueOnce(
      appError("CASH_AMOUNT_SHORT", { requiredTotalCents: 9_901 }),
    );
    await ringUpTwoTickets();
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });

    await waitFor(() =>
      expect(
        screen.getByTestId("tender").getAttribute("data-cash-changed"),
      ).toBe("true"),
    );
    expect(m.recordCashSale).toHaveBeenCalledTimes(1);
    expect(m.toastDanger).not.toHaveBeenCalled();
    expect(screen.getByTestId("tender").getAttribute("data-cash-total")).toBe(
      "9901",
    );

    // The operator tells the buyer, then presses Cash again: the new total.
    await press("cash");
    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(2));
    expect(m.recordCashSale.mock.calls[1]![0]).toMatchObject({
      amountCollectedCents: 9_901,
      comp: false,
    });
  });

  it("starts a card sale with the buyer email and keeps the quoted card total for the reader screen", async () => {
    m.startSale.mockResolvedValue({
      orderId: ORDER_ID,
      clientSecret: "cs_x",
      // The total moved after the quote (a tax rate update, a price change:
      // the screen doesn't say which): the reader asks for more.
      amountCents: CARD_TOTAL_CENTS + 23,
      discountCents: 0,
      currency: "usd",
    });
    m.processOnReader.mockResolvedValue({ ok: true });
    await ringUpTwoTickets();
    fireEvent.click(await screen.findByText("type email"));
    await press("card");

    expect(m.startSale.mock.calls[0]![0]).toMatchObject({
      buyerEmail: "jane@example.com",
    });
    const waiting = await screen.findByTestId("waiting");
    expect(waiting.getAttribute("data-amount")).toBe(
      String(CARD_TOTAL_CENTS + 23),
    );
    expect(waiting.getAttribute("data-quoted")).toBe(String(CARD_TOTAL_CENTS));
  });
});

describe("SellView — the sale charged is the sale quoted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.ticketTypes.current = [GA_TIER];
    m.quote.current = readyQuote();
    m.recordCashSale.mockImplementation(
      (input: { amountCollectedCents: number; comp?: boolean }) =>
        Promise.resolve(cashSaleResult(input.amountCollectedCents, input.comp === true)),
    );
  });

  it("tells the operator to give change when the sale came out lower than the quote", async () => {
    // A hand-entered 9.25% quoted $98.33; by the time Cash was pressed the
    // lookup answered again at a lower rate, and the server charged $90.00.
    m.recordCashSale.mockImplementation(
      (input: { amountCollectedCents: number }) =>
        Promise.resolve(cashSaleResult(input.amountCollectedCents, false, 9_000)),
    );
    await ringUpTwoTickets();
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });

    const done = await screen.findByTestId("done");
    expect(m.recordCashSale.mock.calls[0]![0]).toMatchObject({
      amountCollectedCents: CASH_TOTAL_CENTS,
    });
    expect(done.getAttribute("data-amount")).toBe("9000");
    expect(done.getAttribute("data-change")).toBe(String(CASH_TOTAL_CENTS - 9_000));
  });

  it("sends the lines that were quoted, even if a tier drops out of the catalogue after Charge", async () => {
    const view = render(<SellView />);
    fireEvent.click(await screen.findByText("add two"));
    fireEvent.click(screen.getByText("charge"));
    await screen.findByTestId("tender");

    // The catalogue refetches behind the tender screen and GA has sold out:
    // the live cart would now be empty.
    m.ticketTypes.current = [];
    view.rerender(<SellView />);

    await press("cash");
    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(1));
    expect(m.recordCashSale.mock.calls[0]![0]).toMatchObject({
      items: [{ ticketTypeId: TT_GA, qty: 2 }],
    });
    expect(screen.getByTestId("done").getAttribute("data-tender")).toBe("cash");
  });

  it("won't leave the cart while the same cart's quote is being refetched", async () => {
    m.quote.current = { ...readyQuote(), isFetching: true };
    await ringUpTwoTickets();
    expect(screen.queryByTestId("tender")).toBeNull();
    expect(screen.getByTestId("catalogue").getAttribute("data-quote")).toBe(
      "updating",
    );
  });

  it("only retries a quote that got no answer", () => {
    render(<SellView />);
    expect(m.quoteOptions.current?.retry).toBe(shouldRetryQuote);
  });

  it("goes back to the cart and re-asks for the quote when the cash sale finds tax down", async () => {
    m.recordCashSale.mockRejectedValueOnce(
      appError("TAX_RATE_UNAVAILABLE", { canEnterManualTaxRate: true }),
    );
    await ringUpTwoTickets();
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });
    await waitFor(() => expect(screen.queryByTestId("tender")).toBeNull());
    expect(screen.getByTestId("catalogue")).toBeTruthy();
    expect((m.quote.current as { refetch: ReturnType<typeof vi.fn> }).refetch).toHaveBeenCalled();
  });

  it("goes back to the cart when the card sale finds tax down", async () => {
    m.startSale.mockRejectedValueOnce(
      appError("TAX_RATE_UNAVAILABLE", { canEnterManualTaxRate: false }),
    );
    await ringUpTwoTickets();
    await act(async () => {
      fireEvent.click(await screen.findByText("card"));
    });
    await waitFor(() => expect(screen.queryByTestId("tender")).toBeNull());
    expect(m.processOnReader).not.toHaveBeenCalled();
    expect((m.quote.current as { refetch: ReturnType<typeof vi.fn> }).refetch).toHaveBeenCalled();
  });

  it("re-asks for the quote whenever the tax-rate dialog closes", async () => {
    render(<SellView />);
    fireEvent.click(await screen.findByText("close tax dialog"));
    expect((m.quote.current as { refetch: ReturnType<typeof vi.fn> }).refetch).toHaveBeenCalledTimes(1);
  });

  it("routes Comp instead (tax refused) through the tender screen, with no totals", async () => {
    m.quote.current = {
      data: undefined,
      isError: true,
      error: appError("TAX_RATE_UNAVAILABLE", { canEnterManualTaxRate: false }),
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    };
    render(<SellView />);
    fireEvent.click(await screen.findByText("add two"));
    fireEvent.click(screen.getByText("comp instead"));
    const tender = await screen.findByTestId("tender");
    expect(tender.getAttribute("data-cash-total")).toBe("null");
    expect(tender.getAttribute("data-card-total")).toBe("null");
    expect(tender.getAttribute("data-ticket-count")).toBe("2");

    fireEvent.click(screen.getByText("type email"));
    fireEvent.click(screen.getByText("comp"));
    await act(async () => {
      fireEvent.click(await screen.findByText("Comp them"));
    });
    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(1));
    expect(m.recordCashSale.mock.calls[0]![0]).toMatchObject({
      comp: true,
      amountCollectedCents: 0,
      buyerEmail: "jane@example.com",
      items: [{ ticketTypeId: TT_GA, qty: 2 }],
    });
  });
});

describe("SellView — a sale whose answer never arrived is never taken twice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.ticketTypes.current = [GA_TIER];
    m.quote.current = readyQuote();
  });

  const keyOf = (call: number) =>
    (m.recordCashSale.mock.calls[call]![0] as { clientKey: string }).clientKey;

  it("locks the tender, keeps the key, and says nothing failed", async () => {
    m.recordCashSale.mockRejectedValueOnce(lostResponse());
    m.recordCashSale.mockImplementationOnce(
      (input: { amountCollectedCents: number }) =>
        Promise.resolve(cashSaleResult(input.amountCollectedCents)),
    );
    await ringUpTwoTickets();
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("tender").getAttribute("data-locked")).toBe("cash"),
    );
    // "Could not record that sale" would be a claim nobody can make.
    expect(m.toastDanger).not.toHaveBeenCalled();

    // Pressing Cash again replays under the SAME key: the server returns the
    // stored sale if the first one went through.
    await press("cash");
    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBe(keyOf(0));
    await screen.findByTestId("done");
  });

  it("keeps the key on IDEMPOTENCY_KEY_CONFLICT and sends the operator to check", async () => {
    m.recordCashSale.mockRejectedValueOnce(lostResponse());
    m.recordCashSale.mockRejectedValueOnce(appError("IDEMPOTENCY_KEY_CONFLICT"));
    m.recordCashSale.mockRejectedValueOnce(appError("IDEMPOTENCY_KEY_CONFLICT"));
    await ringUpTwoTickets();
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });
    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(1));

    // A GUARD, not a path the real UI allows: TenderChoice disables the
    // email while a tender is locked. If that lock ever slipped, a "fixed"
    // email is a different payload under the same key, which the server
    // refuses as a conflict, and the till must not mint a new key for it.
    fireEvent.click(screen.getByText("type email"));
    await press("cash");
    await waitFor(() =>
      expect(
        screen.getByTestId("tender").getAttribute("data-may-be-recorded"),
      ).toBe("true"),
    );
    expect(keyOf(1)).toBe(keyOf(0));
    expect(m.toastDanger).not.toHaveBeenCalled();

    // Even if it were pressed again, it would NOT be a new sale.
    await press("cash");
    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(3));
    expect(keyOf(2)).toBe(keyOf(0));
  });

  it("says 'still being processed' on LOCK_IN_PROGRESS, keeps the key, and lets the same tender go again", async () => {
    m.recordCashSale.mockRejectedValueOnce(appError("IDEMPOTENCY_LOCK_IN_PROGRESS"));
    m.recordCashSale.mockImplementationOnce(
      (input: { amountCollectedCents: number }) =>
        Promise.resolve(cashSaleResult(input.amountCollectedCents)),
    );
    await ringUpTwoTickets();
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });

    const tender = screen.getByTestId("tender");
    await waitFor(() => expect(tender.getAttribute("data-locked")).toBe("cash"));
    expect(tender.getAttribute("data-lock-reason")).toBe("processing");
    // Not "may already be recorded": usually the first press is still running.
    expect(tender.getAttribute("data-may-be-recorded")).toBe("false");
    expect(m.toastDanger).not.toHaveBeenCalled();

    await press("cash");
    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBe(keyOf(0));
    await screen.findByTestId("done");
  });

  it("sends the operator to check once LOCK_IN_PROGRESS doesn't clear", async () => {
    // A lost refusal holds the key for fifteen minutes: "wait" never ends.
    m.recordCashSale.mockRejectedValue(appError("IDEMPOTENCY_LOCK_IN_PROGRESS"));
    await ringUpTwoTickets();
    for (let press = 1; press <= 3; press += 1) {
      await act(async () => {
        fireEvent.click(await screen.findByText("cash"));
      });
      await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(press));
      expect(
        screen.getByTestId("tender").getAttribute("data-may-be-recorded"),
      ).toBe(press < 3 ? "false" : "true");
    }
    expect(keyOf(2)).toBe(keyOf(0));
  });

  async function reachMayBeRecorded() {
    m.recordCashSale.mockRejectedValueOnce(appError("IDEMPOTENCY_KEY_CONFLICT"));
    await ringUpTwoTickets();
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("tender").getAttribute("data-may-be-recorded"),
      ).toBe("true"),
    );
  }

  it("'See Cash taken tonight' opens the till, and hides the previous buyer's Last sale", async () => {
    // A finished sale first, so there IS a Last sale to hide.
    m.recordCashSale.mockImplementationOnce(
      (input: { amountCollectedCents: number }) =>
        Promise.resolve(cashSaleResult(input.amountCollectedCents)),
    );
    await ringUpTwoTickets();
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });
    fireEvent.click(await screen.findByText("next sale"));
    expect(await screen.findByTestId("last-sale-bar")).toBeTruthy();
    expect(screen.getByTestId("till").getAttribute("data-checking")).toBe("false");

    // The next buyer's attempt comes back as a key conflict.
    m.recordCashSale.mockRejectedValueOnce(appError("IDEMPOTENCY_KEY_CONFLICT"));
    fireEvent.click(screen.getByText("add two"));
    fireEvent.click(screen.getByText("charge"));
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("tender").getAttribute("data-may-be-recorded"),
      ).toBe("true"),
    );

    fireEvent.click(screen.getByText("check till"));
    expect(await screen.findByTestId("catalogue")).toBeTruthy();
    expect(screen.getByTestId("till").getAttribute("data-checking")).toBe("true");
    expect(screen.getByTestId("sell-unresolved-ring-up")).toBeTruthy();
    expect(screen.queryByTestId("last-sale-bar")).toBeNull();
  });

  it("asks before Clear sale throws away a key that may hold a sale", async () => {
    await reachMayBeRecorded();
    fireEvent.click(screen.getByText("check till"));
    await screen.findByTestId("catalogue");

    fireEvent.click(screen.getByText("clear sale"));
    expect(await screen.findByText("Clear this sale?")).toBeTruthy();
    fireEvent.click(screen.getByText("Keep it"));
    expect(screen.queryByText("Clear this sale?")).toBeNull();
    // Still unresolved: the notice stays.
    expect(screen.getByTestId("sell-unresolved-ring-up")).toBeTruthy();

    fireEvent.click(screen.getByText("clear sale"));
    fireEvent.click(await screen.findByText("Clear it anyway"));
    await waitFor(() =>
      expect(screen.queryByTestId("sell-unresolved-ring-up")).toBeNull(),
    );
    expect(screen.getByTestId("till").getAttribute("data-checking")).toBe("false");

    // A fresh sale gets a fresh key.
    m.recordCashSale.mockImplementationOnce(
      (input: { amountCollectedCents: number }) =>
        Promise.resolve(cashSaleResult(input.amountCollectedCents)),
    );
    fireEvent.click(screen.getByText("add two"));
    fireEvent.click(screen.getByText("charge"));
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });
    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("clears without asking when nothing is unresolved", async () => {
    render(<SellView />);
    fireEvent.click(await screen.findByText("add two"));
    fireEvent.click(screen.getByText("clear sale"));
    expect(screen.queryByText("Clear this sale?")).toBeNull();
    expect(screen.queryByTestId("sell-unresolved-ring-up")).toBeNull();
  });

  it("rotates the key after an ordinary refusal", async () => {
    m.recordCashSale.mockRejectedValueOnce(appError("TICKET_TYPE_TEMPORARILY_HELD"));
    m.recordCashSale.mockImplementationOnce(
      (input: { amountCollectedCents: number }) =>
        Promise.resolve(cashSaleResult(input.amountCollectedCents)),
    );
    await ringUpTwoTickets();
    await act(async () => {
      fireEvent.click(await screen.findByText("cash"));
    });
    await waitFor(() => expect(m.toastDanger).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("tender").getAttribute("data-locked")).toBe("null");
    await press("cash");
    await waitFor(() => expect(m.recordCashSale).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).not.toBe(keyOf(0));
  });
});

describe("SellView — the till answers its own failures", () => {
  it("keeps every sale mutation out of the global error toast", () => {
    m.ticketTypes.current = [GA_TIER];
    m.quote.current = readyQuote();
    render(<SellView />);
    // Without `silent` the global notifier toasted "Action failed" over the
    // till's own answer: a key conflict, a cash total that moved. A cancel
    // that answers ORDER_NOT_PENDING is not dropped either: the till asks
    // completeSale what the order became and says so itself (see the
    // "never takes cash when the cancel finds the card already paid" test).
    for (const name of ["startSale", "processOnReader", "cancelSale", "recordCashSale"]) {
      expect(m.mutationMeta[name]).toEqual({ silent: true });
    }
  });
});
