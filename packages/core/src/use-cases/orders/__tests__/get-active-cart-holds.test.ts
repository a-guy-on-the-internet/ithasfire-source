import { describe, expect, it } from "vitest";

import { getActiveCartHolds } from "../get-active-cart-holds";
import type { GetActiveCartHoldsDeps } from "../get-active-cart-holds";
import type { PendingCartItem } from "@th/ports/repos/orders";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const TICKET_TYPE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-30T12:00:00.000Z");

/**
 * A cart as `createCheckout` re-saves it: 2 × $50, a member benefit and a
 * typed code off, the order row's gross AFTER both ($84.50), the PASS_THROUGH
 * platform fee on the pre-discount lines.
 */
const resavedCart = (): PendingCartItem => ({
  id: ORDER_ID,
  eventId: EVENT_ID,
  eventName: "Gallery Walk",
  eventSlug: "gallery-walk",
  eventStartsAt: new Date("2026-10-10T00:00:00.000Z"),
  amountGrossCents: 8450,
  feesPlatformCents: 206,
  currency: "usd",
  holdExpiresAt: new Date("2026-09-30T12:10:00.000Z"),
  createdAt: new Date("2026-09-30T11:55:00.000Z"),
  ticketSummary: [
    {
      ticketTypeId: TICKET_TYPE_ID,
      ticketTypeName: "Pay What You Want",
      qty: 2,
      unitPriceCents: 5000,
      seatIds: [],
      seats: [],
    },
  ],
  // As the checkout writes them: one qty-1 line per ticket, then the
  // discount lines (negative amounts).
  lines: [
    { kind: "ticket", amountCents: 5000, meta: { effectiveFeeMode: "PASS_THROUGH" } },
    { kind: "ticket", amountCents: 5000, meta: { effectiveFeeMode: "PASS_THROUGH" } },
    { kind: "discount", amountCents: -1000, meta: { source: "membership", membershipBenefitId: "b1" } },
    { kind: "discount", amountCents: -550, meta: { promoId: "p1", code: "WELCOME10", normalizedCode: "WELCOME10" } },
  ],
});

const run = async (items: PendingCartItem[]) => {
  const deps = {
    repos: {
      orders: {
        listPendingCarts: async () => ({ items }),
      },
    },
    clock: { now: () => NOW },
  } as unknown as GetActiveCartHoldsDeps;
  return getActiveCartHolds(deps, { actorHumanId: ACTOR_ID });
};

describe("getActiveCartHolds — a resumable cart's pricing", () => {
  it("regression: exposes the PRE-discount gross and the typed codes it was priced with", async () => {
    const { carts } = await run([resavedCart()]);
    expect(carts[0]).toMatchObject({
      amountGrossCents: 8450,
      preDiscountGrossCents: 10_000,
      promoCodes: ["WELCOME10"],
      feeMode: "PASS_THROUGH",
      buyerFeesCents: 206,
    });
    // The raw lines are the adapter's business, not the API's.
    expect(carts[0]).not.toHaveProperty("lines");
  });

  it("passes each held seat through at its own line's price (seat-price-overrides D-007)", async () => {
    const SEAT_A1 = "55555555-5555-4555-8555-555555555501";
    const SEAT_A2 = "55555555-5555-4555-8555-555555555502";
    const cart = resavedCart();
    cart.ticketSummary = [
      {
        ticketTypeId: TICKET_TYPE_ID,
        ticketTypeName: "Reserved",
        qty: 2,
        unitPriceCents: 5000,
        seatIds: [SEAT_A1, SEAT_A2],
        seats: [
          { seatId: SEAT_A1, unitPriceCents: 5000 },
          { seatId: SEAT_A2, unitPriceCents: 3000 },
        ],
      },
    ];
    const { carts } = await run([cart]);
    expect(carts[0]!.ticketSummary[0]!.seats).toEqual([
      { seatId: SEAT_A1, unitPriceCents: 5000 },
      { seatId: SEAT_A2, unitPriceCents: 3000 },
    ]);
  });
});
