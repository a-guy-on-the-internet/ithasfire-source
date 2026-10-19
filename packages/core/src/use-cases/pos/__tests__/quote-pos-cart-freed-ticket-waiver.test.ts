import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PromoRecord } from "@th/ports/repos/promos";

import { priceCart } from "../../orders/_shared/price-cart";
import { quotePosCart } from "../quote-pos-cart";
import {
  CART,
  EVENT_ID,
  NASHVILLE,
  OPERATOR_ID,
  PORTLAND,
  VIP_ID,
  makeWorld,
  sellCard,
  type Scenario,
  type World,
} from "./door-sale-world";

/**
 * The till's quote and the card sale, for a cart where a promo brings a
 * ticket down to $0 AND a fee waiver applies (owner ruling 2026-10-10: "yes a
 * promo brought down to $0 should have no fee too").
 *
 * The freed ticket has no platform fee, so it has none to waive: the sale
 * builds its waiver ladder from the cart priced WITH the discounts and
 * reserves allowance for the tickets that still carry a fee. The quote must
 * count the same tickets, or the till shows one waiver and the sale takes
 * another.
 *
 * Cart: 2 × $25 GA (175¢ fee each) + 1 × $40 VIP (250¢ fee), 100% off VIP.
 *
 * `priceCart` is wrapped (it still runs) so the number of tickets the quote
 * prices as waived can be read. That count is not in the quote's output, and
 * for the money it is forgiving: `computeOrderAmounts` waives the first N
 * tickets that carry a fee, so a count taken from the undiscounted cart (3)
 * prices the same as the right one (2). The money assertions below would
 * therefore pass with either; the count assertion is the one that holds the
 * quote to the sale's ladder.
 */
vi.mock("../../orders/_shared/price-cart", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../orders/_shared/price-cart")>();
  return { ...actual, priceCart: vi.fn(actual.priceCart) };
});

const priceCartSpy = vi.mocked(priceCart);

const VIP_FREE: Partial<PromoRecord> = {
  kind: "PERCENT",
  value: 100,
  scope: "TICKET_TYPE",
  scopeId: VIP_ID,
};

function quote(w: World, scenario: Scenario) {
  return quotePosCart(
    {
      repos: w.repos,
      authz: w.authz,
      clock: w.clock,
      logger: w.logger,
      reportError: w.reportError,
      taxRateLookup: w.taxRateLookup as never,
    },
    {
      actorHumanId: OPERATOR_ID,
      eventId: EVENT_ID,
      items: CART,
      ...(scenario.promo ? { promoCodes: ["save"] } : {}),
    },
  );
}

/** The `waivedTickets` the quote handed `priceCart` for the card channel. */
function quotedCardWaivedTickets(): number {
  const cardCalls = priceCartSpy.mock.calls.filter(
    ([input]) => input.channel === "DOOR_CARD",
  );
  expect(cardCalls).toHaveLength(1);
  return cardCalls[0]![0].waivedTickets ?? 0;
}

type Item = { kind: string; ticketTypeId?: string; meta: Record<string, unknown> };

beforeEach(() => {
  priceCartSpy.mockClear();
});

describe("quotePosCart: a ticket a promo frees, with a fee waiver", () => {
  for (const place of [
    {
      name: "OR (no sales tax)",
      situs: PORTLAND,
      admissionTaxRateBps: 0,
      // (5000 + fee + 30) / (1 − 0.029), rounded up.
      total: { 175: 5361, 0: 5181 } as Record<number, number>,
    },
    {
      name: "TN (buyer-total base)",
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      // Whole cents at every step, so check each by substitution rather
      // than by the closed form (which gives 5701.90 for the second):
      //   fee 175: processing 202 (2.9% of 5901 + 30 = 201.13, rounded up),
      //            tax 9.75% of (5175 + 202) = 524.26 → 524; 5175 + 202 + 524.
      //   fee 0:   processing 196 (2.9% of 5703 + 30 = 195.39, rounded up),
      //            tax 9.75% of (5000 + 196) = 506.61 → 507; 5000 + 196 + 507.
      //            (195 does not cover it: it gives 5702, which needs 195.36.)
      total: { 175: 5901, 0: 5703 } as Record<number, number>,
    },
  ]) {
    for (const row of [
      // One ticket of allowance: one GA fee waived, the other charged.
      { allowance: 1, waivedTickets: 1, feeCents: 175, waivedCents: 175 },
      // Two: both GA fees waived.
      { allowance: 2, waivedTickets: 2, feeCents: 0, waivedCents: 350 },
      // Three, more than the tickets that carry a fee: still two. The VIP
      // ticket is free by the code and takes none of the allowance.
      { allowance: 3, waivedTickets: 2, feeCents: 0, waivedCents: 350 },
    ]) {
      it(`${place.name}, allowance of ${row.allowance}: the quote waives the tickets the sale waives`, async () => {
        const scenario: Scenario = {
          situs: place.situs,
          admissionTaxRateBps: place.admissionTaxRateBps,
          promo: VIP_FREE,
          waiverTickets: row.allowance,
        };

        const quoteWorld = makeWorld(scenario);
        const q = await quote(quoteWorld, scenario);
        const quotedWaivedTickets = quotedCardWaivedTickets();
        // Read-only: the quote reserves nothing.
        expect(quoteWorld.tx.feeWaivers.reserve).not.toHaveBeenCalled();

        const sale = await sellCard(scenario);
        const order = sale.order()!;
        const tickets = (order.items as Item[]).filter(
          (item) => item.kind === "ticket",
        );
        const saleWaivedFees = tickets
          .map((item) => item.meta.platformFeeWaivedCents)
          .filter((cents): cents is number => typeof cents === "number");

        // The sale's ladder is the two GA fees: the freed VIP is not on it.
        expect(sale.tx.feeWaivers.reserve).toHaveBeenCalledTimes(1);
        expect(
          sale.tx.feeWaivers.reserve.mock.calls[0]![0].waivableTicketFeesCents,
        ).toEqual([175, 175]);
        expect(saleWaivedFees).toHaveLength(row.waivedTickets);

        // The COUNT: the quote prices as many tickets waived as the sale
        // reserves and waives.
        expect(quotedWaivedTickets).toBe(row.waivedTickets);
        expect(quotedWaivedTickets).toBe(saleWaivedFees.length);

        // The MONEY: the quote is the charge, to the cent.
        expect(q.feesWaivedCents).toBe(row.waivedCents);
        expect(q.feesWaivedCents).toBe(
          saleWaivedFees.reduce((sum, cents) => sum + cents, 0),
        );
        expect(q.card).not.toBeNull();
        expect(q.card!.platformFeeCents).toBe(row.feeCents);
        expect(q.card!.platformFeeCents).toBe(order.feesPlatformCents);
        expect(q.card!.discountCents).toBe(4000);
        expect(q.card!.ticketTotalCents).toBe(5000);
        expect(q.card!.taxAmountCents).toBe(order.taxAmountCents);
        expect(q.card!.totalCents).toBe(place.total[row.feeCents]);
        expect(q.card!.totalCents).toBe(sale.paymentIntent!.amountCents);

        // No fee and no waiver on the freed ticket, in the sale.
        const vip = tickets.filter((item) => item.ticketTypeId === VIP_ID);
        expect(vip).toHaveLength(1);
        expect(vip[0]!.meta.platformFeePerTicketCents).toBe(0);
        expect(vip[0]!.meta.platformFeeWaivedCents).toBeUndefined();
        expect(vip[0]!.meta.discountedToZero).toBe(true);

        // Cash: no platform fee, so no waiver, with or without the promo.
        expect(q.cash.platformFeeCents).toBe(0);
        expect(quoteWorld.reportError).not.toHaveBeenCalled();
        expect(sale.reportError).not.toHaveBeenCalled();
      });
    }
  }

  it("without the promo the same allowance of 3 waives all three tickets (the count follows the cart)", async () => {
    const scenario: Scenario = {
      situs: PORTLAND,
      admissionTaxRateBps: 0,
      waiverTickets: 3,
    };
    const q = await quote(makeWorld(scenario), scenario);
    expect(quotedCardWaivedTickets()).toBe(3);
    expect(q.feesWaivedCents).toBe(600);
    expect(q.card!.platformFeeCents).toBe(0);
  });
});
