import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `useCheckoutPromoPreview` against a REAL React Query client.
 *
 * The sibling `.pwyw.test.ts` mocks `useQuery` and returns whatever the test
 * says — which is exactly how a real-client behaviour hid: React Query
 * applies `placeholderData` to a pending query even when it is DISABLED. So
 * removing the last code (key → `codes: []`, query off) kept serving the
 * removed code's discount while the charge was full price. Here only the
 * SERVER is faked; caching, placeholders and enabled/disabled are real.
 */

type Selection = { ticketTypeId: string; qty: number };
type PreviewInput = {
  codes: string[];
  ticketSelections: Selection[];
  excludeOrderId?: string;
};
type PreviewResult = {
  totalDiscountCents: number;
  /** Absent from an API older than the field. */
  platformFeeReductionCents?: number;
  heldCartFees?: {
    buyerPlatformFeeCents: number;
    platformFeeWaivedCents: number;
    withoutDiscounts: {
      buyerPlatformFeeCents: number;
      platformFeeWaivedCents: number;
    };
  } | null;
  applications: Array<{
    normalizedCode: string;
    discountCents: number;
    source?: { kind: string; tierName?: string | null; label?: string | null };
  }>;
};

const { server } = vi.hoisted(() => ({
  server: {
    respond: (_input: PreviewInput): Promise<PreviewResult> =>
      Promise.resolve({ totalDiscountCents: 0, applications: [] }),
  },
}));

vi.mock("@/trpc", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    trpc: {
      promos: {
        preview: {
          // The real hook, keyed like tRPC keys it: path + input.
          useQuery: (input: PreviewInput, options: Record<string, unknown>) =>
            useQuery({
              queryKey: [["promos", "preview"], { input }],
              queryFn: () => server.respond(input),
              ...options,
            }),
        },
      },
    },
  };
});

vi.mock("@th/ui", () => ({
  useNotify: () => ({ toast: { warning: vi.fn(), danger: vi.fn() } }),
  useTranslations: () => (key: string) => key,
}));

import { useCheckoutPromoPreview } from "./useCheckoutPromoPreview";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

const makeWrapper = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return Wrapper;
};

type Props = {
  codes: string[];
  isSignedIn?: boolean;
  pendingOrderId?: string | null;
  qty?: number;
  paused?: boolean;
  urlCodes?: string[];
  /** A PWYW amount on the line (what a pause is for). */
  amount?: number;
};

const onRemovePromoCode = vi.fn();
const NO_URL_CODES: string[] = [];

const renderPreview = (initial: Props) =>
  renderHook(
    ({
      codes,
      isSignedIn = false,
      pendingOrderId = null,
      qty = 1,
      paused = false,
      urlCodes = NO_URL_CODES,
      amount,
    }: Props) =>
      useCheckoutPromoPreview({
        eventId: EVENT_ID,
        initialUrlPromoCodes: urlCodes,
        quantities: { "tt-ga": qty },
        donationAmounts: amount === undefined ? undefined : { "tt-ga": amount },
        promoCodes: codes,
        isSignedIn,
        pendingOrderId,
        paused,
        onApplyPromoCode: () => null,
        onRemovePromoCode,
      }),
    { initialProps: initial, wrapper: makeWrapper() },
  );

/** WELCOME10 is 10% of a $55 ticket: 550 per ticket. */
const discountFor = (codes: string[], qty = 1): PreviewResult => ({
  totalDiscountCents: codes.includes("WELCOME10") ? 550 * qty : 0,
  applications: codes.map((code) => ({
    normalizedCode: code,
    discountCents: code === "WELCOME10" ? 550 * qty : 0,
  })),
});
const qtyOf = (input: PreviewInput) =>
  input.ticketSelections.reduce((sum, s) => sum + s.qty, 0);

beforeEach(() => {
  onRemovePromoCode.mockReset();
  server.respond = (input) =>
    Promise.resolve(discountFor(input.codes, qtyOf(input)));
});

describe("removing the last code (real QueryClient)", () => {
  it("regression: signed out, WELCOME10 applied then removed → discount 0, no stale −$5.50", async () => {
    const { result, rerender } = renderPreview({ codes: ["WELCOME10"] });
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(550));

    // Removed: the key becomes `codes: []` and — signed out — the query is
    // disabled. A disabled pending query still gets placeholder data if it
    // is configured, which is what kept the old discount on screen.
    rerender({ codes: [] });
    expect(result.current.livePromoDiscountCents).toBe(0);
    expect(result.current.memberDiscounts).toEqual([]);
    // …and it stays 0 (nothing refetches it back).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.livePromoDiscountCents).toBe(0);
  });

  it("taking the hold re-keys the preview WITHOUT a $0 flash (placeholder kept while enabled)", async () => {
    let release: (value: PreviewResult) => void = () => {};
    const { result, rerender } = renderPreview({ codes: ["WELCOME10"] });
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(550));

    server.respond = () => new Promise((resolve) => (release = resolve));
    rerender({ codes: ["WELCOME10"], pendingOrderId: "22222222-2222-4222-8222-222222222222" });
    // Still pending on the new key → the previous result bridges the gap.
    expect(result.current.livePromoDiscountCents).toBe(550);
    await act(async () => release(discountFor(["WELCOME10"])));
    expect(result.current.livePromoDiscountCents).toBe(550);
  });
});

describe("placeholder data is never read as a rejection (real QueryClient)", () => {
  it("regression: a just-added code, absent from the PREVIOUS result, is not pruned while its preview is pending", async () => {
    let release: (value: PreviewResult) => void = () => {};
    const { result, rerender } = renderPreview({ codes: ["EARLYBIRD"] });
    await waitFor(() =>
      expect(result.current.livePromoDiscountCents).toBe(0),
    );
    await waitFor(() => expect(onRemovePromoCode).not.toHaveBeenCalled());

    server.respond = () => new Promise((resolve) => (release = resolve));
    rerender({ codes: ["EARLYBIRD", "STUDENT"] });
    // The EARLYBIRD-only result is the placeholder now; STUDENT is absent.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onRemovePromoCode).not.toHaveBeenCalled();

    await act(async () => release(discountFor(["EARLYBIRD", "STUDENT"])));
    expect(onRemovePromoCode).not.toHaveBeenCalled();
  });
});

describe("a failed preview is never silent (real QueryClient)", () => {
  it("regression: a 5xx / unreachable API → 'couldn't check', codes kept, $0", async () => {
    server.respond = () => Promise.reject(new Error("Internal server error"));
    const { result } = renderPreview({ codes: ["WELCOME10"] });
    await waitFor(() => expect(result.current.promoPreviewUnavailable).toBe(true));
    expect(result.current.livePromoDiscountCents).toBe(0);
    expect(result.current.promoCodeRejections).toEqual({});
    expect(onRemovePromoCode).not.toHaveBeenCalled();
  });

  it("a PROMO rejection is not 'unavailable' — it has its own reason", async () => {
    server.respond = () =>
      Promise.reject(
        Object.assign(new Error("promo_min_order_not_met"), {
          data: { meta: { promoCode: "WELCOME10" } },
        }),
      );
    const { result } = renderPreview({ codes: ["WELCOME10"] });
    await waitFor(() =>
      expect(result.current.promoCodeRejections).toEqual({
        WELCOME10: "errors.promoMinOrderNotMet",
      }),
    );
    expect(result.current.promoPreviewUnavailable).toBe(false);
  });
});

describe("signed in, the preview stays ENABLED — a changed cart or code list never shows the old discount (real QueryClient)", () => {
  it("regression: removing the code → $0 at once, not −$5.50 until the refetch lands", async () => {
    const { result, rerender } = renderPreview({ codes: ["WELCOME10"], isSignedIn: true });
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(550));

    // Member-benefit preview keeps running with `codes: []`; it is slow.
    server.respond = () => new Promise(() => {});
    rerender({ codes: [], isSignedIn: true });
    expect(result.current.livePromoDiscountCents).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.livePromoDiscountCents).toBe(0);
  });

  it("regression: lowering the quantity under a % code never shows the bigger, old discount", async () => {
    const { result, rerender } = renderPreview({
      codes: ["WELCOME10"],
      isSignedIn: true,
      qty: 3,
    });
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(1650));

    let release: (value: PreviewResult) => void = () => {};
    server.respond = () => new Promise((resolve) => (release = resolve));
    rerender({ codes: ["WELCOME10"], isSignedIn: true, qty: 1 });
    // Not the 3-ticket discount on a 1-ticket cart.
    expect(result.current.livePromoDiscountCents).not.toBe(1650);
    await act(async () => release(discountFor(["WELCOME10"], 1)));
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(550));
  });
});

describe("pausing mid-fetch keeps the last settled discount (real QueryClient)", () => {
  it("regression: paused while the new AMOUNT's preview is still pending → the last settled result, not a $0 flash", async () => {
    const { result, rerender } = renderPreview({ codes: ["WELCOME10"], amount: 2000 });
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(550));

    server.respond = () => new Promise(() => {});
    rerender({ codes: ["WELCOME10"], amount: 2500 });
    // The buyer keeps typing before $25's preview lands.
    rerender({ codes: ["WELCOME10"], amount: 2500, paused: true });
    expect(result.current.livePromoDiscountCents).toBe(550);
  });

  it("regression: …but a QUANTITY change is not bridged — 3 → 1 under a % code never shows the 3-ticket discount", async () => {
    const { result, rerender } = renderPreview({ codes: ["WELCOME10"], qty: 3 });
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(1650));

    server.respond = () => new Promise(() => {});
    rerender({ codes: ["WELCOME10"], qty: 1 });
    rerender({ codes: ["WELCOME10"], qty: 1, paused: true });
    expect(result.current.livePromoDiscountCents).not.toBe(1650);
  });

  it("…but never brings back a REMOVED code's discount", async () => {
    const { result, rerender } = renderPreview({
      codes: ["WELCOME10"],
      isSignedIn: true,
    });
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(550));

    server.respond = () => new Promise(() => {});
    rerender({ codes: [], isSignedIn: true });
    rerender({ codes: [], isSignedIn: true, paused: true });
    expect(result.current.livePromoDiscountCents).toBe(0);
  });
});

describe("a URL code that couldn't be checked says so (real QueryClient)", () => {
  it("regression: the link's preview fails (5xx) → urlPromoCheckUnavailable, and the code isn't applied", async () => {
    const onApply = vi.fn(() => null);
    server.respond = () => Promise.reject(new Error("Internal server error"));
    const { result } = renderHook(
      () =>
        useCheckoutPromoPreview({
          eventId: EVENT_ID,
          initialUrlPromoCodes: ["SPRING"],
          quantities: { "tt-ga": 1 },
          promoCodes: [],
          isSignedIn: false,
          pendingOrderId: null,
          onApplyPromoCode: onApply,
          onRemovePromoCode,
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.urlPromoCheckUnavailable).toBe(true));
    expect(onApply).not.toHaveBeenCalled();
  });

  it("a URL code REJECTED as a promo (not an outage) is not 'unavailable'", async () => {
    server.respond = () =>
      Promise.reject(
        Object.assign(new Error("promo_not_found"), {
          data: { meta: { promoCode: "SPRING" } },
        }),
      );
    const { result } = renderHook(
      () =>
        useCheckoutPromoPreview({
          eventId: EVENT_ID,
          initialUrlPromoCodes: ["SPRING"],
          quantities: { "tt-ga": 1 },
          promoCodes: [],
          isSignedIn: false,
          pendingOrderId: null,
          onApplyPromoCode: () => null,
          onRemovePromoCode,
        }),
      { wrapper: makeWrapper() },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(result.current.urlPromoCheckUnavailable).toBe(false);
  });
});

describe("the fee figures ride on the SAME result as the discount (real QueryClient)", () => {
  const ORDER_ID = "22222222-2222-4222-8222-222222222222";
  /** VIPFREE frees a ticket: 50¢ of fee comes off before the hold. */
  const freed = (input: PreviewInput): PreviewResult => ({
    ...discountFor(input.codes, qtyOf(input)),
    totalDiscountCents: input.codes.includes("VIPFREE") ? 5000 : 0,
    platformFeeReductionCents: input.codes.includes("VIPFREE") ? 50 : 0,
    // The server states the held fee only for the buyer's pending cart.
    heldCartFees: input.excludeOrderId
      ? {
          buyerPlatformFeeCents: input.codes.includes("VIPFREE") ? 50 : 100,
          platformFeeWaivedCents: 0,
          // The cart at full price: both 50¢ fees, whatever the codes.
          withoutDiscounts: { buyerPlatformFeeCents: 100, platformFeeWaivedCents: 0 },
        }
      : null,
  });
  const STATED_WITH_CODE = { buyerPlatformFeeCents: 50, platformFeeWaivedCents: 0 };
  const NO_DISCOUNT_FEE = { buyerPlatformFeeCents: 100, platformFeeWaivedCents: 0 };
  /** The two figures the page reads, whatever else rides on the object. */
  const feesOf = (fees: { buyerPlatformFeeCents: number; platformFeeWaivedCents: number } | null) =>
    fees && {
      buyerPlatformFeeCents: fees.buyerPlatformFeeCents,
      platformFeeWaivedCents: fees.platformFeeWaivedCents,
    };

  beforeEach(() => {
    server.respond = (input) => Promise.resolve(freed(input));
  });

  it("before the hold: the reduction, and no held-fee statement", async () => {
    const { result } = renderPreview({ codes: ["VIPFREE"], isSignedIn: true });
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(5000));
    expect(result.current.livePromoFeeReductionCents).toBe(50);
    expect(result.current.liveHeldCartFees).toBeNull();
  });

  it("taking the hold: no statement until the server has answered for the held cart, then its figure", async () => {
    const { result, rerender } = renderPreview({ codes: ["VIPFREE"], isSignedIn: true });
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(5000));

    let release: (value: PreviewResult) => void = () => {};
    server.respond = (input) =>
      new Promise((resolve) => (release = () => resolve(freed(input))));
    rerender({ codes: ["VIPFREE"], isSignedIn: true, pendingOrderId: ORDER_ID });
    // The pre-hold result bridges the re-key (no $0 flash on the discount),
    // and it carries no statement: the held order keeps its own fee.
    expect(result.current.livePromoDiscountCents).toBe(5000);
    expect(result.current.liveHeldCartFees).toBeNull();

    await act(async () => release(freed({ codes: [], ticketSelections: [] })));
    await waitFor(() =>
      expect(feesOf(result.current.liveHeldCartFees)).toEqual(STATED_WITH_CODE),
    );
    expect(result.current.livePromoDiscountCents).toBe(5000);
  });

  it("regression: removing the code on the held step shows the NO-DISCOUNT fee at once, beside the $0 discount", async () => {
    // The cart may have been priced by `createCheckout` with the code (a
    // declined card): its order then carries the 50¢ fee. With nothing
    // stated here the page showed that 50¢ beside the full price until the
    // server answered: under the charge by that fee and its processing.
    const { result, rerender } = renderPreview({
      codes: ["VIPFREE"],
      isSignedIn: true,
      pendingOrderId: ORDER_ID,
    });
    await waitFor(() =>
      expect(feesOf(result.current.liveHeldCartFees)).toEqual(STATED_WITH_CODE),
    );

    let release: () => void = () => {};
    server.respond = (input) =>
      new Promise((resolve) => (release = () => resolve(freed(input))));
    rerender({ codes: [], isSignedIn: true, pendingOrderId: ORDER_ID });
    expect(result.current.livePromoDiscountCents).toBe(0);
    expect(result.current.livePromoFeeReductionCents).toBe(0);
    expect(result.current.liveHeldCartFees).toEqual(NO_DISCOUNT_FEE);

    await act(async () => release());
    await waitFor(() =>
      expect(feesOf(result.current.liveHeldCartFees)).toEqual(NO_DISCOUNT_FEE),
    );
  });

  it("…and stays there when the server never answers for the new codes (an outage)", async () => {
    const { result, rerender } = renderPreview({
      codes: ["VIPFREE"],
      isSignedIn: true,
      pendingOrderId: ORDER_ID,
    });
    await waitFor(() =>
      expect(feesOf(result.current.liveHeldCartFees)).toEqual(STATED_WITH_CODE),
    );
    server.respond = () => Promise.reject(new Error("503"));
    rerender({ codes: [], isSignedIn: true, pendingOrderId: ORDER_ID });
    await waitFor(() => expect(result.current.promoPreviewUnavailable).toBe(true));
    expect(result.current.livePromoDiscountCents).toBe(0);
    expect(result.current.liveHeldCartFees).toEqual(NO_DISCOUNT_FEE);
  });

  it("adding a code: the no-discount fee beside the $0 discount until the server answers, then its figure", async () => {
    const { result, rerender } = renderPreview({
      codes: [],
      isSignedIn: true,
      pendingOrderId: ORDER_ID,
    });
    await waitFor(() =>
      expect(feesOf(result.current.liveHeldCartFees)).toEqual(NO_DISCOUNT_FEE),
    );
    let release: () => void = () => {};
    server.respond = (input) =>
      new Promise((resolve) => (release = () => resolve(freed(input))));
    rerender({ codes: ["VIPFREE"], isSignedIn: true, pendingOrderId: ORDER_ID });
    expect(result.current.livePromoDiscountCents).toBe(0);
    expect(result.current.liveHeldCartFees).toEqual(NO_DISCOUNT_FEE);
    await act(async () => release());
    await waitFor(() =>
      expect(feesOf(result.current.liveHeldCartFees)).toEqual(STATED_WITH_CODE),
    );
    expect(result.current.livePromoDiscountCents).toBe(5000);
  });

  it("the no-discount fee is for ONE cart: a changed quantity or another order gets none", async () => {
    const { result, rerender } = renderPreview({
      codes: ["VIPFREE"],
      isSignedIn: true,
      pendingOrderId: ORDER_ID,
    });
    await waitFor(() =>
      expect(feesOf(result.current.liveHeldCartFees)).toEqual(STATED_WITH_CODE),
    );
    server.respond = () => new Promise(() => {});
    // Another quantity: the remembered fee priced one ticket, not two.
    rerender({ codes: [], isSignedIn: true, pendingOrderId: ORDER_ID, qty: 2 });
    expect(result.current.liveHeldCartFees).toBeNull();
    // Another order.
    rerender({
      codes: [],
      isSignedIn: true,
      pendingOrderId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.current.liveHeldCartFees).toBeNull();
    // No order (back on step 1).
    rerender({ codes: [], isSignedIn: true, pendingOrderId: null });
    expect(result.current.liveHeldCartFees).toBeNull();
  });

  it("never the no-discount fee beside a discount that IS on screen (the pre-hold result bridging a re-hold)", async () => {
    // Held once with no code: the server stated this cart's fee, 100.
    const { result, rerender } = renderPreview({
      codes: [],
      isSignedIn: true,
      pendingOrderId: ORDER_ID,
    });
    await waitFor(() =>
      expect(feesOf(result.current.liveHeldCartFees)).toEqual(NO_DISCOUNT_FEE),
    );
    // Back to the tickets step, a code added there.
    rerender({ codes: ["VIPFREE"], isSignedIn: true, pendingOrderId: null });
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(5000));
    expect(result.current.liveHeldCartFees).toBeNull();
    // Held again (the same order), the server slow to answer for it: the
    // pre-hold result bridges, WITH its discount. The remembered 100 is the
    // fee without that discount, so it is not shown: the order keeps its own.
    server.respond = () => new Promise(() => {});
    rerender({ codes: ["VIPFREE"], isSignedIn: true, pendingOrderId: ORDER_ID });
    expect(result.current.livePromoDiscountCents).toBe(5000);
    expect(result.current.liveHeldCartFees).toBeNull();
  });

  it("a cart the server has never stated a fee for: nothing to show beside a changed code list", async () => {
    // The gap that is left: no statement ever arrived for this cart (here
    // the preview is down from the start), so the held order keeps its fee.
    server.respond = () => Promise.reject(new Error("503"));
    const { result, rerender } = renderPreview({
      codes: ["VIPFREE"],
      isSignedIn: true,
      pendingOrderId: ORDER_ID,
    });
    await waitFor(() => expect(result.current.promoPreviewUnavailable).toBe(true));
    rerender({ codes: [], isSignedIn: true, pendingOrderId: ORDER_ID });
    expect(result.current.liveHeldCartFees).toBeNull();
  });

  it("a failed preview states nothing: no reduction, no held fee", async () => {
    server.respond = () => Promise.reject(new Error("503"));
    const { result } = renderPreview({
      codes: ["VIPFREE"],
      isSignedIn: true,
      pendingOrderId: ORDER_ID,
    });
    await waitFor(() => expect(result.current.promoPreviewUnavailable).toBe(true));
    expect(result.current.livePromoFeeReductionCents).toBe(0);
    expect(result.current.liveHeldCartFees).toBeNull();
  });

  it("an API older than the fields: no reduction and no statement, the discount still shown", async () => {
    server.respond = (input) =>
      Promise.resolve(discountFor(input.codes, qtyOf(input)));
    const { result } = renderPreview({
      codes: ["WELCOME10"],
      isSignedIn: true,
      pendingOrderId: ORDER_ID,
    });
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(550));
    expect(result.current.livePromoFeeReductionCents).toBe(0);
    expect(result.current.liveHeldCartFees).toBeNull();
  });
});
