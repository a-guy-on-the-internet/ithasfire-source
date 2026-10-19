import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A reload of the confirmed URL (`?step=confirmed&order=`) starts the page ON
 * the confirmation for that order (its loading state, never the picker), and
 * `Checkout` then settles it with `handleRestoreVerdict`: "confirm" keeps it
 * and closes buying, as an in-session confirm does; "fallback" drops to the
 * EMPTY picker with no order. Harness copied from
 * `useCheckoutState.sync-unlock.test.tsx`.
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const PWYW_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";

const {
  createCheckoutMutateAsync,
  releaseMutate,
  confirmPaymentOptions,
  taxQueryInputs,
  cartHolds,
  updateOrderMutate,
} = vi.hoisted(() => ({
    createCheckoutMutateAsync: vi.fn(),
    releaseMutate: vi.fn(),
    confirmPaymentOptions: {
      current: null as null | {
        onSuccess?: (data: { orderId: string; outcome: "confirmed" | "processing" }) => void;
        onError?: (error: unknown) => void;
      },
    },
    taxQueryInputs: [] as unknown[],
    cartHolds: { carts: [] as unknown[] },
    updateOrderMutate: vi.fn(),
  }));

// `orders.getMyOrder` for the restore: an error, or the order, per test.
const myOrderServer = vi.hoisted(() => ({
  error: null as unknown,
  data: undefined as unknown,
}));
// The URL the page loaded with (useCheckoutUrlSync reads and merges it).
const urlState = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/events/checkout/gallery-walk",
  useSearchParams: () => new URLSearchParams(urlState.search),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/hooks/useCartRecovery", () => ({ useCartRelease: () => {} }));
vi.mock("@/lib/attribution", () => ({ getAttribution: () => ({}) }));

vi.mock("@/trpc", () => {
  const query = (data: unknown = undefined) => ({
    useQuery: () => ({ data, isLoading: false, isError: false }),
  });
  const mutation = (mutateAsync = vi.fn()) => ({
    useMutation: () => ({
      mutate: vi.fn(),
      mutateAsync,
      isPending: false,
    }),
  });
  return {
    trpc: {
      events: {
        listEventSeatAvailability: query(),
        getCheckoutFeeRates: query(),
        estimateCheckoutTax: {
          useQuery: (input: unknown) => {
            taxQueryInputs.push(input);
            return { data: undefined };
          },
        },
      },
      humans: {
        getMyProfile: query(),
        updateProfile: mutation(),
      },
      orders: {
        getMyOrder: {
          useQuery: (_input: unknown, options: { enabled?: boolean }) => {
            const failed = Boolean(options.enabled && myOrderServer.error);
            return {
              data: options.enabled && !failed ? myOrderServer.data : undefined,
              error: failed ? myOrderServer.error : null,
              isError: failed,
              isFetching: false,
              refetch: vi.fn(),
            };
          },
        },
        getActiveCartHolds: {
          useQuery: () => ({ data: { carts: cartHolds.carts } }),
        },
        createCheckout: mutation(createCheckoutMutateAsync),
        updateOrderItems: {
          useMutation: () => ({
            mutate: updateOrderMutate,
            mutateAsync: vi.fn(),
            isPending: false,
          }),
        },
        releaseCartHold: {
          useMutation: () => ({
            mutate: releaseMutate,
            mutateAsync: vi.fn(),
            isPending: false,
          }),
        },
        // Captures the hook's handlers so a test can play the server's answer.
        confirmPayment: {
          useMutation: (options: typeof confirmPaymentOptions.current) => {
            confirmPaymentOptions.current = options;
            return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
          },
        },
      },
    },
  };
});

import { useCheckoutState, type TicketTypeSummary } from "./useCheckoutState";
import { useConfirmedOrder } from "./useConfirmedOrder";
import { useApplyRestoreVerdict } from "./useApplyRestoreVerdict";
import { useCheckoutUrlSync } from "./useCheckoutUrlSync";

const PWYW: TicketTypeSummary = {
  id: PWYW_ID,
  name: "Pay What You Want",
  priceCents: 0,
  capacity: 100,
  remainingCapacity: 100,
  seatSectionId: null,
  layoutSectionId: null,
  pricingMode: "ADJUSTABLE",
  minimumCents: 0,
  suggestedCents: 1500,
};

const heldCart = (unitPriceCents: number) => ({
  id: ORDER_ID,
  eventId: EVENT_ID,
  amountGrossCents: unitPriceCents * 2,
  preDiscountGrossCents: unitPriceCents * 2,
  promoCodes: [] as string[],
  feesPlatformCents: unitPriceCents > 0 ? 100 : 0,
  feeMode: "PASS_THROUGH" as const,
  buyerFeesCents: unitPriceCents > 0 ? 100 : 0,
  currency: "usd",
  holdExpiresAt: new Date(Date.now() + 10 * 60_000),
  ticketSummary: [
    {
      ticketTypeId: PWYW_ID,
      ticketTypeName: "Pay What You Want",
      qty: 2,
      unitPriceCents,
      seatIds: [],
    },
  ],
});

const checkoutStateArgs = (
  resumeOrderId: string | undefined,
): Parameters<typeof useCheckoutState>[0] => ({
  event: { id: EVENT_ID, slug: "gallery-walk" },
  ticketTypes: [PWYW],
  resumeOrderId,
  isSignedIn: true,
  isEmailVerified: true,
  buyerEmail: "buyer@example.com",
  contactFormRef: {
    current: {
      getBillingAddress: () => ({
        line1: "1 Main St",
        city: "New York",
        state: "NY",
        postalCode: "10001",
        country: "US",
      }),
      getPhone: () => null,
    },
  } as never,
  onSignInRequired: () => {},
  currentUrl: "/events/checkout/gallery-walk",
  termsAccepted: true,
  refundPolicyAccepted: true,
});

describe("useCheckoutState — a confirmation restored from the URL", () => {
  const restoredArgs = () => ({
    ...checkoutStateArgs(undefined),
    restoredOrderId: ORDER_ID,
  });

  it("starts confirmed on the restored order, with an empty cart", () => {
    const { result } = renderHook(() => useCheckoutState(restoredArgs()));
    expect(result.current.phase).toBe("confirmed");
    expect(result.current.orderId).toBe(ORDER_ID);
    expect(result.current.order).toBeNull();
    expect(result.current.selectedQty).toBe(0);
  });

  it("a fallback verdict drops to the empty picker with no order", () => {
    const { result } = renderHook(() => useCheckoutState(restoredArgs()));
    act(() => result.current.handleRestoreVerdict("fallback"));
    expect(result.current.phase).toBe("selecting");
    expect(result.current.orderId).toBeNull();
    expect(result.current.selectedQty).toBe(0);
    expect(result.current.errorMessage).toBeNull();
  });

  it("after a fallback, buying is open as on any fresh load", async () => {
    const { result } = renderHook(() => useCheckoutState(restoredArgs()));
    act(() => result.current.handleRestoreVerdict("fallback"));
    act(() => result.current.handleQuantityChange(PWYW_ID, 1));
    await act(async () => {
      await result.current.handleHoldTickets();
    });
    expect(updateOrderMutate).toHaveBeenCalledTimes(1);
  });

  it("a confirm verdict keeps the confirmation and closes buying", async () => {
    updateOrderMutate.mockClear();
    const { result } = renderHook(() => useCheckoutState(restoredArgs()));
    act(() => result.current.handleRestoreVerdict("confirm"));
    expect(result.current.phase).toBe("confirmed");
    expect(result.current.orderId).toBe(ORDER_ID);
    await act(async () => {
      await result.current.handleHoldTickets();
    });
    expect(updateOrderMutate).not.toHaveBeenCalled();
  });

  it("without a restored order the page starts on the picker", () => {
    const { result } = renderHook(() =>
      useCheckoutState(checkoutStateArgs(undefined)),
    );
    expect(result.current.phase).toBe("selecting");
    expect(result.current.orderId).toBeNull();
  });
});

describe("a restored confirmation, end to end: state → verdict → URL", () => {
  const CONFIRMED_URL = `step=confirmed&order=${ORDER_ID}`;

  // The page's wiring, minus rendering: what `Checkout` composes.
  function useRestoredPage() {
    const state = useCheckoutState({
      ...checkoutStateArgs(undefined),
      restoredOrderId: ORDER_ID,
    });
    const confirmed = useConfirmedOrder({
      isConfirmed: state.phase === "confirmed" || state.phase === "done",
      orderId: state.orderId,
      pageOrder: null,
      restore:
        state.orderId === ORDER_ID
          ? { eventId: EVENT_ID, session: "signed-in" }
          : null,
    });
    useApplyRestoreVerdict(confirmed.restoreVerdict, state.handleRestoreVerdict);
    useCheckoutUrlSync({
      phase: state.phase,
      quantities: state.quantities,
      promoCodes: state.promoCodes,
      orderId: state.orderId,
      validTicketTypeIds: [PWYW_ID],
      onSeedQuantity: (id, qty) => state.handleQuantityChange(id, qty),
    });
    return { state, confirmed };
  }

  afterEach(() => {
    myOrderServer.error = null;
    myOrderServer.data = undefined;
    urlState.search = "";
    vi.useRealTimers();
  });

  const lastUrl = (spy: { mock: { calls: unknown[][] } }) =>
    new URL(String(spy.mock.calls.at(-1)?.[2] ?? "/"), "https://x.test")
      .searchParams;

  it("a TRANSIENT error (500) keeps the page confirmed and the URL as it was", () => {
    vi.useFakeTimers();
    // A stale `t=` rides along: still not seeded.
    urlState.search = `${CONFIRMED_URL}&t=${PWYW_ID}%3A2`;
    myOrderServer.error = {
      message: "Invalid `prisma.event.findUnique()` invocation",
      data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
    };
    const spy = vi
      .spyOn(window.history, "replaceState")
      .mockImplementation(() => {});
    const { result } = renderHook(() => useRestoredPage());
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.confirmed.restoreVerdict).toBe("unavailable");
    expect(result.current.confirmed.status).toBe("restore-unavailable");
    expect(result.current.state.phase).toBe("confirmed");
    expect(result.current.state.orderId).toBe(ORDER_ID);
    expect(result.current.state.selectedQty).toBe(0);
    const params = lastUrl(spy);
    expect(params.get("step")).toBe("confirmed");
    expect(params.get("order")).toBe(ORDER_ID);
    expect(params.has("t")).toBe(false);
    spy.mockRestore();
  });

  it("a DEFINITIVE error (ORDER_NOT_FOUND) drops to the picker and strips the URL", () => {
    vi.useFakeTimers();
    urlState.search = CONFIRMED_URL;
    myOrderServer.error = {
      message: "ORDER_NOT_FOUND",
      data: { code: "NOT_FOUND", appCode: "ORDER_NOT_FOUND" },
    };
    const spy = vi
      .spyOn(window.history, "replaceState")
      .mockImplementation(() => {});
    const { result } = renderHook(() => useRestoredPage());
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.state.phase).toBe("selecting");
    expect(result.current.state.orderId).toBeNull();
    const params = lastUrl(spy);
    expect(params.get("step")).toBe("selecting");
    expect(params.has("order")).toBe(false);
    spy.mockRestore();
  });
});
