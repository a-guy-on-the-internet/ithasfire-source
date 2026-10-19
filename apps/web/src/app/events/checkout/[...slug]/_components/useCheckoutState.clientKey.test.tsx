import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The createCheckout idempotency key after a FAILED attempt.
 *
 * A failure with no server app code (lost response, dropped connection) may
 * have committed an order, so the key is kept and the retry replays it; so is
 * IDEMPOTENCY_LOCK_IN_PROGRESS (the first attempt is still running). Any other
 * server refusal already released the key, and the next attempt gets a fresh
 * one. See apps/web/src/lib/checkout-client-key.ts.
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
      onError?: (error: unknown, variables: unknown) => void;
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

const renderResumed = (resumeOrderId: string | undefined = ORDER_ID) =>
  renderHook(() => useCheckoutState(checkoutStateArgs(resumeOrderId)));

const SUCCESS = {
  orderId: ORDER_ID,
  clientSecret: "pi_secret",
  amountGrossCents: 10_000,
  feesPlatformCents: 0,
  buyerFeesCents: 0,
  processorFeeCents: 0,
  taxAmountCents: 0,
  creditAppliedCents: 0,
  feeMode: "PASS_THROUGH",
  holdExpiresAt: null,
};

const trpcError = (appCode: string) =>
  Object.assign(new Error(appCode), { data: { appCode } });

const clientKeyOfCall = (n: number) =>
  (createCheckoutMutateAsync.mock.calls[n]![0] as { clientKey: string })
    .clientKey;

const attempt = async (result: {
  current: ReturnType<typeof useCheckoutState>;
}) => {
  await act(async () => {
    await result.current.handleCheckout().catch(() => undefined);
  });
};

describe("useCheckoutState — the createCheckout key after a failed attempt", () => {
  beforeEach(() => {
    createCheckoutMutateAsync.mockReset();
    cartHolds.carts = [heldCart(5000)];
  });

  it.each([
    ["a lost order link", trpcError("ORDER_NOT_PENDING")],
    ["a sold-out refusal", trpcError("INSUFFICIENT_CAPACITY")],
  ])(
    "rotates the key after %s, which the server already released",
    async (_label, error) => {
      createCheckoutMutateAsync
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(SUCCESS);
      const { result } = renderResumed();
      await waitFor(() => expect(result.current.phase).toBe("held"));

      await attempt(result);
      await attempt(result);

      expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(2);
      expect(clientKeyOfCall(1)).not.toBe(clientKeyOfCall(0));
    },
  );

  it.each([
    ["the first attempt still holds the lock", trpcError("IDEMPOTENCY_LOCK_IN_PROGRESS")],
    // The response was lost: the server may have committed an order holding
    // the seats and credit, and only the same key replays it.
    ["a lost response", new TypeError("Failed to fetch")],
  ])("keeps the key when %s", async (_label, error) => {
    createCheckoutMutateAsync
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(SUCCESS);
    const { result } = renderResumed();
    await waitFor(() => expect(result.current.phase).toBe("held"));

    await attempt(result);
    await attempt(result);

    expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(2);
    expect(clientKeyOfCall(1)).toBe(clientKeyOfCall(0));
  });
});
