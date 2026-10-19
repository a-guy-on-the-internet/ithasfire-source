import { describe, expect, it } from "vitest";

import {
  estimateCartTotal,
  type FeeRatesForOrderEstimate,
} from "@/lib/pricing/order-estimate";

import {
  embedCheckoutItems,
  embedEstimateItems,
  embedInvalidDonationTier,
  withEmbedChosenLinePrices,
} from "./embed-pwyw";

/**
 * The embed checkout with a pay-what-you-want line. Since the estimator
 * prices a PWYW row at the tier's FLOOR, the embed's old items (PWYW priced
 * at its stored $0, no chosen amount) tripped the stale-price guard and a
 * mixed cart read "Calculating total…" forever; the mobile tray quoted the
 * floor's all-in instead of the buyer's amount.
 */

const PWYW = {
  id: "tt-pwyw",
  name: "Pay What You Want",
  priceCents: 0,
  pricingMode: "ADJUSTABLE" as const,
  minimumCents: 500,
  suggestedCents: 1500,
  // The server row: priced at the $5 floor, fees and tax on top.
  buyerUnitTotalCents: 599,
};
const GA = {
  id: "tt-ga",
  name: "General Admission",
  priceCents: 4500,
  pricingMode: "FIXED" as const,
  minimumCents: null,
  suggestedCents: null,
  buyerUnitTotalCents: 5109,
};

const feeRates: FeeRatesForOrderEstimate = {
  feeMode: "PASS_THROUGH",
  admissionTaxRateBps: 888,
  taxImpositions: [
    {
      code: "SALES",
      label: "Sales tax",
      jurisdiction: "US/NY",
      rateBps: 888,
      base: "TICKET_FACE",
      collector: "PLATFORM",
    },
  ],
  processorPct: 0.029,
  processorFixedCents: 30,
  maxPlatformFeeCents: null,
  platformFeeRates: {
    buyerFeePct: 0.0333,
    maxFeeCents: 50,
    minFeeCents: 0,
    platformFixedCents: 0,
  },
  perTicketEstimates: [
    // As the estimator now emits it: the PWYW row at its FLOOR.
    { ticketTypeId: "tt-pwyw", unitPriceCents: 500, platformFeeCents: 17 },
    { ticketTypeId: "tt-ga", unitPriceCents: 4500, platformFeeCents: 50 },
  ],
};

const cart = [
  { ticketTypeId: "tt-pwyw", qty: 1, donationAmountCents: 2000 },
  { ticketTypeId: "tt-ga", qty: 1 },
];

describe("embed checkout — pay-what-you-want lines", () => {
  it("regression: a mixed cart has a KNOWN total, with the buyer's $20 in the gross", () => {
    const estimate = estimateCartTotal(
      feeRates,
      embedEstimateItems(cart, [PWYW, GA]),
    );
    expect(estimate).not.toBeNull();
    expect(estimate!.grossCents).toBe(2000 + 4500);
    // $20 → min(round(66.6), 50) = 50¢, plus GA's 50¢.
    expect(estimate!.platformFeeCents).toBe(100);
  });

  it("a PWYW line with no amount yet is priced at the tier's default", () => {
    const items = embedEstimateItems([{ ticketTypeId: "tt-pwyw", qty: 1 }], [
      PWYW,
    ]);
    expect(items[0]!.chosenAmountCents).toBe(1500);
  });

  it("regression: line displays show the buyer's amount, not the floor's all-in", () => {
    const [pwyw, ga] = withEmbedChosenLinePrices([PWYW, GA], cart);
    expect(pwyw!.priceCents).toBe(2000);
    expect(pwyw!.buyerUnitTotalCents).toBe(2000);
    // Fixed tiers are untouched.
    expect(ga).toBe(GA);
  });
});

describe("embed PWYW — what the guest checkout is sent, and what it refuses", () => {
  it("regression: a pay-what-you-want line sends the buyer's amount as donationAmountCents; a fixed line sends none", () => {
    expect(
      embedCheckoutItems(
        [
          { ticketTypeId: PWYW.id, qty: 1, donationAmountCents: 2000 },
          { ticketTypeId: GA.id, qty: 2, donationAmountCents: 999 },
          { ticketTypeId: GA.id, qty: 0 },
        ],
        [PWYW, GA],
      ),
    ).toEqual([
      // Sent in one fixed order (by ticket type id), not the cart's: see
      // `embedCheckoutItems` and embed-payment-order.test.ts.
      { ticketTypeId: GA.id, qty: 2 },
      { ticketTypeId: PWYW.id, qty: 1, donationAmountCents: 2000 },
    ]);
  });

  it("a PWYW line with no amount yet sends the default (the suggestion), never nothing", () => {
    expect(
      embedCheckoutItems([{ ticketTypeId: PWYW.id, qty: 1 }], [PWYW]),
    ).toEqual([{ ticketTypeId: PWYW.id, qty: 1, donationAmountCents: 1500 }]);
  });

  it("seat ids ride along", () => {
    expect(
      embedCheckoutItems([{ ticketTypeId: GA.id, qty: 1, seatIds: ["s1"] }], [GA]),
    ).toEqual([{ ticketTypeId: GA.id, qty: 1, seatIds: ["s1"] }]);
  });

  it("an amount over the $10,000 cap, or under the minimum, is one the server refuses", () => {
    expect(
      embedInvalidDonationTier(
        [{ ticketTypeId: PWYW.id, qty: 1, donationAmountCents: 1_500_000 }],
        [PWYW],
      )?.id,
    ).toBe(PWYW.id);
    expect(
      embedInvalidDonationTier(
        [{ ticketTypeId: PWYW.id, qty: 1, donationAmountCents: 400 }],
        [PWYW],
      )?.id,
    ).toBe(PWYW.id);
    expect(
      embedInvalidDonationTier(
        [{ ticketTypeId: PWYW.id, qty: 1, donationAmountCents: 2000 }],
        [PWYW],
      ),
    ).toBeNull();
  });

  it("regression: a PWYW-only cart at $20 is NOT free — fees and tax go on top, and it must pay", () => {
    const estimate = estimateCartTotal(
      feeRates,
      embedEstimateItems(
        [{ ticketTypeId: PWYW.id, qty: 1, donationAmountCents: 2000 }],
        [PWYW],
      ),
    )!;
    expect(estimate.grossCents).toBe(2000);
    expect(estimate.totalCents).toBeGreaterThan(2000);
    // EmbedCheckout's isFreeOrder = isTotalKnown && totalCents === 0.
    const isFreeOrder = estimate !== null && estimate.totalCents === 0;
    expect(isFreeOrder).toBe(false);
  });
});
