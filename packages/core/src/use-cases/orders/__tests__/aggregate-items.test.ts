import { describe, expect, it } from "vitest";
import { isAppError } from "@th/errors";
import { aggregateItems } from "../checkout-helpers";

const TIER_A = "11111111-1111-4111-8111-111111111111";
const TIER_B = "22222222-2222-4222-8222-222222222222";

function refusalOf(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected aggregateItems to throw");
}

describe("aggregateItems — one pay-what-you-want amount per tier", () => {
  it("refuses one tier named twice at different amounts", () => {
    const err = refusalOf(() =>
      aggregateItems([
        { ticketTypeId: TIER_A, qty: 1, donationAmountCents: 2500 },
        { ticketTypeId: TIER_A, qty: 1, donationAmountCents: 1000 },
      ]),
    );
    expect(isAppError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "INVALID_INPUT",
      meta: { ticketTypeId: TIER_A },
    });
  });

  it("refuses an amount on one line and none on another, in either order", () => {
    for (const items of [
      [
        { ticketTypeId: TIER_A, qty: 1, donationAmountCents: 2500 },
        { ticketTypeId: TIER_A, qty: 1 },
      ],
      [
        { ticketTypeId: TIER_A, qty: 1 },
        { ticketTypeId: TIER_A, qty: 1, donationAmountCents: 2500 },
      ],
    ]) {
      expect(refusalOf(() => aggregateItems(items))).toMatchObject({
        code: "INVALID_INPUT",
      });
    }
  });

  it("refuses a differing amount on a third line after two matching ones", () => {
    expect(
      refusalOf(() =>
        aggregateItems([
          { ticketTypeId: TIER_A, qty: 1, donationAmountCents: 2500 },
          { ticketTypeId: TIER_A, qty: 1, donationAmountCents: 2500 },
          { ticketTypeId: TIER_A, qty: 1, donationAmountCents: 1000 },
        ]),
      ),
    ).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("merges one tier named twice at the SAME amount, keeping that amount", () => {
    expect(
      aggregateItems([
        { ticketTypeId: TIER_A, qty: 1, donationAmountCents: 2500 },
        { ticketTypeId: TIER_A, qty: 2, donationAmountCents: 2500 },
      ]),
    ).toEqual([
      { ticketTypeId: TIER_A, qty: 3, seatIds: [], donationAmountCents: 2500 },
    ]);
  });

  it("merges a fixed tier's seat lines (no amount on either) exactly as before", () => {
    expect(
      aggregateItems([
        { ticketTypeId: TIER_A, qty: 1, seatIds: ["seat-1"] },
        { ticketTypeId: TIER_B, qty: 1 },
        { ticketTypeId: TIER_A, qty: 1, seatIds: ["seat-2"] },
      ]),
    ).toEqual([
      {
        ticketTypeId: TIER_A,
        qty: 2,
        seatIds: ["seat-1", "seat-2"],
        donationAmountCents: undefined,
      },
      {
        ticketTypeId: TIER_B,
        qty: 1,
        seatIds: [],
        donationAmountCents: undefined,
      },
    ]);
  });

  it("different tiers may carry different amounts", () => {
    expect(
      aggregateItems([
        { ticketTypeId: TIER_A, qty: 1, donationAmountCents: 2500 },
        { ticketTypeId: TIER_B, qty: 1, donationAmountCents: 1000 },
      ]).map((i) => i.donationAmountCents),
    ).toEqual([2500, 1000]);
  });
});
