import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * A paused preview shows its last SETTLED discount only for the same cart.
 * The picked seats are part of the cart: a 50% code on a $50 override seat
 * must not stay on screen after the buyer swaps it for a $30 seat.
 * Real React Query client; only the server is faked.
 */

type PreviewInput = {
  codes: string[];
  ticketSelections: Array<{ ticketTypeId: string; qty: number; seatIds?: string[] }>;
};

const { server } = vi.hoisted(() => ({
  server: {
    respond: (_input: PreviewInput): Promise<unknown> =>
      Promise.resolve({ totalDiscountCents: 0, applications: [] }),
  },
}));

vi.mock("@/trpc", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    trpc: {
      promos: {
        preview: {
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

// 50% of the seat's price: s1 is a $50 override seat, s2 a plain $30 seat.
const halfOf = (input: PreviewInput) => {
  const seat = input.ticketSelections[0]?.seatIds?.[0];
  const cents = seat === "s1" ? 2500 : 1500;
  return {
    totalDiscountCents: cents,
    applications: [{ normalizedCode: "HALF", discountCents: cents }],
  };
};

describe("pausing after a seat swap (real QueryClient)", () => {
  it("regression: the other seat's settled discount is not shown for this seat", async () => {
    server.respond = (input) => Promise.resolve(halfOf(input));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ seat, paused }: { seat: string; paused: boolean }) =>
        useCheckoutPromoPreview({
          eventId: "11111111-1111-4111-8111-111111111111",
          initialUrlPromoCodes: [],
          quantities: { "tt-res": 1 },
          selectedSeatIds: { "tt-res": [seat] },
          ticketTypes: [{ id: "tt-res", pricingMode: "FIXED" }],
          paused,
          promoCodes: ["HALF"],
          isSignedIn: false,
          pendingOrderId: null,
          onApplyPromoCode: () => null,
          onRemovePromoCode: () => {},
        }),
      { wrapper, initialProps: { seat: "s1", paused: false } },
    );
    await waitFor(() => expect(result.current.livePromoDiscountCents).toBe(2500));

    server.respond = () => new Promise(() => {});
    rerender({ seat: "s2", paused: false });
    rerender({ seat: "s2", paused: true });
    expect(result.current.livePromoDiscountCents).not.toBe(2500);
  });
});
