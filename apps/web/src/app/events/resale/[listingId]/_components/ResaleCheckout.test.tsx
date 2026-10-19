import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────
// The TARGET of the dynamic import is stubbed, not `next/dynamic` — mocking
// the loader would test the mock. This keeps the real
// `nextDynamic(..., { loading })` wiring under test while making the eventual
// resolution cheap (the real module pulls in Stripe.js).
vi.mock(
  "@/app/events/checkout/[...slug]/_components/StripePaymentCard",
  () => ({ StripePaymentCard: () => <div data-testid="stripe-card" /> }),
);

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  useFormatters: () => ({
    dateTime: () => "",
    currency: (n: number) => `$${n.toFixed(2)}`,
    number: (n: number) => String(n),
  }),
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

vi.mock("@/app/events/checkout/[...slug]/_components/RefundDisclosure", () => ({
  RefundDisclosure: () => null,
}));

const LISTING = {
  id: "listing-1",
  status: "ACTIVE",
  askPriceCents: 4500,
  currency: "USD",
  eventName: "Sixth Street Comedy Night",
  eventSlug: "sixth-street-comedy-night",
  ticketTypeName: "General Admission",
  facePriceCents: 4000,
  eventStartsAt: null,
  eventLocationLabel: null,
  sectionName: null,
  seatLabel: null,
  seatRow: null,
  seatNumber: null,
  expiresAt: null,
};

vi.mock("@/trpc", () => ({
  trpc: {
    resale: {
      getListing: {
        useQuery: () => ({ data: LISTING, isLoading: false, error: null }),
      },
      createCheckout: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
    },
  },
}));

// Signed IN — the payment card only renders for a signed-in buyer.
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "u1", email: "a@b.com" } } }),
  },
}));

vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: vi.fn() }),
}));

vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ResaleCheckout } from "./ResaleCheckout";

describe("ResaleCheckout", () => {
  // ONE test owns the loading state: `next/dynamic` caches the resolved module
  // at module scope, so only the first render in this file ever sees the
  // fallback — a second test asserting on it would pass or fail by execution
  // order. (Same constraint documented on CheckoutPaymentStep.test.tsx.)
  it("renders the shared loading skeleton inside the shared reserved slot", async () => {
    // The defect: this section rendered BARE for the length of the chunk fetch
    // and again while Stripe's iframes mounted.
    const { container } = render(<ResaleCheckout listingId="listing-1" />);

    // `getByRole`, NOT `findByRole`. Awaiting lets the dynamic import resolve
    // first, after which the skeleton is a DETACHED node and every containment
    // assertion below silently compares against the wrong tree.
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("common.loading");

    // Reused verbatim from the ticket checkout — the reservation is a container
    // query on the slot's own inline size, so it needs no resale-specific rung.
    const slot = container.querySelector(".checkout-payment-slot");
    expect(slot).not.toBeNull();
    expect(slot?.parentElement).toHaveClass("checkout-payment-measure");
    expect(slot).toContainElement(status);

    await waitFor(() =>
      expect(screen.getByTestId("stripe-card")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.querySelector(".checkout-payment-slot")).toContainElement(
      screen.getByTestId("stripe-card"),
    );
  });
});
