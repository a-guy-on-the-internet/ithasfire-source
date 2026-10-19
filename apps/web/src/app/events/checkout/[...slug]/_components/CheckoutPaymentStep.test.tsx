import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CheckoutPaymentStep } from "./CheckoutPaymentStep";

// ── Mocks ─────────────────────────────────────────────────────────────────
// Keys pass through, so assertions stay key-stable (the pattern the other 11
// test files in this folder use).
vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

// Both children record the props they were handed: the wiring test below
// asserts what reaches them.
const captured = vi.hoisted(() => ({
  header: null as null | Record<string, unknown>,
  card: null as null | Record<string, unknown>,
}));

vi.mock("./CheckoutTicketSummaryHeader", () => ({
  CheckoutTicketSummaryHeader: (props: Record<string, unknown>) => {
    captured.header = props;
    return null;
  },
}));

// The TARGET of the dynamic import is stubbed, not `next/dynamic` itself —
// mocking the loader would test the mock. This keeps the real
// `nextDynamic(..., { loading })` wiring under test while making the eventual
// resolution cheap (the real module pulls in Stripe.js).
vi.mock("./StripePaymentCard", () => ({
  StripePaymentCard: (props: Record<string, unknown>) => {
    captured.card = props;
    return <div data-testid="stripe-card" />;
  },
}));

const PROPS = {
  selectedQty: 1,
  onChangeTickets: () => {},
  clientSecret: "cs_test",
  onPaymentSuccess: () => {},
  onPaymentError: () => {},
  totalCents: 4542,
  currency: "USD",
  eventName: "Sixth Street Comedy Night",
  onBeforePayment: () => Promise.resolve(null),
  isCreatingOrder: false,
  payButtonLabel: "Pay $45.42",
  termsAccepted: true,
  refundPolicyAccepted: true,
};

describe("CheckoutPaymentStep", () => {
  // ONE test owns the loading state on purpose. `next/dynamic` caches the
  // resolved module at module scope, so only the first render in this file
  // ever sees the fallback — a second test asserting on it would pass or fail
  // by execution order.
  it("renders a loading skeleton inside the reserved slot, then swaps in the card", async () => {
    // THE regression that started this. With no `loading:` on the dynamic
    // import the step rendered an empty section for the length of the chunk
    // fetch — measured at ~1.5s on Slow 4G, during which the checkout card
    // collapsed from 952px of filled form to 544px.
    const { container } = render(<CheckoutPaymentStep {...PROPS} />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("common.loading");

    // `aria-busy` is deliberately absent: nothing here ever flips it to false
    // (the element unmounts), and a live region that is permanently busy is a
    // live region that never speaks.
    expect(status).not.toHaveAttribute("aria-busy");

    // The reservation is on the SLOT, not the skeleton, because it has to
    // survive the skeleton's unmount — PaymentElement is an iframe and renders
    // as a zero-height div for a second or more after the chunk resolves. The
    // height itself lives in checkout.css so it can be media-queried.
    const slot = container.querySelector(".checkout-payment-slot");
    expect(slot).not.toBeNull();
    expect(slot).toContainElement(status);

    // The card arrives, the skeleton goes with it, and the slot stays put.
    await waitFor(() =>
      expect(screen.getByTestId("stripe-card")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.querySelector(".checkout-payment-slot")).toContainElement(
      screen.getByTestId("stripe-card"),
    );
  });

  it("regression: forwards the 'Stripe confirm submitting' report to the card, and the lock to 'Change tickets'", async () => {
    // Dropping either silently removes the 3-D Secure protection: the hold
    // auto-reset and the way back are held off only while this reports true.
    const onPaymentSubmittingChange = vi.fn();
    render(
      <CheckoutPaymentStep
        {...PROPS}
        changeTicketsDisabled
        onPaymentSubmittingChange={onPaymentSubmittingChange}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("stripe-card")).toBeInTheDocument(),
    );
    expect(captured.card?.onSubmittingChange).toBe(onPaymentSubmittingChange);
    expect(captured.header?.changeTicketsDisabled).toBe(true);
  });

  it("the card's total follows the step's total (the wallet sheet's amount rides on it)", async () => {
    // StripePaymentCard keeps Elements' amount, the figure an Apple Pay /
    // Google Pay sheet shows, on `totalCents`. A step that froze or dropped
    // it would leave the sheet on a stale amount.
    const { rerender } = render(<CheckoutPaymentStep {...PROPS} />);
    await waitFor(() =>
      expect(screen.getByTestId("stripe-card")).toBeInTheDocument(),
    );
    expect(captured.card?.totalCents).toBe(4542);
    rerender(<CheckoutPaymentStep {...PROPS} totalCents={4088} />);
    expect(captured.card?.totalCents).toBe(4088);
  });
});
