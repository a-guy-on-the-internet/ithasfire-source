import { describe, expect, it } from "vitest";

import { computeExpectedPaymentAmount } from "../../../lib/orders/compute-expected-payment-amount";
import {
  resolveTaxImpositions,
  type TaxImposition,
} from "../../../lib/pricing/tax-impositions";
import {
  aggregateItems,
  collectWaivableTicketFees,
  computeOrderAmounts,
  unseatedSeatPrices,
  type OrderComputation,
  type PayoutTermsContext,
  type SeatPrices,
  type TicketTypeSummary,
} from "../checkout-helpers";
import {
  priceCart,
  type PriceCartChannel,
  type PricedCart,
} from "../_shared/price-cart";

/**
 * Owner ruling, 2026-10-10: "If $0 is the cost of the tickets there shouldn't
 * be any fee."
 *
 * A ticket whose unit price is $0 carries no platform fee, and so no
 * processing-fee share and no tax on a fee that is not there, INCLUDING when
 * it sits in a cart with paid tickets. It covers a free ticket type, a seat
 * whose price override is $0, and a pay-what-you-want line the buyer set to
 * $0.
 *
 * The defect these pin: in a paid cart the per-ticket fee was
 * `max(min(round(face × pct), max) + fixed, min)`, which for a $0 face is
 * `max(fixed, min)`. On a 5% + 50¢ policy a $0 ticket beside a $30 ticket was
 * charged 50¢ platform fee, 1¢ more processing and (Tennessee) 5¢ more tax,
 * while the event page and the seat picker quoted it as free.
 *
 * The parity form of the rule, asserted throughout: fees(paid + free) equal
 * fees(paid alone), to the cent and per item.
 */

const NOW = new Date("2026-03-01T12:00:00.000Z");
const GA = "33333333-3333-4333-8333-333333333331";
const CHEAP = "33333333-3333-4333-8333-333333333332";
const FREE = "33333333-3333-4333-8333-333333333333";
const RES = "33333333-3333-4333-8333-333333333334";
const PWYW = "33333333-3333-4333-8333-333333333335";
const SECTION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const S1 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const S2 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const S3 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd3";

type PolicyOverrides = Partial<{
  buyerFeePct: number;
  maxFeeCents: number | null;
  minFeeCents: number;
  platformFixedCents: number;
  maxPlatformFeeCents: number | null;
  /** What the terms and policy ROWS say. Never read for pricing. */
  storedFeeMode: "PASS_THROUGH" | "ABSORB";
}>;

function terms(overrides: PolicyOverrides = {}): PayoutTermsContext {
  const storedFeeMode = overrides.storedFeeMode ?? "PASS_THROUGH";
  return {
    agreement: {
      id: "terms-1",
      kind: "PRIMARY",
      status: "ACTIVE",
      feeMode: storedFeeMode,
      feePolicyId: "policy-1",
      version: 3,
    },
    lines: [
      {
        id: "line-1",
        agreementId: "terms-1",
        payeeId: "payee-1",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    ],
    feePolicy: {
      id: "policy-1",
      version: 7,
      feeMode: storedFeeMode,
      buyerFeePct: overrides.buyerFeePct ?? 0.05,
      maxFeeCents: overrides.maxFeeCents ?? null,
      minFeeCents: overrides.minFeeCents ?? 0,
      maxPlatformFeeCents: overrides.maxPlatformFeeCents ?? null,
      platformFixedCents: overrides.platformFixedCents ?? 0,
      processsorFeePct: 0.029,
      processorFixedCents: 30,
      payoutPct: 0,
      payoutFixedCents: 0,
      monthlyPayoutCents: 0,
    },
  } as unknown as PayoutTermsContext;
}

/** 5% + 50¢ per ticket: $30 → 200¢, $5 → 75¢. A $0 ticket used to pay the 50¢. */
const FIXED: PolicyOverrides = { platformFixedCents: 50 };
/** 5%, floor 50¢: $30 → 150¢, $5 → 50¢ (the floor). A $0 ticket used to pay the floor. */
const MINIMUM: PolicyOverrides = { minFeeCents: 50 };
/** Both: 5% + 30¢, floor 100¢: $30 → 180¢, $5 → 100¢. */
const FIXED_AND_MINIMUM: PolicyOverrides = {
  platformFixedCents: 30,
  minFeeCents: 100,
};
/** The live GLOBAL policy's shape: 3.33% capped at 50¢, no fixed part, no floor. */
const LIVE_SHAPE: PolicyOverrides = { buyerFeePct: 0.0333, maxFeeCents: 50 };

const POLICIES: Array<[string, PolicyOverrides]> = [
  ["5% + 50¢ fixed", FIXED],
  ["5% with a 50¢ minimum", MINIMUM],
  ["5% + 30¢ fixed with a 100¢ minimum", FIXED_AND_MINIMUM],
  ["3.33% capped at 50¢ (the live policy's shape)", LIVE_SHAPE],
];

function ticketTypes(): Map<string, TicketTypeSummary> {
  const base = {
    pricingMode: "FIXED" as const,
    minimumCents: null,
    seatSectionId: null,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    salesOpenAt: null,
    salesCloseAt: null,
  };
  return new Map<string, TicketTypeSummary>([
    [GA, { ...base, id: GA, priceCents: 3000 }],
    [CHEAP, { ...base, id: CHEAP, priceCents: 500 }],
    [FREE, { ...base, id: FREE, priceCents: 0 }],
    [RES, { ...base, id: RES, priceCents: 3000, seatSectionId: SECTION }],
    [
      PWYW,
      {
        ...base,
        id: PWYW,
        priceCents: 0,
        pricingMode: "ADJUSTABLE",
        minimumCents: 0,
      },
    ],
  ]);
}

type Line = {
  ticketTypeId: string;
  qty: number;
  seatIds?: string[];
  donationAmountCents?: number;
};

function compute(
  lines: Line[],
  policy: PolicyOverrides,
  options: { seatPrices?: SeatPrices; waivedTickets?: number } = {},
): OrderComputation {
  const items = aggregateItems(lines);
  return computeOrderAmounts(items, ticketTypes(), terms(policy), {
    now: NOW,
    seatPrices: options.seatPrices ?? unseatedSeatPrices(items),
    ...(options.waivedTickets ? { waivedTickets: options.waivedTickets } : {}),
  });
}

type Meta = Record<string, unknown>;
const metaOf = (item: { meta?: unknown }) => item.meta as Meta;
const isPaid = (item: { unitPriceCents?: number | null }) =>
  (item.unitPriceCents ?? 0) > 0;

/** Every order-level fee figure `computeOrderAmounts` returns. */
function orderFees(c: OrderComputation) {
  return {
    amountGrossCents: c.amountGrossCents,
    feesPlatformCents: c.feesPlatformCents,
    buyerFeesCents: c.buyerFeesCents,
    processorFeeCents: c.processorFeeCents,
    paymentIntentAmountCents: c.paymentIntentAmountCents,
    feesWaivedCents: c.feesWaivedCents,
    waivedTicketCount: c.waivedTicketCount,
    effectiveFeeMode: c.effectiveFeeMode,
  };
}

/** The fee fields written onto each PAID ticket's order item, in cart order. */
function paidItemFees(items: OrderComputation["items"]) {
  return items
    .filter((item) => item.kind === "ticket" && isPaid(item))
    .map((item) => {
      const meta = metaOf(item);
      return {
        unitPriceCents: item.unitPriceCents,
        platformFeePerTicketCents: meta.platformFeePerTicketCents,
        buyerTotalCents: meta.buyerTotalCents,
        buyerUnitTotalCents: meta.buyerUnitTotalCents,
        processorFeeShareCents: meta.processorFeeShareCents,
        platformFeeWaivedCents: meta.platformFeeWaivedCents,
      };
    });
}

/** A $0 ticket's order item carries no fee of any kind. */
function expectFreeItemsCarryNothing(items: OrderComputation["items"]) {
  const freeItems = items.filter(
    (item) => item.kind === "ticket" && !isPaid(item),
  );
  expect(freeItems.length).toBeGreaterThan(0);
  for (const item of freeItems) {
    const meta = metaOf(item);
    expect(item.amountCents).toBe(0);
    expect(meta.platformFeePerTicketCents).toBe(0);
    expect(meta.buyerTotalCents).toBe(0);
    expect(meta.buyerUnitTotalCents).toBe(0);
    // Absent (no processor fee on the order) or 0: never a share.
    expect(meta.processorFeeShareCents ?? 0).toBe(0);
    expect(meta.platformFeeWaivedCents).toBeUndefined();
  }
}

describe("computeOrderAmounts: a $0 ticket carries no fee in a paid cart", () => {
  it("pins the charge on 5% + 50¢: $30 + two free tickets pays the $30 ticket's 200¢, not 300¢", () => {
    const mixed = compute(
      [
        { ticketTypeId: GA, qty: 1 },
        { ticketTypeId: FREE, qty: 2 },
      ],
      FIXED,
    );

    expect(mixed.amountGrossCents).toBe(3000);
    expect(mixed.feesPlatformCents).toBe(200);
    expect(mixed.buyerFeesCents).toBe(200);
    expect(mixed.paymentIntentAmountCents).toBe(3200);
    // ceil(3200 × 2.9% + 30) = 123, the $30 ticket's own figure.
    expect(mixed.processorFeeCents).toBe(123);
    expect(mixed.items.map((item) => metaOf(item).platformFeePerTicketCents)).toEqual(
      [200, 0, 0],
    );
    expect(mixed.items.map((item) => metaOf(item).buyerTotalCents)).toEqual([
      3200, 0, 0,
    ]);
    expectFreeItemsCarryNothing(mixed.items);
  });

  describe.each(POLICIES)("policy %s", (_name, policy) => {
    const PAID_LINES: Line[] = [
      { ticketTypeId: GA, qty: 2 },
      { ticketTypeId: CHEAP, qty: 1 },
    ];
    const FREE_LINE: Line = { ticketTypeId: FREE, qty: 2 };

    it.each([
      ["free line last", [...PAID_LINES, FREE_LINE]],
      ["free line first", [FREE_LINE, ...PAID_LINES]],
      ["free line in the middle", [PAID_LINES[0]!, FREE_LINE, PAID_LINES[1]!]],
    ])("fees(paid + free) === fees(paid alone): %s", (_position, lines) => {
      const alone = compute(PAID_LINES, policy);
      const mixed = compute(lines, policy);

      expect(orderFees(mixed)).toEqual(orderFees(alone));
      expect(paidItemFees(mixed.items)).toEqual(paidItemFees(alone.items));
      expectFreeItemsCarryNothing(mixed.items);
      // The fee ladder a waiver reservation is priced against names paid
      // tickets only.
      expect(collectWaivableTicketFees(mixed)).toEqual(
        collectWaivableTicketFees(alone),
      );
    });

    it("an all-free cart charges nothing (unchanged)", () => {
      const free = compute([{ ticketTypeId: FREE, qty: 3 }], policy);

      expect(orderFees(free)).toEqual({
        amountGrossCents: 0,
        feesPlatformCents: 0,
        buyerFeesCents: 0,
        processorFeeCents: 0,
        paymentIntentAmountCents: 0,
        feesWaivedCents: 0,
        waivedTicketCount: 0,
        effectiveFeeMode: "PASS_THROUGH",
      });
      expectFreeItemsCarryNothing(free.items);
    });
  });

  it("a paid ticket under the minimum still pays the minimum: the rule is for $0 only", () => {
    const cheap = compute([{ ticketTypeId: CHEAP, qty: 1 }], MINIMUM);
    // round(500 × 5%) = 25, floored at 50.
    expect(cheap.feesPlatformCents).toBe(50);

    const withFree = compute(
      [
        { ticketTypeId: CHEAP, qty: 1 },
        { ticketTypeId: FREE, qty: 4 },
      ],
      MINIMUM,
    );
    // The four free tickets are not counted toward any minimum.
    expect(withFree.feesPlatformCents).toBe(50);
    expect(orderFees(withFree)).toEqual(orderFees(cheap));
  });

  it("terms and policy rows that still say ABSORB price the same: no fee on the $0 ticket", () => {
    const lines: Line[] = [
      { ticketTypeId: GA, qty: 1 },
      { ticketTypeId: FREE, qty: 1 },
    ];
    const passThrough = compute(lines, FIXED);
    const absorbRows = compute(lines, { ...FIXED, storedFeeMode: "ABSORB" });

    expect(orderFees(absorbRows)).toEqual(orderFees(passThrough));
    expect(absorbRows.feesPlatformCents).toBe(200);
    expectFreeItemsCarryNothing(absorbRows.items);
  });

  describe("a seat whose price override is $0, beside a paid seat of the same tier", () => {
    it.each([
      ["$0 seat first", [S1, S2], [0, 200]],
      ["$0 seat last", [S2, S1], [200, 0]],
    ])("%s: the $0 seat carries no fee; the paid seat pays what it pays alone", (_name, seatIds, fees) => {
      const seatPrices: SeatPrices = new Map([
        [S1, 0],
        [S2, null],
      ]);
      const mixed = compute(
        [{ ticketTypeId: RES, qty: 2, seatIds }],
        FIXED,
        { seatPrices },
      );
      const alone = compute(
        [{ ticketTypeId: RES, qty: 1, seatIds: [S2] }],
        FIXED,
        { seatPrices },
      );

      expect(
        mixed.items.map((item) => metaOf(item).platformFeePerTicketCents),
      ).toEqual(fees);
      expect(mixed.feesPlatformCents).toBe(200);
      expect(orderFees(mixed)).toEqual(orderFees(alone));
      // The paid seat's item, apart from its position in the request.
      expect(paidItemFees(mixed.items)).toEqual(paidItemFees(alone.items));
      expectFreeItemsCarryNothing(mixed.items);
      // Each line still knows the seat it was priced for.
      expect(mixed.items.map((item) => metaOf(item).seatId)).toEqual(seatIds);
      expect(mixed.ticketLines).toContainEqual({
        ticketTypeId: RES,
        qty: 1,
        unitPriceCents: 0,
        lineGrossCents: 0,
      });
    });

    it("every seat overridden to $0 is a free order (unchanged)", () => {
      const free = compute(
        [{ ticketTypeId: RES, qty: 2, seatIds: [S1, S3] }],
        FIXED,
        {
          seatPrices: new Map([
            [S1, 0],
            [S3, 0],
          ]),
        },
      );

      expect(free.amountGrossCents).toBe(0);
      expect(free.feesPlatformCents).toBe(0);
      expect(free.processorFeeCents).toBe(0);
      expectFreeItemsCarryNothing(free.items);
    });
  });

  it("a pay-what-you-want line the buyer set to $0 carries no fee beside a paid ticket", () => {
    const alone = compute([{ ticketTypeId: GA, qty: 1 }], FIXED);
    const mixed = compute(
      [
        { ticketTypeId: GA, qty: 1 },
        { ticketTypeId: PWYW, qty: 1, donationAmountCents: 0 },
      ],
      FIXED,
    );

    expect(mixed.feesPlatformCents).toBe(200);
    // `nonRefundable` aside (not a fee), the money is the paid ticket's own.
    expect(orderFees(mixed)).toEqual(orderFees(alone));
    expectFreeItemsCarryNothing(mixed.items);
  });

  describe("order-level cap (maxPlatformFeeCents)", () => {
    // Two $30 tickets at 200¢ each = 400¢, capped to 251¢: 125¢ + 126¢ (the
    // last paid ticket takes the rounding cent).
    const CAPPED: PolicyOverrides = { ...FIXED, maxPlatformFeeCents: 251 };

    it.each([
      ["free line last", [{ ticketTypeId: GA, qty: 2 }, { ticketTypeId: FREE, qty: 1 }]],
      ["free line first", [{ ticketTypeId: FREE, qty: 1 }, { ticketTypeId: GA, qty: 2 }]],
    ] as Array<[string, Line[]]>)("the cap is spread over paid tickets only: %s", (_name, lines) => {
      const alone = compute([{ ticketTypeId: GA, qty: 2 }], CAPPED);
      const mixed = compute(lines, CAPPED);

      expect(alone.feesPlatformCents).toBe(251);
      expect(
        alone.items.map((item) => metaOf(item).platformFeePerTicketCents),
      ).toEqual([125, 126]);

      expect(orderFees(mixed)).toEqual(orderFees(alone));
      expect(paidItemFees(mixed.items)).toEqual(paidItemFees(alone.items));
      // The rounding cent never lands on the free ticket, even when it is
      // the last item.
      expectFreeItemsCarryNothing(mixed.items);
    });

    it("free tickets do not push a cart over the cap", () => {
      // One $30 ticket = 200¢, under a 220¢ cap. Free tickets used to add
      // 50¢ each and trip it.
      const policy: PolicyOverrides = { ...FIXED, maxPlatformFeeCents: 220 };
      const mixed = compute(
        [
          { ticketTypeId: GA, qty: 1 },
          { ticketTypeId: FREE, qty: 3 },
        ],
        policy,
      );

      expect(mixed.feesPlatformCents).toBe(200);
      expect(metaOf(mixed.items[0]!).platformFeeCapped).toBeUndefined();
      expect(metaOf(mixed.items[0]!).platformFeePerTicketCents).toBe(200);
    });
  });

  describe("fee waiver", () => {
    const LINES: Line[] = [
      { ticketTypeId: GA, qty: 1 },
      { ticketTypeId: FREE, qty: 2 },
    ];

    it("a free ticket is never a waiver slot: the allowance is spent on paid tickets only", () => {
      // Three tickets in the cart, three tickets of allowance offered: only
      // the one paid ticket has a fee to waive.
      const waived = compute(LINES, FIXED, { waivedTickets: 3 });

      expect(waived.waivedTicketCount).toBe(1);
      expect(waived.feesWaivedCents).toBe(200);
      expect(waived.feesPlatformCents).toBe(0);
      expect(waived.buyerFeesCents).toBe(0);
      expectFreeItemsCarryNothing(waived.items);
    });

    it("the waiver ladder lists the paid ticket's fee only", () => {
      expect(collectWaivableTicketFees(compute(LINES, FIXED))).toEqual([200]);
    });

    it("waived fees(paid + free) === waived fees(paid alone)", () => {
      const alone = compute([{ ticketTypeId: GA, qty: 1 }], FIXED, {
        waivedTickets: 1,
      });
      const mixed = compute(LINES, FIXED, { waivedTickets: 1 });

      expect(orderFees(mixed)).toEqual(orderFees(alone));
      expect(paidItemFees(mixed.items)).toEqual(paidItemFees(alone.items));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The whole pipeline (`priceCart`): what is charged and what is stored on each
// order item, online and at the door.
// ─────────────────────────────────────────────────────────────────────────────

function impositions(
  situs: { countryCode: string; region: string; postalCode: string },
  rateBps: number,
): TaxImposition[] {
  return resolveTaxImpositions({ situs, salesTaxRateBps: rateBps }, []);
}

const NO_TAX: TaxImposition[] = [];
/** Illinois taxes the ticket face only. */
const IL = impositions(
  { countryCode: "US", region: "IL", postalCode: "62701" },
  625,
);
/** Tennessee taxes the buyer total: face + platform fee + processing fee. */
const TN = impositions(
  { countryCode: "US", region: "TN", postalCode: "37203" },
  975,
);

function price(
  channel: PriceCartChannel,
  lines: Line[],
  policy: PolicyOverrides,
  taxImpositions: TaxImposition[],
  seatPrices?: SeatPrices,
): PricedCart {
  const items = aggregateItems(lines);
  return priceCart({
    channel,
    items,
    ticketTypes: ticketTypes(),
    seatPrices: seatPrices ?? unseatedSeatPrices(items),
    payoutTerms: terms(policy),
    now: NOW,
    taxImpositions,
  });
}

/** Everything the buyer is charged and the order row stores. */
function charge(p: PricedCart) {
  return {
    faceCents: p.faceCents,
    amountGrossCents: p.amountGrossCents,
    feesPlatformCents: p.feesPlatformCents,
    buyerFeesCents: p.buyerFeesCents,
    taxAmountCents: p.taxAmountCents,
    processorFeeCents: p.processorFeeCents,
    processorFeeDisplayCents: p.processorFeeDisplayCents,
    chargeTotalCents: p.chargeTotalCents,
    taxLines: p.taxLines,
    orderTaxLines: p.orderTaxLines,
  };
}

const CARD_CHANNELS: PriceCartChannel[] = ["ONLINE", "DOOR_CARD"];

describe("priceCart: a $0 ticket adds nothing to the charge, online or by card at the door", () => {
  // One $30 ticket on 5% + 50¢, recorded per tax base. A free ticket in the
  // cart used to add 51¢ (no tax, Illinois) or 56¢ (Tennessee) to these.
  const PINNED: Array<
    [string, TaxImposition[], { platform: number; processor: number; tax: number; total: number }]
  > = [
    ["no tax", NO_TAX, { platform: 200, processor: 127, tax: 0, total: 3327 }],
    ["IL 6.25% on the face", IL, { platform: 200, processor: 133, tax: 188, total: 3521 }],
    ["TN 9.75% on the buyer total", TN, { platform: 200, processor: 137, tax: 325, total: 3662 }],
  ];

  describe.each(CARD_CHANNELS)("%s", (channel) => {
    it.each(PINNED)("$30 + a free ticket charges the $30 ticket's total: %s", (_name, tax, pinned) => {
      const mixed = price(
        channel,
        [
          { ticketTypeId: GA, qty: 1 },
          { ticketTypeId: FREE, qty: 1 },
        ],
        FIXED,
        tax,
      );

      expect({
        platform: mixed.feesPlatformCents,
        processor: mixed.processorFeeCents,
        tax: mixed.taxAmountCents,
        total: mixed.chargeTotalCents,
      }).toEqual(pinned);
      expectFreeItemsCarryNothing(mixed.items);
    });

    describe.each(POLICIES)("policy %s", (_policyName, policy) => {
      it.each([
        ["no tax", NO_TAX],
        ["IL face-only", IL],
        ["TN buyer-total", TN],
      ] as Array<[string, TaxImposition[]]>)("charge(paid + free) === charge(paid alone): %s", (_name, tax) => {
        // Three equal paid tickets: their processing-fee shares floor, so a
        // rounding remainder exists and must stay on a paid ticket.
        const paid: Line[] = [
          { ticketTypeId: GA, qty: 3 },
          { ticketTypeId: CHEAP, qty: 1 },
        ];
        const alone = price(channel, paid, policy, tax);

        for (const lines of [
          [...paid, { ticketTypeId: FREE, qty: 2 }],
          [{ ticketTypeId: FREE, qty: 2 }, ...paid],
        ]) {
          const mixed = price(channel, lines, policy, tax);

          expect(charge(mixed)).toEqual(charge(alone));
          expect(paidItemFees(mixed.items)).toEqual(paidItemFees(alone.items));
          expectFreeItemsCarryNothing(mixed.items);
          // The finalize AMOUNT_MISMATCH sum still lands on the charge.
          expect(
            computeExpectedPaymentAmount({
              amountGrossCents: mixed.amountGrossCents,
              feesPlatformCents: mixed.feesPlatformCents,
              taxAmountCents: mixed.taxAmountCents,
              items: mixed.items as never,
            }),
          ).toBe(mixed.chargeTotalCents);
        }
      });
    });

    it("a $0 override seat beside a paid seat of the same tier: charged as the paid seat alone", () => {
      const seatPrices: SeatPrices = new Map([
        [S1, null],
        [S2, 0],
      ]);
      const alone = price(
        channel,
        [{ ticketTypeId: RES, qty: 1, seatIds: [S1] }],
        FIXED,
        TN,
        seatPrices,
      );
      const mixed = price(
        channel,
        [{ ticketTypeId: RES, qty: 2, seatIds: [S1, S2] }],
        FIXED,
        TN,
        seatPrices,
      );

      expect(mixed.chargeTotalCents).toBe(3662);
      expect(charge(mixed)).toEqual(charge(alone));
      expect(paidItemFees(mixed.items)).toEqual(paidItemFees(alone.items));
      expectFreeItemsCarryNothing(mixed.items);
    });
  });

  it("DOOR_CASH: still the ticket price plus tax, with or without a free ticket", () => {
    const alone = price("DOOR_CASH", [{ ticketTypeId: GA, qty: 1 }], FIXED, TN);
    const mixed = price(
      "DOOR_CASH",
      [
        { ticketTypeId: GA, qty: 1 },
        { ticketTypeId: FREE, qty: 1 },
      ],
      FIXED,
      TN,
    );

    expect(mixed.feesPlatformCents).toBe(0);
    expect(mixed.processorFeeCents).toBe(0);
    expect(charge(mixed)).toEqual(charge(alone));
    expectFreeItemsCarryNothing(mixed.items);
  });

  it("the door card charge and the online charge agree on a mixed cart", () => {
    const lines: Line[] = [
      { ticketTypeId: GA, qty: 2 },
      { ticketTypeId: FREE, qty: 2 },
      { ticketTypeId: CHEAP, qty: 1 },
    ];
    for (const [, policy] of POLICIES) {
      const online = price("ONLINE", lines, policy, TN);
      const door = price("DOOR_CARD", lines, policy, TN);

      expect(charge(door)).toEqual(charge(online));
      expect(door.items).toEqual(online.items);
    }
  });
});
