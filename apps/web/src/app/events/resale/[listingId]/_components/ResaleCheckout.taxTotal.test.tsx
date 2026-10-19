import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The amount on the Pay button is the amount charged.
 *
 * Found in a live run: before the order existed the page read "Total $51.81"
 * and "Pay $51.81", and the card was charged $56.38 (the tax checkout adds).
 * Before the order exists the page now shows the server's estimate including
 * tax, and labels the button with it; with the tax unknown it claims no
 * figure at all. Once the order exists, the order's own amounts. A charge
 * above the figure the buyer pressed is never confirmed on that press.
 */

type CardProps = {
  totalLabel?: string;
  totalCents?: number;
  expressPay?: boolean;
  onError: (
    message: string,
    code?: string,
    paymentIntentStatus?: string,
  ) => void;
  onBeforePayment: () => Promise<
    { clientSecret: string; amountCents: number } | string | null
  >;
};

const { createCheckoutMutateAsync, cardProps, disclosureProps, listingRef } =
  vi.hoisted(() => ({
    createCheckoutMutateAsync: vi.fn(),
    cardProps: { current: null as null | CardProps },
    disclosureProps: {
      current: null as null | {
        onCheckedChange: (v: boolean) => void;
        onTermsCheckedChange: (v: boolean) => void;
      },
    },
    listingRef: { current: null as null | Record<string, unknown> },
  }));

vi.mock(
  "@/app/events/checkout/[...slug]/_components/StripePaymentCard",
  () => ({
    StripePaymentCard: (props: CardProps) => {
      cardProps.current = props;
      return <div data-testid="stripe-card">{props.totalLabel ?? "PAY_NOW"}</div>;
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

vi.mock("@/components/resale/ResaleListingFacts", () => ({
  ResaleListingFacts: () => null,
}));

vi.mock("@th/ui", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string>) =>
      values ? `${key}(${Object.values(values).join(",")})` : key,
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

/** A $50 ask in an 8.88% state: $1.81 processing before tax, $4.44 tax, $1.94 processing grossed up over the tax, $56.38 total. */
const LISTING = {
  id: "listing-1",
  status: "ACTIVE",
  askPriceCents: 5000,
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
  originalPriceCents: 4000,
  eventShareCents: 500,
  sharePayer: "SELLER",
  buyerTotalBeforeFeesCents: 5000,
  processingPassThroughCents: 181,
  buyerTotalBeforeTaxCents: 5181,
  estimatedTaxCents: 444,
  estimatedProcessingCents: 194,
  estimatedTotalCents: 5638,
  ticketTypePricing: null,
};

async function renderReady() {
  render(<ResaleCheckout listingId="listing-1" />);
  await waitFor(() => expect(cardProps.current).not.toBeNull());
}

const totalRow = () => screen.getByTestId("resale-total-row");

describe("ResaleCheckout — the Pay button and total include the tax", () => {
  beforeEach(() => {
    createCheckoutMutateAsync.mockReset();
    cardProps.current = null;
    disclosureProps.current = null;
    listingRef.current = LISTING;
  });

  it("before the order: Pay, the total and the card's amount are the estimate including tax", async () => {
    await renderReady();

    expect(cardProps.current!.totalLabel).toBe("checkout.payAmount($56.38)");
    expect(cardProps.current!.totalCents).toBe(5638);
    expect(within(totalRow()).getByText("checkout.estimatedTotal")).toBeInTheDocument();
    expect(within(totalRow()).getByText("$56.38")).toBeInTheDocument();
    expect(screen.getByText("checkout.estimatedTaxes")).toBeInTheDocument();
    expect(screen.getByText("$4.44")).toBeInTheDocument();
    expect(screen.queryByText("resell.taxAtCheckout")).not.toBeInTheDocument();
    // The header agrees with the rows: the estimated total, worded as one.
    const header = within(screen.getByTestId("resale-all-in-price"));
    expect(header.getByText("$56.38")).toBeInTheDocument();
    expect(
      header.getByText("resell.estimatedTotalWithProcessingAndTax"),
    ).toBeInTheDocument();
    expect(header.queryByText("resell.plusTaxIncludesProcessing")).not.toBeInTheDocument();
  });

  it("tax unknown: no figure on the button, a subtotal, and tax added at checkout", async () => {
    listingRef.current = {
      ...LISTING,
      estimatedTaxCents: null,
      estimatedProcessingCents: null,
      estimatedTotalCents: null,
    };
    await renderReady();

    expect(cardProps.current!.totalLabel).toBeUndefined();
    expect(screen.getByTestId("stripe-card")).toHaveTextContent("PAY_NOW");
    expect(within(totalRow()).getByText("checkout.subtotal")).toBeInTheDocument();
    expect(within(totalRow()).getByText("$51.81")).toBeInTheDocument();
    // The Processing row falls back to the listing's pre-tax figure.
    const processingRow = screen.getByText("checkout.processingFee").parentElement!;
    expect(within(processingRow).getByText("$1.81")).toBeInTheDocument();
    expect(screen.getByText("resell.taxAtCheckout")).toBeInTheDocument();
    expect(screen.queryByText("checkout.estimatedTotal")).not.toBeInTheDocument();
    // No estimate: the header keeps the pre-tax figure and "plus tax".
    const header = within(screen.getByTestId("resale-all-in-price"));
    expect(header.getByText("$51.81")).toBeInTheDocument();
    expect(header.getByText("resell.plusTaxIncludesProcessing")).toBeInTheDocument();
  });

  it("tax unknown: no wallet buttons (their sheet would show the pre-tax amount)", async () => {
    listingRef.current = {
      ...LISTING,
      estimatedTaxCents: null,
      estimatedProcessingCents: null,
      estimatedTotalCents: null,
    };
    await renderReady();
    expect(cardProps.current!.expressPay).toBe(false);
  });

  it("tax known: wallet buttons stay", async () => {
    await renderReady();
    expect(cardProps.current!.expressPay).toBe(true);
  });

  it("a charge at or below the shown estimate is confirmed, at the server's figure", async () => {
    createCheckoutMutateAsync.mockResolvedValue(order(443)); // 5637 < 5638
    await renderReady();
    acceptTerms();

    const result = await press();

    expect(result).toEqual({ clientSecret: "pi_secret", amountCents: 5637 });
    await waitFor(() =>
      expect(cardProps.current!.totalLabel).toBe("checkout.payAmount($56.37)"),
    );
    expect(within(totalRow()).getByText("checkout.total")).toBeInTheDocument();
    expect(within(totalRow()).getByText("$56.37")).toBeInTheDocument();
  });

  it("a charge ABOVE the shown estimate stops: nothing confirmable, the new total shown, the next press pays that order", async () => {
    createCheckoutMutateAsync.mockResolvedValue(order(445)); // 5639 > 5638
    await renderReady();
    acceptTerms();

    await expect(press()).rejects.toThrow("charge-above-shown");
    await waitFor(() =>
      expect(cardProps.current!.totalLabel).toBe("checkout.payAmount($56.39)"),
    );
    expect(within(totalRow()).getByText("$56.39")).toBeInTheDocument();
    // A neutral status notice, not the error box: nothing failed.
    expect(screen.getByRole("status")).toHaveTextContent(
      "resell.totalChangedPayAgain($56.39)",
    );
    // The wallet sheet's amount follows: the card gets the new total and
    // keeps Elements on it (StripePaymentCard's amount sync, always on).
    expect(cardProps.current!.totalCents).toBe(5639);

    // Second press, the button now naming $56.39: the SAME order, confirmable.
    const second = await press();
    expect(second).toEqual({ clientSecret: "pi_secret", amountCents: 5639 });
    expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("tax unknown: the first charge always stops (no figure was shown), the next press pays it", async () => {
    listingRef.current = {
      ...LISTING,
      estimatedTaxCents: null,
      estimatedProcessingCents: null,
      estimatedTotalCents: null,
    };
    createCheckoutMutateAsync.mockResolvedValue(order(444));
    await renderReady();
    acceptTerms();

    await expect(press()).rejects.toThrow("charge-above-shown");
    await waitFor(() =>
      expect(cardProps.current!.totalLabel).toBe("checkout.payAmount($56.38)"),
    );
    const second = await press();
    expect(second).toEqual({ clientSecret: "pi_secret", amountCents: 5638 });
    expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("a press after the hold's end pays the SAME order (it stays payable until the reaper cancels its PaymentIntent)", async () => {
    // Stopped (5639 > 5638); by the second press the hold time has passed.
    createCheckoutMutateAsync.mockResolvedValue(
      order(445, "2020-01-01T00:00:00.000Z"),
    );
    await renderReady();
    acceptTerms();

    await expect(press()).rejects.toThrow("charge-above-shown");
    const second = await press();

    expect(second).toEqual({ clientSecret: "pi_secret", amountCents: 5639 });
    // A second createCheckout would be refused: the listing is still HELD.
    expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("a CANCELED PaymentIntent (payment_intent_unexpected_state) drops the order; the next press makes a new one", async () => {
    createCheckoutMutateAsync.mockResolvedValue(order(444));
    await renderReady();
    acceptTerms();

    expect(await press()).toEqual({ clientSecret: "pi_secret", amountCents: 5638 });
    act(() => {
      cardProps.current!.onError(
        "This PaymentIntent's status is canceled.",
        "payment_intent_unexpected_state",
        "canceled",
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "resell.reservationEnded",
    );
    expect(
      screen.queryByText("This PaymentIntent's status is canceled."),
    ).not.toBeInTheDocument();

    await press();
    expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(2);
  });

  it.each(["succeeded", "processing"])(
    // `processing` (a bank debit) is accepted but not paid: it shows the
    // processing screen, never "Purchase confirmed" (owner, 2026-10-14).
    "an already-%s PaymentIntent (payment_intent_unexpected_state, e.g. a lost confirm answer) shows the purchase screen for that status, the order kept",
    async (status) => {
      createCheckoutMutateAsync.mockResolvedValue(order(444));
      await renderReady();
      acceptTerms();

      await press();
      act(() => {
        cardProps.current!.onError(
          "You cannot confirm this PaymentIntent because it has already succeeded.",
          "payment_intent_unexpected_state",
          status,
        );
      });

      if (status === "processing") {
        expect(
          screen.getByText("resell.paymentProcessingTitle"),
        ).toBeInTheDocument();
        expect(screen.queryByText("Purchase confirmed")).not.toBeInTheDocument();
      } else {
        expect(screen.getByText("Purchase confirmed")).toBeInTheDocument();
      }
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(1);
    },
  );

  it("any other card error keeps the order (a declined card is retried on it)", async () => {
    createCheckoutMutateAsync.mockResolvedValue(order(444));
    await renderReady();
    acceptTerms();

    await press();
    act(() => {
      cardProps.current!.onError("Your card was declined.", "card_declined");
    });
    expect(screen.getByText("Your card was declined.")).toBeInTheDocument();
    await press();
    expect(createCheckoutMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("processing covers the tax: with an estimate, the processing row shows the estimate's processing, so the rows add up to the total", async () => {
    // Owner 2026-10-14: processing is grossed up over the whole charge, tax
    // included. A new $50 listing stores $1.81 before tax; at 8.88% the
    // estimate's processing is $1.94 and the total $56.38.
    listingRef.current = {
      ...LISTING,
      processingPassThroughCents: 181,
      buyerTotalBeforeTaxCents: 5181,
      estimatedTaxCents: 444,
      estimatedProcessingCents: 194,
      estimatedTotalCents: 5638,
    };
    await renderReady();

    const processingRow = screen.getByText("checkout.processingFee").parentElement!;
    expect(within(processingRow).getByText("$1.94")).toBeInTheDocument();
    expect(within(totalRow()).getByText("$56.38")).toBeInTheDocument();
    expect(cardProps.current!.totalCents).toBe(5638);
    // The header shows the same estimated total as the rows below it.
    expect(
      within(screen.getByTestId("resale-all-in-price")).getByText("$56.38"),
    ).toBeInTheDocument();
  });

  it("processing covers the tax: with the tax unknown, the processing row keeps the listing's pre-tax figure", async () => {
    listingRef.current = {
      ...LISTING,
      processingPassThroughCents: 181,
      buyerTotalBeforeTaxCents: 5181,
      estimatedTaxCents: null,
      estimatedProcessingCents: null,
      estimatedTotalCents: null,
    };
    await renderReady();

    const processingRow = screen.getByText("checkout.processingFee").parentElement!;
    expect(within(processingRow).getByText("$1.81")).toBeInTheDocument();
    expect(screen.getByText("resell.taxAtCheckout")).toBeInTheDocument();
  });
});

function order(
  taxAmountCents: number,
  holdExpiresAt = "2030-01-01T00:15:00.000Z",
) {
  return {
    orderId: "33333333-3333-4333-8333-333333333333",
    clientSecret: "pi_secret",
    amountGrossCents: 5000,
    buyerFeesCents: 194,
    taxAmountCents,
    holdExpiresAt,
  };
}

function acceptTerms() {
  act(() => {
    disclosureProps.current!.onTermsCheckedChange(true);
    disclosureProps.current!.onCheckedChange(true);
  });
}

/** One press of Pay: what the card would get back from onBeforePayment. */
async function press() {
  let out: Promise<Awaited<ReturnType<CardProps["onBeforePayment"]>>>;
  await act(async () => {
    out = cardProps.current!.onBeforePayment();
    await out.catch(() => undefined);
  });
  return out!;
}
