import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A seat refusal refetches the seat map.
 *
 * `listEventSeatAvailability` is cached for 15 s. When the server refuses a
 * picked seat (taken, no longer available, or its price changed under the
 * lock), the map on screen is the stale one the buyer picked from; without a
 * refetch they pick the same seat again and are refused again.
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const RES_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const SEAT_ID = "44444444-4444-4444-8444-444444444444";

const { createCheckoutMutateAsync, seatRefetch, holdOptions, cartHolds } =
  vi.hoisted(() => ({
    createCheckoutMutateAsync: vi.fn(),
    seatRefetch: vi.fn(async () => ({})),
    holdOptions: {
      current: null as null | { onError?: (error: unknown) => void },
    },
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
    useMutation: () => ({ mutate: vi.fn(), mutateAsync, isPending: false }),
  });
  return {
    trpc: {
      events: {
        listEventSeatAvailability: {
          useQuery: () => ({
            data: undefined,
            isLoading: false,
            isError: false,
            refetch: seatRefetch,
          }),
        },
        getCheckoutFeeRates: query(),
        estimateCheckoutTax: query(),
      },
      humans: { getMyProfile: query(), updateProfile: mutation() },
      orders: {
        getActiveCartHolds: {
          useQuery: () => ({ data: { carts: cartHolds.carts } }),
        },
        createCheckout: mutation(createCheckoutMutateAsync),
        // Captures the hook's handlers so a test can play a hold refusal.
        updateOrderItems: {
          useMutation: (options: typeof holdOptions.current) => {
            holdOptions.current = options;
            return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
          },
        },
        releaseCartHold: mutation(),
        confirmPayment: mutation(),
      },
    },
  };
});

import { useCheckoutState, type TicketTypeSummary } from "./useCheckoutState";

const reserved = (seatSectionId: string | null): TicketTypeSummary => ({
  id: RES_ID,
  name: "Reserved",
  priceCents: 3000,
  capacity: 100,
  remainingCapacity: 100,
  seatSectionId,
  layoutSectionId: null,
  pricingMode: "FIXED",
  minimumCents: null,
  suggestedCents: null,
});

const heldCart = {
  id: ORDER_ID,
  eventId: EVENT_ID,
  amountGrossCents: 3000,
  preDiscountGrossCents: 3000,
  promoCodes: [] as string[],
  feesPlatformCents: 100,
  feeMode: "PASS_THROUGH" as const,
  buyerFeesCents: 100,
  currency: "usd",
  holdExpiresAt: new Date(Date.now() + 10 * 60_000),
  ticketSummary: [
    {
      ticketTypeId: RES_ID,
      ticketTypeName: "Reserved",
      qty: 1,
      unitPriceCents: 3000,
      seatIds: [SEAT_ID],
    },
  ],
};

const render = (seatSectionId: string | null = "section-1") =>
  renderHook(() =>
    useCheckoutState({
      event: { id: EVENT_ID, slug: "gallery-walk" },
      ticketTypes: [reserved(seatSectionId)],
      resumeOrderId: ORDER_ID,
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
    }),
  );

const attempt = async (result: {
  current: ReturnType<typeof useCheckoutState>;
}) => {
  await act(async () => {
    await result.current.handleCheckout().catch(() => undefined);
  });
};

const SEAT_REFUSALS = ["seat_taken", "seat_unavailable", "seat_price_changed"];

describe("useCheckoutState — a seat refusal refetches the seat map", () => {
  beforeEach(() => {
    createCheckoutMutateAsync.mockReset();
    seatRefetch.mockClear();
    holdOptions.current = null;
    cartHolds.carts = [heldCart];
  });

  it.each(SEAT_REFUSALS)(
    "createCheckout refused with %s → the map is fetched again",
    async (code) => {
      createCheckoutMutateAsync.mockRejectedValueOnce(new Error(code));
      const { result } = render();
      await waitFor(() => expect(result.current.phase).toBe("held"));

      await attempt(result);

      expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(1);
      expect(seatRefetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(SEAT_REFUSALS)(
    "the cart hold refused with %s → the map is fetched again",
    async (code) => {
      const { result } = render();
      await waitFor(() => expect(result.current.phase).toBe("held"));

      act(() => holdOptions.current!.onError!(new Error(code)));

      expect(seatRefetch).toHaveBeenCalledTimes(1);
    },
  );

  it("createCheckout refused with an uppercase SEAT_TAKEN (mint path) → the map is fetched again", async () => {
    createCheckoutMutateAsync.mockRejectedValueOnce(new Error("SEAT_TAKEN"));
    const { result } = render();
    await waitFor(() => expect(result.current.phase).toBe("held"));

    await attempt(result);

    expect(seatRefetch).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: a refusal that is not about a seat leaves the map alone", async () => {
    createCheckoutMutateAsync.mockRejectedValueOnce(
      new Error("INSUFFICIENT_CAPACITY"),
    );
    const { result } = render();
    await waitFor(() => expect(result.current.phase).toBe("held"));

    await attempt(result);

    expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(1);
    expect(seatRefetch).not.toHaveBeenCalled();
  });

  it("CONTROL: an event with no seat map never fetches one", async () => {
    const { result } = render(null);
    await waitFor(() => expect(result.current.phase).toBe("held"));

    act(() => holdOptions.current!.onError!(new Error("seat_taken")));

    expect(seatRefetch).not.toHaveBeenCalled();
  });
});
