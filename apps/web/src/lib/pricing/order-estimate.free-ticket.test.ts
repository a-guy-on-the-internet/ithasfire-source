import { describe, expect, it } from "vitest";

import {
  computeBuyerTicketPricing,
  type BuyerFeeContext,
} from "@th/core/use-cases/events/_shared/estimate-buyer-ticket-pricing";
import {
  resolveTaxImpositions,
  type TaxImposition,
} from "@th/core/lib/pricing/tax-impositions";
import {
  aggregateItems,
  unseatedSeatPrices,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "@th/core/use-cases/orders/checkout-helpers";
import { priceCart } from "@th/core/use-cases/orders/_shared/price-cart";

import {
  estimateCartTotal,
  type FeeRatesForOrderEstimate,
  type OrderEstimateCartItem,
} from "./order-estimate";

/**
 * Owner ruling, 2026-10-10: "If $0 is the cost of the tickets there shouldn't
 * be any fee."
 *
 * The checkout's pre-hold estimate always quoted a $0 ticket as free. The
 * charge did not: on a policy with a fixed part or a floor it added that fee
 * for each free ticket in a paid cart, so the screen sat below the charge.
 * This file pins the two together on a mixed cart, from the REAL pieces: the
 * server's row builder (`computeBuyerTicketPricing`, what
 * `events.getCheckoutFeeRates` returns) feeding `estimateCartTotal`, against
 * the charge pipeline (`priceCart`, channel ONLINE). No promo, credit or fee
 * waiver.
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const PAID_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const FREE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const PWYW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const PAID_PRICE = 3000;

type Policy = {
  buyerFeePct: number;
  maxFeeCents: number | null;
  minFeeCents: number;
  platformFixedCents: number;
};

const POLICIES: Array<[string, Policy]> = [
  [
    "5% + 50¢ fixed",
    { buyerFeePct: 0.05, maxFeeCents: null, minFeeCents: 0, platformFixedCents: 50 },
  ],
  [
    "5% with a 50¢ minimum",
    { buyerFeePct: 0.05, maxFeeCents: null, minFeeCents: 50, platformFixedCents: 0 },
  ],
  [
    "3.33% capped at 50¢ (the live policy's shape)",
    { buyerFeePct: 0.0333, maxFeeCents: 50, minFeeCents: 0, platformFixedCents: 0 },
  ],
];

const impositions = (region: string, postalCode: string, rateBps: number) =>
  resolveTaxImpositions(
    { situs: { countryCode: "US", region, postalCode }, salesTaxRateBps: rateBps },
    [],
  );

const TAXES: Array<[string, number, TaxImposition[]]> = [
  ["no tax", 0, []],
  ["IL 6.25% on the ticket face", 625, impositions("IL", "62701", 625)],
  ["TN 9.75% on the buyer total", 975, impositions("TN", "37203", 975)],
];

const LINES = [
  {
    id: "line-1",
    agreementId: "terms-1",
    payeeId: "payee-1",
    percent: 100,
    floorCents: 0,
    capPercent: null,
    priority: 0,
    rounding: "FLOOR" as const,
  },
];

function feePolicy(policy: Policy) {
  return {
    id: "policy-1",
    version: 1,
    feeMode: "PASS_THROUGH",
    ...policy,
    maxPlatformFeeCents: null,
    processsorFeePct: 0.029,
    processorFixedCents: 30,
    payoutPct: 0,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
  };
}

const tier = (
  id: string,
  overrides: Partial<TicketTypeSummary>,
): TicketTypeSummary =>
  ({
    id,
    priceCents: 0,
    pricingMode: "FIXED",
    minimumCents: null,
    seatSectionId: null,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    salesOpenAt: null,
    salesCloseAt: null,
    ...overrides,
  }) as TicketTypeSummary;

const TIERS = new Map<string, TicketTypeSummary>([
  [PAID_ID, tier(PAID_ID, { priceCents: PAID_PRICE })],
  [FREE_ID, tier(FREE_ID, { priceCents: 0 })],
  [PWYW_ID, tier(PWYW_ID, { pricingMode: "ADJUSTABLE", minimumCents: 0 })],
]);

/** What `events.getCheckoutFeeRates` hands the client, from the real row builder. */
function feeRates(
  policy: Policy,
  rateBps: number,
  taxImpositions: TaxImposition[],
): FeeRatesForOrderEstimate {
  const ctx = {
    feePolicy: feePolicy(policy),
    agreement: { id: "terms-1", feeMode: null },
    lines: LINES,
  } as unknown as BuyerFeeContext;
  const estimate = computeBuyerTicketPricing(
    ctx,
    { admissionTaxRateBps: rateBps },
    [...TIERS.values()].map(
      (t) => ({ ...t, name: t.id, status: "ACTIVE" }) as never,
    ),
    { taxImpositions },
    NOW,
  );
  return {
    feeMode: estimate.feeMode,
    admissionTaxRateBps: estimate.admissionTaxRateBps,
    taxImpositions: estimate.taxImpositions,
    processorPct: estimate.processorPct,
    processorFixedCents: estimate.processorFixedCents,
    maxPlatformFeeCents: estimate.maxPlatformFeeCents,
    platformFeeRates: estimate.platformFeeRates,
    perTicketEstimates: estimate.perTicketEstimates,
  };
}

/** The charge the server makes for the same cart. */
function charge(
  policy: Policy,
  taxImpositions: TaxImposition[],
  lines: Array<{ ticketTypeId: string; qty: number; donationAmountCents?: number }>,
) {
  const items = aggregateItems(lines);
  const priced = priceCart({
    channel: "ONLINE",
    items,
    ticketTypes: TIERS,
    seatPrices: unseatedSeatPrices(items),
    payoutTerms: {
      agreement: {
        id: "terms-1",
        kind: "PRIMARY",
        status: "ACTIVE",
        feeMode: null,
        feePolicyId: "policy-1",
        version: 1,
      },
      lines: LINES,
      feePolicy: feePolicy(policy),
    } as unknown as PayoutTermsContext,
    now: NOW,
    taxImpositions,
  });
  return {
    grossCents: priced.faceCents,
    platformFeeCents: priced.buyerFeesCents,
    taxCents: priced.taxAmountCents,
    processorFeeCents: priced.processorFeeCents,
    totalCents: priced.chargeTotalCents,
  };
}

describe.each(POLICIES)("a $0 ticket in a paid cart — policy %s", (_name, policy) => {
  describe.each(TAXES)("%s", (_taxName, rateBps, taxImpositions) => {
    const PAID_CART: OrderEstimateCartItem[] = [
      { ticketTypeId: PAID_ID, qty: 2, priceCents: PAID_PRICE },
    ];

    it("the server's row for the free tier is all zero", () => {
      const row = feeRates(policy, rateBps, taxImpositions).perTicketEstimates.find(
        (estimate) => estimate.ticketTypeId === FREE_ID,
      );
      expect(row).toMatchObject({ unitPriceCents: 0, platformFeeCents: 0 });
    });

    it("free ticket type: estimate === charge === the paid tickets' charge alone", () => {
      const rates = feeRates(policy, rateBps, taxImpositions);
      const estimate = estimateCartTotal(rates, [
        ...PAID_CART,
        { ticketTypeId: FREE_ID, qty: 3, priceCents: 0 },
      ]);
      const mixedCharge = charge(policy, taxImpositions, [
        { ticketTypeId: PAID_ID, qty: 2 },
        { ticketTypeId: FREE_ID, qty: 3 },
      ]);
      const paidCharge = charge(policy, taxImpositions, [
        { ticketTypeId: PAID_ID, qty: 2 },
      ]);

      expect(estimate).toEqual(mixedCharge);
      expect(mixedCharge).toEqual(paidCharge);
      expect(estimateCartTotal(rates, PAID_CART)).toEqual(paidCharge);
    });

    it("pay-what-you-want set to $0: estimate === charge === the paid tickets' charge alone", () => {
      const rates = feeRates(policy, rateBps, taxImpositions);
      const estimate = estimateCartTotal(rates, [
        ...PAID_CART,
        { ticketTypeId: PWYW_ID, qty: 1, priceCents: 0, chosenAmountCents: 0 },
      ]);
      const mixedCharge = charge(policy, taxImpositions, [
        { ticketTypeId: PAID_ID, qty: 2 },
        { ticketTypeId: PWYW_ID, qty: 1, donationAmountCents: 0 },
      ]);
      const paidCharge = charge(policy, taxImpositions, [
        { ticketTypeId: PAID_ID, qty: 2 },
      ]);

      expect(estimate).toEqual(mixedCharge);
      expect(mixedCharge).toEqual(paidCharge);
    });
  });
});
