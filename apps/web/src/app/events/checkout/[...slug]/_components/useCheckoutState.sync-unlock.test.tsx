import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Before a gated checkout's own API calls, the hook syncs the viewer's signed
 * gate cookie into a durable unlock via `/api/events/[eventId]/sync-unlock`.
 * It must tell the route the event's gate type, so the route converts only
 * the cookie that belongs to that gate (a stale `th_eu_` on an APPLICATION
 * event must never be tried). Harness copied from
 * `useCheckoutState.pwyw.test.tsx` (resumed hold → Continue).
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
        getActiveCartHolds: {
          useQuery: () => ({ data: { carts: cartHolds.carts } }),
        },
        createCheckout: mutation(createCheckoutMutateAsync),
        updateOrderItems: mutation(),
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

describe("useCheckoutState — signed-unlock sync", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    createCheckoutMutateAsync.mockReset();
    createCheckoutMutateAsync.mockResolvedValue({
      orderId: ORDER_ID,
      clientSecret: "pi_secret",
      amountGrossCents: 10_000,
      feesPlatformCents: 0,
      buyerFeesCents: 0,
      processorFeeCents: 0,
      taxAmountCents: 0,
      creditAppliedCents: 0,
      feeMode: "ABSORB",
      holdExpiresAt: null,
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ persisted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    cartHolds.carts = [heldCart(5000)];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["APPLICATION", "PASSWORD"] as const)(
    "sends the %s gate type to sync-unlock before checkout",
    async (gateType) => {
      const { result } = renderHook(() =>
        useCheckoutState({
          ...checkoutStateArgs(ORDER_ID),
          shouldSyncSignedUnlock: true,
          signedUnlockGateType: gateType,
        }),
      );
      await waitFor(() => expect(result.current.phase).toBe("held"));

      await act(async () => {
        await result.current.handleCheckout();
      });

      expect(fetchMock).toHaveBeenCalledWith(
        `/api/events/${EVENT_ID}/sync-unlock`,
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          body: JSON.stringify({ gateType }),
        }),
      );
      expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(1);
    },
  );

  it("does not call sync-unlock when there is nothing to sync", async () => {
    const { result } = renderHook(() =>
      useCheckoutState({
        ...checkoutStateArgs(ORDER_ID),
        signedUnlockGateType: "APPLICATION",
      }),
    );
    await waitFor(() => expect(result.current.phase).toBe("held"));

    await act(async () => {
      await result.current.handleCheckout();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
