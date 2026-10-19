import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";

import { solveTaxLinesAndProcessorFee } from "@th/core/lib/pricing/solve-tax-and-processor-fee";

/**
 * Step 2 after "back" from the payment step must show the charge.
 *
 * The bug: `createCheckout` answers with the order's gross AFTER its discount
 * (promo codes + member benefits), and CHECKOUT_SUCCEEDED merged that onto the
 * held order. Going back to details (BACK_TO_HELD) — or a declined card, which
 * also lands on details — kept it, and the held step's charge solve
 * (`estimateHeldOrderCharge`) took the live discount off a second time: step 2
 * read a total BELOW what the next `createCheckout` charges.
 *
 * The parity here: fresh hold → createCheckout → back → step 2's total equals
 * the PaymentIntent of a re-run `createCheckout` for the same cart, with a
 * percent promo, a member benefit and a fee waiver. The "server" below prices
 * every call with create-checkout's own arithmetic (line gross, discount off
 * the subtotal, `solveTaxLinesAndProcessorFee` over the discounted base,
 * PI = gross after discount + buyer fees + tax + processor fee).
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const GA_ID = "22222222-2222-4222-8222-222222222222";
const VIP_ID = "33333333-3333-4333-8333-333333333333";
const HOLD_ID = "44444444-4444-4444-8444-444444444444";
const CHARGED_ID = "55555555-5555-4555-8555-555555555555";

const TAX_LINES = [
  {
    code: "SALES",
    label: "Sales tax",
    jurisdiction: "US/NY",
    rateBps: 888,
    base: "TICKET_FACE" as const,
    collector: "PLATFORM" as const,
  },
];
const PROCESSOR_PCT = 0.029;
const PROCESSOR_FIXED_CENTS = 30;
const PWYW_TIER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEATED_TIER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRICES: Record<string, number> = {
  [GA_ID]: 3500,
  [VIP_ID]: 6000,
  [PWYW_TIER_ID]: 0,
  [SEATED_TIER_ID]: 2500,
};

type Line = {
  ticketTypeId: string;
  qty: number;
  donationAmountCents?: number;
  seatIds?: string[];
};

/** One ticket's platform fee: 3.33%, capped at 50¢. */
const platformFeePerTicket = (unitCents: number) =>
  Math.min(50, Math.round(unitCents * 0.0333));

/**
 * The server's pricing of a cart — the SAME for the hold and the charge
 * (`computeOrderAmounts`). One line PER TICKET (qty 1), as the hold writes
 * them. The buyer's allowance waives one ticket's platform fee (stamped on
 * that line's meta, as the hold does).
 */
function priceLines(items: Line[]) {
  let waiverLeft = 1;
  let feesPlatformCents = 0;
  let feeWaivedCents = 0;
  const units = items.flatMap((item) =>
    Array.from({ length: item.qty }, (_, i) => ({
      ticketTypeId: item.ticketTypeId,
      donation: item.donationAmountCents,
      // A seated line names its seat, as `updateOrderItems` writes it.
      seatId: item.seatIds?.[i],
    })),
  );
  const lines = units.map(({ ticketTypeId, donation, seatId }, index) => {
    // A pay-what-you-want line is priced at the buyer's amount.
    const unit = donation ?? PRICES[ticketTypeId]!;
    const perTicket = platformFeePerTicket(unit);
    feesPlatformCents += perTicket;
    const waived = waiverLeft > 0 ? perTicket : 0;
    waiverLeft -= waived > 0 ? 1 : 0;
    feeWaivedCents += waived;
    return {
      id: `line-${index}`,
      kind: "ticket" as const,
      ticketTypeId,
      qty: 1,
      unitPriceCents: unit,
      amountCents: unit,
      meta: {
        ...(waived > 0 ? { platformFeeWaivedCents: waived } : {}),
        ...(seatId ? { seatId, seatIds: [seatId] } : {}),
      },
    };
  });
  const grossCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return {
    lines,
    grossCents,
    feesPlatformCents,
    feeWaivedCents,
    buyerFeesCents: feesPlatformCents - feeWaivedCents,
  };
}

/**
 * The discount `evaluatePromoApplications` grants (and the promo preview
 * quotes): the member benefit — $5 off one GA ticket — then WELCOME10, 10%
 * off what is left.
 */
function discountFor(items: Line[], codes: string[]) {
  const { grossCents } = priceLines(items);
  const memberCents = items.some((i) => i.ticketTypeId === GA_ID && i.qty > 0)
    ? 500
    : 0;
  const promoCents = codes.includes("WELCOME10")
    ? Math.round((grossCents - memberCents) * 0.1)
    : 0;
  return memberCents + promoCents;
}

const {
  createCheckoutMutateAsync,
  releaseMutate,
  releaseMutateAsync,
  confirmMutate,
  confirmOptions,
  holdServer,
  holdDeferral,
  charges,
} = vi.hoisted(() => ({
  /**
   * Off: a hold answers synchronously inside `mutate` (most tests). On: it
   * waits in `pending` until a test settles it — a hold still in flight
   * when something else lands, as on a real network.
   */
  holdDeferral: {
    on: false,
    pending: [] as Array<{
      input: unknown;
      options: {
        onSuccess?: (data: unknown) => void;
        onError?: (error: unknown) => void;
      };
    }>,
  },
  createCheckoutMutateAsync: vi.fn(),
  releaseMutate: vi.fn(),
  // The late hold's release goes through mutateAsync (+ .catch), not mutate.
  releaseMutateAsync: vi.fn((_vars: unknown) => Promise.resolve({ released: true })),
  confirmMutate: vi.fn(),
  confirmOptions: {
    current: null as null | {
      onMutate?: () => void;
      onSuccess?: (data: {
        orderId: string;
        outcome: "confirmed" | "processing";
      }) => void;
      onError?: (error: unknown, variables: unknown) => void;
    },
  },
  holdServer: { current: null as null | ((input: unknown) => unknown) },
  charges: [] as Array<{ paymentIntentCents: number; feeWaivedCents: number; buyerFeesCents: number }>,
}));

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));
// Records what the page asks of the unload release (item: a redirect
// payment or a paid order must not be released on leaving).
const cartRelease = vi.hoisted(() => ({
  last: null as null | { orderId: string | null; suppressRelease?: boolean },
}));
vi.mock("@/hooks/useCartRecovery", () => ({
  useCartRelease: (
    orderId: string | null,
    _eventId: string,
    options: { suppressRelease?: boolean } = {},
  ) => {
    cartRelease.last = { orderId, suppressRelease: options.suppressRelease };
  },
}));
const trace = vi.hoisted(() => ({
  labels: [] as string[],
  errors: [] as unknown[],
}));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => (err: unknown) => {
    trace.labels.push(label);
    trace.errors.push(err);
  },
}));
// The Stripe redirect return verifies its PaymentIntent with Stripe.js.
const stripeJs = vi.hoisted(() => ({
  retrievePaymentIntent: (async () => ({})) as (
    secret: string,
  ) => Promise<unknown>,
  /** Stripe.js failed to load (blocked, offline): getStripe() → null. */
  unavailable: false,
  /** Stripe.js still loading: getStripe() answers with this instead. */
  loading: null as null | Promise<unknown>,
}));
vi.mock("@/config/stripe", () => ({
  getStripe: () =>
    stripeJs.loading ??
    Promise.resolve(
      stripeJs.unavailable
        ? null
        : {
            retrievePaymentIntent: (secret: string) =>
              stripeJs.retrievePaymentIntent(secret),
          },
    ),
}));
// The contact form's phone read can be made to throw (autoSaveProfile).
const contactForm = vi.hoisted(() => ({ throwOnRead: false }));
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
        listEventSeatAvailability: query(),
        getCheckoutFeeRates: query(),
        // Like tRPC: a DISABLED query has no data for a key it never
        // fetched (each quantity change is a new key).
        estimateCheckoutTax: {
          useQuery: (_input: unknown, options?: { enabled?: boolean }) => ({
            data:
              options?.enabled === false
                ? undefined
                : { taxRateBps: 888, taxAmountCents: 0 },
          }),
        },
      },
      humans: { getMyProfile: query(), updateProfile: mutation() },
      orders: {
        getActiveCartHolds: query({ carts: [] }),
        createCheckout: mutation(createCheckoutMutateAsync),
        // A fresh hold: the "server" prices the lines and the hook's
        // onSuccess receives the held order, as tRPC would hand it over.
        updateOrderItems: {
          useMutation: (options: {
            onSuccess?: (data: unknown) => void;
            onError?: (error: unknown) => void;
          }) => ({
            mutate: (input: unknown) => {
              if (holdDeferral.on) {
                holdDeferral.pending.push({ input, options });
                return;
              }
              options.onSuccess?.(holdServer.current!(input));
            },
            mutateAsync: vi.fn(),
            isPending: false,
          }),
        },
        releaseCartHold: {
          useMutation: () => ({
            mutate: releaseMutate,
            mutateAsync: releaseMutateAsync,
            isPending: false,
          }),
        },
        // Records what was confirmed and plays onMutate, as tRPC does; a
        // test plays the server's answer through `confirmOptions`.
        confirmPayment: {
          useMutation: (options: typeof confirmOptions.current) => {
            confirmOptions.current = options;
            return {
              mutate: (input: unknown) => {
                confirmMutate(input);
                options?.onMutate?.();
              },
              mutateAsync: vi.fn(),
              isPending: false,
            };
          },
        },
      },
    },
  };
});

import {
  estimateHeldOrderCharge,
  type FeeRatesForOrderEstimate,
} from "@/lib/pricing/order-estimate";
import { feeWaivedCentsFor } from "@/lib/pricing/fee-waiver";
import { checkoutScreen } from "./checkout-screen";
import {
  HOLD_RESET_DURING_CHECKOUT,
  PURCHASE_ALREADY_SETTLED,
  checkoutStateReducer,
  useCheckoutState,
  type TicketTypeSummary,
} from "./useCheckoutState";
import { useCheckoutDisplayTotal } from "./useCheckoutDisplayTotal";
import {
  STRIPE_VERIFY_TIMEOUT_MS,
  redirectPaymentIntentId,
  useStripeRedirectReturn,
} from "./useStripeRedirectReturn";
import { hasStripeRedirectParams } from "@/lib/stripe-redirect-return";

const tier = (id: string, name: string): TicketTypeSummary => ({
  id,
  name,
  priceCents: PRICES[id]!,
  capacity: 100,
  remainingCapacity: 100,
  seatSectionId: null,
  layoutSectionId: null,
  pricingMode: "FIXED",
});

const FEE_RATES: FeeRatesForOrderEstimate = {
  feeMode: "PASS_THROUGH",
  admissionTaxRateBps: 888,
  taxImpositions: TAX_LINES,
  processorPct: PROCESSOR_PCT,
  processorFixedCents: PROCESSOR_FIXED_CENTS,
  maxPlatformFeeCents: null,
  // The held solve reads none of these; the type requires the field.
  perTicketEstimates: [],
};

const CART: Line[] = [
  { ticketTypeId: GA_ID, qty: 2 },
  { ticketTypeId: VIP_ID, qty: 1 },
];
const CODES = ["WELCOME10"];

const formatPrice = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const POST_CHECKOUT = new Set(["paying", "confirming", "confirmed", "done"]);

/**
 * Checkout.tsx's wiring of step 2's total: the hook's order, the held charge
 * solve over it with the live discount, and the display-total hook (which the
 * summary's total row, the mobile button and the live region all print).
 */
const DEFAULT_TIERS = [tier(GA_ID, "GA"), tier(VIP_ID, "VIP")];

function useStepTwo(
  ticketTypes: TicketTypeSummary[] = DEFAULT_TIERS,
  overrides: Partial<Parameters<typeof useCheckoutState>[0]> = {},
) {
  const state = useCheckoutState({
    ...overrides,
    event: { id: EVENT_ID, slug: "gallery-walk" },
    ticketTypes,
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
        getPhone: () => {
          if (contactForm.throwOnRead) throw new Error("contact form gone");
          return null;
        },
      },
    } as never,
    onSignInRequired: () => {},
    currentUrl: "/events/checkout/gallery-walk",
    termsAccepted: true,
    refundPolicyAccepted: true,
  });
  // What the promo preview returns for this cart and these codes.
  const livePromoDiscountCents = discountFor(CART, state.promoCodes);
  const feeMode = state.order?.feeMode ?? FEE_RATES.feeMode;
  const heldCharge =
    state.order && !POST_CHECKOUT.has(state.phase)
      ? estimateHeldOrderCharge(
          FEE_RATES,
          { ...state.order, feeMode },
          livePromoDiscountCents,
        )
      : null;
  const { displayTotalCents } = useCheckoutDisplayTotal({
    heldCharge,
    order: state.order,
    phase: state.phase,
    isDisplaySubtotalKnown: true,
    displaySubtotalCents: 0,
    livePromoDiscountCents,
    taxEstimate: null,
    feeMode,
    formatPrice,
  });
  return { state, displayTotalCents };
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  charges.length = 0;
  releaseMutate.mockReset();
  releaseMutateAsync.mockReset();
  releaseMutateAsync.mockImplementation(() => Promise.resolve({ released: true }));
  confirmMutate.mockReset();
  holdDeferral.on = false;
  holdDeferral.pending.length = 0;
  trace.labels.length = 0;
  trace.errors.length = 0;
  contactForm.throwOnRead = false;
  cartRelease.last = null;
  stripeJs.unavailable = false;
  stripeJs.loading = null;
  holdServer.current = (input) => {
    const { items } = input as { items: Line[] };
    const priced = priceLines(items);
    return {
      order: {
        id: HOLD_ID,
        eventId: EVENT_ID,
        buyerHumanId: "buyer",
        amountGrossCents: priced.grossCents,
        feesPlatformCents: priced.feesPlatformCents,
        buyerFeesCents: priced.buyerFeesCents,
        processorFeeCents: 0,
        currency: "usd",
        status: "PENDING",
        items: priced.lines,
      },
      holdExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  };
  createCheckoutMutateAsync.mockReset();
  createCheckoutMutateAsync.mockImplementation(async (input: unknown) => {
    const { items, promoCodes } = input as {
      items: Line[];
      promoCodes?: string[];
    };
    const priced = priceLines(items);
    const amountGrossAfterDiscount =
      priced.grossCents - discountFor(items, promoCodes ?? []);
    const { taxCents, processorFeeCents } = solveTaxLinesAndProcessorFee({
      taxableGrossCents: amountGrossAfterDiscount,
      buyerPlatformFeeCents: priced.buyerFeesCents,
      taxLines: TAX_LINES,
      passThrough: true,
      processorPct: PROCESSOR_PCT,
      processorFixedCents: PROCESSOR_FIXED_CENTS,
    });
    const paymentIntentCents =
      amountGrossAfterDiscount + priced.buyerFeesCents + taxCents + processorFeeCents;
    charges.push({
      paymentIntentCents,
      feeWaivedCents: priced.feeWaivedCents,
      buyerFeesCents: priced.buyerFeesCents,
    });
    return {
      orderId: CHARGED_ID,
      clientSecret: "pi_secret",
      amountGrossCents: amountGrossAfterDiscount,
      feesPlatformCents: priced.feesPlatformCents,
      buyerFeesCents: priced.buyerFeesCents,
      processorFeeCents,
      taxAmountCents: taxCents,
      creditAppliedCents: 0,
      feeMode: "PASS_THROUGH",
      feeWaivedCents: priced.feeWaivedCents,
      holdExpiresAt: null,
    };
  });
});

/** Select the cart, type the code, take a fresh hold, then createCheckout. */
async function reachPayment() {
  const rendered = renderHook(() => useStepTwo());
  const { result } = rendered;
  act(() => {
    result.current.state.handleQuantityChange(GA_ID, 2);
    result.current.state.handleQuantityChange(VIP_ID, 1);
  });
  act(() => {
    result.current.state.handleApplyPromoCode("WELCOME10");
  });
  await act(async () => {
    await result.current.state.handleHoldTickets();
  });
  expect(result.current.state.phase).toBe("held");
  const freshHoldTotalCents = result.current.displayTotalCents;

  await act(async () => {
    await result.current.state.handleCheckout();
  });
  expect(result.current.state.phase).toBe("paying");
  return { ...rendered, freshHoldTotalCents };
}

/**
 * Reach the payment step on a createCheckout order whose hold runs out in
 * 60s. Only the clock and the countdown's interval are faked; promises
 * resolve normally.
 */
async function reachPaymentExpiringIn60s() {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const charge = createCheckoutMutateAsync.getMockImplementation()!;
  createCheckoutMutateAsync.mockImplementationOnce(async (input: unknown) => ({
    ...(await charge(input)),
    holdExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  const reached = await reachPayment();
  expect(reached.result.current.state.countdown).not.toBeNull();
  return { ...reached, charge };
}

describe("useCheckoutState — step 2 after leaving the payment step shows the charge", () => {
  it("sanity: a fresh hold's step 2 equals createCheckout's PaymentIntent", async () => {
    const { freshHoldTotalCents } = await reachPayment();
    expect(freshHoldTotalCents).toBe(charges[0]!.paymentIntentCents);
  });

  it("regression: back to details → step 2's total equals a re-run createCheckout's PaymentIntent (no second discount)", async () => {
    const { result, freshHoldTotalCents } = await reachPayment();

    act(() => result.current.state.handleBackToHeld());
    expect(result.current.state.phase).toBe("held");
    const stepTwoTotalCents = result.current.displayTotalCents;

    const shownGrossCents = result.current.state.order?.amountGrossCents;
    // createCheckout's tax was solved on the DISCOUNTED base — not step 2's.
    expect(result.current.state.order?.taxAmountCents).toBeUndefined();
    // The waiver step 2 explains, and the buyer fee it shows, are the
    // charge's.
    const shownWaiverCents = feeWaivedCentsFor(result.current.state.order);
    const shownBuyerFeesCents = result.current.state.order?.buyerFeesCents;

    await act(async () => {
      await result.current.state.handleCheckout();
    });
    const rerun = charges.at(-1)!;
    expect(charges).toHaveLength(2);
    expect(stepTwoTotalCents).toBe(rerun.paymentIntentCents);
    expect(stepTwoTotalCents).toBe(freshHoldTotalCents);
    // The step-2 rows start from the PRE-discount gross, as a fresh hold's.
    expect(shownGrossCents).toBe(priceLines(CART).grossCents);
    expect(shownWaiverCents).toBe(rerun.feeWaivedCents);
    expect(shownBuyerFeesCents).toBe(rerun.buyerFeesCents);
    // The codes step 2 shows are the ones the re-run charges with.
    const rerunInput = createCheckoutMutateAsync.mock.calls.at(-1)![0] as {
      promoCodes?: string[];
      pendingOrderId?: string;
    };
    expect(rerunInput.promoCodes).toEqual(CODES);
    expect(result.current.state.promoCodes).toEqual(CODES);
    expect(rerunInput.pendingOrderId).toBe(CHARGED_ID);
  });

  it("back to details carries no stamped credit (a fresh hold shows none; the held total is pre-credit)", async () => {
    const charge = createCheckoutMutateAsync.getMockImplementation()!;
    createCheckoutMutateAsync.mockImplementation(async (input: unknown) => ({
      ...(await charge(input)),
      creditAppliedCents: 1000,
    }));
    const { result } = await reachPayment();
    expect(result.current.state.order?.creditAppliedCents).toBe(1000);

    act(() => result.current.state.handleBackToHeld());
    expect(result.current.state.order?.creditAppliedCents).toBe(0);
  });

  it("regression: a declined card (back on details) → step 2's total equals the re-run's PaymentIntent", async () => {
    const { result } = await reachPayment();

    act(() => result.current.state.handlePaymentError("Your card was declined."));
    expect(result.current.state.phase).toBe("held");
    const stepTwoTotalCents = result.current.displayTotalCents;

    await act(async () => {
      await result.current.state.handleCheckout();
    });
    expect(stepTwoTotalCents).toBe(charges.at(-1)!.paymentIntentCents);
  });
});

describe("useCheckoutState — step 1 after 'Back to tickets' keeps its tax estimate", () => {
  it("regression: back to tickets, change the quantity → the tax estimate (the 'Taxes (8.88%)' rate) is still there", async () => {
    const rendered = renderHook(() => useStepTwo());
    const { result } = rendered;
    act(() => {
      result.current.state.handleQuantityChange(GA_ID, 2);
      result.current.state.handleQuantityChange(VIP_ID, 1);
    });
    await act(async () => {
      await result.current.state.handleHoldTickets();
    });
    expect(result.current.state.phase).toBe("held");

    act(() => result.current.state.handleBackToSelecting());
    act(() => result.current.state.handleQuantityChange(GA_ID, 1));
    expect(result.current.state.phase).toBe("selecting");
    // What the summary's and the tray's "Taxes (8.88%)" label read.
    expect(result.current.state.taxEstimateQuery.data?.taxRateBps).toBe(888);
  });

  it("regression: the hold expires on step 2 (auto-reset, HOLD_FAILED) → step 1 with no order, and the tax estimate back on", async () => {
    const takeHold = holdServer.current!;
    // A hold that is already past its expiry: the countdown's first tick
    // flags it, and the auto-reset sends the buyer back to step 1.
    holdServer.current = (input) => ({
      ...(takeHold(input) as object),
      holdExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const { result } = renderHook(() => useStepTwo());
    act(() => {
      result.current.state.handleQuantityChange(GA_ID, 2);
    });
    await act(async () => {
      await result.current.state.handleHoldTickets();
    });
    expect(result.current.state.phase).toBe("selecting");
    expect(result.current.state.order).toBeNull();

    act(() => result.current.state.handleQuantityChange(VIP_ID, 1));
    expect(result.current.state.taxEstimateQuery.data?.taxRateBps).toBe(888);
  });
});

describe("useCheckoutState — the hold resets while the charge is in flight", () => {
  const RERUN_ID = "66666666-6666-4666-8666-666666666666";


  it("regression: Pay → createCheckout pending → the hold expires → it resolves: step 1, no order, the minted order released (never 'paying' with no order)", async () => {
    const { result, charge } = await reachPaymentExpiringIn60s();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    createCheckoutMutateAsync.mockImplementationOnce(async (input: unknown) => {
      const response = await charge(input);
      await gate;
      return { ...response, orderId: RERUN_ID };
    });

    // Pay on the payment step re-runs createCheckout (phase stays "paying");
    // the call is out — the server is minting the order.
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.state.handleCheckout().catch((e: unknown) => e);
    });
    expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(2);
    expect(result.current.state.phase).toBe("paying");

    // The hold runs out mid-call: the auto-reset puts the buyer on step 1.
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(result.current.state.phase).toBe("selecting");

    let thrown: unknown;
    await act(async () => {
      openGate();
      thrown = await pending;
    });
    expect((thrown as Error).message).toBe(HOLD_RESET_DURING_CHECKOUT);
    expect(result.current.state.phase).toBe("selecting");
    expect(result.current.state.order).toBeNull();
    expect(result.current.state.countdown).toBeNull();
    expect(releaseMutate).toHaveBeenCalledWith({ orderId: RERUN_ID });

    // Nothing points at the released order: the next hold is a fresh one.
    const holdInputs: unknown[] = [];
    const takeHold = holdServer.current!;
    holdServer.current = (input) => {
      holdInputs.push(input);
      return takeHold(input);
    };
    await act(async () => {
      await result.current.state.handleHoldTickets();
    });
    expect(holdInputs).toHaveLength(1);
    expect((holdInputs[0] as { orderId?: string }).orderId).toBeUndefined();
  });

  it("the hold expires before createCheckout is even sent (during the sign-unlock await): nothing is minted, nothing dispatched", async () => {
    const { result } = await reachPaymentExpiringIn60s();
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.state.handleCheckout().catch((e: unknown) => e);
      // Still inside the call's first await when the hold runs out.
      vi.advanceTimersByTime(61_000);
    });
    let thrown: unknown;
    await act(async () => {
      thrown = await pending;
    });
    expect((thrown as Error).message).toBe(HOLD_RESET_DURING_CHECKOUT);
    expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe("selecting");
    expect(result.current.state.order).toBeNull();
  });

  it("regression: the hold expires on the payment step, THEN the card confirm rejects: still step 1 with no order (not the held step with none)", async () => {
    const { result } = await reachPaymentExpiringIn60s();
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(result.current.state.phase).toBe("selecting");

    act(() => result.current.state.handlePaymentError("Your card was declined."));
    expect(result.current.state.phase).toBe("selecting");
    expect(result.current.state.order).toBeNull();
    expect(result.current.state.errorMessage).toBeTruthy();
  });
});

describe("useCheckoutState — 'Release and go back' takes the hold's countdown with it", () => {
  it("regression: back to tickets → no countdown (the header's 'remaining' and the summary's 'Reserved for' read it)", async () => {
    const { result } = renderHook(() => useStepTwo());
    act(() => {
      result.current.state.handleQuantityChange(GA_ID, 2);
    });
    await act(async () => {
      await result.current.state.handleHoldTickets();
    });
    expect(result.current.state.phase).toBe("held");
    expect(result.current.state.countdown).not.toBeNull();

    act(() => result.current.state.handleBackToSelecting());
    expect(result.current.state.phase).toBe("selecting");
    expect(result.current.state.countdown).toBeNull();
    expect(result.current.state.isHoldActive).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Money-safety round: a charge Stripe made is always confirmed; nothing
// releases the order being paid; late results after a reset say nothing.
// ─────────────────────────────────────────────────────────────────────────────

const H2_ID = "77777777-7777-4777-8777-777777777777";
const FREE_ID = "88888888-8888-4888-8888-888888888888";
const MINTED_ID = "99999999-9999-4999-8999-999999999999";

/** A held cart (GA × 2) on step 2; optionally its hold runs out in 60s. */
async function reachHeld(opts: { expiringIn60s?: boolean } = {}) {
  if (opts.expiringIn60s) {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const takeHold = holdServer.current!;
    holdServer.current = (input) => ({
      ...(takeHold(input) as object),
      holdExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }
  const rendered = renderHook(() => useStepTwo());
  act(() => {
    rendered.result.current.state.handleQuantityChange(GA_ID, 2);
  });
  await act(async () => {
    await rendered.result.current.state.handleHoldTickets();
  });
  expect(rendered.result.current.state.phase).toBe("held");
  return rendered;
}

/** The next createCheckout waits for `open()`, then answers with `answer`. */
function gateNextCheckout(answer: (input: unknown) => Promise<unknown>) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  createCheckoutMutateAsync.mockImplementationOnce(async (input: unknown) => {
    await gate;
    return answer(input);
  });
  return () => open();
}

/** The next holds answer with order id `id` (on top of the current server). */
function withHoldId(id: string) {
  const takeHold = holdServer.current!;
  holdServer.current = (input) => {
    const held = takeHold(input) as { order: object };
    return { ...held, order: { ...held.order, id } };
  };
}

/** Settle the oldest deferred hold: the server's answer, or a refusal. */
function settleHold(outcome: "success" | { error: string }) {
  const next = holdDeferral.pending.shift()!;
  if (outcome === "success") {
    next.options.onSuccess?.(holdServer.current!(next.input));
  } else {
    next.options.onError?.(new Error(outcome.error));
  }
}

/**
 * A free claim is in flight; the hold expires; the buyer re-picks and takes
 * H2 — which is still IN FLIGHT when the free result lands.
 */
async function freeClaimLandsWhileH2InFlight() {
  const rendered = await reachHeld({ expiringIn60s: true });
  const { result } = rendered;
  const charge = createCheckoutMutateAsync.getMockImplementation()!;
  const open = gateNextCheckout(async (input) => ({
    ...((await charge(input)) as object),
    orderId: FREE_ID,
    clientSecret: null,
  }));
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = result.current.state.handleCheckout().catch((e: unknown) => e);
  });
  act(() => {
    vi.advanceTimersByTime(61_000);
  });
  expect(result.current.state.phase).toBe("selecting");

  withHoldId(H2_ID);
  holdDeferral.on = true;
  act(() => result.current.state.handleQuantityChange(VIP_ID, 1));
  await act(async () => {
    await result.current.state.handleHoldTickets();
  });
  expect(result.current.state.phase).toBe("holding");
  expect(holdDeferral.pending).toHaveLength(1);

  await act(async () => {
    open();
    await pending;
  });
  expect(result.current.state.phase).toBe("confirmed");
  return rendered;
}

describe("useCheckoutState — a charge Stripe made is always confirmed", () => {
  it("regression: the hold auto-resets during the confirm (3-D Secure outlasting it), THEN Stripe succeeds → confirmPayment is sent for the charged order and the page lands on confirming → confirmed", async () => {
    const { result } = await reachPaymentExpiringIn60s();
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(result.current.state.phase).toBe("selecting");
    expect(result.current.state.orderId).toBeNull();

    act(() => result.current.state.handlePaymentSuccess("pi_x"));
    expect(confirmMutate).toHaveBeenCalledWith({
      orderId: CHARGED_ID,
      paymentIntentId: "pi_x",
    });
    expect(result.current.state.phase).toBe("confirming");

    act(() => confirmOptions.current?.onSuccess?.({ orderId: CHARGED_ID, outcome: "confirmed" }));
    expect(result.current.state.phase).toBe("confirmed");
    expect(result.current.state.orderId).toBe(CHARGED_ID);
  });

  it("…and if confirmPayment errors, the terminal 'received' screen is for the charged order (not 'no order')", async () => {
    const { result } = await reachPaymentExpiringIn60s();
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    act(() => result.current.state.handlePaymentSuccess("pi_x"));
    act(() =>
      confirmOptions.current?.onError?.(
        new Error("network"),
        // tRPC hands onError the variables the mutation was called with.
        confirmMutate.mock.calls.at(-1)![0],
      ),
    );
    expect(result.current.state.phase).toBe("confirmed");
    expect(result.current.state.orderId).toBe(CHARGED_ID);
    // The interstitial, not the confirmation with step 4 "Confirmed".
    expect(result.current.state.isPaymentReceivedUnconfirmed).toBe(true);
    expect(result.current.state.unconfirmedPaymentOutcome).toBe("received");
  });

  it("regression: while a Stripe confirm is submitting, the hold is NOT auto-reset under it; once it stops (the confirm failed), the reset runs", async () => {
    const { result } = await reachPaymentExpiringIn60s();
    act(() => result.current.state.handlePaymentSubmittingChange(true));
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(result.current.state.phase).toBe("paying");

    act(() => result.current.state.handlePaymentSubmittingChange(false));
    expect(result.current.state.phase).toBe("selecting");
  });
});

describe("useCheckoutState — nothing releases the order being paid", () => {
  it("regression: mid-submit, 'Change tickets' / the stepper's way back do nothing — no release, no step change", async () => {
    const { result } = await reachPayment();
    act(() => result.current.state.handlePaymentSubmittingChange(true));
    expect(result.current.state.isBackNavigationLocked).toBe(true);

    act(() => result.current.state.handleBackToSelecting());
    act(() => result.current.state.handleBackToHeld());
    expect(releaseMutate).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("paying");
  });

  it("regression: while confirming, 'back' releases nothing", async () => {
    const { result } = await reachPayment();
    act(() => result.current.state.handlePaymentSuccess("pi_x"));
    expect(result.current.state.phase).toBe("confirming");
    expect(result.current.state.isBackNavigationLocked).toBe(true);

    act(() => result.current.state.handleBackToSelecting());
    expect(releaseMutate).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("confirming");
  });

  it("not submitting, on the payment step: the way back still works (and releases the createCheckout order)", async () => {
    const { result } = await reachPayment();
    expect(result.current.state.isBackNavigationLocked).toBe(false);
    act(() => result.current.state.handleBackToSelecting());
    expect(releaseMutate).toHaveBeenCalledWith({ orderId: CHARGED_ID });
    expect(result.current.state.phase).toBe("selecting");
  });
});

describe("useCheckoutState — late createCheckout results after a reset", () => {
  it("regression: 'Back to tickets' is refused while createCheckout runs (a free claim confirms mid-call); the expiry reset then releases the order the call mints — exactly once", async () => {
    const { result } = await reachHeld({ expiringIn60s: true });
    const charge = createCheckoutMutateAsync.getMockImplementation()!;
    const open = gateNextCheckout(async (input) => ({
      ...((await charge(input)) as object),
      orderId: MINTED_ID,
    }));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.state.handleCheckout().catch((e: unknown) => e);
    });
    expect(result.current.state.phase).toBe("creating");
    expect(result.current.state.isBackNavigationLocked).toBe(true);

    // Back mid-call: refused — nothing released, still creating.
    act(() => result.current.state.handleBackToSelecting());
    expect(releaseMutate).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("creating");

    // The hold runs out instead (the expired hold is reaped server-side).
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(result.current.state.phase).toBe("selecting");
    let thrown: unknown;
    await act(async () => {
      open();
      thrown = await pending;
    });
    expect((thrown as Error).message).toBe(HOLD_RESET_DURING_CHECKOUT);
    expect(releaseMutate.mock.calls).toEqual([[{ orderId: MINTED_ID }]]);

    // Nothing left pointing at it: "back" releases nothing more.
    act(() => result.current.state.handleBackToSelecting());
    expect(releaseMutate).toHaveBeenCalledTimes(1);
  });

  it("regression: a createCheckout that FAILS after the hold expired leaves 'Hold expired' on screen (not overwritten)", async () => {
    const { result } = await reachHeld({ expiringIn60s: true });
    const open = gateNextCheckout(async () => {
      throw new Error("Your hold has expired");
    });
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.state.handleCheckout().catch((e: unknown) => e);
    });
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(result.current.state.errorMessage).toBe("checkout.holdExpired");
    await act(async () => {
      open();
      await pending;
    });
    expect(result.current.state.errorMessage).toBe("checkout.holdExpired");
  });

  it("regression: a FREE order confirmed after the hold EXPIRED and the buyer took a NEWER hold (H2): H2 is released, the confirmation is the free order's (its lines, its selection), not H2's", async () => {
    const { result } = await reachHeld({ expiringIn60s: true });
    const heldLines = result.current.state.order!.items;
    const charge = createCheckoutMutateAsync.getMockImplementation()!;
    const open = gateNextCheckout(async (input) => ({
      ...((await charge(input)) as object),
      orderId: FREE_ID,
      clientSecret: null,
    }));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.state.handleCheckout().catch((e: unknown) => e);
    });

    // The hold expires mid-call; the buyer picks more and takes H2.
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(result.current.state.phase).toBe("selecting");
    withHoldId(H2_ID);
    act(() => result.current.state.handleQuantityChange(VIP_ID, 1));
    await act(async () => {
      await result.current.state.handleHoldTickets();
    });
    expect(result.current.state.order?.id).toBe(H2_ID);

    await act(async () => {
      open();
      await pending;
    });
    expect(releaseMutate.mock.calls).toEqual([[{ orderId: H2_ID }]]);
    expect(result.current.state.phase).toBe("confirmed");
    expect(result.current.state.orderId).toBe(FREE_ID);
    expect(result.current.state.order?.id).toBe(FREE_ID);
    expect(result.current.state.order?.items).toEqual(heldLines);
    expect(result.current.state.quantities).toEqual({ [GA_ID]: 2, [VIP_ID]: 0 });
    // Nothing points at H2 any more.
    act(() => result.current.state.handleBackToSelecting());
    expect(releaseMutate).toHaveBeenCalledTimes(1);
  });

  it("regression: a credit-covered order confirmed after the hold EXPIRED: the confirmation has the order (with its credit), not a pre-hold estimate as a cash total", async () => {
    const { result } = await reachHeld({ expiringIn60s: true });
    const charge = createCheckoutMutateAsync.getMockImplementation()!;
    const open = gateNextCheckout(async (input) => {
      const paid = (await charge(input)) as {
        amountGrossCents: number;
        buyerFeesCents: number;
        taxAmountCents: number;
      };
      return {
        ...paid,
        orderId: FREE_ID,
        clientSecret: null,
        processorFeeCents: 0,
        creditAppliedCents:
          paid.amountGrossCents + paid.buyerFeesCents + paid.taxAmountCents,
      };
    });
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.state.handleCheckout().catch((e: unknown) => e);
    });
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(result.current.state.order).toBeNull();

    await act(async () => {
      open();
      await pending;
    });
    const order = result.current.state.order;
    expect(result.current.state.phase).toBe("confirmed");
    expect(order?.id).toBe(FREE_ID);
    // What the confirmation totals: gross + fees + tax − credit = $0.
    expect(
      order!.amountGrossCents +
        order!.buyerFeesCents +
        (order!.taxAmountCents ?? 0) -
        (order!.creditAppliedCents ?? 0),
    ).toBe(0);
  });
});

describe("checkout reducer — no order on screen means no checkout transition", () => {
  const stepOne = {
    phase: "selecting" as const,
    orderId: null,
    order: null,
    holdExpiresAt: null,
    clientSecret: null,
    errorMessage: "checkout.holdExpired",
    payment: "unknown" as const,
  };
  type Act = Parameters<typeof checkoutStateReducer>[1];

  it("CHECKOUT_STARTED with no order leaves step 1 as it is (never 'creating')", () => {
    expect(
      checkoutStateReducer(stepOne, { type: "CHECKOUT_STARTED" } as Act),
    ).toBe(stepOne);
  });

  it("CHECKOUT_SUCCEEDED with no order leaves step 1 as it is (never 'paying' with no order)", () => {
    expect(
      checkoutStateReducer(stepOne, {
        type: "CHECKOUT_SUCCEEDED",
        orderId: MINTED_ID,
        order: { amountGrossCents: 1 },
        holdExpiresAt: null,
        clientSecret: "pi_secret",
      } as Act),
    ).toBe(stepOne);
  });

  it("CHECKOUT_FAILED with no order only sets the message (never the held step with none)", () => {
    const next = checkoutStateReducer(stepOne, {
      type: "CHECKOUT_FAILED",
      error: "declined",
    } as Act);
    expect(next).toEqual({ ...stepOne, errorMessage: "declined" });
  });
});

describe("useCheckoutState — a hold that finishes after the purchase settled", () => {
  it("regression: H2 SUCCEEDS after the free confirmation → it is released; the confirmation stays (no held step, no second claim)", async () => {
    const { result } = await freeClaimLandsWhileH2InFlight();
    act(() => settleHold("success"));
    expect(result.current.state.phase).toBe("confirmed");
    expect(result.current.state.orderId).toBe(FREE_ID);
    expect(result.current.state.order?.id).toBe(FREE_ID);
    expect(releaseMutateAsync).toHaveBeenCalledWith({ orderId: H2_ID });
    // …and it never became "the hold" back would release again.
    act(() => result.current.state.handleBackToSelecting());
    expect(releaseMutateAsync).toHaveBeenCalledTimes(1);
    expect(releaseMutate).not.toHaveBeenCalled();
  });

  it("H2's release after the free confirmation fails → reported, not lost (the cart waits for the reaper)", async () => {
    const { result } = await freeClaimLandsWhileH2InFlight();
    const failure = new Error("network");
    releaseMutateAsync.mockImplementationOnce(() => Promise.reject(failure));
    trace.labels.length = 0;
    trace.errors.length = 0;
    await act(async () => settleHold("success"));
    expect(releaseMutateAsync.mock.calls).toEqual([[{ orderId: H2_ID }]]);
    // Reported on the REJECTION (a per-call onError is dropped by TanStack
    // when the observer has a newer mutate), not via an options argument.
    expect(trace.labels).toEqual(["checkout.lateHoldRelease"]);
    expect(trace.errors).toEqual([failure]);
    expect(result.current.state.phase).toBe("confirmed");
  });

  it("regression: H2 FAILS after the free confirmation → no 'sold out' over tickets the buyer owns; the confirmation stays", async () => {
    const { result } = await freeClaimLandsWhileH2InFlight();
    act(() => settleHold({ error: "sold_out" }));
    expect(result.current.state.phase).toBe("confirmed");
    expect(result.current.state.errorMessage).toBeNull();
    expect(result.current.state.order?.id).toBe(FREE_ID);
  });

  it("no new hold is even sent once the purchase settled", async () => {
    const { result } = await freeClaimLandsWhileH2InFlight();
    act(() => settleHold("success"));
    holdDeferral.on = false;
    const holdInputs: unknown[] = [];
    const takeHold = holdServer.current!;
    holdServer.current = (input) => {
      holdInputs.push(input);
      return takeHold(input);
    };
    await act(async () => {
      await result.current.state.handleHoldTickets();
    });
    expect(holdInputs).toHaveLength(0);
    expect(result.current.state.phase).toBe("confirmed");
  });

  it("reducer floor: HOLD_STARTED / HOLD_SUCCEEDED / HOLD_FAILED leave a confirmed page as it is", () => {
    type Act = Parameters<typeof checkoutStateReducer>[1];
    const confirmed = {
      phase: "confirmed" as const,
      orderId: FREE_ID,
      order: null,
      holdExpiresAt: null,
      clientSecret: null,
      errorMessage: null,
      payment: "paid" as const,
    };
    for (const action of [
      { type: "HOLD_STARTED" },
      { type: "HOLD_SUCCEEDED", orderId: H2_ID, order: {}, holdExpiresAt: null },
      { type: "HOLD_FAILED", error: "sold out" },
    ]) {
      expect(checkoutStateReducer(confirmed, action as Act)).toBe(confirmed);
    }
  });
});

describe("useCheckoutState — the free-race restore covers seats and amounts", () => {
  const PWYW_TIER: TicketTypeSummary = {
    id: PWYW_TIER_ID,
    name: "Pay what you want",
    priceCents: 0,
    capacity: 100,
    remainingCapacity: 100,
    seatSectionId: null,
    layoutSectionId: null,
    pricingMode: "ADJUSTABLE",
    minimumCents: 0,
    suggestedCents: 1500,
  };
  const SEATED_TIER: TicketTypeSummary = {
    ...tier(SEATED_TIER_ID, "Reserved"),
    seatSectionId: "sec-1",
  };

  it("regression: the confirmation shows the CLAIMED seats and pay-what-you-want amount, not the ones re-picked for H2", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const takeHold = holdServer.current!;
    holdServer.current = (input) => ({
      ...(takeHold(input) as object),
      holdExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { result } = renderHook(() =>
      useStepTwo([...DEFAULT_TIERS, PWYW_TIER, SEATED_TIER]),
    );
    act(() => {
      result.current.state.handleQuantityChange(PWYW_TIER_ID, 1);
      result.current.state.handleDonationAmountChange(PWYW_TIER_ID, 2000);
      result.current.state.handleSeatToggle("seat-A1", "sec-1");
    });
    await act(async () => {
      await result.current.state.handleHoldTickets();
    });
    expect(result.current.state.phase).toBe("held");

    const charge = createCheckoutMutateAsync.getMockImplementation()!;
    const open = gateNextCheckout(async (input) => ({
      ...((await charge(input)) as object),
      orderId: FREE_ID,
      clientSecret: null,
    }));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.state.handleCheckout().catch((e: unknown) => e);
    });
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(result.current.state.phase).toBe("selecting");

    // Re-pick for H2: another seat, another amount.
    act(() => {
      result.current.state.handleDonationAmountChange(PWYW_TIER_ID, 500);
      result.current.state.handleSeatToggle("seat-A1", "sec-1");
      result.current.state.handleSeatToggle("seat-B7", "sec-1");
    });
    expect(result.current.state.selectedSeatIds[SEATED_TIER_ID]).toEqual(["seat-B7"]);

    await act(async () => {
      open();
      await pending;
    });
    expect(result.current.state.phase).toBe("confirmed");
    expect(result.current.state.selectedSeatIds[SEATED_TIER_ID]).toEqual(["seat-A1"]);
    expect(result.current.state.donationAmounts[PWYW_TIER_ID]).toBe(2000);
    expect(result.current.state.quantities[SEATED_TIER_ID]).toBe(1);
  });
});

describe("useCheckoutState — a confirmed page stays confirmed", () => {
  type Act = Parameters<typeof checkoutStateReducer>[1];
  type ReducerState = Parameters<typeof checkoutStateReducer>[0];
  // WITH an order: the no-order guards would otherwise answer for the floor
  // (CHECKOUT_STARTED / CHECKOUT_SUCCEEDED already no-op without one).
  const confirmed: ReducerState = {
    phase: "confirmed",
    orderId: CHARGED_ID,
    order: {
      id: CHARGED_ID,
      eventId: EVENT_ID,
      buyerHumanId: "buyer",
      amountGrossCents: 5000,
      feesPlatformCents: 100,
      buyerFeesCents: 100,
      processorFeeCents: 190,
      currency: "usd",
      status: "PENDING",
      items: [],
    } as unknown as ReducerState["order"],
    holdExpiresAt: null,
    clientSecret: null,
    errorMessage: null,
    payment: "paid" as const,
  };

  it("reducer floor: a late CHECKOUT_STARTED / CHECKOUT_SUCCEEDED / CHECKOUT_FAILED / PAYMENT_FAILED leaves it as it is", () => {
    for (const action of [
      { type: "CHECKOUT_STARTED" },
      {
        type: "CHECKOUT_SUCCEEDED",
        orderId: MINTED_ID,
        order: { amountGrossCents: 1 },
        holdExpiresAt: null,
        clientSecret: "pi_secret",
      },
      { type: "CHECKOUT_FAILED", error: "declined" },
      { type: "PAYMENT_FAILED", error: "declined", orderId: null },
    ]) {
      expect(checkoutStateReducer(confirmed, action as Act)).toBe(confirmed);
    }
  });

  it("confirmPayment ERRORS with an order → the terminal screen counts as settled: no new hold is sent from it", async () => {
    const { result } = await reachPayment();
    act(() => result.current.state.handlePaymentSuccess("pi_x"));
    act(() =>
      confirmOptions.current?.onError?.(
        new Error("network"),
        // tRPC hands onError the variables the mutation was called with.
        confirmMutate.mock.calls.at(-1)![0],
      ),
    );
    expect(result.current.state.phase).toBe("confirmed");
    expect(result.current.state.isPaymentReceivedUnconfirmed).toBe(true);

    const holdInputs: unknown[] = [];
    const takeHold = holdServer.current!;
    holdServer.current = (input) => {
      holdInputs.push(input);
      return takeHold(input);
    };
    await act(async () => {
      await result.current.state.handleHoldTickets();
    });
    expect(holdInputs).toHaveLength(0);
    expect(result.current.state.phase).toBe("confirmed");
  });
});

describe("useCheckoutState — a Stripe success always reaches confirmPayment", () => {
  it("regression: confirmPayment is sent FIRST — a throwing profile save after it is reported, and the page still moves to confirming", async () => {
    const { result } = await reachPayment();
    contactForm.throwOnRead = true;
    act(() => result.current.state.handlePaymentSuccess("pi_x"));
    expect(confirmMutate).toHaveBeenCalledWith({
      orderId: CHARGED_ID,
      paymentIntentId: "pi_x",
    });
    expect(result.current.state.phase).toBe("confirming");
    expect(trace.labels).toContain("checkout.autoSaveProfile");
  });

  it("regression: an in-page success with no order handed to Stripe is reported and confirmed by the PaymentIntent alone (no spinner stuck forever)", async () => {
    const { result } = await reachHeld();
    act(() => result.current.state.handlePaymentSuccess("pi_orphan"));
    expect(trace.labels).toContain("checkout.paymentSuccessWithoutOrder");
    expect(confirmMutate).toHaveBeenCalledWith({ paymentIntentId: "pi_orphan" });
    expect(result.current.state.phase).toBe("confirming");
  });
});

// A US bank debit Stripe reports `processing` can still fail days later: it
// must not read as paid (owner, 2026-10-14). The page takes that from the
// confirm's answer, never from a second read.
describe("useCheckoutState — whether the money moved", () => {
  it.each([
    ["confirmed", "paid"],
    ["processing", "processing"],
  ] as const)(
    "a confirm that answers %s leaves payment %s",
    async (outcome, payment) => {
      const { result } = await reachPayment();
      expect(result.current.state.payment).toBe("unknown");
      act(() => result.current.state.handlePaymentSuccess("pi_x"));
      act(() =>
        confirmOptions.current?.onSuccess?.({ orderId: CHARGED_ID, outcome }),
      );
      expect(result.current.state.phase).toBe("confirmed");
      expect(result.current.state.payment).toBe(payment);
    },
  );

  it("a confirm that FAILS with an order goes to the terminal screen with payment unknown, never paid", async () => {
    const { result } = await reachPayment();
    act(() => result.current.state.handlePaymentSuccess("pi_x"));
    act(() =>
      confirmOptions.current?.onError?.(
        new Error("network"),
        confirmMutate.mock.calls.at(-1)![0],
      ),
    );
    expect(result.current.state.phase).toBe("confirmed");
    expect(result.current.state.payment).toBe("unknown");
    expect(result.current.state.isPaymentReceivedUnconfirmed).toBe(true);
  });

  it("a free order is paid", async () => {
    const { result } = await reachHeld();
    const charge = createCheckoutMutateAsync.getMockImplementation()!;
    createCheckoutMutateAsync.mockImplementationOnce(async (input: unknown) => ({
      ...((await charge(input)) as object),
      orderId: FREE_ID,
      clientSecret: null,
    }));
    await act(async () => {
      await result.current.state.handleCheckout();
    });
    expect(result.current.state.phase).toBe("confirmed");
    expect(result.current.state.payment).toBe("paid");
  });
});

// `payment_intent_unexpected_state` with the PaymentIntent already
// `succeeded` / `processing` is a payment Stripe accepted earlier (a confirm
// whose answer was lost, then a second press). It went to CHECKOUT_FAILED and
// read as a decline; it is confirmed with the server like any success.
describe("useCheckoutState — an already-accepted PaymentIntent is confirmed, not failed", () => {
  it.each(["succeeded", "processing"])(
    "unexpected_state with the PaymentIntent %s → confirmPayment for the charged order",
    async (status) => {
      const { result } = await reachPayment();
      act(() =>
        result.current.state.handlePaymentError(
          "already confirmed",
          "payment_intent_unexpected_state",
          status,
          "pi_accepted",
        ),
      );
      expect(confirmMutate).toHaveBeenCalledWith({
        orderId: CHARGED_ID,
        paymentIntentId: "pi_accepted",
      });
      expect(result.current.state.phase).toBe("confirming");
      expect(result.current.state.errorMessage).toBeNull();

      act(() =>
        confirmOptions.current?.onSuccess?.({
          orderId: CHARGED_ID,
          outcome: status === "processing" ? "processing" : "confirmed",
        }),
      );
      expect(result.current.state.phase).toBe("confirmed");
      expect(result.current.state.payment).toBe(
        status === "processing" ? "processing" : "paid",
      );
    },
  );

  it("with no PaymentIntent on the error, the id comes from the client secret", async () => {
    const { result } = await reachHeld();
    const charge = createCheckoutMutateAsync.getMockImplementation()!;
    createCheckoutMutateAsync.mockImplementationOnce(async (input: unknown) => ({
      ...((await charge(input)) as object),
      // gitleaks:allow (fake test fixture)
      clientSecret: "pi_3Abc_def_secret_FakeFixtureNotReal",
    }));
    await act(async () => {
      await result.current.state.handleCheckout();
    });
    expect(result.current.state.phase).toBe("paying");
    act(() =>
      result.current.state.handlePaymentError(
        "already confirmed",
        "payment_intent_unexpected_state",
        "succeeded",
      ),
    );
    expect(confirmMutate).toHaveBeenCalledWith({
      orderId: CHARGED_ID,
      paymentIntentId: "pi_3Abc_def",
    });
  });

  it("unexpected_state with the PaymentIntent canceled is still a failure: back to the held step, nothing confirmed", async () => {
    const { result } = await reachPayment();
    act(() =>
      result.current.state.handlePaymentError(
        "This PaymentIntent was canceled.",
        "payment_intent_unexpected_state",
        "canceled",
        "pi_dead",
      ),
    );
    expect(confirmMutate).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("held");
  });

  // No order handed to Stripe (`paymentOrderIdRef` empty): the confirm goes
  // by PaymentIntent alone, and if it errors the terminal copy follows what
  // Stripe said in the page. A bank debit still `processing` is "submitted",
  // never "received" (round-2 review, 2026-10-14).
  it.each([
    ["processing", "submitted"],
    ["succeeded", "received"],
  ] as const)(
    "unexpected_state %s, no order, the confirm errors → '%s'",
    async (status, outcome) => {
      const { result } = await reachHeld();
      act(() =>
        result.current.state.handlePaymentError(
          "already accepted",
          "payment_intent_unexpected_state",
          status,
          "pi_orphan",
        ),
      );
      expect(confirmMutate).toHaveBeenCalledWith({ paymentIntentId: "pi_orphan" });
      act(() =>
        confirmOptions.current?.onError?.(
          appError("INTERNAL_SERVER_ERROR", 500),
          confirmMutate.mock.calls.at(-1)![0],
        ),
      );
      expect(result.current.state.unconfirmedPaymentOutcome).toBe(outcome);
    },
  );

  // WITH an order id the confirm error used to leave the steps up, step 4
  // reading "Confirmed" over "couldn't confirm" (round-1 review). It goes to
  // the terminal screen instead, its copy from what Stripe said.
  it.each([
    ["processing", "submitted"],
    ["succeeded", "received"],
  ] as const)(
    "Stripe said %s, the confirm WITH an order id errors → the terminal '%s' screen",
    async (status, outcome) => {
      const { result } = await reachPayment();
      act(() => result.current.state.handlePaymentSuccess("pi_x", status));
      expect(confirmMutate).toHaveBeenCalledWith({
        orderId: CHARGED_ID,
        paymentIntentId: "pi_x",
      });
      act(() =>
        confirmOptions.current?.onError?.(
          appError("INTERNAL_SERVER_ERROR", 500),
          confirmMutate.mock.calls.at(-1)![0],
        ),
      );
      expect(result.current.state.unconfirmedPaymentOutcome).toBe(outcome);
      expect(result.current.state.isPaymentReceivedUnconfirmed).toBe(true);
      expect(result.current.state.orderId).toBe(CHARGED_ID);
    },
  );

  it("the confirm WITH an order id is refused as NOT_RESOURCE_OWNER → 'wrong-account', and reported", async () => {
    const { result } = await reachPayment();
    act(() => result.current.state.handlePaymentSuccess("pi_x", "succeeded"));
    act(() =>
      confirmOptions.current?.onError?.(
        appError("NOT_RESOURCE_OWNER", 403),
        confirmMutate.mock.calls.at(-1)![0],
      ),
    );
    expect(result.current.state.unconfirmedPaymentOutcome).toBe("wrong-account");
    expect(trace.labels).toContain("checkout.confirmWithOrder");
  });

  it("an in-page success Stripe called 'processing', no order, the confirm errors → 'submitted'", async () => {
    const { result } = await reachHeld();
    act(() => result.current.state.handlePaymentSuccess("pi_ach", "processing"));
    act(() =>
      confirmOptions.current?.onError?.(
        appError("INTERNAL_SERVER_ERROR", 500),
        confirmMutate.mock.calls.at(-1)![0],
      ),
    );
    expect(result.current.state.unconfirmedPaymentOutcome).toBe("submitted");
  });

  it("a plain decline is unchanged: back to the held step, nothing confirmed", async () => {
    const { result } = await reachPayment();
    act(() =>
      result.current.state.handlePaymentError(
        "Your card was declined.",
        "card_declined",
        "requires_payment_method",
        "pi_declined",
      ),
    );
    expect(confirmMutate).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("held");
  });
});

describe("useCheckoutState — leaving never releases an order being (or already) paid", () => {
  it("held, nothing submitting → leaving releases (suppressRelease false)", async () => {
    await reachHeld();
    expect(cartRelease.last).toEqual({ orderId: HOLD_ID, suppressRelease: false });
  });

  it("regression: a payment submitting (a redirect method navigates away mid-confirm) → suppressed", async () => {
    const { result } = await reachPayment();
    act(() => result.current.state.handlePaymentSubmittingChange(true));
    expect(cartRelease.last).toEqual({ orderId: CHARGED_ID, suppressRelease: true });
  });

  it("regression: confirming → suppressed", async () => {
    const { result } = await reachPayment();
    act(() => result.current.state.handlePaymentSuccess("pi_x"));
    expect(result.current.state.phase).toBe("confirming");
    expect(cartRelease.last?.suppressRelease).toBe(true);
  });

  it("regression: confirmed (a PAID order) → suppressed", async () => {
    const { result } = await reachPayment();
    act(() => result.current.state.handlePaymentSuccess("pi_x"));
    act(() => confirmOptions.current?.onSuccess?.({ orderId: CHARGED_ID, outcome: "confirmed" }));
    expect(result.current.state.phase).toBe("confirmed");
    expect(cartRelease.last?.suppressRelease).toBe(true);
  });
});

describe("useCheckoutState — a hold taken during the sign-unlock await after the purchase settled", () => {
  it("regression: a free claim lands while handleHoldTickets awaits the unlock sync → no hold is sent", async () => {
    let gateUnlock = false;
    let openUnlock!: () => void;
    const unlockGate = new Promise<void>((resolve) => {
      openUnlock = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (gateUnlock) await unlockGate;
        return { ok: true, json: async () => ({ persisted: true }) };
      }),
    );
    try {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const takeHold = holdServer.current!;
      holdServer.current = (input) => ({
        ...(takeHold(input) as object),
        holdExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const { result } = renderHook(() =>
        useStepTwo(DEFAULT_TIERS, {
          shouldSyncSignedUnlock: true,
          signedUnlockGateType: "PASSWORD" as never,
        }),
      );
      act(() => result.current.state.handleQuantityChange(GA_ID, 2));
      await act(async () => {
        await result.current.state.handleHoldTickets();
      });
      expect(result.current.state.phase).toBe("held");

      // A free claim in flight; the hold expires under it.
      const charge = createCheckoutMutateAsync.getMockImplementation()!;
      const openFree = gateNextCheckout(async (input) => ({
        ...((await charge(input)) as object),
        orderId: FREE_ID,
        clientSecret: null,
      }));
      let pendingCheckout!: Promise<unknown>;
      await act(async () => {
        pendingCheckout = result.current.state.handleCheckout().catch((e: unknown) => e);
      });
      act(() => {
        vi.advanceTimersByTime(61_000);
      });
      expect(result.current.state.phase).toBe("selecting");

      // Hold again — stuck in the unlock sync while the free claim lands.
      const holdInputs: unknown[] = [];
      const next = holdServer.current!;
      holdServer.current = (input) => {
        holdInputs.push(input);
        return next(input);
      };
      gateUnlock = true;
      let pendingHold!: Promise<void>;
      await act(async () => {
        pendingHold = result.current.state.handleHoldTickets();
      });
      await act(async () => {
        openFree();
        await pendingCheckout;
      });
      expect(result.current.state.phase).toBe("confirmed");

      await act(async () => {
        openUnlock();
        await pendingHold;
      });
      expect(holdInputs).toHaveLength(0);
      expect(result.current.state.phase).toBe("confirmed");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The Stripe REDIRECT RETURN. The buyer may have paid: the page goes back to
// the steps (where they could buy again) ONLY on a definite failure; anything
// the page cannot verify, the server decides; anything nobody can confirm is
// a terminal "check My tickets" screen with buying closed.
// ─────────────────────────────────────────────────────────────────────────────

const RETURN_URL = (status: string, params = "payment_intent=pi_r&payment_intent_client_secret=pi_r_secret_x") =>
  `/events/checkout/gallery-walk?orderId=${HOLD_ID}&${params}&redirect_status=${status}`;
const SERVER_ORDER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** A tRPC error as the client sees it: `data.appCode` + `data.httpStatus` (+ `data.meta`). */
const appError = (
  appCode: string,
  httpStatus = 400,
  meta?: Record<string, unknown>,
) => ({
  message: appCode,
  data: { appCode, httpStatus, ...(meta ? { meta: { ...meta, appCode } } : {}) },
});
/** confirmPayment's refusal, naming the PaymentIntent's status (or not). */
const notSucceeded = (status?: string) =>
  appError("PAYMENT_NOT_SUCCEEDED", 409, status ? { status } : undefined);
/** page.tsx's seed: the request's searchParams carry a redirect return. */
const seedFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  return hasStripeRedirectParams((key) => params.has(key));
};
const urlHasRedirectParams = () =>
  /payment_intent|redirect_status/.test(window.location.search);

function useReturnPage(isStripeRedirectReturn = true) {
  // As page.tsx seeds it: the SERVER saw the redirect params.
  const page = useStepTwo(DEFAULT_TIERS, { isStripeRedirectReturn });
  useStripeRedirectReturn(
    page.state.handleRedirectPaymentSuccess,
    page.state.handleRedirectPaymentError,
    page.state.handleRedirectUnverifiable,
  );
  return page;
}
const screenOf = (state: ReturnType<typeof useStepTwo>["state"]) =>
  checkoutScreen({
    phase: state.phase,
    isRedirectReturnPending: state.isRedirectReturnPending,
    isPaymentReceivedUnconfirmed: state.isPaymentReceivedUnconfirmed,
  });
async function returnTo(url: string) {
  window.history.replaceState({}, "", url);
  let rendered!: ReturnType<typeof renderHook<ReturnType<typeof useReturnPage>, unknown>>;
  await act(async () => {
    rendered = renderHook(() => useReturnPage());
  });
  return rendered;
}
/** A reload: a fresh mount, seeded the way page.tsx would from the URL now. */
function reload() {
  const seed = seedFromUrl();
  return renderHook(() => useReturnPage(seed));
}
/** Buying is CLOSED: no checkout, no hold, no createCheckout. */
async function expectBuyingClosed(result: { current: ReturnType<typeof useReturnPage> }) {
  let thrown: unknown;
  await act(async () => {
    thrown = await result.current.state.handleCheckout().catch((e: unknown) => e);
  });
  expect((thrown as Error).message).toBe(PURCHASE_ALREADY_SETTLED);
  const holdInputs: unknown[] = [];
  const takeHold = holdServer.current!;
  holdServer.current = (input) => {
    holdInputs.push(input);
    return takeHold(input);
  };
  act(() => result.current.state.handleQuantityChange(GA_ID, 1));
  await act(async () => {
    await result.current.state.handleHoldTickets();
  });
  expect(holdInputs).toHaveLength(0);
  expect(createCheckoutMutateAsync).not.toHaveBeenCalled();
}

describe("redirect return — seeded from the server (no hydration mismatch)", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it("regression: isStripeRedirectReturn=true → the FIRST render is already 'being verified' (the interstitial), with no URL in sight", () => {
    window.history.replaceState({}, "", "/");
    const renders: boolean[] = [];
    renderHook(() => {
      const page = useStepTwo(DEFAULT_TIERS, { isStripeRedirectReturn: true });
      renders.push(page.state.isRedirectReturnPending);
      return page;
    });
    expect(renders[0]).toBe(true);
  });

  it("…and the URL alone does not flip it (the server's read is the one that counts)", () => {
    window.history.replaceState({}, "", RETURN_URL("succeeded"));
    const renders: boolean[] = [];
    renderHook(() => {
      const page = useStepTwo(DEFAULT_TIERS, { isStripeRedirectReturn: false });
      renders.push(page.state.isRedirectReturnPending);
      return page;
    });
    expect(renders[0]).toBe(false);
  });
});

describe("redirect return — Stripe.js says it went through", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it("succeeded → confirmPayment({ paymentIntentId }) only, the interstitial while it runs, then the server's order confirmed", async () => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded" },
    });
    const { result } = await returnTo(RETURN_URL("succeeded"));
    expect(screenOf(result.current.state)).toBe("redirect-confirming");
    expect(cartRelease.last?.suppressRelease).toBe(true);
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    expect(confirmMutate.mock.calls[0]![0]).toEqual({ paymentIntentId: "pi_r" });
    expect(screenOf(result.current.state)).toBe("redirect-confirming");

    act(() => confirmOptions.current?.onSuccess?.({ orderId: SERVER_ORDER_ID, outcome: "confirmed" }));
    expect(result.current.state.phase).toBe("confirmed");
    expect(result.current.state.orderId).toBe(SERVER_ORDER_ID);
    expect(result.current.state.isRedirectReturnPending).toBe(false);
  });

  it("the confirm is SILENT (no global toast beside the in-page outcome)", async () => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded" },
    });
    await returnTo(RETURN_URL("succeeded"));
    expect(
      (confirmOptions.current as { meta?: { silent?: boolean } } | null)?.meta?.silent,
    ).toBe(true);
  });

  it.each([
    ["400", appError("NOT_FOUND", 404)],
    ["500", appError("INTERNAL_SERVER_ERROR", 500)],
    ["401", appError("UNAUTHORIZED", 401)],
  ])("Stripe said succeeded, our confirm fails (%s) → terminal 'payment received', reported; buying closed", async (_s, error) => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded" },
    });
    const { result } = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    act(() => confirmOptions.current?.onError?.(error, confirmMutate.mock.calls.at(-1)![0]));
    expect(result.current.state.unconfirmedPaymentOutcome).toBe("received");
    expect(screenOf(result.current.state)).toBe("payment-received");
    expect(result.current.state.phase).not.toBe("paying");
    expect(trace.labels).toContain("checkout.redirectConfirm");
    await expectBuyingClosed(result);
  });

  it("regression: signed into ANOTHER account (NOT_RESOURCE_OWNER) → 'sign into the account that paid'", async () => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded" },
    });
    const { result } = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    act(() =>
      confirmOptions.current?.onError?.(appError("NOT_RESOURCE_OWNER", 403), confirmMutate.mock.calls.at(-1)![0]),
    );
    expect(result.current.state.unconfirmedPaymentOutcome).toBe("wrong-account");
  });

  it("regression: an ACH payment still `processing` — the server's PAYMENT_NOT_SUCCEEDED is NOT a failure: 'submitted, we'll email you', buying closed", async () => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "processing" },
    });
    const { result } = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    act(() =>
      confirmOptions.current?.onError?.(notSucceeded("processing"), confirmMutate.mock.calls.at(-1)![0]),
    );
    expect(result.current.state.unconfirmedPaymentOutcome).toBe("submitted");
    await expectBuyingClosed(result);
  });
});

describe("redirect return — a DEFINITE failure goes back to the steps (buying open)", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  const expectBackOnTheSteps = (state: ReturnType<typeof useReturnPage>["state"]) => {
    expect(state.isRedirectReturnPending).toBe(false);
    expect(state.isPaymentReceivedUnconfirmed).toBe(false);
    expect(state.phase).toBe("selecting");
    expect(state.errorMessage).toBeTruthy();
    expect(screenOf(state)).toBe("steps");
    expect(cartRelease.last?.suppressRelease).toBe(false);
  };

  it("redirect_status=failed AND Stripe.js verifies requires_payment_method → steps, with no confirm sent", async () => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "requires_payment_method" },
    });
    const { result } = await returnTo(RETURN_URL("failed"));
    await waitFor(() => expect(result.current.state.errorMessage).toBeTruthy());
    expectBackOnTheSteps(result.current.state);
    expect(confirmMutate).not.toHaveBeenCalled();
  });

  it.each(["requires_payment_method", "canceled"])("PaymentIntent %s → steps, no confirm sent", async (status) => {
    stripeJs.retrievePaymentIntent = async () => ({ paymentIntent: { id: "pi_r", status } });
    const { result } = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(result.current.state.errorMessage).toBeTruthy());
    expectBackOnTheSteps(result.current.state);
    expect(confirmMutate).not.toHaveBeenCalled();
  });

  it.each(["requires_payment_method", "canceled"])("the page could not verify, and the SERVER says PAYMENT_NOT_SUCCEEDED for a %s PaymentIntent → steps, and a new hold can be taken", async (status) => {
    stripeJs.unavailable = true;
    const { result } = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    act(() =>
      confirmOptions.current?.onError?.(notSucceeded(status), confirmMutate.mock.calls.at(-1)![0]),
    );
    expectBackOnTheSteps(result.current.state);
    expect(trace.labels).not.toContain("checkout.redirectConfirm");
    const holdInputs: unknown[] = [];
    const takeHold = holdServer.current!;
    holdServer.current = (input) => {
      holdInputs.push(input);
      return takeHold(input);
    };
    act(() => result.current.state.handleQuantityChange(GA_ID, 1));
    await act(async () => {
      await result.current.state.handleHoldTickets();
    });
    expect(holdInputs).toHaveLength(1);
  });
});

describe("redirect return — the page cannot verify: the SERVER decides", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it.each([
    ["no Stripe.js (getStripe() → null)", () => { stripeJs.unavailable = true; }],
    ["a retrieve error", () => { stripeJs.retrievePaymentIntent = async () => ({ error: { message: "rate limited" } }); }],
    ["a retrieve throw", () => { stripeJs.retrievePaymentIntent = async () => { throw new Error("network"); }; }],
    ["requires_capture", () => { stripeJs.retrievePaymentIntent = async () => ({ paymentIntent: { id: "pi_r", status: "requires_capture" } }); }],
    ["requires_confirmation", () => { stripeJs.retrievePaymentIntent = async () => ({ paymentIntent: { id: "pi_r", status: "requires_confirmation" } }); }],
    ["requires_action", () => { stripeJs.retrievePaymentIntent = async () => ({ paymentIntent: { id: "pi_r", status: "requires_action" } }); }],
  ])("regression: %s → confirmPayment({ paymentIntentId }) is still sent, and the server's PAYMENT_NOT_SUCCEEDED for a still-completable PI is terminal (never back to the steps)", async (_label, arrange) => {
    arrange();
    const { result } = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    expect(confirmMutate.mock.calls[0]![0]).toEqual({ paymentIntentId: "pi_r" });
    expect(screenOf(result.current.state)).toBe("redirect-confirming");
    expect(result.current.state.errorMessage).toBeNull();

    // The server's answer: the PaymentIntent still waits on the buyer (a
    // Cash App approval pending). It can still be charged.
    act(() =>
      confirmOptions.current?.onError?.(notSucceeded("requires_action"), confirmMutate.mock.calls.at(-1)![0]),
    );
    expect(result.current.state.unconfirmedPaymentOutcome).toBe("unverified");
    expect(screenOf(result.current.state)).toBe("payment-received");
    expect(result.current.state.phase).not.toBe("selecting");
    await expectBuyingClosed(result);
  });

  describe("the server's PAYMENT_NOT_SUCCEEDED decides by the PaymentIntent status it names", () => {
    const arrangeRequiresAction = () => {
      stripeJs.retrievePaymentIntent = async () => ({
        paymentIntent: { id: "pi_r", status: "requires_action" },
      });
    };

    it("BLOCKER regression: { status: 'requires_action' } → terminal, buying stays CLOSED (no double charge)", async () => {
      arrangeRequiresAction();
      const { result } = await returnTo(RETURN_URL("succeeded"));
      await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
      act(() =>
        confirmOptions.current?.onError?.(notSucceeded("requires_action"), confirmMutate.mock.calls.at(-1)![0]),
      );
      expect(result.current.state.unconfirmedPaymentOutcome).toBe("unverified");
      expect(result.current.state.errorMessage).toBeNull();
      expect(cartRelease.last?.suppressRelease).toBe(true);
      await expectBuyingClosed(result);
    });

    it("{ status: 'requires_payment_method' } → back to the steps, buying reopens", async () => {
      arrangeRequiresAction();
      const { result } = await returnTo(RETURN_URL("succeeded"));
      await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
      act(() =>
        confirmOptions.current?.onError?.(notSucceeded("requires_payment_method"), confirmMutate.mock.calls.at(-1)![0]),
      );
      expect(result.current.state.isPaymentReceivedUnconfirmed).toBe(false);
      expect(result.current.state.phase).toBe("selecting");
      expect(result.current.state.errorMessage).toBeTruthy();
      expect(screenOf(result.current.state)).toBe("steps");
      const holdInputs: unknown[] = [];
      const takeHold = holdServer.current!;
      holdServer.current = (input) => {
        holdInputs.push(input);
        return takeHold(input);
      };
      act(() => result.current.state.handleQuantityChange(GA_ID, 1));
      await act(async () => {
        await result.current.state.handleHoldTickets();
      });
      expect(holdInputs).toHaveLength(1);
    });

    it.each([
      ["no meta at all", appError("PAYMENT_NOT_SUCCEEDED", 409)],
      ["meta without a status", appError("PAYMENT_NOT_SUCCEEDED", 409, {})],
      ["a status Stripe adds later", notSucceeded("requires_something_new")],
    ])("%s → terminal, buying closed", async (_label, error) => {
      arrangeRequiresAction();
      const { result } = await returnTo(RETURN_URL("succeeded"));
      await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
      act(() => confirmOptions.current?.onError?.(error, confirmMutate.mock.calls.at(-1)![0]));
      expect(result.current.state.unconfirmedPaymentOutcome).toBe("unverified");
      await expectBuyingClosed(result);
    });

    it("Stripe.js failed to load and the server names no status → terminal, buying closed", async () => {
      stripeJs.unavailable = true;
      const { result } = await returnTo(RETURN_URL("succeeded"));
      await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
      act(() =>
        confirmOptions.current?.onError?.(notSucceeded(), confirmMutate.mock.calls.at(-1)![0]),
      );
      expect(result.current.state.unconfirmedPaymentOutcome).toBe("unverified");
      await expectBuyingClosed(result);
    });
  });

  it("regression: …and the server cannot place it either (NOT_FOUND) → terminal 'couldn't confirm — check My tickets', buying closed", async () => {
    stripeJs.unavailable = true;
    const { result } = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    act(() =>
      confirmOptions.current?.onError?.(appError("NOT_FOUND", 404), confirmMutate.mock.calls.at(-1)![0]),
    );
    expect(result.current.state.unconfirmedPaymentOutcome).toBe("unverified");
    expect(screenOf(result.current.state)).toBe("payment-received");
    await expectBuyingClosed(result);
  });

  it("…and the server CONFIRMS it → confirmed", async () => {
    stripeJs.unavailable = true;
    const { result } = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    act(() => confirmOptions.current?.onSuccess?.({ orderId: SERVER_ORDER_ID, outcome: "confirmed" }));
    expect(result.current.state.phase).toBe("confirmed");
  });

  it("regression: no usable PaymentIntent id to ask about → terminal 'couldn't confirm', buying closed, nothing sent", async () => {
    const { result } = await returnTo(RETURN_URL("succeeded", "payment_intent=not-a-pi"));
    await waitFor(() => expect(result.current.state.unconfirmedPaymentOutcome).toBe("unverified"));
    expect(confirmMutate).not.toHaveBeenCalled();
    expect(trace.labels).toContain("checkout.redirectUnverifiable");
    await expectBuyingClosed(result);
  });
});

describe("checkout reducer — a late cart resume never moves a paid page", () => {
  type Act = Parameters<typeof checkoutStateReducer>[1];
  const confirmed = {
    phase: "confirmed" as const,
    orderId: SERVER_ORDER_ID,
    order: null,
    holdExpiresAt: null,
    clientSecret: null,
    errorMessage: null,
    payment: "paid" as const,
  };
  it("regression: HOLD_RESUMED / HOLD_RESUME_FAILED leave a confirmed page as it is", () => {
    for (const action of [
      { type: "HOLD_RESUMED", orderId: HOLD_ID, order: {}, holdExpiresAt: null },
      { type: "HOLD_RESUME_FAILED", error: "gone" },
    ]) {
      expect(checkoutStateReducer(confirmed, action as Act)).toBe(confirmed);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A RELOAD before the outcome is settled must arrive as a redirect return
// again: the Stripe params stay in the URL until then (page.tsx seeds from
// them), and the page asks the server again (confirmPayment is idempotent).
// ─────────────────────────────────────────────────────────────────────────────

describe("redirect return — the Stripe params stay until the outcome is settled", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));
  const succeeded = () => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded" },
    });
  };

  it("regression: a reload while 'Confirming…' is still a redirect return, and asks the server again", async () => {
    succeeded();
    const first = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalledTimes(1));
    expect(urlHasRedirectParams()).toBe(true);
    first.unmount();

    expect(seedFromUrl()).toBe(true);
    const { result } = reload();
    expect(result.current.state.isRedirectReturnPending).toBe(true);
    expect(screenOf(result.current.state)).toBe("redirect-confirming");
    await waitFor(() => expect(confirmMutate).toHaveBeenCalledTimes(2));
    expect(confirmMutate.mock.calls[1]![0]).toEqual({ paymentIntentId: "pi_r" });
    await expectBuyingClosed(result);
  });

  it("regression: a reload from a terminal screen is still a redirect return (buying never reopens)", async () => {
    stripeJs.unavailable = true;
    const first = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    act(() =>
      confirmOptions.current?.onError?.(appError("NOT_FOUND", 404), confirmMutate.mock.calls.at(-1)![0]),
    );
    expect(first.result.current.state.unconfirmedPaymentOutcome).toBe("unverified");
    expect(urlHasRedirectParams()).toBe(true);
    first.unmount();

    const { result } = reload();
    expect(result.current.state.isRedirectReturnPending).toBe(true);
    await waitFor(() => expect(confirmMutate).toHaveBeenCalledTimes(2));
    await expectBuyingClosed(result);
  });

  it("confirmed → the params are stripped (a reload is a fresh checkout)", async () => {
    succeeded();
    const { result } = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    act(() => confirmOptions.current?.onSuccess?.({ orderId: SERVER_ORDER_ID, outcome: "confirmed" }));
    expect(result.current.state.phase).toBe("confirmed");
    expect(urlHasRedirectParams()).toBe(false);
    expect(window.location.search).toContain(`orderId=${HOLD_ID}`);
    expect(seedFromUrl()).toBe(false);
  });

  it("redirect_status=failed, verified dead by Stripe.js → stripped", async () => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "requires_payment_method" },
    });
    const { result } = await returnTo(RETURN_URL("failed"));
    await waitFor(() => expect(result.current.state.errorMessage).toBeTruthy());
    expect(urlHasRedirectParams()).toBe(false);
  });

  it("the server names a dead PaymentIntent → stripped", async () => {
    stripeJs.unavailable = true;
    const { result } = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    act(() =>
      confirmOptions.current?.onError?.(notSucceeded("canceled"), confirmMutate.mock.calls.at(-1)![0]),
    );
    expect(result.current.state.phase).toBe("selecting");
    expect(urlHasRedirectParams()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stripe.js that never answers must not leave the buyer on "Confirming…":
// past the timeout the page asks the server, and a late answer is ignored.
// ─────────────────────────────────────────────────────────────────────────────

describe("redirect return — Stripe.js that never answers times out to the server", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it("getStripe() hangs → after the timeout, confirmPayment({ paymentIntentId }) is sent once", async () => {
    vi.useFakeTimers();
    let resolveStripe!: (value: unknown) => void;
    stripeJs.loading = new Promise((resolve) => {
      resolveStripe = resolve;
    });
    const { result } = await returnTo(RETURN_URL("succeeded"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STRIPE_VERIFY_TIMEOUT_MS - 1);
    });
    expect(confirmMutate).not.toHaveBeenCalled();
    expect(screenOf(result.current.state)).toBe("redirect-confirming");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(confirmMutate).toHaveBeenCalledTimes(1);
    expect(confirmMutate.mock.calls[0]![0]).toEqual({ paymentIntentId: "pi_r" });

    // Stripe.js turns up late: nothing more fires.
    await act(async () => {
      resolveStripe({
        retrievePaymentIntent: async () => ({
          paymentIntent: { id: "pi_r", status: "requires_payment_method" },
        }),
      });
      await vi.advanceTimersByTimeAsync(STRIPE_VERIFY_TIMEOUT_MS * 2);
    });
    expect(confirmMutate).toHaveBeenCalledTimes(1);
    expect(result.current.state.errorMessage).toBeNull();
  });

  it("retrievePaymentIntent hangs → after the timeout, the server is asked", async () => {
    vi.useFakeTimers();
    stripeJs.retrievePaymentIntent = () => new Promise(() => {});
    await returnTo(RETURN_URL("succeeded"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STRIPE_VERIFY_TIMEOUT_MS);
    });
    expect(confirmMutate).toHaveBeenCalledTimes(1);
    expect(confirmMutate.mock.calls[0]![0]).toEqual({ paymentIntentId: "pi_r" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `redirect_status` is a HINT. `failed` never reopens buying on its own: the
// PaymentIntent is verified like any other return (Stripe.js, then the
// server), and only a verified dead status goes back to the steps. A `failed`
// return whose PaymentIntent is still live (awaiting approval) can yet be
// charged; reopening buying there is a second charge.
// ─────────────────────────────────────────────────────────────────────────────

describe("redirect return — redirect_status=failed is a hint, never the verdict", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it("BLOCKER regression: failed, but Stripe.js says requires_action (still live) → the server is asked, then terminal; buying closed, params kept", async () => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "requires_action" },
    });
    const { result } = await returnTo(RETURN_URL("failed"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    expect(confirmMutate.mock.calls[0]![0]).toEqual({ paymentIntentId: "pi_r" });
    expect(result.current.state.errorMessage).toBeNull();
    expect(screenOf(result.current.state)).toBe("redirect-confirming");

    act(() =>
      confirmOptions.current?.onError?.(notSucceeded("requires_action"), confirmMutate.mock.calls.at(-1)![0]),
    );
    expect(result.current.state.unconfirmedPaymentOutcome).toBe("unverified");
    expect(screenOf(result.current.state)).toBe("payment-received");
    expect(result.current.state.phase).not.toBe("selecting");
    expect(urlHasRedirectParams()).toBe(true);
    await expectBuyingClosed(result);
  });

  it("failed, and Stripe.js VERIFIES requires_payment_method → steps with the declined copy, params stripped, no confirm", async () => {
    const retrieve = vi.fn(async () => ({
      paymentIntent: { id: "pi_r", status: "requires_payment_method" },
    }));
    stripeJs.retrievePaymentIntent = retrieve;
    const { result } = await returnTo(RETURN_URL("failed"));
    await waitFor(() => expect(result.current.state.errorMessage).toBeTruthy());
    // The verdict came from the PaymentIntent, not the param.
    expect(retrieve).toHaveBeenCalledWith("pi_r_secret_x");
    expect(result.current.state.errorMessage).toBe("checkout.redirectFailedDeclined");
    expect(result.current.state.phase).toBe("selecting");
    expect(screenOf(result.current.state)).toBe("steps");
    expect(urlHasRedirectParams()).toBe(false);
    expect(confirmMutate).not.toHaveBeenCalled();
  });

  it("…without the failed hint, the same dead PaymentIntent keeps the neutral copy", async () => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "requires_payment_method" },
    });
    const { result } = await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(result.current.state.errorMessage).toBeTruthy());
    expect(result.current.state.errorMessage).toBe("checkout.redirectFailedNotCompleted");
  });

  it("failed, Stripe.js says succeeded → confirmed through the server (the param loses to the PaymentIntent)", async () => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded" },
    });
    const { result } = await returnTo(RETURN_URL("failed"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    act(() => confirmOptions.current?.onSuccess?.({ orderId: SERVER_ORDER_ID, outcome: "confirmed" }));
    expect(result.current.state.phase).toBe("confirmed");
  });

  it("failed, no Stripe.js, and the server says PAYMENT_NOT_SUCCEEDED{canceled} → steps (verified dead), params stripped", async () => {
    stripeJs.unavailable = true;
    const { result } = await returnTo(RETURN_URL("failed"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    expect(confirmMutate.mock.calls[0]![0]).toEqual({ paymentIntentId: "pi_r" });
    expect(screenOf(result.current.state)).toBe("redirect-confirming");
    act(() =>
      confirmOptions.current?.onError?.(notSucceeded("canceled"), confirmMutate.mock.calls.at(-1)![0]),
    );
    expect(result.current.state.phase).toBe("selecting");
    expect(screenOf(result.current.state)).toBe("steps");
    expect(urlHasRedirectParams()).toBe(false);
  });

  it("failed, Stripe.js times out, and the server says PAYMENT_NOT_SUCCEEDED{canceled} → steps", async () => {
    vi.useFakeTimers();
    stripeJs.loading = new Promise(() => {});
    const { result } = await returnTo(RETURN_URL("failed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STRIPE_VERIFY_TIMEOUT_MS - 1);
    });
    // Still verifying: the param alone did not reopen anything.
    expect(result.current.state.errorMessage).toBeNull();
    expect(screenOf(result.current.state)).toBe("redirect-confirming");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(confirmMutate).toHaveBeenCalledTimes(1);
    act(() =>
      confirmOptions.current?.onError?.(notSucceeded("canceled"), confirmMutate.mock.calls.at(-1)![0]),
    );
    expect(result.current.state.phase).toBe("selecting");
    expect(screenOf(result.current.state)).toBe("steps");
  });

  it.each([
    ["NOT_FOUND", appError("NOT_FOUND", 404)],
    ["a network error", new TypeError("Failed to fetch")],
    ["PAYMENT_NOT_SUCCEEDED with no status", notSucceeded()],
  ])("failed, no Stripe.js, and the server answers %s → terminal 'couldn't confirm', buying closed, params kept", async (_label, error) => {
    stripeJs.unavailable = true;
    const { result } = await returnTo(RETURN_URL("failed"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    act(() => confirmOptions.current?.onError?.(error, confirmMutate.mock.calls.at(-1)![0]));
    expect(result.current.state.unconfirmedPaymentOutcome).toBe("unverified");
    expect(screenOf(result.current.state)).toBe("payment-received");
    expect(urlHasRedirectParams()).toBe(true);
    await expectBuyingClosed(result);
  });

  it("failed, Stripe.js times out, and the server answers NOT_FOUND → terminal, buying closed", async () => {
    vi.useFakeTimers();
    stripeJs.retrievePaymentIntent = () => new Promise(() => {});
    const { result } = await returnTo(RETURN_URL("failed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STRIPE_VERIFY_TIMEOUT_MS);
    });
    expect(confirmMutate).toHaveBeenCalledTimes(1);
    act(() =>
      confirmOptions.current?.onError?.(appError("NOT_FOUND", 404), confirmMutate.mock.calls.at(-1)![0]),
    );
    expect(result.current.state.unconfirmedPaymentOutcome).toBe("unverified");
    expect(urlHasRedirectParams()).toBe(true);
    vi.useRealTimers();
    await expectBuyingClosed(result);
  });
});

describe("redirect return — the PaymentIntent id comes from the client secret when the param is unusable", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it.each([
    ["missing", "payment_intent_client_secret=pi_s3cret_secret_abc"],
    ["malformed", "payment_intent=not-a-pi&payment_intent_client_secret=pi_s3cret_secret_abc"],
  ])("payment_intent %s, failed, no Stripe.js → the server is asked about the secret's PaymentIntent", async (_label, params) => {
    stripeJs.unavailable = true;
    const { result } = await returnTo(RETURN_URL("failed", params));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    expect(confirmMutate.mock.calls[0]![0]).toEqual({ paymentIntentId: "pi_s3cret" });
    expect(result.current.state.errorMessage).toBeNull();
    expect(trace.labels).not.toContain("checkout.redirectUnverifiable");
  });

  it("payment_intent missing, succeeded hint, no Stripe.js → still asks the server (not 'unverifiable')", async () => {
    stripeJs.unavailable = true;
    await returnTo(RETURN_URL("succeeded", "payment_intent_client_secret=pi_s3cret_secret_abc"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    expect(confirmMutate.mock.calls[0]![0]).toEqual({ paymentIntentId: "pi_s3cret" });
  });

  it.each([
    ["no _secret_ part", "payment_intent_client_secret=pi_abc"],
    ["a non-PI prefix", "payment_intent_client_secret=seti_abc_secret_x"],
  ])("a secret with %s gives no id → terminal 'couldn't confirm', nothing sent", async (_label, params) => {
    stripeJs.unavailable = true;
    const { result } = await returnTo(RETURN_URL("failed", params));
    await waitFor(() => expect(result.current.state.unconfirmedPaymentOutcome).toBe("unverified"));
    expect(confirmMutate).not.toHaveBeenCalled();
    await expectBuyingClosed(result);
  });
});

describe("redirect return — verification is abandoned on unmount", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  const callbacks = () => ({
    onConfirm: vi.fn(),
    onDefiniteFailure: vi.fn(),
    onUnverifiable: vi.fn(),
  });
  const mount = (cb: ReturnType<typeof callbacks>) =>
    renderHook(() =>
      useStripeRedirectReturn(cb.onConfirm, cb.onDefiniteFailure, cb.onUnverifiable),
    );

  it.each(["failed", "succeeded"])("redirect_status=%s, unmounted while Stripe.js loads, then it answers requires_payment_method → nothing fires", async (status) => {
    let resolveStripe!: (value: unknown) => void;
    stripeJs.loading = new Promise((resolve) => {
      resolveStripe = resolve;
    });
    window.history.replaceState({}, "", RETURN_URL(status));
    const cb = callbacks();
    const { unmount } = mount(cb);
    unmount();
    await act(async () => {
      resolveStripe({
        retrievePaymentIntent: async () => ({
          paymentIntent: { id: "pi_r", status: "requires_payment_method" },
        }),
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(cb.onDefiniteFailure).not.toHaveBeenCalled();
    expect(cb.onConfirm).not.toHaveBeenCalled();
    expect(cb.onUnverifiable).not.toHaveBeenCalled();
  });

  it.each(["failed", "succeeded"])("redirect_status=%s, unmounted while Stripe.js hangs, then the timeout passes → the server is NOT asked", async (status) => {
    vi.useFakeTimers();
    stripeJs.loading = new Promise(() => {});
    window.history.replaceState({}, "", RETURN_URL(status));
    const cb = callbacks();
    const { unmount } = mount(cb);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STRIPE_VERIFY_TIMEOUT_MS * 2);
    });
    expect(cb.onConfirm).not.toHaveBeenCalled();
    expect(cb.onDefiniteFailure).not.toHaveBeenCalled();
    expect(cb.onUnverifiable).not.toHaveBeenCalled();
  });

  it("the full page: unmounted mid-verification → no confirmPayment call and no dispatch", async () => {
    let resolveStripe!: (value: unknown) => void;
    stripeJs.loading = new Promise((resolve) => {
      resolveStripe = resolve;
    });
    const { result, unmount } = await returnTo(RETURN_URL("failed"));
    const before = result.current.state;
    // The param alone moved nothing: still verifying when the page goes.
    expect(screenOf(before)).toBe("redirect-confirming");
    expect(before.errorMessage).toBeNull();
    unmount();
    await act(async () => {
      resolveStripe({
        retrievePaymentIntent: async () => ({
          paymentIntent: { id: "pi_r", status: "requires_action" },
        }),
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(confirmMutate).not.toHaveBeenCalled();
    expect(urlHasRedirectParams()).toBe(true);
  });

  it("new callback identities mid-verification neither restart nor cancel it; the latest ones are called, once", async () => {
    let resolveStripe!: (value: unknown) => void;
    stripeJs.loading = new Promise((resolve) => {
      resolveStripe = resolve;
    });
    window.history.replaceState({}, "", RETURN_URL("failed"));
    const first = callbacks();
    const { rerender } = renderHook(
      ({ cb }) => useStripeRedirectReturn(cb.onConfirm, cb.onDefiniteFailure, cb.onUnverifiable),
      { initialProps: { cb: first } },
    );
    const second = callbacks();
    rerender({ cb: second });
    await act(async () => {
      resolveStripe({
        retrievePaymentIntent: async () => ({
          paymentIntent: { id: "pi_r", status: "canceled" },
        }),
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(first.onDefiniteFailure).not.toHaveBeenCalled();
    expect(second.onDefiniteFailure).toHaveBeenCalledTimes(1);
  });

  it("StrictMode's dev double-mount asks the server exactly once", async () => {
    stripeJs.unavailable = true;
    window.history.replaceState({}, "", RETURN_URL("failed"));
    const cb = callbacks();
    renderHook(
      () => useStripeRedirectReturn(cb.onConfirm, cb.onDefiniteFailure, cb.onUnverifiable),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(cb.onConfirm).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(cb.onConfirm).toHaveBeenCalledTimes(1);
    expect(cb.onConfirm).toHaveBeenCalledWith("pi_r", "unverified", true);
  });

  it("StrictMode, `?payment_intent=pi_r` with NO client secret (no Stripe.js step at all) → onConfirm once", async () => {
    window.history.replaceState({}, "", "/events/checkout/gallery-walk?payment_intent=pi_r");
    const cb = callbacks();
    renderHook(
      () => useStripeRedirectReturn(cb.onConfirm, cb.onDefiniteFailure, cb.onUnverifiable),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(cb.onConfirm).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(cb.onConfirm).toHaveBeenCalledTimes(1);
    expect(cb.onConfirm).toHaveBeenCalledWith("pi_r", "unverified", false);
  });
});

describe("redirect return — the failure copy is a reason code, mapped through t()", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it.each([
    ["failed", "requires_payment_method", "checkout.redirectFailedDeclined"],
    ["succeeded", "requires_payment_method", "checkout.redirectFailedNotCompleted"],
    ["failed", "canceled", "checkout.redirectFailedCanceled"],
    ["succeeded", "canceled", "checkout.redirectFailedCanceled"],
  ])("hint %s, the SERVER verifies %s → %s", async (hint, status, key) => {
    stripeJs.unavailable = true;
    const { result } = await returnTo(RETURN_URL(hint));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    act(() =>
      confirmOptions.current?.onError?.(notSucceeded(status), confirmMutate.mock.calls.at(-1)![0]),
    );
    expect(result.current.state.phase).toBe("selecting");
    expect(result.current.state.errorMessage).toBe(key);
  });

  it("Stripe.js verifies canceled under a failed hint → the canceled copy", async () => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "canceled" },
    });
    const { result } = await returnTo(RETURN_URL("failed"));
    await waitFor(() => expect(result.current.state.errorMessage).toBeTruthy());
    expect(result.current.state.errorMessage).toBe("checkout.redirectFailedCanceled");
  });
});

describe("redirect return — a Stripe.js stall is reported, not swallowed", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it("getStripe() times out → traced as checkout.redirectVerifyTimeout", async () => {
    vi.useFakeTimers();
    stripeJs.loading = new Promise(() => {});
    await returnTo(RETURN_URL("succeeded"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STRIPE_VERIFY_TIMEOUT_MS);
    });
    expect(confirmMutate).toHaveBeenCalledTimes(1);
    expect(trace.labels).toContain("checkout.redirectVerifyTimeout");
  });

  it("retrievePaymentIntent times out → traced as checkout.redirectVerifyTimeout", async () => {
    vi.useFakeTimers();
    stripeJs.retrievePaymentIntent = () => new Promise(() => {});
    await returnTo(RETURN_URL("succeeded"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STRIPE_VERIFY_TIMEOUT_MS);
    });
    expect(trace.labels).toContain("checkout.redirectVerifyTimeout");
  });

  it.each([
    ["a retrieve error", () => { stripeJs.retrievePaymentIntent = async () => ({ error: { message: "rate limited" } }); }],
    ["a retrieve throw", () => { stripeJs.retrievePaymentIntent = async () => { throw new Error("network"); }; }],
  ])("%s → traced as checkout.redirectVerifyError, and the server is still asked", async (_label, arrange) => {
    arrange();
    await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    expect(trace.labels).toContain("checkout.redirectVerifyError");
    expect(trace.labels).not.toContain("checkout.redirectVerifyTimeout");
  });

  it("no Stripe.js (an ad blocker) → traced under its own key, not as a verify error, and the server is still asked", async () => {
    stripeJs.unavailable = true;
    await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    expect(trace.labels).toContain("checkout.redirectVerifyStripeUnavailable");
    expect(trace.labels).not.toContain("checkout.redirectVerifyError");
    expect(trace.labels).not.toContain("checkout.redirectVerifyTimeout");
  });

  it("a verified answer traces nothing", async () => {
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded" },
    });
    await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    expect(trace.labels.filter((l) => l.startsWith("checkout.redirectVerify"))).toEqual([]);
  });
});

describe("redirect return — odd params never leave the page on 'Confirming…'", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it("a PaymentIntent id longer than 255 characters is not one", () => {
    const long = `pi_${"a".repeat(253)}`;
    expect(long).toHaveLength(256);
    expect(redirectPaymentIntentId(long, null)).toBeNull();
    expect(redirectPaymentIntentId(null, `${long}_secret_x`)).toBeNull();
    expect(redirectPaymentIntentId(`pi_${"a".repeat(252)}`, null)).toHaveLength(255);
  });

  it("a repeated param whose first value is empty (`?payment_intent=&payment_intent=pi_x`) → seeded AND asks the server about pi_x", async () => {
    stripeJs.unavailable = true;
    window.history.replaceState({}, "", "/events/checkout/gallery-walk?payment_intent=&payment_intent=pi_x&redirect_status=failed");
    expect(seedFromUrl()).toBe(true);
    const { result } = reload();
    expect(result.current.state.isRedirectReturnPending).toBe(true);
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    expect(confirmMutate.mock.calls[0]![0]).toEqual({ paymentIntentId: "pi_x" });
  });

  it("present-but-empty params only (`?payment_intent=`) → seeded, then settles on 'couldn't confirm' (never stuck), buying closed", async () => {
    window.history.replaceState({}, "", "/events/checkout/gallery-walk?payment_intent=&redirect_status=failed");
    expect(seedFromUrl()).toBe(true);
    const { result } = reload();
    expect(screenOf(result.current.state)).toBe("redirect-confirming");
    await waitFor(() => expect(result.current.state.unconfirmedPaymentOutcome).toBe("unverified"));
    expect(result.current.state.isRedirectReturnPending).toBe(false);
    expect(confirmMutate).not.toHaveBeenCalled();
    await expectBuyingClosed(result);
  });
});

describe("redirect return — what reaches Sentry never carries the client secret or a Stripe object", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));
  const reported = () => JSON.stringify(trace.errors.map((e) => (e instanceof Error ? { name: e.name, message: e.message } : e)));

  it("a retrieve error (a StripeError holding the PaymentIntent and echoing the secret) → only `stripe <type>/<code>`", async () => {
    stripeJs.retrievePaymentIntent = async () => ({
      error: {
        type: "invalid_request_error",
        code: "resource_missing",
        message: "No such payment_intent: 'pi_r'; client_secret pi_r_secret_x",
        payment_intent: { id: "pi_r", client_secret: "pi_r_secret_x" },
      },
    });
    await returnTo(RETURN_URL("failed"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    const i = trace.labels.indexOf("checkout.redirectVerifyError");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(trace.errors[i]).toBeInstanceOf(Error);
    expect((trace.errors[i] as Error).message).toBe("stripe invalid_request_error/resource_missing");
    expect(reported()).not.toMatch(/secret|payment_intent/);
  });

  it("a retrieve error with no code → `stripe <type>/none`", async () => {
    stripeJs.retrievePaymentIntent = async () => ({ error: { type: "api_error", message: "pi_r_secret_x" } });
    await returnTo(RETURN_URL("succeeded"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    expect((trace.errors[trace.labels.indexOf("checkout.redirectVerifyError")] as Error).message).toBe("stripe api_error/none");
    expect(reported()).not.toContain("secret");
  });

  it("a thrown IntegrationError quoting the secret → only its name", async () => {
    stripeJs.retrievePaymentIntent = async () => {
      const err = new Error("Invalid value for retrievePaymentIntent: pi_r_secret_x is not a client secret");
      err.name = "IntegrationError";
      throw err;
    };
    await returnTo(RETURN_URL("failed"));
    await waitFor(() => expect(confirmMutate).toHaveBeenCalled());
    expect((trace.errors[trace.labels.indexOf("checkout.redirectVerifyError")] as Error).message).toBe("stripe.js threw IntegrationError");
    expect(reported()).not.toContain("secret");
  });

  it("a timeout reports our own error, naming the stage only", async () => {
    vi.useFakeTimers();
    stripeJs.retrievePaymentIntent = () => new Promise(() => {});
    await returnTo(RETURN_URL("failed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STRIPE_VERIFY_TIMEOUT_MS);
    });
    const err = trace.errors[trace.labels.indexOf("checkout.redirectVerifyTimeout")] as Error;
    expect(err.message).toBe(`stripe.js retrieve took longer than ${STRIPE_VERIFY_TIMEOUT_MS}ms`);
    expect(reported()).not.toContain("secret");
  });
});
