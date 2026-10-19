import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `resale.createListing` takes a TICKET id. The form lists ORDER ITEMS, and
 * an earlier version sent the item id, so the server refused every listing
 * with TICKET_NOT_FOUND. Every fixture here gives the item and its ticket
 * different ids, so sending the wrong one fails the test.
 *
 * The form therefore depends on a second read, `orders.listMyOrderTickets`.
 * The mocks model that read's whole result (data, error, loading) and run a
 * mutation's `onSuccess` when it resolves, because the defects this file
 * guards live in exactly those places: a tickets read that failed, one still
 * in flight, and a tickets cache nobody refreshed after a cancel.
 */

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_ID = "33333333-3333-4333-8333-333333333333";
const ITEM_NO_TICKET_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ITEM_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_TICKET_ID = "66666666-6666-4666-8666-666666666666";
const LISTING_ID = "77777777-7777-4777-8777-777777777777";
/** The listing a resale buyer's ticket was bought through. */
const PURCHASED_LISTING_ID = "88888888-8888-4888-8888-888888888888";

const state = vi.hoisted(() => ({
  order: {} as Record<string, unknown>,
  ticketsQuery: {} as Record<string, unknown>,
  /** What `resale.estimateListing` answers; null = no answer yet. */
  split: null as Record<string, unknown> | null,
  /** While set, the debounced ask stays at this value (a pending debounce). */
  holdDebounced: null as string | null,
  listings: { items: [] as unknown[] },
  connectStatus: { data: undefined, dataUpdatedAt: 0 } as Record<
    string,
    unknown
  >,
  /** Called with the options of every `stripeConnect.getStatus` read. */
  connectStatusOptions: vi.fn(),
  /** Called with the input and options of every split read. */
  estimateInput: vi.fn(),
  createListing: vi.fn(),
  cancelListing: vi.fn(),
  refetchTickets: vi.fn(),
  formatErrorMessage: vi.fn(),
  /** What `getAppErrorCode` reads off a refusal. */
  appErrorCode: vi.fn(),
  /** The form's `setError`: a refusal that goes to the shared copy. */
  setFormError: vi.fn(),
  scrollIntoView: vi.fn(),
  invalidate: {
    listMyListings: vi.fn(),
    getMyOrder: vi.fn(),
    listMyOrderTickets: vi.fn(),
    getStatus: vi.fn(),
  },
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    Repeat: Icon,
    Tag: Icon,
    AlertTriangle: Icon,
    ArrowLeft: Icon,
    ArrowRight: Icon,
    CheckCircle2: Icon,
  };
});

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
      if (
        key === "role" ||
        key === "id" ||
        key === "data-testid" ||
        key === "tabIndex" ||
        key === "onKeyDown" ||
        key.startsWith("aria-")
      )
        safe[key] = value;
    }
    return React.createElement("div", { ...safe, onClick: onPress }, children);
  };
  return {
    XStack: Stack,
    YStack: Stack,
    Card: Stack,
    Spinner: () => <span>Loading</span>,
    styled: () => Stack,
  };
});

vi.mock("@th/ui", () => {
  // `id` reaches the DOM, as it does on the real Text: the price field is
  // named by pointing at its visible caption.
  const Text = ({ children, id }: { children?: ReactNode; id?: string }) => (
    <span id={id}>{children}</span>
  );
  return {
    Text,
    FormErrorBanner: ({ message }: { message?: string | null }) =>
      message ? <div data-testid="form-error-banner">{message}</div> : null,
    // The touch minimum reaches the DOM as a data attribute, so a test can
    // see which buttons take it.
    Button: ({
      children,
      onPress,
      disabled,
      $pointerCoarse,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      $pointerCoarse?: { minHeight?: number };
    }) => (
      <button
        type="button"
        onClick={onPress}
        disabled={disabled}
        data-touch-min-height={$pointerCoarse?.minHeight}
      >
        {children}
      </button>
    ),
    // What the real TextInput puts on its <input>: the name, the input
    // mode, the `aria-labelledby`, and Enter as `onSubmitEditing`.
    TextInput: ({
      value,
      onChangeText,
      onSubmitEditing,
      testId,
      name,
      inputMode,
      "aria-labelledby": labelledBy,
    }: {
      value: string;
      onChangeText: (v: string) => void;
      onSubmitEditing?: () => void;
      testId?: string;
      name?: string;
      inputMode?: "decimal" | "numeric" | "text";
      "aria-labelledby"?: string;
    }) => (
      <input
        data-testid={testId}
        name={name}
        inputMode={inputMode}
        aria-labelledby={labelledBy}
        value={value}
        onChange={(e) => onChangeText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmitEditing?.();
        }}
      />
    ),
    useTranslations: () => (key: string, vars?: { amount?: string }) =>
      vars?.amount ? `${key}|${vars.amount}` : key,
    useFormatters: () => ({}),
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
  };
});

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_f: unknown, cents: number) => `$${cents}`,
  fmtDate: () => "date",
  fmtDateShort: () => "date",
  toMajorUnits: (cents: number) => cents / 100,
}));
vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: (value: string) => state.holdDebounced ?? value,
}));
vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (error: unknown, t?: unknown) =>
    state.formatErrorMessage(error, t),
}));
vi.mock("@/hooks/useFormErrors", () => ({
  useFormErrors: () => ({
    formError: null,
    setError: state.setFormError,
    clearAll: vi.fn(),
  }),
}));
vi.mock("@/lib/app-error", () => ({
  getAppErrorCode: (error: unknown) => state.appErrorCode(error),
}));
vi.mock("@/app/account/settings/_lib/settings-routes", () => ({
  settingsSectionHref: () => "/settings",
}));

vi.mock("@/trpc", () => {
  // Like the real hook: `onSuccess` runs when, and only when, the call
  // resolves.
  const mutation =
    (run: (input: unknown) => Promise<unknown>) =>
    (options?: { onSuccess?: () => void }) => ({
      isPending: false,
      mutateAsync: async (input: unknown) => {
        const result = await run(input);
        options?.onSuccess?.();
        return result;
      },
    });
  return {
    trpc: {
      useUtils: () => ({
        resale: {
          listMyListings: { invalidate: state.invalidate.listMyListings },
        },
        orders: {
          getMyOrder: { invalidate: state.invalidate.getMyOrder },
          listMyOrderTickets: {
            invalidate: state.invalidate.listMyOrderTickets,
          },
        },
        stripeConnect: { getStatus: { invalidate: state.invalidate.getStatus } },
      }),
      orders: {
        getMyOrder: { useQuery: () => ({ data: state.order }) },
        listMyOrderTickets: { useQuery: () => state.ticketsQuery },
      },
      stripeConnect: {
        getStatus: {
          // Returns its data whether or not the read is enabled, as a cached
          // result would: the card must not lean on the read being skipped.
          useQuery: (_input: unknown, options?: { enabled?: boolean }) => {
            state.connectStatusOptions(options);
            return state.connectStatus;
          },
        },
      },
      resale: {
        estimateListing: {
          useQuery: (input: unknown, options?: { enabled?: boolean }) => {
            state.estimateInput(input, options);
            // Like the real read: an answer only while enabled, for the ask
            // it was sent, unless a test pins one.
            const ask = (input as { askPriceCents: number }).askPriceCents;
            return {
              data: options?.enabled ? (state.split ?? splitFor(ask)) : undefined,
              isError: false,
              error: null,
            };
          },
        },
        listMyListings: { useQuery: () => ({ data: state.listings }) },
        createListing: {
          useMutation: mutation((input) => state.createListing(input)),
        },
        cancelListing: {
          useMutation: mutation((input) => state.cancelListing(input)),
        },
      },
    },
  };
});

import { ResellForm } from "../ResellForm";
import { setNavbarVisibleHeight } from "@/components/navigation/navbar-offset-store";

function item(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    qty: 1,
    unitPriceCents: 3500,
    amountCents: 3500,
    kind: "ticket",
    ticketTypeId: "tt-1",
    resaleListingId: null,
    paidOutAt: null,
    refundedAt: null,
    transferredAt: null,
    status: "active",
    ...overrides,
  };
}

function ticket(id: string, orderItemId: string | null, status = "VALID") {
  return {
    id,
    code: "ABCD1234",
    status,
    scannedAt: null,
    orderItemId,
    ticketTypeId: "tt-1",
  };
}

/** The server's split for a $42.00 ask on a $35.00 ticket, SELLER pays. */
function splitFor(askPriceCents: number, overrides: Record<string, unknown> = {}) {
  const shareCents = Math.floor(askPriceCents / 10);
  return {
    ticketId: TICKET_ID,
    currency: "usd",
    askPriceCents,
    shareCents,
    shareHeld: false,
    heldFromCents: null,
    sellerReceivesCents: askPriceCents - shareCents,
    basisCents: askPriceCents,
    payer: "SELLER",
    originalPriceCents: 3500,
    capCents: null,
    withinCap: true,
    highestFittingAskCents: null,
    ...overrides,
  };
}

/** A settled, successful tickets read. */
function ticketsLoaded(tickets: unknown[]) {
  return {
    data: { orderId: ORDER_ID, tickets },
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: state.refetchTickets,
  };
}

function activeListing() {
  return {
    id: LISTING_ID,
    status: "ACTIVE",
    askPriceCents: 4200,
    currency: "usd",
    faceValueCents: 3500,
    processingPassThroughCents: 0,
    saleCutoffAt: null,
    payoutReleaseAt: null,
  };
}

/** The order-level fields `getMyOrder` returns that the form reads. */
const PRIMARY_ORDER = { id: ORDER_ID, source: "PRIMARY", status: "SUCCEEDED" };
const RESALE_ORDER = { id: ORDER_ID, source: "RESALE", status: "SUCCEEDED" };

const header = (itemId: string) => screen.getByTestId(`resell-ticket-${itemId}`);
const queryHeader = (itemId: string) =>
  screen.queryByTestId(`resell-ticket-${itemId}`);

/** The List button, whatever its label (the amount appears with the split). */
const listButton = () => screen.getByText(/^resell\.listFor(Sale|Amount)/);
const retryButton = () =>
  screen.getByText("orderDetail.retry") as HTMLButtonElement;
/** Every `enabled` the Stripe status read was rendered with. */
const connectStatusEnabled = () =>
  state.connectStatusOptions.mock.calls.map(
    ([options]) => (options as { enabled?: boolean } | undefined)?.enabled,
  );

beforeEach(() => {
  vi.clearAllMocks();
  state.createListing.mockResolvedValue({});
  state.cancelListing.mockResolvedValue({});
  state.appErrorCode.mockReturnValue(null);
  // jsdom has no layout, so no `scrollIntoView` of its own.
  HTMLElement.prototype.scrollIntoView = state.scrollIntoView;
  state.formatErrorMessage.mockImplementation(
    (error: unknown) => `formatted:${(error as Error).message}`,
  );
  state.order = { ...PRIMARY_ORDER, items: [item(ITEM_ID)] };
  state.ticketsQuery = ticketsLoaded([ticket(TICKET_ID, ITEM_ID)]);
  state.listings = { items: [] };
  state.connectStatus = { data: undefined, dataUpdatedAt: 0 };
  state.split = null;
  state.holdDebounced = null;
});

afterEach(cleanup);

describe("ResellForm", () => {
  it("lists the TICKET id, not the order item id", async () => {
    render(<ResellForm orderId={ORDER_ID} />);
    fireEvent.click(header(ITEM_ID));
    fireEvent.change(screen.getByTestId("resale-ask-price"), {
      target: { value: "42.00" },
    });
    fireEvent.click(listButton());
    await waitFor(() => expect(state.createListing).toHaveBeenCalledTimes(1));
    const arg = state.createListing.mock.calls[0]![0];
    expect(arg.ticketId).toBe(TICKET_ID);
    expect(arg.ticketId).not.toBe(ITEM_ID);
    expect(arg.askPriceCents).toBe(4200);
    // A listed ticket closes its form.
    await waitFor(() =>
      expect(screen.queryByTestId("resale-ask-price")).toBeNull(),
    );
  });

  describe("the tickets read is refreshed when a ticket's status moves", () => {
    it("refetches the order's tickets after a listing is created", async () => {
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(header(ITEM_ID));
      fireEvent.click(listButton());
      await waitFor(() =>
        expect(state.invalidate.listMyOrderTickets).toHaveBeenCalledWith({
          orderId: ORDER_ID,
        }),
      );
      expect(state.invalidate.getMyOrder).toHaveBeenCalledWith({
        orderId: ORDER_ID,
      });
      await waitFor(() =>
        expect(screen.queryByTestId("resale-ask-price")).toBeNull(),
      );
    });

    it("refetches the order's tickets after a listing is cancelled", async () => {
      // The seller opened the form with this ticket on sale: the item is
      // filtered out by its listing, and the tickets cache says LISTED.
      // Cancelling makes the ticket VALID again on the server, so the cached
      // LISTED has to be thrown away with the cached order.
      state.order = {
        ...PRIMARY_ORDER,
        items: [item(ITEM_ID, { resaleListingId: LISTING_ID })],
      };
      state.ticketsQuery = ticketsLoaded([
        ticket(TICKET_ID, ITEM_ID, "LISTED"),
      ]);
      state.listings = { items: [activeListing()] };
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(screen.getByText("Cancel"));
      await waitFor(() =>
        expect(state.cancelListing).toHaveBeenCalledWith({
          listingId: LISTING_ID,
        }),
      );
      await waitFor(() =>
        expect(state.invalidate.listMyOrderTickets).toHaveBeenCalledWith({
          orderId: ORDER_ID,
        }),
      );
    });

    it("does not refetch them when the cancel is refused", async () => {
      state.listings = { items: [activeListing()] };
      state.cancelListing.mockRejectedValue(new Error("LISTING_NOT_ACTIVE"));
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(screen.getByText("Cancel"));
      await waitFor(() =>
        expect(state.formatErrorMessage).toHaveBeenCalledTimes(1),
      );
      expect(state.invalidate.listMyOrderTickets).not.toHaveBeenCalled();
    });
  });

  describe("the ticket header from the keyboard", () => {
    it("is a button that Enter presses", () => {
      render(<ResellForm orderId={ORDER_ID} />);
      expect(header(ITEM_ID).getAttribute("role")).toBe("button");
      expect(header(ITEM_ID).getAttribute("aria-pressed")).toBe("false");

      fireEvent.keyDown(header(ITEM_ID), { key: "Enter" });
      expect(screen.queryByTestId("resale-ask-price")).not.toBeNull();
      expect(header(ITEM_ID).getAttribute("aria-pressed")).toBe("true");

      fireEvent.keyDown(header(ITEM_ID), { key: "Enter" });
      expect(screen.queryByTestId("resale-ask-price")).toBeNull();
    });

    it("is pressed by Space, without scrolling the page", () => {
      render(<ResellForm orderId={ORDER_ID} />);
      // `fireEvent` returns false when the handler called preventDefault.
      const notPrevented = fireEvent.keyDown(header(ITEM_ID), { key: " " });
      expect(notPrevented).toBe(false);
      expect(screen.queryByTestId("resale-ask-price")).not.toBeNull();
    });

    it("presses once for a held key, and a held Space still does not scroll", () => {
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.keyDown(header(ITEM_ID), { key: "Enter" });
      expect(screen.queryByTestId("resale-ask-price")).not.toBeNull();
      // The repeats a held key sends must not close it again.
      fireEvent.keyDown(header(ITEM_ID), { key: "Enter", repeat: true });
      fireEvent.keyDown(header(ITEM_ID), { key: "Enter", repeat: true });
      expect(screen.queryByTestId("resale-ask-price")).not.toBeNull();

      const notPrevented = fireEvent.keyDown(header(ITEM_ID), {
        key: " ",
        repeat: true,
      });
      expect(notPrevented).toBe(false);
      expect(screen.queryByTestId("resale-ask-price")).not.toBeNull();
    });

    it("leaves every other key alone", () => {
      render(<ResellForm orderId={ORDER_ID} />);
      const notPrevented = fireEvent.keyDown(header(ITEM_ID), { key: "Tab" });
      expect(notPrevented).toBe(true);
      expect(screen.queryByTestId("resale-ask-price")).toBeNull();
    });
  });

  describe("a ticket that cannot be listed says why", () => {
    it("labels a scanned ticket as used, and it is not a button", () => {
      state.ticketsQuery = ticketsLoaded([
        ticket(TICKET_ID, ITEM_ID, "SCANNED"),
      ]);
      render(<ResellForm orderId={ORDER_ID} />);
      expect(header(ITEM_ID).textContent).toContain("orderDetail.used");
      expect(header(ITEM_ID).hasAttribute("role")).toBe(false);
      expect(header(ITEM_ID).hasAttribute("aria-pressed")).toBe(false);

      fireEvent.click(header(ITEM_ID));
      expect(screen.queryByTestId("resale-ask-price")).toBeNull();
      const notPrevented = fireEvent.keyDown(header(ITEM_ID), { key: " " });
      expect(notPrevented).toBe(true);
      fireEvent.keyDown(header(ITEM_ID), { key: "Enter" });
      expect(screen.queryByTestId("resale-ask-price")).toBeNull();
    });

    it.each([
      ["INVALID", "orderDetail.invalid"],
      ["REFUNDED", "myTickets.refunded"],
      ["LISTED", "orderDetail.listedForResale"],
    ])("labels a %s ticket with %s", (status, key) => {
      state.ticketsQuery = ticketsLoaded([ticket(TICKET_ID, ITEM_ID, status)]);
      render(<ResellForm orderId={ORDER_ID} />);
      expect(header(ITEM_ID).textContent).toContain(key);
      fireEvent.click(header(ITEM_ID));
      expect(screen.queryByTestId("resale-ask-price")).toBeNull();
    });

    it("keeps a listable ticket pressable beside one that is not", () => {
      state.order = {
        ...PRIMARY_ORDER,
        items: [item(ITEM_ID), item(OTHER_ITEM_ID)],
      };
      state.ticketsQuery = ticketsLoaded([
        ticket(TICKET_ID, ITEM_ID, "SCANNED"),
        ticket(OTHER_TICKET_ID, OTHER_ITEM_ID),
      ]);
      render(<ResellForm orderId={ORDER_ID} />);
      expect(header(OTHER_ITEM_ID).textContent).not.toContain(
        "orderDetail.used",
      );
      fireEvent.click(header(OTHER_ITEM_ID));
      expect(screen.queryByTestId("resale-ask-price")).not.toBeNull();
    });

    it("leaves out an item that has no ticket row", () => {
      state.order = {
        ...PRIMARY_ORDER,
        items: [item(ITEM_ID), item(ITEM_NO_TICKET_ID)],
      };
      render(<ResellForm orderId={ORDER_ID} />);
      expect(queryHeader(ITEM_ID)).not.toBeNull();
      expect(queryHeader(ITEM_NO_TICKET_ID)).toBeNull();
      expect(screen.queryByText("resell.noTicketsAvailable")).toBeNull();
    });

    it("says no tickets are available when no item has a ticket row", () => {
      state.order = { ...PRIMARY_ORDER, items: [item(ITEM_NO_TICKET_ID)] };
      render(<ResellForm orderId={ORDER_ID} />);
      expect(queryHeader(ITEM_NO_TICKET_ID)).toBeNull();
      expect(screen.queryByText("resell.noTicketsAvailable")).not.toBeNull();
    });
  });

  describe("the tickets read itself", () => {
    it("says the tickets could not be loaded, and offers a retry", () => {
      const failure = new Error("boom");
      state.ticketsQuery = {
        data: undefined,
        error: failure,
        isLoading: false,
        isFetching: false,
        refetch: state.refetchTickets,
      };
      render(<ResellForm orderId={ORDER_ID} />);

      const notice = screen.getByTestId("resell-tickets-load-failed");
      expect(notice.textContent).toContain("resaleClaim.loadFailedTitle");
      expect(notice.textContent).toContain("formatted:boom");
      // Always with the translator: without it a coded error reads
      // "Something went wrong".
      expect(state.formatErrorMessage).toHaveBeenCalledWith(
        failure,
        expect.any(Function),
      );
      // Neither a list of tickets nobody can press, nor "you have none".
      expect(queryHeader(ITEM_ID)).toBeNull();
      expect(screen.queryByText("resell.noTicketsAvailable")).toBeNull();

      expect(retryButton().disabled).toBe(false);
      fireEvent.click(retryButton());
      expect(state.refetchTickets).toHaveBeenCalledTimes(1);
    });

    it("lets a failed refresh win over the tickets it already had, and keeps the typed price", () => {
      const { rerender } = render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(header(ITEM_ID));
      fireEvent.change(screen.getByTestId("resale-ask-price"), {
        target: { value: "12.34" },
      });

      // A refetch failed: React Query keeps the last data beside the error.
      // The old list may no longer be true, so the failure is what shows.
      state.ticketsQuery = {
        ...ticketsLoaded([ticket(TICKET_ID, ITEM_ID)]),
        error: new Error("boom"),
      };
      rerender(<ResellForm orderId={ORDER_ID} />);
      expect(screen.queryByTestId("resell-tickets-load-failed")).not.toBeNull();
      expect(queryHeader(ITEM_ID)).toBeNull();
      expect(screen.queryByTestId("resale-ask-price")).toBeNull();

      // While the retry is in flight the button cannot start a second one.
      state.ticketsQuery = { ...state.ticketsQuery, isFetching: true };
      rerender(<ResellForm orderId={ORDER_ID} />);
      expect(retryButton().disabled).toBe(true);
      fireEvent.click(retryButton());
      expect(state.refetchTickets).not.toHaveBeenCalled();

      // The retry lands: the same ticket is still selected, with the price
      // the seller typed before the failure.
      state.ticketsQuery = ticketsLoaded([ticket(TICKET_ID, ITEM_ID)]);
      rerender(<ResellForm orderId={ORDER_ID} />);
      expect(screen.queryByTestId("resell-tickets-load-failed")).toBeNull();
      expect(header(ITEM_ID).getAttribute("aria-pressed")).toBe("true");
      expect(
        (screen.getByTestId("resale-ask-price") as HTMLInputElement).value,
      ).toBe("12.34");
    });

    it("shows a spinner in place of the list while it loads", () => {
      state.ticketsQuery = {
        data: undefined,
        error: null,
        isLoading: true,
        isFetching: true,
        refetch: state.refetchTickets,
      };
      render(<ResellForm orderId={ORDER_ID} />);
      expect(screen.queryByTestId("resell-tickets-loading")).not.toBeNull();
      expect(queryHeader(ITEM_ID)).toBeNull();
      expect(screen.queryByText("resell.noTicketsAvailable")).toBeNull();
      expect(screen.queryByTestId("resell-tickets-load-failed")).toBeNull();
    });
  });

  describe("what frames the list follows what is in it", () => {
    const unpaidSeller = () => {
      state.connectStatus = {
        data: { payoutsEnabled: false },
        dataUpdatedAt: 1,
      };
    };

    it("frames a ticket that can be listed: heading, payout setup", () => {
      unpaidSeller();
      render(<ResellForm orderId={ORDER_ID} />);
      expect(screen.queryByText("resell.selectTicketToResell")).not.toBeNull();
      expect(screen.queryByTestId("resell-payout-setup")).not.toBeNull();
      expect(connectStatusEnabled()).toContain(true);
    });

    it("an order whose only ticket is used: no payout setup, no Stripe read, no heading", () => {
      unpaidSeller();
      state.ticketsQuery = ticketsLoaded([
        ticket(TICKET_ID, ITEM_ID, "SCANNED"),
      ]);
      render(<ResellForm orderId={ORDER_ID} />);
      // The card that says why is still there.
      expect(header(ITEM_ID).textContent).toContain("orderDetail.used");
      expect(screen.queryByTestId("resell-payout-setup")).toBeNull();
      expect(connectStatusEnabled().length).toBeGreaterThan(0);
      expect(connectStatusEnabled()).not.toContain(true);
      expect(screen.queryByText("resell.selectTicketToResell")).toBeNull();
    });

    it("an order whose only item has no ticket row: no payout setup, no Stripe read", () => {
      unpaidSeller();
      state.order = { ...PRIMARY_ORDER, items: [item(ITEM_NO_TICKET_ID)] };
      render(<ResellForm orderId={ORDER_ID} />);
      expect(screen.queryByText("resell.noTicketsAvailable")).not.toBeNull();
      expect(screen.queryByTestId("resell-payout-setup")).toBeNull();
      expect(connectStatusEnabled()).not.toContain(true);
    });

    it("keeps the heading when a used ticket sits beside one that can be listed", () => {
      state.order = {
        ...PRIMARY_ORDER,
        items: [item(ITEM_ID), item(OTHER_ITEM_ID)],
      };
      state.ticketsQuery = ticketsLoaded([
        ticket(TICKET_ID, ITEM_ID, "SCANNED"),
        ticket(OTHER_TICKET_ID, OTHER_ITEM_ID),
      ]);
      render(<ResellForm orderId={ORDER_ID} />);
      expect(screen.queryByText("resell.selectTicketToResell")).not.toBeNull();
    });

    it("reads no Stripe status while tickets load", () => {
      state.ticketsQuery = {
        data: undefined,
        error: new Error("boom"),
        isLoading: false,
        isFetching: false,
        refetch: state.refetchTickets,
      };
      const { rerender } = render(<ResellForm orderId={ORDER_ID} />);
      expect(screen.queryByTestId("resell-tickets-load-failed")).not.toBeNull();

      state.ticketsQuery = {
        data: undefined,
        error: null,
        isLoading: true,
        isFetching: true,
        refetch: state.refetchTickets,
      };
      rerender(<ResellForm orderId={ORDER_ID} />);
      expect(screen.queryByTestId("resell-tickets-loading")).not.toBeNull();
      expect(connectStatusEnabled()).not.toContain(true);
    });
  });

  // Reselling is infinite (owner, 2026-10-11). On an order that was itself a
  // resale purchase every item carries `resaleListingId` for life: it is the
  // listing the ticket was BOUGHT through. On a primary order the same field
  // is a listing the buyer OPENED. The item alone cannot tell the two apart;
  // the ticket's status can.
  describe("a ticket bought on resale", () => {
    const boughtOnResale = (ticketStatus = "VALID") => {
      state.order = {
        ...RESALE_ORDER,
        items: [item(ITEM_ID, { resaleListingId: PURCHASED_LISTING_ID })],
      };
      state.ticketsQuery = ticketsLoaded([
        ticket(TICKET_ID, ITEM_ID, ticketStatus),
      ]);
    };

    it("can be selected and listed again, by its TICKET id", async () => {
      boughtOnResale();
      render(<ResellForm orderId={ORDER_ID} />);
      expect(screen.queryByText("resell.noTicketsAvailable")).toBeNull();
      expect(header(ITEM_ID).getAttribute("role")).toBe("button");
      expect(screen.queryByText("resell.selectTicketToResell")).not.toBeNull();
      // Something to sell, so the seller's payout status is read.
      expect(connectStatusEnabled()).toContain(true);

      fireEvent.click(header(ITEM_ID));
      fireEvent.change(screen.getByTestId("resale-ask-price"), {
        target: { value: "42.00" },
      });
      fireEvent.click(listButton());
      await waitFor(() => expect(state.createListing).toHaveBeenCalledTimes(1));
      const arg = state.createListing.mock.calls[0]![0];
      expect(arg.ticketId).toBe(TICKET_ID);
      expect(arg.askPriceCents).toBe(4200);
    });

    it("is not offered once its buyer has listed it, like a listed primary ticket", () => {
      boughtOnResale("LISTED");
      state.listings = { items: [activeListing()] };
      render(<ResellForm orderId={ORDER_ID} />);
      expect(queryHeader(ITEM_ID)).toBeNull();
      expect(screen.queryByText("resell.noTicketsAvailable")).not.toBeNull();
      expect(screen.queryByText("resell.selectTicketToResell")).toBeNull();
      expect(connectStatusEnabled()).not.toContain(true);
      // Its listing is still there to cancel.
      expect(screen.queryByText("Cancel")).not.toBeNull();
    });

    it("says it is used once scanned, and cannot be pressed", () => {
      boughtOnResale("SCANNED");
      render(<ResellForm orderId={ORDER_ID} />);
      expect(header(ITEM_ID).textContent).toContain("orderDetail.used");
      expect(header(ITEM_ID).hasAttribute("role")).toBe(false);
      fireEvent.click(header(ITEM_ID));
      expect(screen.queryByTestId("resale-ask-price")).toBeNull();
    });

    it("waits for the tickets read instead of saying there are none", () => {
      boughtOnResale();
      state.ticketsQuery = {
        data: undefined,
        error: null,
        isLoading: true,
        isFetching: true,
        refetch: state.refetchTickets,
      };
      render(<ResellForm orderId={ORDER_ID} />);
      expect(screen.queryByTestId("resell-tickets-loading")).not.toBeNull();
      expect(screen.queryByText("resell.noTicketsAvailable")).toBeNull();
      expect(connectStatusEnabled()).not.toContain(true);
    });

    it("is not offered when the resale purchase itself was refunded", () => {
      // The whole-order refund leaves the item `active`, and the server
      // refuses to list such a ticket (`purchase_refunded`).
      boughtOnResale();
      state.order = { ...state.order, status: "REFUNDED" };
      render(<ResellForm orderId={ORDER_ID} />);
      expect(queryHeader(ITEM_ID)).toBeNull();
      expect(screen.queryByText("resell.noTicketsAvailable")).not.toBeNull();
      expect(connectStatusEnabled()).not.toContain(true);
    });

    it("is still left out when refunded or transferred away", () => {
      state.order = {
        ...RESALE_ORDER,
        items: [
          item(ITEM_ID, {
            resaleListingId: PURCHASED_LISTING_ID,
            status: "refunded",
            refundedAt: "2026-09-02T00:00:00.000Z",
          }),
          item(OTHER_ITEM_ID, {
            resaleListingId: PURCHASED_LISTING_ID,
            status: "transferred",
            transferredAt: "2026-09-02T00:00:00.000Z",
          }),
        ],
      };
      state.ticketsQuery = ticketsLoaded([
        ticket(TICKET_ID, ITEM_ID, "REFUNDED"),
        ticket(OTHER_TICKET_ID, OTHER_ITEM_ID),
      ]);
      render(<ResellForm orderId={ORDER_ID} />);
      expect(queryHeader(ITEM_ID)).toBeNull();
      expect(queryHeader(OTHER_ITEM_ID)).toBeNull();
      expect(screen.queryByText("resell.noTicketsAvailable")).not.toBeNull();
    });
  });

  describe("a primary ticket its buyer has listed", () => {
    it("stays out of the list, beside one that can still be listed", () => {
      state.order = {
        ...PRIMARY_ORDER,
        items: [
          item(ITEM_ID, { resaleListingId: LISTING_ID }),
          item(OTHER_ITEM_ID),
        ],
      };
      state.ticketsQuery = ticketsLoaded([
        ticket(TICKET_ID, ITEM_ID, "LISTED"),
        ticket(OTHER_TICKET_ID, OTHER_ITEM_ID),
      ]);
      state.listings = { items: [activeListing()] };
      render(<ResellForm orderId={ORDER_ID} />);
      expect(queryHeader(ITEM_ID)).toBeNull();
      expect(header(OTHER_ITEM_ID).getAttribute("role")).toBe("button");
    });

    it("is left out without waiting for the tickets read", () => {
      // The item's own listing id decides on a primary order: no spinner
      // first, no failure card, and nothing priced for it.
      state.order = {
        ...PRIMARY_ORDER,
        items: [item(ITEM_ID, { resaleListingId: LISTING_ID })],
      };
      state.ticketsQuery = {
        data: undefined,
        error: null,
        isLoading: true,
        isFetching: true,
        refetch: state.refetchTickets,
      };
      const { rerender } = render(<ResellForm orderId={ORDER_ID} />);
      expect(screen.queryByText("resell.noTicketsAvailable")).not.toBeNull();
      expect(screen.queryByTestId("resell-tickets-loading")).toBeNull();

      state.ticketsQuery = { ...state.ticketsQuery, error: new Error("boom") };
      rerender(<ResellForm orderId={ORDER_ID} />);
      expect(screen.queryByText("resell.noTicketsAvailable")).not.toBeNull();
      expect(screen.queryByTestId("resell-tickets-load-failed")).toBeNull();
    });

    it("says no tickets are available when it is the only one", () => {
      state.order = {
        ...PRIMARY_ORDER,
        items: [item(ITEM_ID, { resaleListingId: LISTING_ID })],
      };
      state.ticketsQuery = ticketsLoaded([
        ticket(TICKET_ID, ITEM_ID, "LISTED"),
      ]);
      render(<ResellForm orderId={ORDER_ID} />);
      expect(queryHeader(ITEM_ID)).toBeNull();
      expect(screen.queryByText("resell.noTicketsAvailable")).not.toBeNull();
    });
  });

  it("does not offer an item that was transferred away", () => {
    // The shape `orderItems.updateStatus` writes: the status and its
    // timestamp always move together.
    state.order = {
      ...PRIMARY_ORDER,
      items: [
        item(ITEM_ID, {
          status: "transferred",
          transferredAt: "2026-09-02T00:00:00.000Z",
        }),
      ],
    };
    render(<ResellForm orderId={ORDER_ID} />);
    expect(queryHeader(ITEM_ID)).toBeNull();
    expect(screen.queryByText("resell.noTicketsAvailable")).not.toBeNull();
  });

  it("keeps the form open while the seller types", () => {
    render(<ResellForm orderId={ORDER_ID} />);
    fireEvent.click(header(ITEM_ID));
    const input = screen.getByTestId("resale-ask-price");
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: "12" } });
    expect(screen.queryByTestId("resale-ask-price")).not.toBeNull();
  });

  describe("the price field", () => {
    it("is named by its visible caption", () => {
      render(<ResellForm orderId={ORDER_ID} />);
      // No ticket selected, no form: nothing on the page is a text field.
      expect(screen.queryAllByRole("textbox")).toHaveLength(0);
      fireEvent.click(header(ITEM_ID));
      const named = screen.getAllByRole("textbox", { name: /price/i });
      expect(named).toHaveLength(1);
      expect(named[0]).toBe(screen.getByTestId("resale-ask-price"));
      // The name is the caption's own text, not a second copy of it.
      expect(named[0]!.getAttribute("aria-labelledby")).toBe(
        screen.getByText("resell.priceInputLabel").id,
      );
      expect(named[0]!.getAttribute("name")).toBe("askPrice");
    });

    it("asks a phone for the keypad with a decimal point", () => {
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(header(ITEM_ID));
      expect(
        screen.getByTestId("resale-ask-price").getAttribute("inputmode"),
      ).toBe("decimal");
    });

    it("Enter lists the ticket once, however often it is pressed while the listing is in flight", async () => {
      // A create that never settles: the listing stays in flight.
      state.createListing.mockReturnValue(new Promise(() => {}));
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(header(ITEM_ID));
      const input = screen.getByTestId("resale-ask-price");
      fireEvent.change(input, { target: { value: "42.00" } });

      fireEvent.keyDown(input, { key: "Enter" });
      expect(state.createListing).toHaveBeenCalledTimes(1);
      // The button shows the same in-flight state the Enter path now obeys.
      await waitFor(() =>
        expect(screen.queryByText("resell.listingInProgress")).not.toBeNull(),
      );

      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });
      // The mock records a create the moment it is asked for, so a second
      // one would already be counted here.
      expect(state.createListing).toHaveBeenCalledTimes(1);
      expect(state.createListing.mock.calls[0]![0].ticketId).toBe(TICKET_ID);
    });
  });

  describe("a listing just made", () => {
    const NEW_LISTING_ID = "99999999-9999-4999-8999-999999999999";

    const listTicket = () => {
      fireEvent.click(header(ITEM_ID));
      fireEvent.change(screen.getByTestId("resale-ask-price"), {
        target: { value: "42.00" },
      });
      fireEvent.click(listButton());
    };

    afterEach(() => setNavbarVisibleHeight(0));

    it("is brought into view below the navbar, with focus, once the listings carry it", async () => {
      setNavbarVisibleHeight(68);
      state.createListing.mockResolvedValue({ listingId: NEW_LISTING_ID });
      const { rerender } = render(<ResellForm orderId={ORDER_ID} />);
      listTicket();
      await waitFor(() =>
        expect(screen.queryByTestId("resale-ask-price")).toBeNull(),
      );
      // The listings read has not come back with it yet: nothing to show.
      expect(state.scrollIntoView).not.toHaveBeenCalled();

      state.listings = {
        items: [{ ...activeListing(), id: NEW_LISTING_ID }],
      };
      rerender(<ResellForm orderId={ORDER_ID} />);

      const heading = screen.getByText("resell.activeListings");
      const block = screen.getByRole("region");
      await waitFor(() => expect(state.scrollIntoView).toHaveBeenCalledTimes(1));
      expect(state.scrollIntoView.mock.instances[0]).toBe(block);
      expect(state.scrollIntoView.mock.calls[0]![0]).toMatchObject({
        block: "start",
      });
      // Clear of the 68px navbar, with room to spare.
      expect(block.style.scrollMarginTop).toBe("84px");
      expect(document.activeElement).toBe(block);
      // The region is named by its visible heading.
      expect(block.getAttribute("aria-labelledby")).toBe(heading.id);

      // Only once: a later refresh that changes the list (another listing
      // arrives) leaves the page where it is.
      state.listings = {
        items: [
          { ...activeListing(), id: NEW_LISTING_ID },
          { ...activeListing(), id: LISTING_ID },
        ],
      };
      rerender(<ResellForm orderId={ORDER_ID} />);
      expect(screen.getAllByText("Cancel")).toHaveLength(2);
      expect(state.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it("leaves a seller who has moved on where they are", async () => {
      state.createListing.mockResolvedValue({ listingId: NEW_LISTING_ID });
      const { rerender } = render(<ResellForm orderId={ORDER_ID} />);
      listTicket();
      await waitFor(() =>
        expect(screen.queryByTestId("resale-ask-price")).toBeNull(),
      );
      // Before the listings come back, the seller focuses another control.
      const backLink = screen.getByText("resell.backToOrder").closest("a")!;
      backLink.focus();
      expect(document.activeElement).toBe(backLink);

      state.listings = {
        items: [{ ...activeListing(), id: NEW_LISTING_ID }],
      };
      rerender(<ResellForm orderId={ORDER_ID} />);
      expect(screen.getByRole("region")).not.toBeNull();
      expect(state.scrollIntoView).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(backLink);

      // Nor later: the pending scroll was dropped, not deferred.
      backLink.blur();
      state.listings = {
        items: [
          { ...activeListing(), id: NEW_LISTING_ID },
          { ...activeListing(), id: LISTING_ID },
        ],
      };
      rerender(<ResellForm orderId={ORDER_ID} />);
      expect(state.scrollIntoView).not.toHaveBeenCalled();
    });

    it("jumps instead of gliding when the seller asks for reduced motion", async () => {
      const original = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia;
      try {
        state.createListing.mockResolvedValue({ listingId: NEW_LISTING_ID });
        const { rerender } = render(<ResellForm orderId={ORDER_ID} />);
        listTicket();
        await waitFor(() =>
          expect(screen.queryByTestId("resale-ask-price")).toBeNull(),
        );
        state.listings = {
          items: [{ ...activeListing(), id: NEW_LISTING_ID }],
        };
        rerender(<ResellForm orderId={ORDER_ID} />);
        await waitFor(() =>
          expect(state.scrollIntoView).toHaveBeenCalledWith(
            expect.objectContaining({ behavior: "auto" }),
          ),
        );
      } finally {
        window.matchMedia = original;
      }
    });

    it("gives its Cancel button the touch minimum height", () => {
      state.listings = { items: [activeListing()] };
      render(<ResellForm orderId={ORDER_ID} />);
      expect(
        screen.getByText("Cancel").getAttribute("data-touch-min-height"),
      ).toBe("44");
    });
  });

  describe("a refusal", () => {
    it("goes to the shared copy", async () => {
      const refusal = new Error("TICKET_NOT_FOUND");
      state.createListing.mockRejectedValue(refusal);
      state.appErrorCode.mockReturnValue("TICKET_NOT_FOUND");
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(header(ITEM_ID));
      fireEvent.change(screen.getByTestId("resale-ask-price"), {
        target: { value: "42.00" },
      });
      fireEvent.click(listButton());
      await waitFor(() =>
        expect(state.setFormError).toHaveBeenCalledWith(refusal),
      );
    });
  });

  describe("the split the server prices", () => {
    it("opens at what the seller paid", () => {
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(header(ITEM_ID));
      expect(
        (screen.getByTestId("resale-ask-price") as HTMLInputElement).value,
      ).toBe("35.00");
    });

    it("shows the share, what the seller receives and what the buyer pays, from the server's numbers", async () => {
      state.split = splitFor(4200);
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(header(ITEM_ID));
      fireEvent.change(screen.getByTestId("resale-ask-price"), {
        target: { value: "42.00" },
      });
      const card = await screen.findByTestId("resell-split");
      expect(card.textContent).toContain("resell.shareLineLabel");
      expect(card.textContent).toContain("resell.youReceive");
      expect(card.textContent).toContain("resell.buyerPaysSeller");
      expect(card.textContent).toContain("resell.noPlatformCut");
    });

    it("says how much less than the seller paid they get back", async () => {
      state.split = splitFor(3500);
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(header(ITEM_ID));
      fireEvent.change(screen.getByTestId("resale-ask-price"), {
        target: { value: "35.00" },
      });
      expect((await screen.findByTestId("resell-split")).textContent).toContain(
        "resell.lessThanPaid",
      );
    });

    it("BUYER pays: the share adds to the buyer's price and the seller receives the ask", async () => {
      state.split = splitFor(5000, {
        payer: "BUYER",
        basisCents: 5500,
        shareCents: 500,
        sellerReceivesCents: 5000,
      });
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(header(ITEM_ID));
      fireEvent.change(screen.getByTestId("resale-ask-price"), {
        target: { value: "50.00" },
      });
      const card = await screen.findByTestId("resell-split");
      expect(card.textContent).toContain("+$500");
      expect(card.textContent).toContain("resell.shareNoteBuyer");
      expect(card.textContent).toContain("resell.buyerPaysBuyer");
      expect(card.textContent).toMatch(/resell\.youReceive\$5000/);
    });

    it("drops the previous answer while the new ask is pending, and List waits for it", async () => {
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(header(ITEM_ID));
      const input = screen.getByTestId("resale-ask-price");
      fireEvent.change(input, { target: { value: "42.00" } });
      await screen.findByTestId("resell-split");
      expect(
        listButton().closest("button")?.disabled,
      ).toBe(false);

      // The field moves on; the debounced value has not caught up.
      state.holdDebounced = "42.00";
      fireEvent.change(input, { target: { value: "50.00" } });
      expect(screen.queryByTestId("resell-split")).toBeNull();
      expect(screen.queryByTestId("resell-split-pending")).not.toBeNull();
      expect(listButton().textContent).toBe("resell.listForSale");
      expect(listButton().closest("button")?.disabled).toBe(true);
      fireEvent.click(listButton());
      expect(state.createListing).not.toHaveBeenCalled();

      // The debounce settles and the answer for $50.00 arrives.
      state.holdDebounced = null;
      fireEvent.change(input, { target: { value: "50.00" } });
      fireEvent.change(input, { target: { value: "50.01" } });
      await screen.findByTestId("resell-split");
      expect(listButton().closest("button")?.disabled).toBe(false);
    });

    it("over the limit: names the highest ask that fits, offers it, and will not list", async () => {
      // BUYER pays: ask + share (10%) must fit the $44.00 cap, so $40.00 does.
      state.split = splitFor(6000, {
        payer: "BUYER",
        basisCents: 6600,
        sellerReceivesCents: 6000,
        withinCap: false,
        capCents: 4400,
        highestFittingAskCents: 4000,
      });
      render(<ResellForm orderId={ORDER_ID} />);
      fireEvent.click(header(ITEM_ID));
      fireEvent.change(screen.getByTestId("resale-ask-price"), {
        target: { value: "60.00" },
      });
      expect((await screen.findByTestId("resell-split")).textContent).toContain(
        "resell.overLimit",
      );
      expect(listButton().closest("button")?.disabled).toBe(true);
      fireEvent.click(listButton());
      expect(state.createListing).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText(/^resell\.useHighestAsk/));
      expect(
        (screen.getByTestId("resale-ask-price") as HTMLInputElement).value,
      ).toBe("40.00");
    });
  });
});
