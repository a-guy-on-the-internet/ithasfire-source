import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * The live promo preview must discount a seat with a price override at its
 * own price. It used to send `{ticketTypeId, qty}` only, so the server priced
 * every line at the tier: a 50% code on a $50 seat in a $30 tier previewed
 * $15 off while step 1's Subtotal read $50 and the charge took $25.
 */

const { previewInputs } = vi.hoisted(() => ({
  previewInputs: [] as Array<{
    ticketSelections: Array<Record<string, unknown>>;
  }>,
}));

vi.mock("@th/ui", () => ({
  useNotify: () => ({ toast: { warning: vi.fn(), danger: vi.fn() } }),
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/trpc", () => ({
  trpc: {
    promos: {
      preview: {
        useQuery: (input: (typeof previewInputs)[number]) => {
          previewInputs.push(input);
          return { data: undefined, isError: false, error: null };
        },
      },
    },
  },
}));

import {
  promoPreviewSelections,
  useCheckoutPromoPreview,
} from "./useCheckoutPromoPreview";

const TIERS = [
  { id: "tt-res", pricingMode: "FIXED" as const },
  { id: "tt-pwyw", pricingMode: "ADJUSTABLE" as const },
  { id: "tt-ga" },
];

describe("promoPreviewSelections — picked seats", () => {
  it("sends a fixed-price tier's picked seats, never a pay-what-you-want tier's", () => {
    expect(
      promoPreviewSelections(
        { "tt-res": 2, "tt-pwyw": 1, "tt-ga": 1 },
        { "tt-pwyw": 2000 },
        { "tt-res": ["s1", "s2"], "tt-pwyw": ["s3"] },
        TIERS,
      ),
    ).toEqual([
      { ticketTypeId: "tt-res", qty: 2, seatIds: ["s1", "s2"] },
      { ticketTypeId: "tt-pwyw", qty: 1, donationAmountCents: 2000 },
      { ticketTypeId: "tt-ga", qty: 1 },
    ]);
  });

  it("at most qty seats, each once (what the server accepts)", () => {
    expect(
      promoPreviewSelections(
        { "tt-res": 2 },
        undefined,
        { "tt-res": ["s1", "s1", "s2", "s3"] },
        TIERS,
      ),
    ).toEqual([{ ticketTypeId: "tt-res", qty: 2, seatIds: ["s1", "s2"] }]);
  });

  it("a tier the list does not name sends no seats", () => {
    expect(
      promoPreviewSelections({ "tt-x": 1 }, undefined, { "tt-x": ["s1"] }, TIERS),
    ).toEqual([{ ticketTypeId: "tt-x", qty: 1 }]);
  });

  it("no tier list (older call sites): no seats, as before", () => {
    expect(
      promoPreviewSelections({ "tt-res": 1 }, undefined, { "tt-res": ["s1"] }, undefined),
    ).toEqual([{ ticketTypeId: "tt-res", qty: 1 }]);
  });
});

describe("useCheckoutPromoPreview — the live query carries the seats", () => {
  it("regression: the preview input names the picked seats of a fixed tier", () => {
    previewInputs.length = 0;
    renderHook(() =>
      useCheckoutPromoPreview({
        eventId: "11111111-1111-4111-8111-111111111111",
        initialUrlPromoCodes: [],
        quantities: { "tt-res": 1, "tt-pwyw": 1 },
        donationAmounts: { "tt-pwyw": 3000 },
        selectedSeatIds: { "tt-res": ["s1"], "tt-pwyw": ["s9"] },
        ticketTypes: TIERS,
        promoCodes: ["HALF"],
        isSignedIn: false,
        pendingOrderId: null,
        onApplyPromoCode: () => null,
        onRemovePromoCode: () => {},
      }),
    );
    expect(previewInputs.at(-1)!.ticketSelections).toEqual([
      { ticketTypeId: "tt-res", qty: 1, seatIds: ["s1"] },
      { ticketTypeId: "tt-pwyw", qty: 1, donationAmountCents: 3000 },
    ]);
  });
});
