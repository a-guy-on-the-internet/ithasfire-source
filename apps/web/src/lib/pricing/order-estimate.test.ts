import { describe, expect, it } from "vitest";

import {
  estimateCartTotal,
  estimateHeldOrderCharge,
  estimateHeldTaxFallback,
  withBuyerUnitTotals,
  type FeeRatesForOrderEstimate,
} from "./order-estimate";

const TT_GA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TT_VIP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TT_FREE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** Seeded-policy shape: flat 30¢ platform fee, Stripe 2.9% + 30¢, 8.88% tax. */
const SALES_888 = {
  code: "SALES",
  label: "Sales tax",
  jurisdiction: "US/GA",
  rateBps: 888,
  base: "TICKET_FACE",
  collector: "PLATFORM",
} as const;

const passThroughFeeRates: FeeRatesForOrderEstimate = {
  feeMode: "PASS_THROUGH",
  admissionTaxRateBps: 888,
  taxImpositions: [SALES_888],
  processorPct: 0.029,
  processorFixedCents: 30,
  maxPlatformFeeCents: null,
  perTicketEstimates: [
    { ticketTypeId: TT_GA, unitPriceCents: 4500, platformFeeCents: 30 },
    { ticketTypeId: TT_VIP, unitPriceCents: 10_000, platformFeeCents: 30 },
    { ticketTypeId: TT_FREE, unitPriceCents: 0, platformFeeCents: 0 },
  ],
};

describe("estimateCartTotal", () => {
  it("regression: 2 × $45.00 totals $101.85 (server parity), NOT $102.18 (unit × qty)", () => {
    const estimate = estimateCartTotal(passThroughFeeRates, [
      { ticketTypeId: TT_GA, qty: 2, priceCents: 4500 },
    ]);
    // gross 9000 + platform 60 + tax round(9000×888/10⁴)=799
    // + gross-up(9859 @ 2.9%+30¢)=326 → 10185
    expect(estimate).toEqual({
      grossCents: 9000,
      platformFeeCents: 60,
      taxCents: 799,
      processorFeeCents: 326,
      totalCents: 10_185,
    });
    // The old naive path: per-unit inclusive 5109 × 2 = 10218.
    expect(estimate?.totalCents).not.toBe(10_218);
  });

  it("returns a zero estimate for an empty cart even before fee rates load", () => {
    expect(estimateCartTotal(undefined, [])).toEqual({
      grossCents: 0,
      platformFeeCents: 0,
      taxCents: 0,
      processorFeeCents: 0,
      totalCents: 0,
    });
    expect(
      estimateCartTotal(passThroughFeeRates, [
        { ticketTypeId: TT_GA, qty: 0, priceCents: 4500 },
      ])?.totalCents,
    ).toBe(0);
  });

  it("is unknown (null) while fee rates haven't loaded and priced items are selected", () => {
    expect(
      estimateCartTotal(undefined, [
        { ticketTypeId: TT_GA, qty: 1, priceCents: 4500 },
      ]),
    ).toBeNull();
  });

  it("is unknown when a priced item has no per-ticket estimate row", () => {
    expect(
      estimateCartTotal(passThroughFeeRates, [
        { ticketTypeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", qty: 1, priceCents: 2500 },
      ]),
    ).toBeNull();
  });

  it("treats free tickets without a row as known zeros", () => {
    const estimate = estimateCartTotal(
      { ...passThroughFeeRates, perTicketEstimates: [] },
      [{ ticketTypeId: TT_FREE, qty: 3, priceCents: 0 }],
    );
    expect(estimate?.totalCents).toBe(0);
  });

  it("free-only cart is known (zero) BEFORE the fee rates load", () => {
    // Regression: this must not flash "Calculating total…" — free orders
    // never need rates, and the embed's free-order CTA depends on it.
    const estimate = estimateCartTotal(undefined, [
      { ticketTypeId: TT_FREE, qty: 2, priceCents: 0 },
    ]);
    expect(estimate?.totalCents).toBe(0);
  });

  it("degrades to unknown when the cached estimate row's face price is stale", () => {
    // Mid-session reprice: fresh ticket record says $50.00, cached row $45.00.
    // A wrong number is the one unacceptable failure mode — must be null.
    expect(
      estimateCartTotal(passThroughFeeRates, [
        { ticketTypeId: TT_GA, qty: 2, priceCents: 5000 },
      ]),
    ).toBeNull();
  });

  it("is unknown for PASS_THROUGH when numeric processor rates are missing", () => {
    const estimate = estimateCartTotal(
      { ...passThroughFeeRates, processorPct: null, processorFixedCents: null },
      [{ ticketTypeId: TT_GA, qty: 2, priceCents: 4500 }],
    );
    expect(estimate).toBeNull();
  });

  it("charges only face + aggregate tax in ABSORB mode", () => {
    const estimate = estimateCartTotal(
      {
        ...passThroughFeeRates,
        feeMode: "ABSORB",
        processorPct: null,
        processorFixedCents: null,
        perTicketEstimates: [
          { ticketTypeId: TT_GA, unitPriceCents: 4500, platformFeeCents: 0 },
        ],
      },
      [{ ticketTypeId: TT_GA, qty: 2, priceCents: 4500 }],
    );
    expect(estimate).toEqual({
      grossCents: 9000,
      platformFeeCents: 0,
      taxCents: 799,
      processorFeeCents: 0,
      totalCents: 9799,
    });
  });

  it("handles mixed carts including free tickets in one pass", () => {
    const estimate = estimateCartTotal(passThroughFeeRates, [
      { ticketTypeId: TT_GA, qty: 2, priceCents: 4500 },
      { ticketTypeId: TT_VIP, qty: 1, priceCents: 10_000 },
      { ticketTypeId: TT_FREE, qty: 2, priceCents: 0 },
    ]);
    // gross 19000 + platform 90 + tax round(19000×888/10⁴)=1687
    // → base 20777, gross-up: fee 651 → total 21428
    expect(estimate?.grossCents).toBe(19_000);
    expect(estimate?.platformFeeCents).toBe(90);
    expect(estimate?.taxCents).toBe(1687);
    expect(estimate?.totalCents).toBe(
      19_000 + 90 + 1687 + (estimate?.processorFeeCents ?? 0),
    );
  });

  it("is unknown for any pre-taxImpositions payload (never guessed)", () => {
    const { taxImpositions: _omit, ...legacy } = passThroughFeeRates;
    expect(
      estimateCartTotal(legacy, [
        { ticketTypeId: TT_GA, qty: 1, priceCents: 4500 },
      ]),
    ).toBeNull();
    // …even with NO sales rate: a local imposition could still apply.
    expect(
      estimateCartTotal({ ...legacy, admissionTaxRateBps: null }, [
        { ticketTypeId: TT_GA, qty: 1, priceCents: 4500 },
      ]),
    ).toBeNull();
  });

  it("adds a local PLATFORM line to the tax and grosses the fee up over both", () => {
    const sales = estimateCartTotal(passThroughFeeRates, [
      { ticketTypeId: TT_GA, qty: 2, priceCents: 4500 },
    ])!;
    const withCity = estimateCartTotal(
      {
        ...passThroughFeeRates,
        taxImpositions: [
          SALES_888,
          {
            code: "CITY_AMUSEMENT",
            label: "City amusement tax",
            jurisdiction: "US/GA/City",
            rateBps: 500,
            base: "TICKET_FACE",
            collector: "PLATFORM",
          },
        ],
      },
      [{ ticketTypeId: TT_GA, qty: 2, priceCents: 4500 }],
    )!;
    // 799 sales (unchanged) + round(9000 × 5%) = 450 city.
    expect(sales.taxCents).toBe(799);
    expect(withCity.taxCents).toBe(799 + 450);
    expect(withCity.processorFeeCents).toBeGreaterThan(sales.processorFeeCents);
  });

  it("an ORGANISER line is not charged to the buyer", () => {
    const withOrganiser = estimateCartTotal(
      {
        ...passThroughFeeRates,
        taxImpositions: [
          SALES_888,
          {
            code: "VENUE_SEAT",
            label: "Venue seat tax",
            jurisdiction: "US/GA/City",
            rateBps: 1000,
            base: "BUYER_TOTAL",
            collector: "ORGANISER",
          },
        ],
      },
      [{ ticketTypeId: TT_GA, qty: 2, priceCents: 4500 }],
    );
    expect(withOrganiser?.totalCents).toBe(10_185);
  });

  it("applies the order-level platform fee cap", () => {
    const estimate = estimateCartTotal(
      { ...passThroughFeeRates, maxPlatformFeeCents: 50 },
      [{ ticketTypeId: TT_GA, qty: 5, priceCents: 4500 }],
    );
    expect(estimate?.platformFeeCents).toBe(50);
  });
});

describe("withBuyerUnitTotals", () => {
  it("merges per-unit buyer totals and nulls out unknown ones", () => {
    const merged = withBuyerUnitTotals(
      [
        { id: TT_GA, name: "GA", priceCents: 4500 },
        { id: TT_VIP, name: "VIP", priceCents: 10_000 },
      ],
      [{ ticketTypeId: TT_GA, buyerUnitTotalCents: 5109 }],
    );
    expect(merged[0]?.buyerUnitTotalCents).toBe(5109);
    expect(merged[1]?.buyerUnitTotalCents).toBeNull();
  });

  it("nulls every unit total while the estimates are undefined", () => {
    const merged = withBuyerUnitTotals(
      [{ id: TT_GA, name: "GA", priceCents: 4500 }],
      undefined,
    );
    expect(merged[0]?.buyerUnitTotalCents).toBeNull();
  });
});

describe("estimateCartTotal — pay-what-you-want (ADJUSTABLE) lines", () => {
  const TT_PWYW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const TT_FIXED_15 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  /** 3.33% capped at 50¢ per ticket, Stripe 2.9% + 30¢, 8.88% tax. */
  const pwywRates: FeeRatesForOrderEstimate = {
    ...passThroughFeeRates,
    platformFeeRates: {
      buyerFeePct: 0.0333,
      maxFeeCents: 50,
      minFeeCents: 0,
      platformFixedCents: 0,
    },
    perTicketEstimates: [
      // The PWYW row is priced at its $0 list price — useless for the fee.
      { ticketTypeId: TT_PWYW, unitPriceCents: 0, platformFeeCents: 0 },
      // A fixed $15 tier: round(1500 × 3.33%) = 50 → the 50¢ cap.
      { ticketTypeId: TT_FIXED_15, unitPriceCents: 1500, platformFeeCents: 50 },
    ],
  };

  it("regression: a chosen $15 is NOT free — it prices exactly like a fixed $15 ticket", () => {
    const pwyw = estimateCartTotal(pwywRates, [
      { ticketTypeId: TT_PWYW, qty: 2, priceCents: 0, chosenAmountCents: 1500 },
    ]);
    const fixed = estimateCartTotal(pwywRates, [
      { ticketTypeId: TT_FIXED_15, qty: 2, priceCents: 1500 },
    ]);

    expect(pwyw).not.toBeNull();
    expect(pwyw!.grossCents).toBe(3000);
    expect(pwyw!.platformFeeCents).toBe(100);
    expect(pwyw!.taxCents).toBe(Math.round((3000 * 888) / 10_000));
    expect(pwyw!.processorFeeCents).toBeGreaterThan(0);
    expect(pwyw).toEqual(fixed);
  });

  it("the fee is on the CHOSEN amount, below the cap too ($7.50 → 25¢)", () => {
    const estimate = estimateCartTotal(pwywRates, [
      { ticketTypeId: TT_PWYW, qty: 1, priceCents: 0, chosenAmountCents: 750 },
    ]);
    expect(estimate?.grossCents).toBe(750);
    expect(estimate?.platformFeeCents).toBe(25);
  });

  it("ABSORB: face + tax only, no rates needed", () => {
    const estimate = estimateCartTotal(
      { ...pwywRates, feeMode: "ABSORB", platformFeeRates: null },
      [{ ticketTypeId: TT_PWYW, qty: 1, priceCents: 0, chosenAmountCents: 1500 }],
    );
    expect(estimate).toEqual({
      grossCents: 1500,
      platformFeeCents: 0,
      taxCents: Math.round((1500 * 888) / 10_000),
      processorFeeCents: 0,
      totalCents: 1500 + Math.round((1500 * 888) / 10_000),
    });
  });

  it("PASS_THROUGH without the rates is unknown, never a fee-less guess", () => {
    expect(
      estimateCartTotal({ ...pwywRates, platformFeeRates: undefined }, [
        { ticketTypeId: TT_PWYW, qty: 1, priceCents: 0, chosenAmountCents: 1500 },
      ]),
    ).toBeNull();
  });

  it("a chosen $15 still waits for the fee rates instead of reading Free", () => {
    expect(
      estimateCartTotal(undefined, [
        { ticketTypeId: TT_PWYW, qty: 1, priceCents: 0, chosenAmountCents: 1500 },
      ]),
    ).toBeNull();
  });

  it("a chosen $0 (minimum 0) is a genuinely free line", () => {
    expect(
      estimateCartTotal(undefined, [
        { ticketTypeId: TT_PWYW, qty: 1, priceCents: 0, chosenAmountCents: 0 },
      ])?.totalCents,
    ).toBe(0);
  });
});

describe("estimateCartTotal / estimateHeldOrderCharge — a promo discount", () => {
  const absorbRates: FeeRatesForOrderEstimate = {
    ...passThroughFeeRates,
    feeMode: "ABSORB",
    processorPct: null,
    processorFixedCents: null,
  };

  it("ABSORB + discount: face − discount + tax, no fees", () => {
    const estimate = estimateCartTotal(
      absorbRates,
      [{ ticketTypeId: TT_GA, qty: 2, priceCents: 4500 }],
      { discountCents: 900 },
    );
    const tax = Math.round((8100 * 888) / 10_000);
    expect(estimate).toEqual({
      grossCents: 9000,
      platformFeeCents: 0,
      taxCents: tax,
      processorFeeCents: 0,
      totalCents: 8100 + tax,
    });
  });

  it("100% off (discount ≥ gross) → a free order, nothing charged", () => {
    expect(
      estimateCartTotal(
        passThroughFeeRates,
        [{ ticketTypeId: TT_GA, qty: 1, priceCents: 4500 }],
        { discountCents: 4500 },
      )?.totalCents,
    ).toBe(0);
  });

  it("held step, ABSORB: face − discount + tax; the processing row stays the hold's (null here)", () => {
    const held = estimateHeldOrderCharge(
      absorbRates,
      { amountGrossCents: 9000, buyerFeesCents: 0 },
      900,
    );
    const tax = Math.round((8100 * 888) / 10_000);
    expect(held).toEqual({
      taxCents: tax,
      processorFeeCents: null,
      totalCents: 8100 + tax,
    });
  });

  it("regression: the HOLD's recorded mode wins over the event's current setting (one source with the rows)", () => {
    // A cart held under ABSORB, resumed after the event flipped to
    // PASS_THROUGH: no processing gross-up, exactly as the rows show.
    const held = estimateHeldOrderCharge(
      passThroughFeeRates,
      { amountGrossCents: 9000, buyerFeesCents: 0, feeMode: "ABSORB" },
      900,
    );
    const tax = Math.round((8100 * 888) / 10_000);
    expect(held).toEqual({
      taxCents: tax,
      processorFeeCents: null,
      totalCents: 8100 + tax,
    });
  });

  it("held step: the pre-hold and held figures agree for the same cart and discount", () => {
    const step1 = estimateCartTotal(
      passThroughFeeRates,
      [{ ticketTypeId: TT_GA, qty: 2, priceCents: 4500 }],
      { discountCents: 900 },
    );
    const held = estimateHeldOrderCharge(
      passThroughFeeRates,
      { amountGrossCents: 9000, buyerFeesCents: step1!.platformFeeCents },
      900,
    );
    expect(held!.totalCents).toBe(step1!.totalCents);
    expect(held!.taxCents).toBe(step1!.taxCents);
    expect(held!.processorFeeCents).toBe(step1!.processorFeeCents);
  });

  it("held step without fee rates (or pre-impositions payload) → null, the old display stands", () => {
    expect(
      estimateHeldOrderCharge(undefined, { amountGrossCents: 9000, buyerFeesCents: 60 }, 0),
    ).toBeNull();
    expect(
      estimateHeldOrderCharge(
        { ...passThroughFeeRates, taxImpositions: undefined },
        { amountGrossCents: 9000, buyerFeesCents: 60 },
        0,
      ),
    ).toBeNull();
  });
});

describe("estimateCartTotal — the all-free shortcut respects a loaded row", () => {
  it("regression: a cached $0 ticket beside a row priced at $20 (a flip the ticket list predates) is unknown, not Free", () => {
    const rates: FeeRatesForOrderEstimate = {
      ...passThroughFeeRates,
      perTicketEstimates: [
        { ticketTypeId: TT_FREE, unitPriceCents: 2000, platformFeeCents: 50 },
      ],
    };
    expect(
      estimateCartTotal(rates, [{ ticketTypeId: TT_FREE, qty: 1, priceCents: 0 }]),
    ).toBeNull();
  });

  it("a genuinely free ticket stays a known $0, rates loaded or not", () => {
    const rates: FeeRatesForOrderEstimate = {
      ...passThroughFeeRates,
      perTicketEstimates: [
        { ticketTypeId: TT_FREE, unitPriceCents: 0, platformFeeCents: 0 },
      ],
    };
    const cart = [{ ticketTypeId: TT_FREE, qty: 1, priceCents: 0 }];
    expect(estimateCartTotal(rates, cart)?.totalCents).toBe(0);
    expect(estimateCartTotal(undefined, cart)?.totalCents).toBe(0);
  });

  it("a $0 pay-what-you-want amount is the buyer's, never judged against the floor row", () => {
    const rates: FeeRatesForOrderEstimate = {
      ...passThroughFeeRates,
      perTicketEstimates: [
        { ticketTypeId: TT_FREE, unitPriceCents: 500, platformFeeCents: 17 },
      ],
    };
    expect(
      estimateCartTotal(rates, [
        { ticketTypeId: TT_FREE, qty: 1, priceCents: 0, chosenAmountCents: 0 },
      ])?.totalCents,
    ).toBe(0);
  });
});

describe("estimateHeldTaxFallback — the held tax when the fee rates cannot solve it", () => {
  const MN_SALES = {
    code: "SALES",
    label: "Sales tax",
    jurisdiction: "US/MN",
    rateBps: 903,
    base: "BUYER_TOTAL",
    collector: "PLATFORM",
  } as const;
  const MPLS = {
    code: "MPLS_ENTERTAINMENT",
    label: "Minneapolis entertainment tax",
    jurisdiction: "US/MN/Minneapolis",
    rateBps: 300,
    base: "TICKET_FACE",
    collector: "PLATFORM",
  } as const;
  const heldOrder = {
    amountGrossCents: 2500,
    buyerFeesCents: 100,
    processorFeeCents: 110,
    taxAmountCents: 316,
  };

  it("no discount: the hold's own stamped tax, untouched", () => {
    expect(
      estimateHeldTaxFallback(heldOrder, {
        discountCents: 0,
        feeMode: "PASS_THROUGH",
        taxImpositions: [MN_SALES, MPLS],
      }),
    ).toBe(316);
  });

  it("no discount and no stamped tax yet: the quote's amount", () => {
    expect(
      estimateHeldTaxFallback(
        { ...heldOrder, taxAmountCents: null },
        { discountCents: 0, feeMode: "ABSORB", estimateTaxCents: 222 },
      ),
    ).toBe(222);
  });

  it("Minneapolis + discount, PASS_THROUGH: sales on discounted face + fees, the city's 3% on the discounted face", () => {
    const sales = Math.round(((2000 + 100 + 110) * 903) / 10_000);
    const city = Math.round((2000 * 300) / 10_000);
    expect(
      estimateHeldTaxFallback(heldOrder, {
        discountCents: 500,
        feeMode: "PASS_THROUGH",
        taxImpositions: [MN_SALES, MPLS],
      }),
    ).toBe(sales + city);
  });

  it("Minneapolis + discount, ABSORB: nothing is passed through, so both lines tax the discounted face", () => {
    expect(
      estimateHeldTaxFallback(heldOrder, {
        discountCents: 500,
        feeMode: "ABSORB",
        taxImpositions: [MN_SALES, MPLS],
      }),
    ).toBe(Math.round((2000 * 903) / 10_000) + Math.round((2000 * 300) / 10_000));
  });

  it("single face line + discount: the same figure the old flat recompute gave (unchanged jurisdictions)", () => {
    expect(
      estimateHeldTaxFallback(
        { amountGrossCents: 5500, buyerFeesCents: 100, processorFeeCents: 190 },
        { discountCents: 550, feeMode: "PASS_THROUGH", taxImpositions: [SALES_888] },
      ),
    ).toBe(Math.round((4950 * 888) / 10_000));
  });

  it("impositions unknown: the undiscounted figure, never a guessed rate", () => {
    expect(
      estimateHeldTaxFallback(heldOrder, {
        discountCents: 500,
        feeMode: "PASS_THROUGH",
        taxImpositions: null,
      }),
    ).toBe(316);
  });
});
