import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * A Stripe REDIRECT RETURN (Amazon Pay, Cash App, …) is a fresh page load:
 * the page holds no order. `confirmPayment({ paymentIntentId })` returns the
 * confirmed order's id, and the confirmation used to total the PRE-HOLD
 * ESTIMATE as a cash total for it. Now it loads that order
 * (`orders.getMyOrder`) and shows its CHARGED totals — "loading" until then,
 * never an estimate.
 *
 * Wired as Checkout.tsx wires it: the state hook, the redirect-return hook,
 * `useConfirmedOrder`, then the confirmed step (or its pending view).
 */

const ORDER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

const server = vi.hoisted(() => ({
  confirmMutate: vi.fn(),
  confirmOptions: null as null | {
    onMutate?: () => void;
    onSuccess?: (data: { orderId: string; outcome: "confirmed" | "processing" }) => void;
  },
  myOrder: undefined as unknown,
  myOrderQueryInputs: [] as unknown[],
}));

vi.mock("@/trpc", () => {
  const query = (data: unknown = undefined) => ({
    useQuery: () => ({ data, isLoading: false, isError: false }),
  });
  const mutation = () => ({
    useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  });
  return {
    trpc: {
      events: {
        listEventSeatAvailability: query(),
        getCheckoutFeeRates: query(),
        estimateCheckoutTax: query(),
      },
      humans: { getMyProfile: query(), updateProfile: mutation() },
      orders: {
        getActiveCartHolds: query({ carts: [] }),
        createCheckout: mutation(),
        updateOrderItems: mutation(),
        releaseCartHold: mutation(),
        confirmPayment: {
          useMutation: (options: typeof server.confirmOptions) => {
            server.confirmOptions = options;
            return {
              mutate: (input: unknown) => {
                server.confirmMutate(input);
                options?.onMutate?.();
              },
              mutateAsync: vi.fn(),
              isPending: false,
            };
          },
        },
        getMyOrder: {
          useQuery: (input: unknown, options: { enabled?: boolean }) => {
            if (options.enabled) server.myOrderQueryInputs.push(input);
            return {
              data: options.enabled ? server.myOrder : undefined,
              isLoading: options.enabled && server.myOrder === undefined,
              isError: false,
            };
          },
        },
      },
    },
  };
});
vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  useFormatters: () => ({ dateTime: () => "date" }),
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number) => `$${(cents / 100).toFixed(2)}`,
}));
vi.mock("@/hooks/useCartRecovery", () => ({ useCartRelease: () => {} }));
vi.mock("@/lib/attribution", () => ({ getAttribution: () => ({}) }));
vi.mock("@/config/stripe", () => ({
  getStripe: async () => ({
    retrievePaymentIntent: async () => ({
      paymentIntent: { id: "pi_redirect", status: "succeeded" },
    }),
  }),
}));

import { useCheckoutState, type TicketTypeSummary } from "./useCheckoutState";
import { useStripeRedirectReturn } from "./useStripeRedirectReturn";
import { useConfirmedOrder } from "./useConfirmedOrder";
import { CheckoutConfirmedStep } from "./CheckoutConfirmedStep";
import { CheckoutConfirmedPending } from "./CheckoutConfirmedPending";

const GA: TicketTypeSummary = {
  id: "tt-ga",
  name: "General Admission",
  priceCents: 3500,
  capacity: 100,
  remainingCapacity: 100,
  seatSectionId: null,
  layoutSectionId: null,
  pricingMode: "FIXED",
};

/** The page's pre-hold estimate for an EMPTY fresh-mount cart — never shown. */
const ESTIMATE_CENTS = 4008;

function Page() {
  const state = useCheckoutState({
    event: { id: EVENT_ID, slug: "gallery-walk" },
    ticketTypes: [GA],
    isSignedIn: true,
    isEmailVerified: true,
    buyerEmail: "buyer@example.com",
    contactFormRef: { current: null } as never,
    onSignInRequired: () => {},
    currentUrl: "/events/checkout/gallery-walk",
    termsAccepted: true,
    refundPolicyAccepted: true,
    // As page.tsx seeds it from the request's query.
    isStripeRedirectReturn: true,
  });
  useStripeRedirectReturn(
    state.handleRedirectPaymentSuccess,
    state.handleRedirectPaymentError,
    state.handleRedirectUnverifiable,
  );
  const confirmed = useConfirmedOrder({
    isConfirmed: state.phase === "confirmed" || state.phase === "done",
    orderId: state.orderId,
    pageOrder: state.order
      ? { ...state.order, taxAmountCents: state.order.taxAmountCents ?? 0 }
      : null,
  });
  if (state.phase !== "confirmed" || !state.orderId) {
    return <p data-testid="phase">{state.phase}</p>;
  }
  if (confirmed.status !== "ready") {
    return <CheckoutConfirmedPending status={confirmed.status} orderId={state.orderId} />;
  }
  return (
    <CheckoutConfirmedStep
      orderId={state.orderId}
      eventName="Sixth Street"
      eventSlug="sixth-street"
      eventId="evt_sixth_street"
      eventDate={new Date("2026-11-01T02:00:00Z")}
      order={confirmed.order}
      fallbackSubtotalCents={ESTIMATE_CENTS}
      ticketTypes={[GA]}
      quantities={confirmed.quantities ?? state.quantities}
      currency="usd"
      payment={confirmed.payment}
    />
  );
}

describe("Checkout — the redirect return shows the CONFIRMED order's real totals", () => {
  it("regression: fresh mount with ?payment_intent=…&redirect_status=succeeded → loading, then the order's charged total (never the estimate)", async () => {
    window.history.replaceState(
      {},
      "",
      "/events/checkout/gallery-walk?payment_intent=pi_redirect&payment_intent_client_secret=pi_redirect_secret_x&redirect_status=succeeded",
    );
    try {
      const { rerender } = render(<Page />);
      await waitFor(() =>
        expect(server.confirmMutate).toHaveBeenCalledWith({
          paymentIntentId: "pi_redirect",
        }),
      );
      act(() => server.confirmOptions?.onSuccess?.({ orderId: ORDER_ID, outcome: "confirmed" }));

      // The order has not arrived: a loading state, no figure at all.
      expect(screen.getByTestId("checkout-confirmed-pending")).toHaveTextContent(
        "checkout.confirmedOrderLoading",
      );
      expect(screen.queryByText(/\$\d/)).toBeNull();
      expect(server.myOrderQueryInputs.at(-1)).toEqual({ orderId: ORDER_ID });

      // getMyOrder answers: 2 × GA $35 with WELCOME10, PASS_THROUGH, NY tax.
      server.myOrder = {
        // A paid order: the confirmation shows only a paid one as paid.
        status: "SUCCEEDED",
        charges: {
          buyerFeeMode: "PASS_THROUGH",
          subtotalCents: 6300,
          platformFeeCents: 100,
          processingFeeCents: 229,
          taxCents: 559,
          creditCents: 0,
          totalCents: 7188,
        },
        items: [
          { kind: "ticket", ticketTypeId: "tt-ga", qty: 1, unitPriceCents: 3500, amountCents: 3500 },
          { kind: "ticket", ticketTypeId: "tt-ga", qty: 1, unitPriceCents: 3500, amountCents: 3500 },
        ],
      };
      rerender(<Page />);

      expect(screen.getByText("$71.88")).toBeInTheDocument();
      expect(screen.queryByText(`$${(ESTIMATE_CENTS / 100).toFixed(2)}`)).toBeNull();
      expect(screen.queryByTestId("checkout-confirmed-pending")).toBeNull();

      // …and its rows add up to it: the order's gross ($63.00) is AFTER
      // WELCOME10, its lines are at face ($70.00) — the Subtotal shows the
      // lines' $70.00 and a Discount row the $7.00.
      const cents = (id: string) =>
        Math.round(
          Number(
            (screen.getByTestId(id).textContent ?? "").replace(/[^0-9.]/g, ""),
          ) * 100,
        );
      expect(cents("order-confirmation-subtotal-value")).toBe(7000);
      expect(cents("order-confirmation-discount-value")).toBe(700);
      expect(
        cents("order-confirmation-subtotal-value") +
          100 + // platform
          229 + // processing (PASS_THROUGH)
          cents("order-confirmation-tax-value") -
          cents("order-confirmation-discount-value"),
      ).toBe(7188);
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });
});
