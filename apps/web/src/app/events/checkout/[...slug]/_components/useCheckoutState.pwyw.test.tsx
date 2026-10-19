import { act, render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A RESUMED pay-what-you-want hold must charge the amount that was held.
 *
 * The bug: the HOLD_RESUMED effect restored `quantities` from the cart's
 * `ticketSummary` but not the donation amounts, so `chosenAmountFor` fell back
 * to the default and `createCheckout` sent THAT as `donationAmountCents` — and
 * the server prices from `input.items`. Hold $50, resume, press Continue: pay
 * $15. Hold $0 at minimum 0, resume: billing suddenly required, $15 charged.
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

describe("useCheckoutState — resuming a pay-what-you-want hold", () => {
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
    taxQueryInputs.length = 0;
  });

  it("regression: Continue charges the HELD $50, not the $15 default", async () => {
    cartHolds.carts = [heldCart(5000)];
    const { result } = renderResumed();

    await waitFor(() => expect(result.current.phase).toBe("held"));
    expect(result.current.donationAmounts[PWYW_ID]).toBe(5000);

    await act(async () => {
      await result.current.handleCheckout();
    });

    expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(1);
    const input = createCheckoutMutateAsync.mock.calls[0]![0] as {
      items: Array<{ ticketTypeId: string; donationAmountCents?: number }>;
    };
    expect(input.items).toEqual([
      expect.objectContaining({
        ticketTypeId: PWYW_ID,
        qty: 2,
        donationAmountCents: 5000,
      }),
    ]);
  });

  it("a held $0 at minimum 0 resumes as $0 — still free, no billing, no $15", async () => {
    cartHolds.carts = [heldCart(0)];
    const { result } = renderResumed();

    await waitFor(() => expect(result.current.phase).toBe("held"));
    expect(result.current.donationAmounts[PWYW_ID]).toBe(0);
    expect(result.current.subtotalCents).toBe(0);
  });

  it("the held step's tax estimate is quoted on the resumed amount", async () => {
    cartHolds.carts = [heldCart(5000)];
    const { result } = renderResumed();
    await waitFor(() => expect(result.current.phase).toBe("held"));
    const last = taxQueryInputs.at(-1) as {
      items: Array<{ donationAmountCents?: number }>;
    };
    expect(last.items[0]!.donationAmountCents).toBe(5000);
  });
});

describe("useCheckoutState — only amounts the hold accepts are quoted", () => {
  it("regression: an over-cap amount is never sent to the tax / promo quotes", async () => {
    cartHolds.carts = [];
    taxQueryInputs.length = 0;
    const { result } = renderResumed(undefined);
    act(() => {
      result.current.handleQuantityChange(PWYW_ID, 1);
      result.current.handleDonationAmountChange(PWYW_ID, 1_500_000);
    });
    // Past the 300ms quote debounce.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await waitFor(() =>
      expect(result.current.donationAmounts[PWYW_ID]).toBe(1_500_000),
    );
    expect(result.current.quotedDonationAmounts).not.toHaveProperty(PWYW_ID);
    const last = taxQueryInputs.at(-1) as {
      items: Array<{ donationAmountCents?: number }>;
    };
    expect(last.items[0]).not.toHaveProperty("donationAmountCents");
  });

  it("a valid amount is quoted once the debounce settles", async () => {
    cartHolds.carts = [];
    const { result } = renderResumed(undefined);
    act(() => {
      result.current.handleQuantityChange(PWYW_ID, 1);
      result.current.handleDonationAmountChange(PWYW_ID, 2250);
    });
    await waitFor(() =>
      expect(result.current.quotedDonationAmounts[PWYW_ID]).toBe(2250),
    );
  });
});

describe("useCheckoutState — hasInvalidDonation (pauses the promo preview)", () => {
  it("is true for a selected tier over the cap, false once the amount is valid", () => {
    cartHolds.carts = [];
    const { result } = renderResumed(undefined);
    expect(result.current.hasInvalidDonation).toBe(false);
    act(() => {
      result.current.handleQuantityChange(PWYW_ID, 1);
      result.current.handleDonationAmountChange(PWYW_ID, 1_500_000);
    });
    expect(result.current.hasInvalidDonation).toBe(true);
    act(() => {
      result.current.handleDonationAmountChange(PWYW_ID, 1500);
    });
    expect(result.current.hasInvalidDonation).toBe(false);
  });

  it("ignores an unselected tier", () => {
    cartHolds.carts = [];
    const { result } = renderResumed(undefined);
    act(() => {
      result.current.handleDonationAmountChange(PWYW_ID, 1_500_000);
    });
    expect(result.current.hasInvalidDonation).toBe(false);
  });
});

describe("useCheckoutState — promoPreviewPaused waits for the debounced quote", () => {
  it("regression: raw amount valid, debounced amount still invalid → PAUSED", async () => {
    cartHolds.carts = [];
    const { result } = renderResumed(undefined);
    act(() => {
      result.current.handleQuantityChange(PWYW_ID, 1);
      result.current.handleDonationAmountChange(PWYW_ID, 1_500_000);
    });
    // Let the over-cap amount settle through the 300ms debounce.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await waitFor(() =>
      expect(result.current.quotedDonationAmounts).not.toHaveProperty(PWYW_ID),
    );

    // The buyer fixes it. The LIVE amount is valid at once…
    act(() => {
      result.current.handleDonationAmountChange(PWYW_ID, 1500);
    });
    expect(result.current.hasInvalidDonation).toBe(false);
    // …but the quote has not caught up, so the preview must stay paused.
    expect(result.current.quotedDonationAmounts).not.toHaveProperty(PWYW_ID);
    expect(result.current.promoPreviewPaused).toBe(true);

    // Once the quote catches up, it unpauses.
    await waitFor(() =>
      expect(result.current.quotedDonationAmounts[PWYW_ID]).toBe(1500),
    );
    expect(result.current.promoPreviewPaused).toBe(false);
  });

  it("an unselected PWYW tier never pauses the preview", () => {
    cartHolds.carts = [];
    const { result } = renderResumed(undefined);
    act(() => {
      result.current.handleDonationAmountChange(PWYW_ID, 1_500_000);
    });
    expect(result.current.promoPreviewPaused).toBe(false);
  });
});

describe("useCheckoutState — a refused Hold is announced at the field", () => {
  it("focuses the amount input (whose aria-describedby carries the alert)", async () => {
    cartHolds.carts = [];
    const input = document.createElement("input");
    input.id = `donation-amount-${PWYW_ID}`;
    document.body.appendChild(input);
    try {
      const { result } = renderResumed(undefined);
      act(() => {
        result.current.handleQuantityChange(PWYW_ID, 1);
        result.current.handleDonationAmountChange(PWYW_ID, 1_500_000);
      });
      await act(async () => {
        await result.current.handleHoldTickets();
      });
      expect(document.activeElement).toBe(input);
      // Forces the field's error (role="alert", linked by aria-describedby —
      // pinned in CheckoutTicketsStep.test.tsx) even before blur.
      expect(result.current.showDonationErrors).toBe(true);
    } finally {
      input.remove();
    }
  });

  it("regression: focus lands AFTER the error state has rendered (so the reader hears the message)", async () => {
    cartHolds.carts = [];
    // A field wired like PayWhatYouWantAmount: its error is linked by
    // aria-describedby only once `showDonationErrors` has RENDERED. What the
    // reader announces on focus is whatever is linked at that instant.
    const describedByAtFocus: Array<string | null> = [];
    const latest: { state: ReturnType<typeof useCheckoutState> | null } = {
      state: null,
    };
    const Field = () => {
      const state = useCheckoutState(checkoutStateArgs(undefined));
      latest.state = state;
      return (
        <input
          id={`donation-amount-${PWYW_ID}`}
          aria-describedby={state.showDonationErrors ? "amount-error" : undefined}
          onFocus={(e) =>
            describedByAtFocus.push(
              e.currentTarget.getAttribute("aria-describedby"),
            )
          }
        />
      );
    };
    const view = render(<Field />);
    try {
      act(() => {
        latest.state!.handleQuantityChange(PWYW_ID, 1);
        latest.state!.handleDonationAmountChange(PWYW_ID, 1_500_000);
      });
      await act(async () => {
        await latest.state!.handleHoldTickets();
      });
      expect(describedByAtFocus).toEqual(["amount-error"]);

      // A second refusal re-focuses the same field.
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      await act(async () => {
        await latest.state!.handleHoldTickets();
      });
      expect(describedByAtFocus).toEqual(["amount-error", "amount-error"]);
    } finally {
      view.unmount();
    }
  });
});

describe("useCheckoutState — a resumed hold keeps its buyer-funded platform fee", () => {
  it("regression: the resumed order carries the cart's buyerFeesCents (was hard-coded 0)", async () => {
    cartHolds.carts = [heldCart(5000)];
    const { result } = renderResumed();
    await waitFor(() => expect(result.current.phase).toBe("held"));
    expect(result.current.order?.buyerFeesCents).toBe(100);
  });
});

describe("useCheckoutState — resuming a cart createCheckout re-saved (discounted)", () => {
  // 2 × $50 with WELCOME10 (−$5.50): createCheckout stores the gross AFTER
  // the discount ($94.50) on the order; the lines still sum to $100.
  const resavedCart = () => ({
    ...heldCart(5000),
    amountGrossCents: 9450,
    preDiscountGrossCents: 10_000,
    promoCodes: ["WELCOME10"],
    feeMode: "ABSORB" as const,
    buyerFeesCents: 0,
  });

  it("regression: the held step starts from the PRE-discount gross (the preview takes the discount off once)", async () => {
    cartHolds.carts = [resavedCart()];
    const { result } = renderResumed();
    await waitFor(() => expect(result.current.phase).toBe("held"));
    expect(result.current.order?.amountGrossCents).toBe(10_000);
    expect(result.current.order?.feeMode).toBe("ABSORB");
  });

  it("regression: the codes it was priced with are restored and sent with the charge", async () => {
    cartHolds.carts = [resavedCart()];
    const { result } = renderResumed();
    await waitFor(() => expect(result.current.phase).toBe("held"));
    expect(result.current.promoCodes).toEqual(["WELCOME10"]);

    await act(async () => {
      await result.current.handleCheckout();
    });
    const input = createCheckoutMutateAsync.mock.calls.at(-1)![0] as {
      promoCodes?: string[];
    };
    expect(input.promoCodes).toEqual(["WELCOME10"]);
  });
});

describe("useCheckoutState — after createCheckout, the page tracks the NEW order", () => {
  const CHARGED_ORDER_ID = "44444444-4444-4444-8444-444444444444";
  const charged = (feeWaivedCents?: number) => ({
    orderId: CHARGED_ORDER_ID,
    clientSecret: "pi_secret",
    amountGrossCents: 10_000,
    feesPlatformCents: 100,
    buyerFeesCents: 100,
    processorFeeCents: 300,
    taxAmountCents: 0,
    creditAppliedCents: 0,
    feeMode: "PASS_THROUGH",
    holdExpiresAt: null,
    ...(feeWaivedCents === undefined ? {} : { feeWaivedCents }),
  });

  it("regression: back to tickets from payment releases the createCheckout order (Y), not the retired hold (X)", async () => {
    releaseMutate.mockReset();
    createCheckoutMutateAsync.mockReset();
    createCheckoutMutateAsync.mockResolvedValue(charged());
    cartHolds.carts = [heldCart(5000)];
    const { result } = renderResumed();
    await waitFor(() => expect(result.current.phase).toBe("held"));

    await act(async () => {
      await result.current.handleCheckout();
    });
    expect(result.current.phase).toBe("paying");

    act(() => result.current.handleBackToSelecting());
    expect(releaseMutate).toHaveBeenCalledTimes(1);
    expect(releaseMutate).toHaveBeenCalledWith({ orderId: CHARGED_ORDER_ID });
  });

  it("regression: createCheckout's feeWaivedCents lands on the order (the waiver caption reads it, not the held lines)", async () => {
    createCheckoutMutateAsync.mockReset();
    createCheckoutMutateAsync.mockResolvedValue(charged(0));
    cartHolds.carts = [heldCart(5000)];
    const { result } = renderResumed();
    await waitFor(() => expect(result.current.phase).toBe("held"));
    await act(async () => {
      await result.current.handleCheckout();
    });
    expect(result.current.order?.feeWaivedCents).toBe(0);
  });
});

describe("useCheckoutState — a paid or free order has no hold for 'back' to release", () => {
  const CHARGED_ORDER_ID = "55555555-5555-4555-8555-555555555555";
  const chargedResult = (clientSecret: string | null) => ({
    orderId: CHARGED_ORDER_ID,
    clientSecret,
    amountGrossCents: 10_000,
    feesPlatformCents: 100,
    buyerFeesCents: 100,
    processorFeeCents: 300,
    taxAmountCents: 0,
    creditAppliedCents: 0,
    feeMode: "PASS_THROUGH",
    holdExpiresAt: null,
  });
  const reachPayment = async (clientSecret: string | null) => {
    releaseMutate.mockReset();
    createCheckoutMutateAsync.mockReset();
    createCheckoutMutateAsync.mockResolvedValue(chargedResult(clientSecret));
    cartHolds.carts = [heldCart(5000)];
    const rendered = renderResumed();
    await waitFor(() => expect(rendered.result.current.phase).toBe("held"));
    await act(async () => {
      await rendered.result.current.handleCheckout();
    });
    return rendered;
  };

  it("regression: PAYMENT_CONFIRMED → back sends no releaseCartHold for the paid order", async () => {
    const { result } = await reachPayment("pi_secret");
    act(() => confirmPaymentOptions.current?.onSuccess?.({ orderId: CHARGED_ORDER_ID, outcome: "confirmed" }));
    expect(result.current.phase).toBe("confirmed");
    act(() => result.current.handleBackToSelecting());
    expect(releaseMutate).not.toHaveBeenCalled();
  });

  it("regression: PAYMENT_FAILED with an order → back sends no releaseCartHold", async () => {
    const { result } = await reachPayment("pi_secret");
    // tRPC hands onError the variables the confirm was sent with.
    act(() =>
      confirmPaymentOptions.current?.onError?.(new Error("network"), {
        orderId: CHARGED_ORDER_ID,
        paymentIntentId: "pi_secret",
      }),
    );
    act(() => result.current.handleBackToSelecting());
    expect(releaseMutate).not.toHaveBeenCalled();
  });

  it("regression: a FREE order (no client secret) → back sends no releaseCartHold", async () => {
    const { result } = await reachPayment(null);
    act(() => result.current.handleBackToSelecting());
    expect(releaseMutate).not.toHaveBeenCalled();
  });
});


describe("useCheckoutState — back on step 1, no old order is on screen", () => {
  it("regression: after 'Back to tickets' the hook hands out no order, so step 1 shows (and announces) the estimate, not the released hold", async () => {
    releaseMutate.mockReset();
    cartHolds.carts = [heldCart(5000)];
    const { result } = renderResumed();
    await waitFor(() => expect(result.current.phase).toBe("held"));
    expect(result.current.order).not.toBeNull();

    act(() => result.current.handleBackToSelecting());
    expect(result.current.phase).toBe("selecting");
    expect(result.current.order).toBeNull();
  });
});
