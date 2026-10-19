import type React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Checkout for an event gated after its detail was read (owner ruling
 * 2026-10-12): the detail screen never offers checkout for a gated event, but
 * a widget that read it ungated can still reach here. The waiver and fee
 * rates are refused for it (EVENT_GATED, 403) and an unanswered fee-rate read
 * left "Calculating total…" up for good, so neither is asked for, and the
 * screen is the detail's gated card under the one Back.
 */

const state = vi.hoisted(() => ({
  gateType: "APPLICATION" as string | undefined,
  /** What the checkout's own detail read answers. */
  detail: "data" as "data" | "loading" | "error",
  refetches: 0,
  feeRateOptions: [] as Array<{ enabled?: boolean }>,
  waiverOptions: [] as Array<{ enabled?: boolean }>,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    embeds: {
      createGuestCheckout: {
        useMutation: () => ({ mutateAsync: () => new Promise(() => {}) }),
      },
      getEventDetail: {
        useQuery: () =>
          state.detail === "loading"
            ? {
                data: undefined,
                isLoading: true,
                isError: false,
                error: null,
                refetch: () => undefined,
              }
            : state.detail === "error"
              ? {
                  data: undefined,
                  isError: true,
                  error: new Error("Failed to fetch"),
                  refetch: () => {
                    state.refetches += 1;
                  },
                }
              : {
                  isError: false,
                  error: null,
                  refetch: () => undefined,
                  data: {
                    event: {
                      id: "event-1",
                      slug: "gated-night",
                      title: "Gated Night",
                      startsAt: new Date("2026-11-01T23:00:00Z"),
                      endsAt: null,
                      timezone: "America/Chicago",
                      currency: "usd",
                      heroImageUrl: null,
                      gateType: state.gateType,
                    },
                    ticketTypes: [],
                    salesClosed: false,
                  },
                },
      },
    },
    waivers: {
      getEventWaiver: {
        useQuery: (_input: unknown, options: { enabled?: boolean }) => {
          state.waiverOptions.push(options);
          return { data: undefined };
        },
      },
    },
    events: {
      getCheckoutFeeRates: {
        useQuery: (_input: unknown, options: { enabled?: boolean }) => {
          state.feeRateOptions.push(options);
          return { data: undefined, refetch: () => undefined };
        },
      },
    },
    useUtils: () => ({
      embeds: {
        listAvailableSeats: {
          invalidate: () => Promise.resolve(),
          fetch: () => Promise.resolve({ seats: [] }),
        },
      },
    }),
  },
}));
vi.mock("@th/ui", () => ({
  Spinner: () => <span data-testid="spinner" />,
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}));
vi.mock("@/lib/embed-host-origin", () => ({
  getEmbedHostOrigin: () => "https://host.test",
  getEmbedHostOriginOrNull: () => "https://host.test",
}));
vi.mock("@/config/stripe", () => ({ getStripe: () => null }));
vi.mock("@/config/site", () => ({
  getSiteUrl: () => "https://ithasfire.test",
}));
vi.mock("@marsidev/react-turnstile", () => ({ Turnstile: () => null }));
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/maps/geocoding", () => ({
  forwardGeocode: () => Promise.resolve([]),
}));
vi.mock("@/app/events/checkout/[...slug]/_components/CheckoutStepper", () => ({
  CheckoutStepper: () => <div data-testid="checkout-stepper" />,
}));
vi.mock("./EmbedCheckoutHeader", () => ({
  EmbedCheckoutHeader: ({ onBack }: { onBack: () => void }) => (
    <button type="button" onClick={onBack}>
      back
    </button>
  ),
}));
vi.mock("./EmbedCheckoutFormSection", () => ({
  EmbedCheckoutFormSection: () => <div data-testid="details-form" />,
}));
vi.mock("./EmbedOrderSummarySidebar", () => ({
  EmbedOrderSummarySidebar: () => <div data-testid="order-summary" />,
}));
vi.mock("./EmbedMobileCTABar", () => ({
  EmbedMobileCTABar: () => <div data-testid="mobile-cta-bar" />,
}));
vi.mock("./EmbedErrorScreen", () => ({
  EmbedErrorScreen: ({ onRetry }: { onRetry: () => void }) => (
    <button type="button" data-testid="detail-error" onClick={onRetry}>
      retry
    </button>
  ),
}));
vi.mock("./EmbedPaymentForm", () => ({
  EmbedPaymentForm: () => <div data-testid="payment-form" />,
}));
vi.mock("./useIsFramed", () => ({ useIsFramed: () => true }));

import { EmbedCheckout } from "./EmbedCheckout";
import type {
  EmbedCheckoutProps,
  EmbedPaymentOrder,
} from "./embed-checkout-types";

/** An order already created: its payment step is on screen. */
const orderOnScreen: EmbedPaymentOrder = {
  clientSecret: "pi_1_secret_x",
  clientKey: "key-1",
  eventId: "event-1",
  cart: [{ ticketTypeId: "tt-ga", qty: 1 }],
  orderFees: {
    amountGrossCents: 2000,
    feesPlatformCents: 100,
    buyerFeesCents: 100,
    processorFeeCents: 0,
    feeMode: "ABSORB",
    taxAmountCents: 0,
    holdExpiresAt: null,
  },
  lineItems: [],
};

const props = (): EmbedCheckoutProps => ({
  embedId: "embed-1",
  eventId: "event-1",
  cart: [{ ticketTypeId: "tt-ga", qty: 1 }],
  guestName: "",
  guestEmail: "",
  onGuestNameChange: () => undefined,
  onGuestEmailChange: () => undefined,
  clientKey: "key-1",
  paymentOrder: null,
  checkoutError: null,
  checkoutStep: "details",
  onCheckoutCreated: () => true,
  onCheckoutError: () => undefined,
  onCheckoutFailed: () => undefined,
  onCartUpdate: () => undefined,
  onPaymentSuccess: () => undefined,
  isPaying: false,
  onPayingChange: () => undefined,
  onPaymentOutcomeUnknown: () => undefined,
  earlierReservedUntil: null,
  onPaymentOrderExpired: () => undefined,
  onBack: () => undefined,
  stepperStepId: "details",
  completedStepIds: ["tickets"],
});

beforeEach(() => {
  state.gateType = "APPLICATION";
  state.detail = "data";
  state.refetches = 0;
  state.feeRateOptions = [];
  state.waiverOptions = [];
});

describe("EmbedCheckout — a gated event", () => {
  it("shows the gated card under Back, with no form, summary or total", () => {
    render(<EmbedCheckout {...props()} />);
    expect(screen.getByTestId("embed-gated-event")).toBeInTheDocument();
    expect(
      screen.getByTestId("embed-gated-event-cta").getAttribute("href"),
    ).toBe("https://ithasfire.test/events/gated-night");
    expect(screen.getByRole("button", { name: "back" })).toBeInTheDocument();
    expect(screen.queryByTestId("details-form")).toBeNull();
    expect(screen.queryByTestId("order-summary")).toBeNull();
    expect(screen.queryByTestId("mobile-cta-bar")).toBeNull();
    expect(screen.queryByText("checkout.calculatingTotal")).toBeNull();
  });

  it("never asks for the fee rates or the waiver", () => {
    render(<EmbedCheckout {...props()} />);
    expect(state.feeRateOptions.length).toBeGreaterThan(0);
    expect(state.feeRateOptions.every((o) => o.enabled === false)).toBe(true);
    expect(state.waiverOptions.length).toBeGreaterThan(0);
    expect(state.waiverOptions.every((o) => o.enabled === false)).toBe(true);
  });

  it.each(["NONE", undefined])(
    "an ungated detail (gateType %s) keeps the form and asks for both",
    (gateType) => {
      state.gateType = gateType;
      render(<EmbedCheckout {...props()} />);
      expect(screen.queryByTestId("embed-gated-event")).toBeNull();
      expect(screen.getByTestId("details-form")).toBeInTheDocument();
      expect(state.feeRateOptions.at(-1)?.enabled).toBe(true);
      expect(state.waiverOptions.at(-1)?.enabled).toBe(true);
    },
  );

  // Review 2026-10-13: with no detail there is no waiver read either, so a
  // form shown then asked for no waiver and the submit failed on
  // WAIVER_REQUIRED with the waiver never shown.
  it("while the detail read is loading: a spinner under Back, no form", () => {
    state.detail = "loading";
    render(<EmbedCheckout {...props()} />);
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "back" })).toBeInTheDocument();
    expect(screen.queryByTestId("details-form")).toBeNull();
    expect(screen.queryByTestId("order-summary")).toBeNull();
    expect(screen.queryByTestId("mobile-cta-bar")).toBeNull();
  });

  it("when the detail read fails: the error screen retries the read, no form", () => {
    state.detail = "error";
    render(<EmbedCheckout {...props()} />);
    expect(screen.queryByTestId("details-form")).toBeNull();
    fireEvent.click(screen.getByTestId("detail-error"));
    expect(state.refetches).toBe(1);
  });

  // Review round 2: the wait for the detail read is for the details form
  // only. Once an order exists (or a payment is in flight) the payment step
  // stays on screen whatever the detail read is doing.
  it.each([
    ["an order exists", false],
    ["an order exists and its payment is in flight", true],
  ])(
    "while the detail read is loading and %s: the payment step, no spinner, no form",
    (_label, isPaying) => {
      state.detail = "loading";
      render(
        <EmbedCheckout
          {...props()}
          paymentOrder={orderOnScreen}
          isPaying={isPaying}
        />,
      );
      expect(screen.queryByTestId("embed-checkout-detail-loading")).toBeNull();
      expect(screen.queryByTestId("details-form")).toBeNull();
      expect(screen.getByTestId("payment-form")).toBeInTheDocument();
    },
  );
});
