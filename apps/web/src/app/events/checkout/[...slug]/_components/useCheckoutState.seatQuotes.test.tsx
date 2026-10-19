import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Seat quotes from the web checkout (seat-price-overrides spec D-007). The
 * server refuses `seat_price_changed` when its price differs from a quote and
 * never charges the quote.
 *
 *   - The HOLD quotes the seat map's overrides (plain seats go unquoted: their
 *     tier price came with the page and nothing refreshes it).
 *   - PAY quotes the HELD summary's lines, never the live map: a map that
 *     refetched to $80 while the summary still says $50 must not let Pay
 *     charge $80.
 *   - A Pay refused `seat_price_changed` re-holds, so the summary shows the
 *     new price before it can be charged.
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const RES_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const SEAT_OVERRIDE = "44444444-4444-4444-8444-444444444441";
const SEAT_PLAIN = "44444444-4444-4444-8444-444444444442";
const SECTION = "section-1";

type HoldOptions = {
  onSuccess?: (data: unknown, variables?: unknown) => void;
  onError?: (error: unknown, variables: unknown) => void;
};

const {
  createCheckoutMutateAsync,
  holdMutate,
  holdOptions,
  releaseMutate,
  releaseMutateAsync,
  releaseOptions,
  traced,
  seatData,
  cartHolds,
} = vi.hoisted(() => ({
  createCheckoutMutateAsync: vi.fn(),
  holdMutate: vi.fn(),
  holdOptions: { current: null as null | HoldOptions },
  releaseMutate: vi.fn(),
  // The re-hold's release: per call, so a test can make it fail or hang.
  releaseMutateAsync: vi.fn(
    (_vars: unknown): Promise<{ released: boolean; gone?: true }> =>
      Promise.resolve({ released: true }),
  ),
  releaseOptions: [] as unknown[],
  // traceIgnoredError(label)(err), flattened: the Sentry report of a swallow.
  traced: vi.fn(),
  seatData: { current: undefined as unknown },
  cartHolds: { carts: [] as unknown[] },
}));

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/hooks/useCartRecovery", () => ({ useCartRelease: () => {} }));
vi.mock("@/lib/attribution", () => ({ getAttribution: () => ({}) }));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => (err: unknown) => traced(label, err),
}));

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
            data: seatData.current,
            isLoading: false,
            isError: false,
            refetch: vi.fn(() => Promise.resolve({})),
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
        // Captures the hook's handlers so a test can land a hold.
        updateOrderItems: {
          useMutation: (options: HoldOptions) => {
            holdOptions.current = options;
            return { mutate: holdMutate, mutateAsync: vi.fn(), isPending: false };
          },
        },
        releaseCartHold: {
          useMutation: (options?: unknown) => {
            releaseOptions.push(options);
            return {
            mutate: releaseMutate,
            mutateAsync: releaseMutateAsync,
            isPending: false,
            };
          },
        },
        confirmPayment: mutation(),
      },
    },
  };
});

import { useCheckoutState, type TicketTypeSummary } from "./useCheckoutState";

const reserved = (priceCents = 3000): TicketTypeSummary => ({
  id: RES_ID,
  name: "Reserved",
  priceCents,
  capacity: 100,
  remainingCapacity: 100,
  seatSectionId: SECTION,
  layoutSectionId: null,
  pricingMode: "FIXED",
  minimumCents: null,
  suggestedCents: null,
});

const mapWith = (overrideCents: number) => ({
  eventId: EVENT_ID,
  seats: [
    {
      id: SEAT_OVERRIDE,
      seatSectionId: SECTION,
      status: "AVAILABLE",
      label: "A1",
      row: "A",
      number: 1,
      priceOverride: { priceCents: overrideCents, buyerTotalCents: null },
    },
    {
      id: SEAT_PLAIN,
      seatSectionId: SECTION,
      status: "AVAILABLE",
      label: "A2",
      row: "A",
      number: 2,
      priceOverride: null,
    },
  ],
});

/** The held order as updateOrderItems answers it: one line per seat. */
const heldOrder = (overrideCents: number) => ({
  order: {
    id: ORDER_ID,
    eventId: EVENT_ID,
    buyerHumanId: "buyer",
    amountGrossCents: overrideCents + 3000,
    feesPlatformCents: 0,
    buyerFeesCents: 0,
    processorFeeCents: 0,
    currency: "usd",
    status: "PENDING",
    items: [
      {
        id: "item-1",
        kind: "ticket",
        ticketTypeId: RES_ID,
        qty: 1,
        unitPriceCents: overrideCents,
        amountCents: overrideCents,
        meta: { seatId: SEAT_OVERRIDE, seatIds: [SEAT_OVERRIDE] },
      },
      {
        id: "item-2",
        kind: "ticket",
        ticketTypeId: RES_ID,
        qty: 1,
        unitPriceCents: 3000,
        amountCents: 3000,
        meta: { seatId: SEAT_PLAIN, seatIds: [SEAT_PLAIN] },
      },
    ],
  },
  holdExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
});

const paid = (gross: number) => ({
  orderId: ORDER_ID,
  clientSecret: "pi_secret",
  amountGrossCents: gross,
  feesPlatformCents: 0,
  buyerFeesCents: 0,
  processorFeeCents: 0,
  taxAmountCents: 0,
  creditAppliedCents: 0,
  feeMode: "PASS_THROUGH" as const,
  holdExpiresAt: null,
});

const resumedCart = {
  id: ORDER_ID,
  eventId: EVENT_ID,
  amountGrossCents: 8000,
  preDiscountGrossCents: 8000,
  promoCodes: [] as string[],
  feesPlatformCents: 0,
  feeMode: "PASS_THROUGH" as const,
  buyerFeesCents: 0,
  currency: "usd",
  holdExpiresAt: new Date(Date.now() + 10 * 60_000),
  // As getActiveCartHolds answers it: the per-type unit price is the FIRST
  // line's ($50), so only `seats` knows A2 is $30.
  ticketSummary: [
    {
      ticketTypeId: RES_ID,
      ticketTypeName: "Reserved",
      qty: 2,
      unitPriceCents: 5000,
      seatIds: [SEAT_OVERRIDE, SEAT_PLAIN],
      seats: [
        { seatId: SEAT_OVERRIDE, unitPriceCents: 5000 },
        { seatId: SEAT_PLAIN, unitPriceCents: 3000 },
      ],
    },
  ],
};

const appError = (code: string) =>
  Object.assign(new Error(code), { data: { appCode: code } });

const render = (
  opts: { ticketType?: TicketTypeSummary; resume?: boolean } = {},
) =>
  renderHook(() =>
    useCheckoutState({
      event: { id: EVENT_ID, slug: "gallery-walk" },
      ticketTypes: [opts.ticketType ?? reserved()],
      ...(opts.resume ? { resumeOrderId: ORDER_ID } : {}),
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

type Hook = { current: ReturnType<typeof useCheckoutState> };
type Items = Array<Record<string, unknown>>;

const pickBothSeats = (result: Hook) => {
  act(() => result.current.handleSeatToggle(SEAT_OVERRIDE, SECTION));
  act(() => result.current.handleSeatToggle(SEAT_PLAIN, SECTION));
};

const hold = async (result: Hook) => {
  await act(async () => {
    await result.current.handleHoldTickets();
  });
  return holdMutate.mock.calls.at(-1)![0] as { items: Items; orderId?: string };
};

const landHold = (overrideCents: number) =>
  act(() => holdOptions.current!.onSuccess!(heldOrder(overrideCents)));

const pay = async (result: Hook) => {
  await act(async () => {
    await result.current.handleCheckout().catch(() => undefined);
  });
  return createCheckoutMutateAsync.mock.calls.at(-1)![0] as { items: Items };
};

const quoteFor = (items: Items, seatId: string) =>
  (items[0]!.seatQuotes as Array<{ seatId: string; unitPriceCents: number }> | undefined)?.find(
    (q) => q.seatId === seatId,
  )?.unitPriceCents;

describe("useCheckoutState seat quotes", () => {
  beforeEach(() => {
    createCheckoutMutateAsync.mockReset();
    holdMutate.mockReset();
    releaseMutate.mockClear();
    releaseMutateAsync.mockReset();
    releaseMutateAsync.mockImplementation(() =>
      Promise.resolve({ released: true }),
    );
    holdOptions.current = null;
    releaseOptions.length = 0;
    traced.mockClear();
    seatData.current = mapWith(5000);
    cartHolds.carts = [];
  });

  it("the hold quotes the map's override seat only; the plain seat goes unquoted", async () => {
    const { result } = render();
    pickBothSeats(result);

    const input = await hold(result);

    expect(input.items).toEqual([
      {
        ticketTypeId: RES_ID,
        qty: 2,
        seatIds: [SEAT_OVERRIDE, SEAT_PLAIN],
        seatQuotes: [{ seatId: SEAT_OVERRIDE, unitPriceCents: 5000 }],
      },
    ]);
  });

  it("CONTROL: with no seat map loaded the hold quotes nothing", async () => {
    seatData.current = undefined;
    const { result } = render();
    pickBothSeats(result);

    const input = await hold(result);

    expect(input.items[0]).not.toHaveProperty("seatQuotes");
  });

  it("held at $50, map refetches to $80: Pay never sends 8000 while the summary says 5000; the re-hold shows 8000, then Pay at 8000 goes through", async () => {
    const { result } = render();
    pickBothSeats(result);
    await hold(result);
    landHold(5000);
    expect(result.current.phase).toBe("held");

    // The organiser sets A1 to $80; the map refetches (reconnect, focus, or
    // a refusal). The summary still shows the hold's $50.
    seatData.current = mapWith(8000);
    createCheckoutMutateAsync.mockRejectedValueOnce(
      new Error("seat_price_changed"),
    );

    // Pay #1 quotes the HELD line, every held seat, and is refused.
    const first = await pay(result);
    expect(quoteFor(first.items, SEAT_OVERRIDE)).toBe(5000);
    expect(quoteFor(first.items, SEAT_PLAIN)).toBe(3000);

    // The refusal re-holds the same selection, unquoted, on the same cart.
    const rehold = holdMutate.mock.calls.at(-1)![0] as {
      items: Items;
      orderId?: string;
    };
    expect(holdMutate).toHaveBeenCalledTimes(2);
    expect(rehold.orderId).toBe(ORDER_ID);
    expect(rehold.items[0]).not.toHaveProperty("seatQuotes");
    expect(rehold.items[0]!.seatIds).toEqual([SEAT_OVERRIDE, SEAT_PLAIN]);

    // Pay #2 BEFORE the re-hold lands: the summary is about to change, so
    // Pay sends nothing (never the map's 8000, nor a fresh PaymentIntent the
    // re-hold would pull the buyer off) and starts no second re-hold.
    expect(result.current.order!.items[0]!.unitPriceCents).toBe(5000);
    let secondError: unknown;
    await act(async () => {
      await result.current.handleCheckout().catch((e: unknown) => {
        secondError = e;
      });
    });
    expect((secondError as Error).message).toBe("already in progress");
    expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(1);
    expect(holdMutate).toHaveBeenCalledTimes(2);

    // The re-hold lands: the summary shows $80 and keeps saying why.
    landHold(8000);
    expect(result.current.phase).toBe("held");
    expect(result.current.order!.items[0]!.unitPriceCents).toBe(8000);
    expect(result.current.errorMessage).toBeTruthy();

    // Pay #3 quotes the $80 the buyer now sees, and is charged.
    createCheckoutMutateAsync.mockResolvedValueOnce(paid(11000));
    const third = await pay(result);
    expect(quoteFor(third.items, SEAT_OVERRIDE)).toBe(8000);
    expect(result.current.phase).toBe("paying");
  });

  it("CONTROL: a Pay refusal that is not about price does not re-hold", async () => {
    const { result } = render();
    pickBothSeats(result);
    await hold(result);
    landHold(5000);
    createCheckoutMutateAsync.mockRejectedValueOnce(new Error("seat_taken"));

    await pay(result);

    expect(holdMutate).toHaveBeenCalledTimes(1);
  });

  it("a resumed seated cart shows each seat at its own price, and Pay sends those seats quoted from those lines", async () => {
    cartHolds.carts = [resumedCart];
    // The organiser has since set A1 to $90; the map knows, the summary does not.
    seatData.current = mapWith(9000);
    createCheckoutMutateAsync.mockRejectedValueOnce(
      new Error("seat_price_changed"),
    );
    const { result } = render({ resume: true });
    await waitFor(() => expect(result.current.phase).toBe("held"));

    // One line per seat, not "Reserved ×2 at $50" ($100 over an $80 cart).
    const lines = result.current.order!.items.map((i) => [
      i.qty,
      i.unitPriceCents,
      i.amountCents,
    ]);
    expect(lines).toEqual([
      [1, 5000, 5000],
      [1, 3000, 3000],
    ]);

    const input = await pay(result);

    expect(input.items[0]).toMatchObject({
      ticketTypeId: RES_ID,
      qty: 2,
      seatIds: [SEAT_OVERRIDE, SEAT_PLAIN],
    });
    // Quoted from the resumed lines the buyer sees, never the map's $90.
    expect(quoteFor(input.items, SEAT_OVERRIDE)).toBe(5000);
    expect(quoteFor(input.items, SEAT_PLAIN)).toBe(3000);
    // Refused: the same cart is re-held so the summary can show $90.
    expect(holdMutate.mock.calls.at(-1)![0]).toMatchObject({
      orderId: ORDER_ID,
    });
  });

  describe("a same-cart price re-hold (startHold with orderId)", () => {
    const refusedResume = async () => {
      cartHolds.carts = [resumedCart];
      seatData.current = mapWith(9000);
      createCheckoutMutateAsync.mockRejectedValueOnce(
        new Error("seat_price_changed"),
      );
      const { result } = render({ resume: true });
      await waitFor(() => expect(result.current.phase).toBe("held"));
      expect(result.current.isPending).toBe(false);
      await pay(result);
      expect(holdMutate.mock.calls.at(-1)![0]).toMatchObject({
        orderId: ORDER_ID,
      });
      return result;
    };

    it("Pay shows busy while it runs, and idle once it lands", async () => {
      const result = await refusedResume();
      expect(result.current.isPending).toBe(true);

      landHold(9000);
      expect(result.current.isPending).toBe(false);
    });

    it("Pay shows idle again when the re-hold fails", async () => {
      const result = await refusedResume();
      expect(result.current.isPending).toBe(true);

      act(() =>
        holdOptions.current!.onError!(
          new Error("seat_unavailable"),
          holdMutate.mock.calls.at(-1)![0],
        ),
      );
      expect(result.current.isPending).toBe(false);
    });
  });

  it("a re-hold of a cart that has a PaymentIntent (declined card, then a price edit) releases it and holds afresh", async () => {
    const CHECKOUT_ORDER = "55555555-5555-4555-8555-555555555555";
    const { result } = render();
    pickBothSeats(result);
    await hold(result);
    landHold(5000);

    // Pay #1 mints the checkout order with a PaymentIntent; the card is declined.
    createCheckoutMutateAsync.mockResolvedValueOnce({
      ...paid(8000),
      orderId: CHECKOUT_ORDER,
    });
    await pay(result);
    expect(result.current.phase).toBe("paying");
    act(() => result.current.handlePaymentError("card_declined"));
    expect(result.current.phase).toBe("held");

    // The organiser edits A1; Pay #2 is refused.
    createCheckoutMutateAsync.mockRejectedValueOnce(
      new Error("seat_price_changed"),
    );
    await pay(result);

    // updateOrderItems cannot edit that order (ORDER_HAS_PAYMENT_INTENT):
    // release it (settles the PaymentIntent, frees the seats), hold afresh.
    expect(releaseMutateAsync).toHaveBeenCalledWith({
      orderId: CHECKOUT_ORDER,
    });
    const fresh = holdMutate.mock.calls.at(-1)![0] as { orderId?: string };
    expect(holdMutate).toHaveBeenCalledTimes(2);
    expect(fresh).not.toHaveProperty("orderId");

    landHold(8000);
    expect(result.current.phase).toBe("held");
    expect(result.current.order!.items[0]!.unitPriceCents).toBe(8000);
  });

  it("a resumed cart the server refuses to edit (ORDER_HAS_PAYMENT_INTENT) is released and held afresh, not left on step 1", async () => {
    cartHolds.carts = [resumedCart];
    createCheckoutMutateAsync.mockRejectedValueOnce(
      new Error("seat_price_changed"),
    );
    const { result } = render({ resume: true });
    await waitFor(() => expect(result.current.phase).toBe("held"));
    await pay(result);
    const rehold = holdMutate.mock.calls.at(-1)![0];
    expect(rehold).toMatchObject({ orderId: ORDER_ID });

    await act(async () => {
      holdOptions.current!.onError!(appError("ORDER_HAS_PAYMENT_INTENT"), rehold);
      await Promise.resolve();
    });

    expect(releaseMutateAsync).toHaveBeenCalledWith({ orderId: ORDER_ID });
    expect(holdMutate.mock.calls.at(-1)![0]).not.toHaveProperty("orderId");
    expect(result.current.phase).toBe("held");
  });

  it.each(["ORDER_NOT_PENDING", "ORDER_NOT_FOUND"])(
    "a hold refused %s stops naming that cart: the next hold is a fresh one",
    async (code) => {
      const { result } = render();
      pickBothSeats(result);
      await hold(result);
      landHold(5000);
      act(() => result.current.handleSeatToggle(SEAT_PLAIN, SECTION));
      const edit = await hold(result);
      expect(edit).toMatchObject({ orderId: ORDER_ID });

      act(() => holdOptions.current!.onError!(appError(code), edit));
      expect(result.current.phase).toBe("selecting");
      expect(releaseMutateAsync).not.toHaveBeenCalled();

      const next = await hold(result);
      expect(next).not.toHaveProperty("orderId");
    },
  );

  describe("the release before a fresh hold", () => {
    const CHECKOUT_ORDER = "55555555-5555-4555-8555-555555555555";

    const FRESH_ORDER = "66666666-6666-4666-8666-666666666666";

    /** Held at $50, Pay #1 minted CHECKOUT_ORDER, the card was declined. */
    const declinedCheckout = async (
      opts: { holdExpiresAt?: string | null } = {},
    ) => {
      const hook = render();
      const { result } = hook;
      pickBothSeats(result);
      await hold(result);
      landHold(5000);
      createCheckoutMutateAsync.mockResolvedValueOnce({
        ...paid(8000),
        orderId: CHECKOUT_ORDER,
        holdExpiresAt: opts.holdExpiresAt ?? null,
      });
      await pay(result);
      act(() => result.current.handlePaymentError("card_declined"));
      createCheckoutMutateAsync.mockRejectedValueOnce(
        new Error("seat_price_changed"),
      );
      return hook;
    };

    it.each([
      ["throws (network / 5xx)", () => Promise.reject(new Error("fetch failed"))],
      [
        "answers released:false (Stripe would not settle)",
        () => Promise.resolve({ released: false }),
      ],
    ] as const)(
      "a release that %s keeps the cart: no fresh hold, the page still points at it",
      async (_label, outcome) => {
        releaseMutateAsync.mockImplementationOnce(outcome);
        const { result } = await declinedCheckout();

        await pay(result);

        expect(releaseMutateAsync).toHaveBeenCalledWith({
          orderId: CHECKOUT_ORDER,
        });
        // The first hold only: nothing held over seats the old cart still has.
        expect(holdMutate).toHaveBeenCalledTimes(1);
        // Held step, same cart (the unload release reads state.orderId), and
        // a message the buyer can act on.
        expect(result.current.phase).toBe("held");
        expect(result.current.orderId).toBe(CHECKOUT_ORDER);
        expect(result.current.errorMessage).toBeTruthy();

        // The next Pay refusal tries the release again: the reference held.
        createCheckoutMutateAsync.mockRejectedValueOnce(
          new Error("seat_price_changed"),
        );
        await pay(result);
        expect(releaseMutateAsync).toHaveBeenCalledTimes(2);
        expect(releaseMutateAsync).toHaveBeenLastCalledWith({
          orderId: CHECKOUT_ORDER,
        });
      },
    );

    it("a fresh hold refused after a good release lands on step 1 with the reason, naming no cart", async () => {
      const { result } = await declinedCheckout();
      await pay(result);
      const fresh = holdMutate.mock.calls.at(-1)![0];
      expect(fresh).not.toHaveProperty("orderId");

      act(() =>
        holdOptions.current!.onError!(new Error("seat_unavailable"), fresh),
      );

      expect(result.current.phase).toBe("selecting");
      expect(result.current.errorMessage).toBeTruthy();
      pickBothSeats(result);
      pickBothSeats(result);
      const next = await hold(result);
      expect(next).not.toHaveProperty("orderId");
    });

    it("Back to tickets while the release runs: the release lands, no fresh hold is sent", async () => {
      let settle!: (v: { released: boolean }) => void;
      releaseMutateAsync.mockImplementationOnce(
        () => new Promise((resolve) => (settle = resolve)),
      );
      const { result } = await declinedCheckout();
      await pay(result);
      expect(releaseMutateAsync).toHaveBeenCalledTimes(1);

      act(() => result.current.handleBackToSelecting());
      await act(async () => {
        settle({ released: true });
        await Promise.resolve();
      });

      expect(holdMutate).toHaveBeenCalledTimes(1);
    });

    it("Hold and Pay are refused while the release runs", async () => {
      let settle!: (v: { released: boolean }) => void;
      releaseMutateAsync.mockImplementationOnce(
        () => new Promise((resolve) => (settle = resolve)),
      );
      const { result } = await declinedCheckout();
      await pay(result);
      const paysBefore = createCheckoutMutateAsync.mock.calls.length;

      await act(async () => {
        await result.current.handleHoldTickets();
      });
      let payError: unknown;
      await act(async () => {
        await result.current.handleCheckout().catch((e: unknown) => {
          payError = e;
        });
      });
      expect(holdMutate).toHaveBeenCalledTimes(1);
      expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(paysBefore);
      expect((payError as Error).message).toBe("already in progress");

      // Once it lands, exactly one fresh hold goes out.
      await act(async () => {
        settle({ released: true });
        await Promise.resolve();
      });
      expect(holdMutate).toHaveBeenCalledTimes(2);
      expect(holdMutate.mock.calls.at(-1)![0]).not.toHaveProperty("orderId");
    });

    /** A release that answers when the test says so. */
    const deferRelease = () => {
      let settle!: (v: { released: boolean; gone?: true }) => void;
      releaseMutateAsync.mockImplementationOnce(
        () => new Promise((resolve) => (settle = resolve)),
      );
      return (v: { released: boolean; gone?: true }) =>
        act(async () => {
          settle(v);
          await Promise.resolve();
        });
    };

    it("Hold and Pay show busy for the whole release, and stop once it answers", async () => {
      const settle = deferRelease();
      const { result } = await declinedCheckout();
      expect(result.current.isHolding).toBe(false);
      expect(result.current.isPending).toBe(false);

      await pay(result);
      expect(result.current.isHolding).toBe(true);
      expect(result.current.isPending).toBe(true);

      await settle({ released: true });
      expect(result.current.isHolding).toBe(false);
      // The fresh hold is now the re-hold in flight (the mocked hold
      // mutation never reports pending): Pay stays busy until it lands.
      expect(result.current.isPending).toBe(true);
      landHold(8000);
      expect(result.current.isPending).toBe(false);
    });

    it("the page unmounts while the release runs: the release lands, no fresh hold is minted", async () => {
      const settle = deferRelease();
      const { result, unmount } = await declinedCheckout();
      await pay(result);

      unmount();
      await settle({ released: true });

      expect(holdMutate).toHaveBeenCalledTimes(1);
    });

    it("a hold that lands after the page unmounted is released, not kept", async () => {
      const { result, unmount } = render();
      pickBothSeats(result);
      const vars = await hold(result);

      unmount();
      act(() => holdOptions.current!.onSuccess!(heldOrder(5000), vars));

      expect(releaseMutateAsync).toHaveBeenCalledWith({ orderId: ORDER_ID });
    });

    it("a late hold's release that fails is reported to Sentry, not just swallowed", async () => {
      const { result, unmount } = render();
      pickBothSeats(result);
      const vars = await hold(result);
      unmount();
      const failure = new Error("network");
      releaseMutateAsync.mockImplementationOnce(() => Promise.reject(failure));
      await act(async () => {
        holdOptions.current!.onSuccess!(heldOrder(5000), vars);
      });

      expect(traced).toHaveBeenCalledWith("checkout.lateHoldRelease", failure);
    });

    it("the fresh hold lands after Back to tickets: the buyer stays on step 1 and the fresh cart is released", async () => {
      const { result } = await declinedCheckout();
      await pay(result);
      const fresh = holdMutate.mock.calls.at(-1)![0];
      expect(fresh).not.toHaveProperty("orderId");

      act(() => result.current.handleBackToSelecting());
      act(() =>
        holdOptions.current!.onSuccess!(
          { ...heldOrder(8000), order: { ...heldOrder(8000).order, id: FRESH_ORDER } },
          fresh,
        ),
      );

      expect(result.current.phase).toBe("selecting");
      expect(result.current.order).toBeNull();
      expect(releaseMutateAsync).toHaveBeenCalledWith({ orderId: FRESH_ORDER });
      // The next hold starts a new cart; it does not edit the released one.
      pickBothSeats(result);
      pickBothSeats(result);
      expect(await hold(result)).not.toHaveProperty("orderId");
    });

    it("a same-cart re-hold that lands, or is refused, after Back to tickets changes nothing on step 1", async () => {
      const { result } = render();
      pickBothSeats(result);
      await hold(result);
      landHold(5000);
      createCheckoutMutateAsync.mockRejectedValueOnce(
        new Error("seat_price_changed"),
      );
      await pay(result);
      const rehold = holdMutate.mock.calls.at(-1)![0];
      expect(rehold).toMatchObject({ orderId: ORDER_ID });

      act(() => result.current.handleBackToSelecting());
      act(() =>
        holdOptions.current!.onError!(appError("ORDER_NOT_PENDING"), rehold),
      );
      expect(result.current.phase).toBe("selecting");
      expect(result.current.errorMessage).toBeNull();

      act(() => holdOptions.current!.onSuccess!(heldOrder(8000), rehold));
      expect(result.current.phase).toBe("selecting");
      expect(result.current.order).toBeNull();
    });

    it("a release answering gone (the cart was already cancelled) holds afresh instead of looping", async () => {
      releaseMutateAsync.mockImplementationOnce(() =>
        Promise.resolve({ released: false, gone: true }),
      );
      const { result } = await declinedCheckout();
      await pay(result);

      expect(holdMutate).toHaveBeenCalledTimes(2);
      expect(holdMutate.mock.calls.at(-1)![0]).not.toHaveProperty("orderId");

      landHold(8000);
      expect(result.current.phase).toBe("held");
      expect(result.current.order!.items[0]!.unitPriceCents).toBe(8000);
    });

    it("a release that throws is reported to Sentry, not just swallowed", async () => {
      const failure = new Error("fetch failed");
      releaseMutateAsync.mockImplementationOnce(() => Promise.reject(failure));
      const { result } = await declinedCheckout();
      await pay(result);

      expect(traced).toHaveBeenCalledWith("checkout.reholdRelease", failure);
    });

    it("the background release is silent: no global toast beside the page's own message", () => {
      render();
      expect(releaseOptions).toContainEqual(
        expect.objectContaining({ meta: { silent: true } }),
      );
    });

    it("Back to tickets while a release that keeps the cart runs: no fresh hold, no stale reference", async () => {
      const settle = deferRelease();
      const { result } = await declinedCheckout();
      await pay(result);

      act(() => result.current.handleBackToSelecting());
      await settle({ released: false });

      expect(holdMutate).toHaveBeenCalledTimes(1);
      expect(result.current.phase).toBe("selecting");
      pickBothSeats(result);
      pickBothSeats(result);
      expect(await hold(result)).not.toHaveProperty("orderId");
    });

    it("the hold expires while a release that keeps the cart runs: the dead cart is not named again", async () => {
      const settle = deferRelease();
      const { result } = await declinedCheckout({
        holdExpiresAt: new Date(Date.now() + 1200).toISOString(),
      });
      await pay(result);

      await waitFor(() => expect(result.current.phase).toBe("selecting"), {
        timeout: 4000,
      });
      await settle({ released: false });

      expect(holdMutate).toHaveBeenCalledTimes(1);
      expect(result.current.errorMessage).toBe("checkout.holdExpired");
      pickBothSeats(result);
      pickBothSeats(result);
      expect(await hold(result)).not.toHaveProperty("orderId");
    });
  });

  it("backstop: a GA-shaped held order (no seat on its lines) with seats picked re-holds instead of charging unquoted", async () => {
    const { result } = render();
    pickBothSeats(result);
    await hold(result);
    const ga = heldOrder(5000);
    act(() =>
      holdOptions.current!.onSuccess!({
        ...ga,
        order: {
          ...ga.order,
          items: [
            {
              id: "item-1",
              kind: "ticket",
              ticketTypeId: RES_ID,
              qty: 2,
              unitPriceCents: 4000,
              amountCents: 8000,
              meta: {},
            },
          ],
        },
      }),
    );

    await pay(result).catch(() => undefined);

    expect(createCheckoutMutateAsync).not.toHaveBeenCalled();
    expect(holdMutate.mock.calls.at(-1)![0]).toMatchObject({
      orderId: ORDER_ID,
    });
  });

  it("backstop: a seat picked after the hold has no held price, so Pay re-holds the selection instead of charging", async () => {
    const SEAT_NEW = "44444444-4444-4444-8444-444444444443";
    const { result } = render();
    pickBothSeats(result);
    await hold(result);
    landHold(5000);
    // A2 swapped for a seat the held summary does not show.
    act(() => result.current.handleSeatToggle(SEAT_PLAIN, SECTION));
    act(() => result.current.handleSeatToggle(SEAT_NEW, SECTION));

    let payError: unknown;
    await act(async () => {
      await result.current.handleCheckout().catch((e: unknown) => {
        payError = e;
      });
    });

    expect(createCheckoutMutateAsync).not.toHaveBeenCalled();
    expect((payError as Error).message).toBe("already in progress");
    expect(holdMutate.mock.calls.at(-1)![0]).toMatchObject({
      orderId: ORDER_ID,
      items: [
        expect.objectContaining({ seatIds: [SEAT_OVERRIDE, SEAT_NEW] }),
      ],
    });
  });

  it("regression: before the hold, a $50 seat on a $30 tier is $50 in the lines, the subtotal and the estimate's cart; the held summary says the same", async () => {
    const { result } = render();
    pickBothSeats(result);

    // What step 1 shows (and `Checkout` estimates the total from).
    expect(result.current.shownLineCents).toEqual({ [RES_ID]: 8000 });
    expect(result.current.subtotalCents).toBe(8000);
    expect(result.current.shownLines).toEqual([
      { ticketTypeId: RES_ID, qty: 1, priceCents: 3000, chosenAmountCents: null },
      { ticketTypeId: RES_ID, qty: 1, priceCents: 5000, chosenAmountCents: 5000 },
    ]);

    // What the hold answers for those seats: the same 8000.
    await hold(result);
    landHold(5000);
    const heldGross = result.current
      .order!.items.filter((i) => i.kind === "ticket")
      .reduce((sum, i) => sum + i.amountCents, 0);
    expect(heldGross).toBe(result.current.subtotalCents);
  });

  it("a $10 override seat on a $0 tier makes a paid subtotal (billing address required)", () => {
    seatData.current = mapWith(1000);
    const { result } = render({ ticketType: reserved(0) });
    act(() => result.current.handleSeatToggle(SEAT_OVERRIDE, SECTION));

    expect(result.current.subtotalCents).toBe(1000);
  });
});
