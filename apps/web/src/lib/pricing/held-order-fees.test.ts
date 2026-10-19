import { describe, expect, it } from "vitest";

import { withStatedHeldFees } from "./held-order-fees";

/**
 * `withStatedHeldFees`: the held order every checkout surface reads, with the
 * platform fee the server states for it (`promos.preview`'s `heldCartFees`).
 * The page does no arithmetic on a held order's fee; this is the one place
 * the stated figure reaches it. The chain it sits in (hold, preview, charge)
 * is driven against the real use cases in
 * `promo-to-zero-create-checkout.test.ts`.
 */
type Order = {
  id: string;
  amountGrossCents: number;
  feesPlatformCents: number;
  buyerFeesCents: number;
  feeWaivedCents?: number;
};

/** A fresh hold: $30 + $50, priced with no promo (50¢ + 50¢). */
const FRESH: Order = {
  id: "order-1",
  amountGrossCents: 8000,
  feesPlatformCents: 100,
  buyerFeesCents: 100,
};

describe("withStatedHeldFees", () => {
  it("puts the stated fee on the order: the row, the buyer's fee and the waived note", () => {
    const stated = { buyerPlatformFeeCents: 50, platformFeeWaivedCents: 0 };
    expect(withStatedHeldFees(FRESH, stated, "PASS_THROUGH")).toEqual({
      id: "order-1",
      amountGrossCents: 8000,
      feesPlatformCents: 50,
      buyerFeesCents: 50,
      feeWaivedCents: 0,
    });
  });

  it("states, never subtracts: a cart already priced with the promo keeps its 50¢ (not 50 − 50)", () => {
    // After a declined card the order carries `createCheckout`'s own fee.
    const repriced: Order = { ...FRESH, feesPlatformCents: 50, buyerFeesCents: 50, feeWaivedCents: 0 };
    const stated = { buyerPlatformFeeCents: 50, platformFeeWaivedCents: 0 };
    const result = withStatedHeldFees(repriced, stated, "PASS_THROUGH");
    expect(result!.buyerFeesCents).toBe(50);
    expect(result!.feesPlatformCents).toBe(50);
  });

  it("a stated fee can be HIGHER than the order's (a freeing code was removed from a re-priced cart)", () => {
    const repriced: Order = { ...FRESH, feesPlatformCents: 50, buyerFeesCents: 50, feeWaivedCents: 0 };
    const stated = { buyerPlatformFeeCents: 100, platformFeeWaivedCents: 0 };
    expect(withStatedHeldFees(repriced, stated, "PASS_THROUGH")).toMatchObject({
      feesPlatformCents: 100,
      buyerFeesCents: 100,
    });
  });

  it("carries the waiver as the charge will apply it (it moved off the freed ticket)", () => {
    // Hold: VIP's 50¢ waived, two 33¢ fees charged. With VIP free the waiver
    // lands on a 33¢ ticket instead.
    const hold: Order = {
      id: "order-2",
      amountGrossCents: 7000,
      feesPlatformCents: 66,
      buyerFeesCents: 66,
      feeWaivedCents: 50,
    };
    expect(
      withStatedHeldFees(
        hold,
        { buyerPlatformFeeCents: 33, platformFeeWaivedCents: 33 },
        "PASS_THROUGH",
      ),
    ).toEqual({ ...hold, feesPlatformCents: 33, buyerFeesCents: 33, feeWaivedCents: 33 });
  });

  it("does not mutate the order it is given", () => {
    const order = { ...FRESH };
    withStatedHeldFees(
      order,
      { buyerPlatformFeeCents: 50, platformFeeWaivedCents: 0 },
      "PASS_THROUGH",
    );
    expect(order).toEqual(FRESH);
  });

  it("returns the SAME object when the statement changes nothing (no needless re-render)", () => {
    const order: Order = { ...FRESH, feeWaivedCents: 0 };
    expect(
      withStatedHeldFees(
        order,
        { buyerPlatformFeeCents: 100, platformFeeWaivedCents: 0 },
        "PASS_THROUGH",
      ),
    ).toBe(order);
  });

  it.each([
    ["null (the preview has not answered, is off, or failed)", null],
    ["undefined (an API older than the field)", undefined],
  ])("no statement, %s: the order is returned as is, the same object", (_name, stated) => {
    expect(withStatedHeldFees(FRESH, stated, "PASS_THROUGH")).toBe(FRESH);
  });

  it.each([["ABSORB" as const], [null], [undefined]])(
    "fee mode %s: the buyer pays no platform fee, nothing is restated",
    (feeMode) => {
      expect(
        withStatedHeldFees(
          FRESH,
          { buyerPlatformFeeCents: 50, platformFeeWaivedCents: 0 },
          feeMode,
        ),
      ).toBe(FRESH);
    },
  );

  it("no order (step 1, or the hold was lost): null, whatever the statement", () => {
    expect(
      withStatedHeldFees(
        null,
        { buyerPlatformFeeCents: 50, platformFeeWaivedCents: 0 },
        "PASS_THROUGH",
      ),
    ).toBeNull();
  });
});
