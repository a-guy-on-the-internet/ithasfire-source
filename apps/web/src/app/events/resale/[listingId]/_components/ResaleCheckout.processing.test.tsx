import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type CardProps = {
  onBeforePayment: () => Promise<string | null>;
  onSuccess: (id: string, status: "succeeded" | "processing") => void;
  onError: (message: string, code?: string, status?: string) => void;
};

/**
 * A US bank debit confirms with PaymentIntent status `processing`: Stripe
 * accepted it, but the debit can still fail days later, so the page must not
 * treat it as paid. The card's `onSuccess` and the
 * `payment_intent_unexpected_state` error (an already-accepted PaymentIntent
 * pressed again) both carry the status; `processing` enters the processing
 * phase, `succeeded` the confirmed one.
 */

const {
  listingRef,
  listingErrorRef,
  createCheckoutMutateAsync,
  cardProps,
  disclosureProps,
  routerPush,
} = vi.hoisted(() => ({
    routerPush: vi.fn(),
    listingRef: { current: {} as Record<string, unknown> | undefined },
    /** A failed (background) read: React Query keeps `data` beside it. */
    listingErrorRef: { current: false },
    createCheckoutMutateAsync: vi.fn(),
    cardProps: {
      current: null as null | CardProps,
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
    StripePaymentCard: (props: CardProps) => {
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
  Button: ({
    children,
    onPress,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
  }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
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
          isError: listingErrorRef.current,
          error: listingErrorRef.current ? new Error("refetch failed") : null,
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

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: routerPush }),
}));

import { ResaleCheckout } from "./ResaleCheckout";
import en from "@/i18n/messages/en";

async function renderPaying(): Promise<
  CardProps & { rerender: () => void }
> {
  const view = render(<ResaleCheckout listingId="listing-1" />);
  await waitFor(() => expect(cardProps.current).not.toBeNull());
  return {
    ...cardProps.current!,
    rerender: () => view.rerender(<ResaleCheckout listingId="listing-1" />),
  };
}

describe("ResaleCheckout — a payment still processing is not confirmed", () => {
  beforeEach(() => {
    createCheckoutMutateAsync.mockReset();
    routerPush.mockReset();
    cardProps.current = null;
    disclosureProps.current = null;
    listingRef.current = { ...BASE_LISTING, isOwnListing: false };
    listingErrorRef.current = false;
  });

  /** The processing screen: marked, and the payment card gone. */
  const expectProcessingScreen = async () => {
    await waitFor(() =>
      expect(
        document.querySelector('[data-payment-processing="true"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByTestId("stripe-card")).not.toBeInTheDocument();
  };

  // Owner board pick A (2026-10-14): the confirmed screen with only the
  // untrue parts changed. `t` is the identity here, so the keys show; the
  // catalog check pins the words.
  it("processing phase shows the pending copy, never 'Purchase confirmed'", async () => {
    const card = await renderPaying();
    act(() => card.onSuccess("pi_1", "processing"));
    await expectProcessingScreen();

    expect(
      screen.getByText("resell.paymentProcessingTitle"),
    ).toBeInTheDocument();
    expect(screen.getByText("resell.paymentProcessingBody")).toBeInTheDocument();
    expect(screen.queryByText("Purchase confirmed")).not.toBeInTheDocument();
    // What was bought, and the way out, are unchanged.
    expect(screen.getByText("Sixth Street Comedy Night")).toBeInTheDocument();
    expect(screen.getByText("General Admission")).toBeInTheDocument();
    expect(screen.getByText("Back to event")).toBeInTheDocument();
  });

  it("processing: the primary button is 'View order' and opens the order, not 'View my tickets'", async () => {
    createCheckoutMutateAsync.mockResolvedValue({
      orderId: "0920501b-8045-439c-a2dc-7570a8052907",
      clientSecret: "cs_1",
      amountGrossCents: 4500,
      buyerFeesCents: 0,
      taxAmountCents: 0,
    });
    // The Pay button's figure, so the charge goes ahead.
    listingRef.current = {
      ...BASE_LISTING,
      isOwnListing: false,
      estimatedTotalCents: 4500,
    };
    const card = await renderPaying();
    act(() => {
      disclosureProps.current?.onCheckedChange(true);
      disclosureProps.current?.onTermsCheckedChange(true);
    });
    await act(async () => {
      await cardProps.current!.onBeforePayment();
    });
    act(() => card.onSuccess("pi_1", "processing"));
    await expectProcessingScreen();

    expect(screen.queryByText("View my tickets")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("confirmation.viewOrder"));
    expect(routerPush).toHaveBeenCalledWith(
      "/my-tickets/0920501b-8045-439c-a2dc-7570a8052907",
    );
  });

  it("succeeded: the primary button is still 'View my tickets' to the tickets list", async () => {
    const card = await renderPaying();
    act(() => card.onSuccess("pi_1", "succeeded"));
    fireEvent.click(await screen.findByText("View my tickets"));
    expect(routerPush).toHaveBeenCalledWith("/account/tickets");
  });

  it("the processing copy reads as the owner wrote it", () => {
    const resell = (en as unknown as Record<string, Record<string, string>>)
      .resell;
    expect(resell.paymentProcessingTitle).toBe("Payment processing");
    expect(resell.paymentProcessingBody).toBe(
      "Bank payments take a few business days to clear. The ticket is yours when it does, and we'll email you. If the payment doesn't go through, the order is cancelled and you aren't charged.",
    );
  });

  it("onSuccess with 'processing' enters the processing phase", async () => {
    const card = await renderPaying();
    act(() => card.onSuccess("pi_1", "processing"));

    await expectProcessingScreen();
  });

  it("onSuccess with 'succeeded' enters the confirmed phase", async () => {
    const card = await renderPaying();
    act(() => card.onSuccess("pi_1", "succeeded"));

    expect(await screen.findByText("Purchase confirmed")).toBeInTheDocument();
    expect(document.querySelector("[data-payment-processing]")).toBeNull();
  });

  it("payment_intent_unexpected_state with 'processing' enters the processing phase", async () => {
    const card = await renderPaying();
    act(() =>
      card.onError("already", "payment_intent_unexpected_state", "processing"),
    );

    await expectProcessingScreen();
  });

  it("payment_intent_unexpected_state with 'succeeded' enters the confirmed phase", async () => {
    const card = await renderPaying();
    act(() =>
      card.onError("already", "payment_intent_unexpected_state", "succeeded"),
    );

    expect(await screen.findByText("Purchase confirmed")).toBeInTheDocument();
    expect(document.querySelector("[data-payment-processing]")).toBeNull();
  });

  it("the processing screen stays up when the listing is no longer ACTIVE", async () => {
    const card = await renderPaying();
    act(() => card.onSuccess("pi_1", "processing"));
    await expectProcessingScreen();

    // The listing leaves ACTIVE once bought (an ACH purchase leaves it
    // HELD); the next read must not swap the screen for "Listing
    // unavailable".
    listingRef.current = {
      ...BASE_LISTING,
      isOwnListing: false,
      status: "HELD",
    };
    card.rerender();

    await expectProcessingScreen();
    expect(screen.queryByText("Listing unavailable")).not.toBeInTheDocument();
  });

  it("regression: a background refetch that FAILS (data kept) does not swap the processing screen for 'Listing not found'", async () => {
    const card = await renderPaying();
    act(() => card.onSuccess("pi_1", "processing"));
    await expectProcessingScreen();

    listingErrorRef.current = true;
    card.rerender();

    await expectProcessingScreen();
    expect(screen.queryByText("Listing not found")).not.toBeInTheDocument();
  });

  it("a failed read with NO listing data still keeps the purchase screen, without the listing's names", async () => {
    const card = await renderPaying();
    act(() => card.onSuccess("pi_1", "succeeded"));
    expect(await screen.findByText("Purchase confirmed")).toBeInTheDocument();

    listingErrorRef.current = true;
    listingRef.current = undefined;
    card.rerender();

    expect(screen.getByText("Purchase confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Listing not found")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Sixth Street Comedy Night"),
    ).not.toBeInTheDocument();
  });
});
