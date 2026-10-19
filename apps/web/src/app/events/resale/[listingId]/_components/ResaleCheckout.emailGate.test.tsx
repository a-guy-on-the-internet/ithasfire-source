import type { ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BeforePaymentResult } from "@/app/events/checkout/[...slug]/_components/StripePaymentCard";

/**
 * B2: `resale.createCheckout` refuses an unverified buyer with
 * `email_verification_required`. The buyer used to see that raw code inline
 * plus the global "Action failed" toast. Now the verify prompt takes the
 * payment card's place (up front when the session already says unverified),
 * the toast is suppressed for that error only, and verifying brings the card
 * back.
 */

const h = vi.hoisted(() => ({
  createCheckoutMutateAsync: vi.fn(),
  mutationOptions: { current: null as null | { meta?: Record<string, unknown> } },
  session: {
    current: { id: "u1", email: "ana@example.com", emailVerified: true } as Record<
      string,
      unknown
    >,
  },
  cardProps: {
    current: null as null | {
      onBeforePayment: () => Promise<BeforePaymentResult | string | null>;
    },
  },
  gateProps: {
    current: null as null | {
      context?: string;
      autoFocusHeading?: boolean;
      onVerified?: () => void;
    },
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
      onBeforePayment: () => Promise<BeforePaymentResult | string | null>;
    }) => {
      h.cardProps.current = props;
      return <div data-testid="stripe-card" />;
    },
  }),
);

vi.mock("@/app/events/checkout/[...slug]/_components/RefundDisclosure", () => ({
  RefundDisclosure: (props: {
    onCheckedChange: (v: boolean) => void;
    onTermsCheckedChange: (v: boolean) => void;
  }) => {
    h.disclosureProps.current = props;
    return null;
  },
}));

vi.mock("@/components/auth/EmailVerificationRequired", () => ({
  EmailVerificationRequired: (props: {
    context?: string;
    onVerified?: () => void;
  }) => {
    h.gateProps.current = props;
    return <div data-testid="resale-checkout-verify-email">{props.context}</div>;
  },
}));

vi.mock("@th/ui", async () => {
  const { ButtonStub } = await import("@/test-support/th-ui-button-stub");
  return {
    useTranslations: () => (key: string) => key,
    useFormatters: () => ({
      dateTime: () => "",
      currency: (n: number) => `$${n.toFixed(2)}`,
      number: (n: number) => String(n),
    }),
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Button: ButtonStub,
  };
});

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
  estimatedTotalCents: 4660,
};

vi.mock("@/trpc", () => ({
  trpc: {
    resale: {
      getListing: {
        useQuery: () => ({ data: LISTING, isLoading: false, error: null }),
      },
      createCheckout: {
        useMutation: (options: { meta?: Record<string, unknown> }) => {
          h.mutationOptions.current = options;
          return { isPending: false, mutateAsync: h.createCheckoutMutateAsync };
        },
      },
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: h.session.current } }),
  },
}));

vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: vi.fn() }),
}));

vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ResaleCheckout } from "./ResaleCheckout";

const gateError = {
  name: "TRPCClientError",
  message: "email_verification_required",
  data: { code: "FORBIDDEN", httpStatus: 403, appCode: "FORBIDDEN" },
};

describe("ResaleCheckout: unverified buyer (B2)", () => {
  beforeEach(() => {
    h.createCheckoutMutateAsync.mockReset();
    h.cardProps.current = null;
    h.gateProps.current = null;
    h.disclosureProps.current = null;
    h.session.current = {
      id: "u1",
      email: "ana@example.com",
      emailVerified: true,
    };
  });

  it("asks for the code up front when the session is unverified, with no card to fill", async () => {
    h.session.current = { ...h.session.current, emailVerified: false };
    render(<ResaleCheckout listingId="listing-1" />);

    expect(
      await screen.findByTestId("resale-checkout-verify-email"),
    ).toHaveTextContent("resale");
    expect(screen.queryByTestId("stripe-card")).not.toBeInTheDocument();
    // Nothing was pressed, so focus is left where it is.
    expect(h.gateProps.current?.autoFocusHeading).toBe(false);
  });

  it("swaps the card for the prompt when the server refuses, without the raw code", async () => {
    h.createCheckoutMutateAsync.mockRejectedValueOnce(gateError);
    render(<ResaleCheckout listingId="listing-1" />);
    await waitFor(() => expect(h.cardProps.current).not.toBeNull());
    act(() => {
      h.disclosureProps.current!.onTermsCheckedChange(true);
      h.disclosureProps.current!.onCheckedChange(true);
    });

    await act(async () => {
      await h.cardProps.current!.onBeforePayment().catch(() => undefined);
    });

    expect(
      screen.getByTestId("resale-checkout-verify-email"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("stripe-card")).not.toBeInTheDocument();
    expect(
      screen.queryByText("email_verification_required"),
    ).not.toBeInTheDocument();
    // The pressed control is gone: focus goes to the prompt, not <body>.
    expect(h.gateProps.current?.autoFocusHeading).toBe(true);

    // Verifying brings the payment card back.
    act(() => h.gateProps.current!.onVerified!());
    expect(screen.getByTestId("stripe-card")).toBeInTheDocument();
    expect(
      screen.queryByTestId("resale-checkout-verify-email"),
    ).not.toBeInTheDocument();
  });

  it("silences the global mutation toast for the gate error only", () => {
    render(<ResaleCheckout listingId="listing-1" />);
    const silentWhen = h.mutationOptions.current?.meta?.silentWhen as
      | ((error: unknown) => boolean)
      | undefined;

    expect(silentWhen).toBeTypeOf("function");
    expect(silentWhen!(gateError)).toBe(true);
    expect(
      silentWhen!({ message: "LISTING_ALREADY_HELD", data: { appCode: "LISTING_ALREADY_HELD" } }),
    ).toBe(false);
  });
});
