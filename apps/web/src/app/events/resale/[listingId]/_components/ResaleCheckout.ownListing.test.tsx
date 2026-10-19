import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The seller opening their own listing link. `resale.getListing` answers
 * `isOwnListing: true` for the session's seller, and checkout would refuse
 * them (CANNOT_BUY_OWN_LISTING), so the page shows "This is your listing"
 * with no payment card. If the refusal still arrives (the flag was false on
 * a stale read), it shows the translated copy, not the raw server message.
 */

const { listingRef, createCheckoutMutateAsync, cardProps, disclosureProps } =
  vi.hoisted(() => ({
    listingRef: { current: {} as Record<string, unknown> },
    createCheckoutMutateAsync: vi.fn(),
    cardProps: {
      current: null as null | { onBeforePayment: () => Promise<string | null> },
    },
    disclosureProps: {
      current: null as null | {
        onCheckedChange: (v: boolean) => void;
        onTermsCheckedChange: (v: boolean) => void;
      },
    },
  }));

vi.mock(
  "@/app/events/checkout/[...slug]/_components/StripePaymentCard",
  () => ({
    StripePaymentCard: (props: {
      onBeforePayment: () => Promise<string | null>;
    }) => {
      cardProps.current = props;
      return <div data-testid="stripe-card" />;
    },
  }),
);

vi.mock("@/app/events/checkout/[...slug]/_components/RefundDisclosure", () => ({
  RefundDisclosure: (props: {
    onCheckedChange: (v: boolean) => void;
    onTermsCheckedChange: (v: boolean) => void;
  }) => {
    disclosureProps.current = props;
    return null;
  },
}));

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

const BASE_LISTING = {
  id: "listing-1",
  eventId: "40000000-0000-4000-8000-000000000004",
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
        useQuery: () => ({
          data: listingRef.current,
          isLoading: false,
          error: null,
        }),
      },
      createCheckout: {
        useMutation: () => ({
          isPending: false,
          mutateAsync: createCheckoutMutateAsync,
        }),
      },
    },
  },
}));

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

describe("ResaleCheckout — the seller's own listing", () => {
  beforeEach(() => {
    createCheckoutMutateAsync.mockReset();
    cardProps.current = null;
    disclosureProps.current = null;
  });

  it("shows 'This is your listing' with the back link and no payment card", () => {
    listingRef.current = { ...BASE_LISTING, isOwnListing: true };

    render(<ResaleCheckout listingId="listing-1" />);

    expect(screen.getByText("resell.ownListingTitle")).toBeInTheDocument();
    expect(screen.getByText("resell.ownListingBody")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "common.backToEvent" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("stripe-card")).not.toBeInTheDocument();
    expect(document.querySelector(".checkout-payment-slot")).toBeNull();
  });

  it("a CANNOT_BUY_OWN_LISTING refusal shows the translated copy", async () => {
    listingRef.current = { ...BASE_LISTING, isOwnListing: false };
    createCheckoutMutateAsync.mockRejectedValueOnce(
      Object.assign(new Error("raw server message"), {
        data: { appCode: "CANNOT_BUY_OWN_LISTING" },
      }),
    );

    render(<ResaleCheckout listingId="listing-1" />);
    await waitFor(() => expect(cardProps.current).not.toBeNull());
    await waitFor(() => expect(disclosureProps.current).not.toBeNull());
    act(() => {
      disclosureProps.current!.onTermsCheckedChange(true);
      disclosureProps.current!.onCheckedChange(true);
    });
    await act(async () => {
      await cardProps.current!.onBeforePayment().catch(() => undefined);
    });

    expect(
      await screen.findByText("errors.cannotBuyOwnListing"),
    ).toBeInTheDocument();
    expect(screen.queryByText("raw server message")).not.toBeInTheDocument();
  });
});
