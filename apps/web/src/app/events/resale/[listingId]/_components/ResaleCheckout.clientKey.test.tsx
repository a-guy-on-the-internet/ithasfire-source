import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BeforePaymentResult } from "@/app/events/checkout/[...slug]/_components/StripePaymentCard";

/**
 * The resale.createCheckout idempotency key after a FAILED attempt.
 *
 * Same rule as the ticket checkout (apps/web/src/lib/checkout-client-key.ts):
 * a failure with no server app code (lost response, dropped connection) may
 * have committed an order holding the listing, so the key is kept and the
 * retry replays it; so is IDEMPOTENCY_LOCK_IN_PROGRESS (the first attempt is
 * still running). Any other server refusal already released the key, and the
 * next attempt gets a fresh one. Mirrors useCheckoutState.clientKey.test.tsx.
 */

const { createCheckoutMutateAsync, cardProps, disclosureProps } = vi.hoisted(
  () => ({
    createCheckoutMutateAsync: vi.fn(),
    cardProps: {
      current: null as null | {
        onBeforePayment: () => Promise<BeforePaymentResult | string | null>;
      },
    },
    disclosureProps: {
      current: null as null | {
        onCheckedChange: (v: boolean) => void;
        onTermsCheckedChange: (v: boolean) => void;
      },
    },
  }),
);

vi.mock(
  "@/app/events/checkout/[...slug]/_components/StripePaymentCard",
  () => ({
    StripePaymentCard: (props: {
      onBeforePayment: () => Promise<BeforePaymentResult | string | null>;
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
  // The estimate the Pay button showed: OK's charge (4500 + 160), so a
  // successful attempt is confirmable rather than stopped for a higher total.
  estimatedTotalCents: 4660,
};

vi.mock("@/trpc", () => ({
  trpc: {
    resale: {
      getListing: {
        useQuery: () => ({ data: LISTING, isLoading: false, error: null }),
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

const trpcError = (appCode: string) =>
  Object.assign(new Error(appCode), { data: { appCode } });

const OK = {
  orderId: "33333333-3333-4333-8333-333333333333",
  clientSecret: "pi_secret",
  amountGrossCents: 4500,
  buyerFeesCents: 160,
  taxAmountCents: 0,
  holdExpiresAt: "2030-01-01T00:15:00.000Z",
};

async function renderReady() {
  render(<ResaleCheckout listingId="listing-1" />);
  await waitFor(() => expect(cardProps.current).not.toBeNull());
  await waitFor(() => expect(disclosureProps.current).not.toBeNull());
  act(() => {
    disclosureProps.current!.onTermsCheckedChange(true);
    disclosureProps.current!.onCheckedChange(true);
  });
}

/** Run one attempt; swallow the rethrow the payment card would show. */
async function attempt() {
  await act(async () => {
    await cardProps.current!.onBeforePayment().catch(() => undefined);
  });
}

const sentKeys = () =>
  createCheckoutMutateAsync.mock.calls.map(
    ([input]) => (input as { clientKey: string }).clientKey,
  );

describe("ResaleCheckout — clientKey after a failed attempt", () => {
  beforeEach(() => {
    createCheckoutMutateAsync.mockReset();
    cardProps.current = null;
    disclosureProps.current = null;
  });

  it.each([
    ["no app code (lost response)", new Error("fetch failed")],
    ["IDEMPOTENCY_LOCK_IN_PROGRESS", trpcError("IDEMPOTENCY_LOCK_IN_PROGRESS")],
  ])("keeps the key after %s, so the retry replays the first attempt", async (_label, error) => {
    createCheckoutMutateAsync
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(OK);
    await renderReady();

    await attempt();
    await attempt();

    const [first, second] = sentKeys();
    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
  });

  it("rotates the key after any other server refusal (claim already released)", async () => {
    createCheckoutMutateAsync
      .mockRejectedValueOnce(trpcError("LISTING_ALREADY_HELD"))
      .mockResolvedValueOnce(OK);
    await renderReady();

    await attempt();
    await attempt();

    const [first, second] = sentKeys();
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
  });

  it("after the order is created, the next press pays the SAME order (no second createCheckout, whose hold check would refuse it)", async () => {
    createCheckoutMutateAsync.mockResolvedValue(OK);
    await renderReady();

    let second: unknown;
    await attempt();
    await act(async () => {
      second = await cardProps.current!.onBeforePayment();
    });

    expect(sentKeys()).toHaveLength(1);
    expect(second).toEqual({ clientSecret: "pi_secret", amountCents: 4660 });
  });
});
