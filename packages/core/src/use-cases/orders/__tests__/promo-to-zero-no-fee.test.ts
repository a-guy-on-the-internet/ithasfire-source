import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { PromoRecord } from "@th/ports/repos/promos";

import { computeExpectedPaymentAmount } from "../../../lib/orders/compute-expected-payment-amount";
import {
  resolveTaxImpositions,
  type TaxImposition,
} from "../../../lib/pricing/tax-impositions";
import type { MemberBenefitGrant } from "../../memberships/resolve-member-benefits";
import {
  aggregateItems,
  collectWaivableTicketFees,
  computeOrderAmounts,
  isTicketDiscountedToZero,
  unseatedSeatPrices,
  type OrderComputation,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "../checkout-helpers";
import {
  evaluatePromoApplications,
  type PromoEvaluationResult,
} from "../checkout-promos";
import {
  priceCart,
  priceComputedCart,
  type PriceCartChannel,
  type PricedCart,
} from "../_shared/price-cart";

/**
 * Owner ruling, 2026-10-10: "yes a promo brought down to $0 should have no fee
 * too."
 *
 * A ticket a promo code or a membership benefit discounts to $0 pays no
 * platform fee, and so adds nothing to the processing fee or to a tax base
 * that includes fees, in a cart with paid tickets too. A ticket discounted to
 * any amount above $0 keeps the fee on its list price, exactly as before.
 *
 * "Brought down to $0" is defined in `lib/orders/discounted-to-zero.ts` (each
 * discount is spread over the tickets it applies to, in proportion to price).
 * These tests drive the REAL promo evaluation into the REAL pricing pipeline,
 * so the definition and the charge cannot drift apart.
 *
 * The defect they pin: the platform fee was computed on the pre-discount
 * price and nothing ever asked what a ticket cost after its discount. On a 5%
 * + 50¢ policy, a $30 ticket beside a $50 ticket made free by a code on its
 * ticket type was charged the $50 ticket's 300¢ fee on top of its own 200¢
 * (plus processing, and in Tennessee tax, on that 300¢).
 *
 * The parity form of the rule, asserted throughout: the cart with the
 * discounted-to-$0 ticket costs what the cart WITHOUT that ticket costs.
 */

const NOW = new Date("2026-03-01T12:00:00.000Z");
const EVENT_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const GA = "33333333-3333-4333-8333-333333333331";
const VIP = "33333333-3333-4333-8333-333333333332";

type PolicyOverrides = Partial<{
  buyerFeePct: number;
  maxFeeCents: number | null;
  minFeeCents: number;
  platformFixedCents: number;
  maxPlatformFeeCents: number | null;
}>;

function terms(overrides: PolicyOverrides = {}): PayoutTermsContext {
  return {
    agreement: {
      id: "terms-1",
      kind: "PRIMARY",
      status: "ACTIVE",
      feeMode: "PASS_THROUGH",
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
      feeMode: "PASS_THROUGH",
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

/** 5% + 50¢ per ticket: $30 → 200¢, $50 → 300¢. */
const FIXED: PolicyOverrides = { platformFixedCents: 50 };
/** 5%, floor 50¢: $30 → 150¢, $50 → 250¢. */
const MINIMUM: PolicyOverrides = { minFeeCents: 50 };
/** The live GLOBAL policy's shape: 3.33% capped at 50¢. $30 → 50¢, $50 → 50¢. */
const LIVE_SHAPE: PolicyOverrides = { buyerFeePct: 0.0333, maxFeeCents: 50 };

const POLICIES: Array<[string, PolicyOverrides]> = [
  ["5% + 50¢ fixed", FIXED],
  ["5% with a 50¢ minimum", MINIMUM],
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
    [VIP, { ...base, id: VIP, priceCents: 5000 }],
  ]);
}

function impositions(
  situs: { countryCode: string; region: string; postalCode: string },
  rateBps: number,
): TaxImposition[] {
  return resolveTaxImpositions({ situs, salesTaxRateBps: rateBps }, []);
}
const NO_TAX: TaxImposition[] = [];
/** Illinois taxes the ticket face only. */
const IL = impositions({ countryCode: "US", region: "IL", postalCode: "62701" }, 625);
/** Tennessee taxes the buyer total: face + platform fee + processing fee. */
const TN = impositions({ countryCode: "US", region: "TN", postalCode: "37203" }, 975);

const TAXES: Array<[string, TaxImposition[]]> = [
  ["no tax", NO_TAX],
  ["Illinois (ticket-face base)", IL],
  ["Tennessee (buyer-total base)", TN],
];

type Line = { ticketTypeId: string; qty: number };

const event = { id: EVENT_ID, orgId: ORG_ID, humanId: null } as EventRecord;

function promo(overrides: Partial<PromoRecord> & { code: string }): PromoRecord {
  return {
    id: `promo-${overrides.code}`,
    codeNormalized: overrides.code,
    kind: "PERCENT",
    value: 100,
    currency: "usd",
    scope: "EVENT",
    scopeId: EVENT_ID,
    minOrderCents: 0,
    maxRedemptions: undefined,
    maxRedemptionsPerHuman: undefined,
    maxDiscountCents: undefined,
    stackable: true,
    isPublic: false,
    status: "ACTIVE",
    startsAt: undefined,
    endsAt: undefined,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as PromoRecord;
}

/** 100% off the VIP ticket type. */
const VIP_FREE = promo({ code: "VIPFREE", scope: "TICKET_TYPE", scopeId: VIP });
/** $50 off the VIP ticket type: exactly one VIP ticket's price. */
const VIP_50_DOLLARS = promo({
  code: "VIP50",
  kind: "AMOUNT",
  value: 5000,
  scope: "TICKET_TYPE",
  scopeId: VIP,
});
/** $75 off the VIP ticket type: more than one VIP ticket costs. */
const VIP_75_DOLLARS = promo({
  code: "VIP75",
  kind: "AMOUNT",
  value: 7500,
  scope: "TICKET_TYPE",
  scopeId: VIP,
});
/** 50% off the VIP ticket type. */
const VIP_HALF = promo({
  code: "VIPHALF",
  value: 50,
  scope: "TICKET_TYPE",
  scopeId: VIP,
});
/** 100% off the whole order. */
const EVERYTHING_FREE = promo({ code: "ALLFREE" });
/** 20% off the whole order. */
const ORDER_20_PERCENT = promo({ code: "TWENTY", value: 20 });
/** $10 off the whole order. */
const ORDER_10_DOLLARS = promo({ code: "TENOFF", kind: "AMOUNT", value: 1000 });
/** 100% off the GA ticket type. */
const GA_FREE = promo({ code: "GAFREE", scope: "TICKET_TYPE", scopeId: GA });

function grant(overrides: Partial<MemberBenefitGrant>): MemberBenefitGrant {
  return {
    benefitId: "benefit-1",
    tierId: "tier-1",
    tierName: "Friends",
    membershipId: "membership-1",
    discountKind: "PERCENT",
    discountValue: 100,
    maxDiscountCents: null,
    label: null,
    ownerScope: { kind: "ORG", orgId: ORG_ID },
    ...overrides,
  } as MemberBenefitGrant;
}

function faceOf(lines: Line[], policy: PolicyOverrides): OrderComputation {
  const items = aggregateItems(lines);
  return computeOrderAmounts(items, ticketTypes(), terms(policy), {
    now: NOW,
    seatPrices: unseatedSeatPrices(items),
  });
}

/** The real evaluation, on the cart's real lines, as every sale path runs it. */
async function evaluate(
  lines: Line[],
  promos: PromoRecord[],
  memberGrants: MemberBenefitGrant[] = [],
): Promise<PromoEvaluationResult> {
  const face = faceOf(lines, FIXED);
  const tx = {
    promos: {
      findActiveByCodes: vi.fn(async () => promos),
      getRedemptionStats: vi.fn(async () => ({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      })),
    },
  } as unknown as TxRepos;
  return evaluatePromoApplications({
    codes: promos.map((p) => ({ original: p.code, normalized: p.codeNormalized })),
    tx,
    event,
    buyerHumanId: null,
    now: NOW,
    orderSubtotalCents: face.amountGrossCents,
    ticketLines: face.ticketLines,
    memberGrants,
  });
}

function price(
  channel: PriceCartChannel,
  lines: Line[],
  policy: PolicyOverrides,
  taxImpositions: TaxImposition[],
  promoEvaluation?: PromoEvaluationResult | null,
  waivedTickets?: number,
): PricedCart {
  const items = aggregateItems(lines);
  return priceCart({
    channel,
    items,
    ticketTypes: ticketTypes(),
    seatPrices: unseatedSeatPrices(items),
    payoutTerms: terms(policy),
    now: NOW,
    taxImpositions,
    ...(promoEvaluation ? { promo: promoEvaluation } : {}),
    ...(waivedTickets ? { waivedTickets } : {}),
  });
}

/** What the buyer is charged in fees and tax, and the total. */
function feesOf(p: PricedCart) {
  return {
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

type Meta = Record<string, unknown>;
const metaOf = (item: { meta?: unknown }) => item.meta as Meta;
const ticketsOf = (p: { items: OrderComputation["items"] }, ticketTypeId?: string) =>
  p.items.filter(
    (item) =>
      item.kind === "ticket" &&
      (ticketTypeId === undefined || item.ticketTypeId === ticketTypeId),
  );

/** The fee fields stored on each ticket of a type, in cart order. */
function itemFees(p: { items: OrderComputation["items"] }, ticketTypeId: string) {
  return ticketsOf(p, ticketTypeId).map((item) => {
    const meta = metaOf(item);
    return {
      unitPriceCents: item.unitPriceCents,
      platformFeePerTicketCents: meta.platformFeePerTicketCents,
      buyerTotalCents: meta.buyerTotalCents,
      buyerUnitTotalCents: meta.buyerUnitTotalCents,
      processorFeeShareCents: meta.processorFeeShareCents,
      platformFeeWaivedCents: meta.platformFeeWaivedCents,
      discountedToZero: meta.discountedToZero,
    };
  });
}

function expectFinalizeSumIsTheCharge(p: PricedCart) {
  expect(
    computeExpectedPaymentAmount({
      amountGrossCents: p.amountGrossCents,
      feesPlatformCents: p.feesPlatformCents,
      taxAmountCents: p.taxAmountCents,
      items: p.items as never,
    }),
  ).toBe(p.chargeTotalCents);
}

/** A ticket a discount brought to $0: its price is still its list price; it carries no fee. */
function expectDiscountedToZero(p: PricedCart, ticketTypeId: string, count: number) {
  const tickets = ticketsOf(p, ticketTypeId);
  expect(tickets).toHaveLength(count);
  for (const item of tickets) {
    const meta = metaOf(item);
    expect(isTicketDiscountedToZero(item)).toBe(true);
    expect(meta.platformFeePerTicketCents).toBe(0);
    // The pre-discount price: the negative discount line cancels it.
    expect(meta.buyerTotalCents).toBe(item.amountCents);
    expect(meta.buyerUnitTotalCents).toBe(item.amountCents);
    expect(meta.processorFeeShareCents ?? 0).toBe(0);
    expect(meta.platformFeeWaivedCents).toBeUndefined();
  }
}

const CARD_CHANNELS: PriceCartChannel[] = ["ONLINE", "DOOR_CARD"];
const ONE_GA: Line[] = [{ ticketTypeId: GA, qty: 1 }];

describe("the evaluation says which tickets each discount comes off", () => {
  it("a ticket-type code names its type; an order-wide code and a membership benefit name none", async () => {
    const lines: Line[] = [
      { ticketTypeId: GA, qty: 1 },
      { ticketTypeId: VIP, qty: 1 },
    ];
    const evaluation = await evaluate(
      lines,
      [VIP_HALF, ORDER_10_DOLLARS],
      [grant({ discountValue: 10 })],
    );
    expect(evaluation.ticketDiscounts).toEqual([
      { discountCents: 2500, ticketTypeId: VIP },
      { discountCents: 1000, ticketTypeId: null },
      // 10% of the $80 list subtotal.
      { discountCents: 800, ticketTypeId: null },
    ]);
    expect(evaluation.totalDiscountCents).toBe(4300);
  });

  it("no codes and no benefits: no discounts", async () => {
    const evaluation = await evaluate(ONE_GA, []);
    expect(evaluation.ticketDiscounts).toEqual([]);
  });
});

describe("a ticket-type code that makes one ticket free in a paid cart", () => {
  // One $30 ticket on 5% + 50¢, per tax base: what the cart must cost once
  // the $50 VIP ticket beside it is free. Before the ruling this cart was
  // charged the VIP ticket's 300¢ platform fee as well: 3636 / 3830 / 4003.
  const PINNED: Array<[string, TaxImposition[], Record<string, number>]> = [
    [
      "no tax",
      NO_TAX,
      { feesPlatformCents: 200, taxAmountCents: 0, processorFeeCents: 127, chargeTotalCents: 3327 },
    ],
    [
      "Illinois",
      IL,
      { feesPlatformCents: 200, taxAmountCents: 188, processorFeeCents: 133, chargeTotalCents: 3521 },
    ],
    [
      "Tennessee",
      TN,
      { feesPlatformCents: 200, taxAmountCents: 325, processorFeeCents: 137, chargeTotalCents: 3662 },
    ],
  ];

  it.each(PINNED)(
    "pins the charge on 5% + 50¢, %s: $30 + a $50 ticket at 100% off pays the $30 ticket's fees only",
    async (_name, tax, expected) => {
      const lines: Line[] = [
        { ticketTypeId: GA, qty: 1 },
        { ticketTypeId: VIP, qty: 1 },
      ];
      const evaluation = await evaluate(lines, [VIP_FREE]);
      expect(evaluation.totalDiscountCents).toBe(5000);

      for (const channel of CARD_CHANNELS) {
        const priced = price(channel, lines, FIXED, tax, evaluation);
        expect(priced.faceCents).toBe(8000);
        expect(priced.discountCents).toBe(5000);
        expect(priced.amountGrossCents).toBe(3000);
        expect(priced.isFree).toBe(false);
        expect({
          feesPlatformCents: priced.feesPlatformCents,
          taxAmountCents: priced.taxAmountCents,
          processorFeeCents: priced.processorFeeCents,
          chargeTotalCents: priced.chargeTotalCents,
        }).toEqual(expected);
      }
    },
  );

  describe.each(POLICIES)("policy %s", (_policyName, policy) => {
    describe.each(TAXES)("%s", (_taxName, tax) => {
      it.each([
        ["100% off the type", VIP_FREE],
        ["a fixed amount equal to the ticket's price", VIP_50_DOLLARS],
        ["a fixed amount larger than the ticket's price", VIP_75_DOLLARS],
      ])("%s: the paid ticket pays exactly what it pays alone", async (_promoName, code) => {
        for (const lines of [
          [
            { ticketTypeId: GA, qty: 1 },
            { ticketTypeId: VIP, qty: 1 },
          ],
          // The free ticket first: it must not matter where it sits.
          [
            { ticketTypeId: VIP, qty: 1 },
            { ticketTypeId: GA, qty: 1 },
          ],
        ] as Line[][]) {
          const evaluation = await evaluate(lines, [code]);
          // A fixed amount is clamped to the type's tickets: never more than $50.
          expect(evaluation.totalDiscountCents).toBe(5000);

          for (const channel of CARD_CHANNELS) {
            const alone = price(channel, ONE_GA, policy, tax);
            const mixed = price(channel, lines, policy, tax, evaluation);

            // Every fee and tax figure, and the total, is the $30 ticket's own.
            expect(feesOf(mixed)).toEqual(feesOf(alone));
            // And so is what is stored on the $30 ticket's order item.
            expect(itemFees(mixed, GA)).toEqual(itemFees(alone, GA));

            expectDiscountedToZero(mixed, VIP, 1);
            expectFinalizeSumIsTheCharge(mixed);
            // Fees stored per ticket add up to the order's fee.
            expect(
              ticketsOf(mixed).reduce(
                (sum, item) => sum + (metaOf(item).platformFeePerTicketCents as number),
                0,
              ),
            ).toBe(mixed.feesPlatformCents);
          }
        }
      });

      it("100% off a type zeroes EVERY ticket of the type: two paid + three free costs the two paid alone", async () => {
        const paid: Line[] = [{ ticketTypeId: GA, qty: 2 }];
        const lines: Line[] = [...paid, { ticketTypeId: VIP, qty: 3 }];
        const evaluation = await evaluate(lines, [VIP_FREE]);
        expect(evaluation.totalDiscountCents).toBe(15000);

        for (const channel of CARD_CHANNELS) {
          const alone = price(channel, paid, policy, tax);
          const mixed = price(channel, lines, policy, tax, evaluation);
          expect(feesOf(mixed)).toEqual(feesOf(alone));
          expect(itemFees(mixed, GA)).toEqual(itemFees(alone, GA));
          expectDiscountedToZero(mixed, VIP, 3);
          expectFinalizeSumIsTheCharge(mixed);
        }
      });
    });
  });

  it("door cash: no fee on any ticket anyway; the code changes only the face", async () => {
    const lines: Line[] = [
      { ticketTypeId: GA, qty: 1 },
      { ticketTypeId: VIP, qty: 1 },
    ];
    const evaluation = await evaluate(lines, [VIP_FREE]);
    for (const [, tax] of TAXES) {
      const alone = price("DOOR_CASH", ONE_GA, FIXED, tax);
      const mixed = price("DOOR_CASH", lines, FIXED, tax, evaluation);
      expect(feesOf(mixed)).toEqual(feesOf(alone));
      expect(mixed.feesPlatformCents).toBe(0);
      expect(mixed.processorFeeCents).toBe(0);
      expectFinalizeSumIsTheCharge(mixed);
    }
  });
});

describe("a ticket discounted to an amount above $0 keeps today's fee", () => {
  /**
   * What each of these carts cost BEFORE the ruling, per tax world (no tax,
   * Illinois, Tennessee, in `TAXES` order):
   * `[amountGrossCents, feesPlatformCents, taxAmountCents, processorFeeCents,
   * chargeTotalCents]`.
   *
   * These are literals, not a second run of today's code: they were produced
   * by pricing the same carts with the pricing code as committed before the
   * change (95d1cee89, extracted with `git archive` and run outside the
   * tree), where the whole priced cart, items and meta included, came out
   * identical to today's for all 90 carts. Online and door card agree on every
   * figure here. Hand check of the first row: (5500 + 500 + 30) / (1 − 0.029)
   * = 6210.09, charged 6211, so processing is 211.
   *
   * A row moving means a partially discounted cart changed price. That is not
   * part of the ruling: only a ticket discounted all the way to $0 loses its
   * fee.
   */
  type Pinned = [number, number, number, number, number];
  const PINNED: Record<string, Record<string, [Pinned, Pinned, Pinned]>> = {
    "50% off the VIP type": {
      "5% + 50¢ fixed": [
        [5500, 500, 0, 211, 6211],
        [5500, 500, 344, 221, 6565],
        [5500, 500, 607, 229, 6836],
      ],
      "5% with a 50¢ minimum": [
        [5500, 400, 0, 208, 6108],
        [5500, 400, 344, 218, 6462],
        [5500, 400, 597, 225, 6722],
      ],
      "3.33% capped at 50¢ (the live policy's shape)": [
        [5500, 100, 0, 199, 5799],
        [5500, 100, 344, 209, 6153],
        [5500, 100, 567, 216, 6383],
      ],
    },
    "20% off the order": {
      "5% + 50¢ fixed": [
        [6400, 500, 0, 237, 7137],
        [6400, 500, 400, 249, 7549],
        [6400, 500, 698, 258, 7856],
      ],
      "5% with a 50¢ minimum": [
        [6400, 400, 0, 234, 7034],
        [6400, 400, 400, 246, 7446],
        [6400, 400, 688, 255, 7743],
      ],
      "3.33% capped at 50¢ (the live policy's shape)": [
        [6400, 100, 0, 226, 6726],
        [6400, 100, 400, 237, 7137],
        [6400, 100, 658, 245, 7403],
      ],
    },
    "$10 off the order": {
      "5% + 50¢ fixed": [
        [7000, 500, 0, 255, 7755],
        [7000, 500, 438, 268, 8206],
        [7000, 500, 758, 278, 8536],
      ],
      "5% with a 50¢ minimum": [
        [7000, 400, 0, 252, 7652],
        [7000, 400, 438, 265, 8103],
        [7000, 400, 748, 275, 8423],
      ],
      "3.33% capped at 50¢ (the live policy's shape)": [
        [7000, 100, 0, 243, 7343],
        [7000, 100, 438, 257, 7795],
        [7000, 100, 718, 265, 8083],
      ],
    },
    "$50 off the VIP type across TWO VIP tickets ($25 off each)": {
      "5% + 50¢ fixed": [
        [8000, 800, 0, 294, 9094],
        [8000, 800, 500, 309, 9609],
        [8000, 800, 889, 321, 10010],
      ],
      "5% with a 50¢ minimum": [
        [8000, 650, 0, 290, 8940],
        [8000, 650, 500, 305, 9455],
        [8000, 650, 874, 316, 9840],
      ],
      "3.33% capped at 50¢ (the live policy's shape)": [
        [8000, 150, 0, 275, 8425],
        [8000, 150, 500, 290, 8940],
        [8000, 150, 824, 299, 9273],
      ],
    },
    "two stacked partial codes": {
      "5% + 50¢ fixed": [
        [4500, 500, 0, 181, 5181],
        [4500, 500, 281, 189, 5470],
        [4500, 500, 507, 196, 5703],
      ],
      "5% with a 50¢ minimum": [
        [4500, 400, 0, 178, 5078],
        [4500, 400, 281, 186, 5367],
        [4500, 400, 497, 193, 5590],
      ],
      "3.33% capped at 50¢ (the live policy's shape)": [
        [4500, 100, 0, 169, 4769],
        [4500, 100, 281, 177, 5058],
        [4500, 100, 466, 183, 5249],
      ],
    },
  };

  const LINES: Line[] = [
    { ticketTypeId: GA, qty: 1 },
    { ticketTypeId: VIP, qty: 1 },
  ];

  describe.each(POLICIES)("policy %s", (policyName, policy) => {
    it.each([
      ["50% off the VIP type", [VIP_HALF], LINES, 2500],
      ["20% off the order", [ORDER_20_PERCENT], LINES, 1600],
      ["$10 off the order", [ORDER_10_DOLLARS], LINES, 1000],
      [
        "$50 off the VIP type across TWO VIP tickets ($25 off each)",
        [VIP_50_DOLLARS],
        [
          { ticketTypeId: GA, qty: 1 },
          { ticketTypeId: VIP, qty: 2 },
        ] as Line[],
        5000,
      ],
      ["two stacked partial codes", [VIP_HALF, ORDER_10_DOLLARS], LINES, 3500],
    ])("%s: every ticket pays the fee on its list price", async (name, codes, lines, discount) => {
      const evaluation = await evaluate(lines, codes);
      expect(evaluation.totalDiscountCents).toBe(discount);
      const noPromo = faceOf(lines, policy);

      for (const [taxIndex, [, tax]] of TAXES.entries()) {
        for (const channel of CARD_CHANNELS) {
          const priced = price(channel, lines, policy, tax, evaluation);

          // The platform fee is the undiscounted cart's, ticket by ticket.
          expect(priced.feesPlatformCents).toBe(noPromo.feesPlatformCents);
          expect(
            ticketsOf(priced).map((item) => metaOf(item).platformFeePerTicketCents),
          ).toEqual(
            noPromo.items.map((item) => metaOf(item).platformFeePerTicketCents),
          );
          expect(ticketsOf(priced).some(isTicketDiscountedToZero)).toBe(false);

          // And every figure is the literal it was before the ruling.
          expect([
            priced.amountGrossCents,
            priced.feesPlatformCents,
            priced.taxAmountCents,
            priced.processorFeeCents,
            priced.chargeTotalCents,
          ]).toEqual(PINNED[name]![policyName]![taxIndex]);
          expect(priced.buyerFeesCents).toBe(priced.feesPlatformCents);
          expectFinalizeSumIsTheCharge(priced);
        }
      }
    });
  });
});

describe("a discount that makes the whole order free: unchanged", () => {
  const LINES: Line[] = [
    { ticketTypeId: GA, qty: 1 },
    { ticketTypeId: VIP, qty: 1 },
  ];

  it.each([
    ["100% off the order", [EVERYTHING_FREE], [] as MemberBenefitGrant[]],
    ["100% off each ticket type, stacked", [VIP_FREE, GA_FREE], []],
    ["a 100% membership benefit", [] as PromoRecord[], [grant({})]],
    ["100% off VIP, then a membership benefit that covers the rest", [VIP_FREE], [grant({})]],
  ])("%s: a free order, no fee anywhere, no per-ticket mark", async (_name, codes, grants) => {
    const evaluation = await evaluate(LINES, codes, grants);
    expect(evaluation.totalDiscountCents).toBe(8000);

    for (const [, policy] of POLICIES) {
      for (const [, tax] of TAXES) {
        for (const channel of [...CARD_CHANNELS, "DOOR_CASH"] as PriceCartChannel[]) {
          const priced = price(channel, LINES, policy, tax, evaluation);
          expect(priced.isFree).toBe(true);
          expect(priced.amountGrossCents).toBe(0);
          expect(priced.feesPlatformCents).toBe(0);
          expect(priced.buyerFeesCents).toBe(0);
          expect(priced.taxAmountCents).toBe(0);
          expect(priced.processorFeeCents).toBe(0);
          expect(priced.chargeTotalCents).toBe(0);
          for (const item of ticketsOf(priced)) {
            expect(metaOf(item).platformFeePerTicketCents).toBe(0);
            expect(metaOf(item).buyerTotalCents).toBe(0);
            expect(metaOf(item).discountedToZero).toBeUndefined();
          }

          // Every figure above is a literal zero. (Checked once against
          // the code committed before the ruling, 95d1cee89: all 108 of
          // these priced carts came out identical, items and meta included.)
          expectFinalizeSumIsTheCharge(priced);
        }
      }
    }
  });
});

describe("membership benefits follow the same rule", () => {
  const LINES: Line[] = [
    { ticketTypeId: GA, qty: 1 },
    { ticketTypeId: VIP, qty: 1 },
  ];

  it("a partial benefit on its own zeroes no ticket: fees are the undiscounted cart's", async () => {
    // A benefit applies to the whole order, so it reaches $0 on a ticket only
    // when it reaches $0 on the order.
    const evaluation = await evaluate(LINES, [], [grant({ discountValue: 50 })]);
    expect(evaluation.totalDiscountCents).toBe(4000);
    const noPromo = faceOf(LINES, FIXED);
    const priced = price("ONLINE", LINES, FIXED, TN, evaluation);
    expect(priced.feesPlatformCents).toBe(noPromo.feesPlatformCents);
    expect(ticketsOf(priced).some(isTicketDiscountedToZero)).toBe(false);
  });

  it("a benefit stacked on a code that frees one ticket: that ticket still pays no fee, the other its list-price fee", async () => {
    // VIP is free by the code. The benefit takes 10% of the $80 list subtotal
    // ($8) off what is left, which is all on the $30 ticket.
    const evaluation = await evaluate(LINES, [VIP_FREE], [grant({ discountValue: 10 })]);
    expect(evaluation.totalDiscountCents).toBe(5800);

    for (const channel of CARD_CHANNELS) {
      const priced = price(channel, LINES, FIXED, TN, evaluation);
      expect(priced.amountGrossCents).toBe(2200);
      // The $30 ticket's fee on its LIST price (5% + 50¢), not on $22.
      expect(priced.feesPlatformCents).toBe(200);
      expect(itemFees(priced, GA)[0]!.platformFeePerTicketCents).toBe(200);
      expect(itemFees(priced, GA)[0]!.discountedToZero).toBeUndefined();
      expectDiscountedToZero(priced, VIP, 1);
      expectFinalizeSumIsTheCharge(priced);
    }
  });
});

describe("the order-level fee cap and the fee waiver see only tickets that carry a fee", () => {
  it("the cap is measured without the discounted-to-$0 ticket", async () => {
    // 5% + 50¢, order cap 251¢. $30 (200¢) + $50 (300¢) is 500¢, capped to
    // 251¢ before the ruling. With the $50 ticket free, the $30 ticket's
    // 200¢ is under the cap: it pays 200¢, as it does alone.
    const policy: PolicyOverrides = { ...FIXED, maxPlatformFeeCents: 251 };
    const lines: Line[] = [
      { ticketTypeId: GA, qty: 1 },
      { ticketTypeId: VIP, qty: 1 },
    ];
    const evaluation = await evaluate(lines, [VIP_FREE]);
    const mixed = price("ONLINE", lines, policy, TN, evaluation);
    const alone = price("ONLINE", ONE_GA, policy, TN);
    expect(mixed.feesPlatformCents).toBe(200);
    expect(feesOf(mixed)).toEqual(feesOf(alone));
    expect(itemFees(mixed, GA)).toEqual(itemFees(alone, GA));
  });

  it("when the cap still bites, its rounding remainder stays on a ticket that pays a fee", async () => {
    // Two $30 tickets: 400¢, capped to 251¢ → 125 + 126. The free VIP ticket
    // is LAST in the cart and must not take the remainder.
    const policy: PolicyOverrides = { ...FIXED, maxPlatformFeeCents: 251 };
    const paid: Line[] = [{ ticketTypeId: GA, qty: 2 }];
    const lines: Line[] = [...paid, { ticketTypeId: VIP, qty: 1 }];
    const evaluation = await evaluate(lines, [VIP_FREE]);
    const mixed = price("ONLINE", lines, policy, TN, evaluation);
    const alone = price("ONLINE", paid, policy, TN);
    expect(mixed.feesPlatformCents).toBe(251);
    expect(
      ticketsOf(mixed).map((item) => metaOf(item).platformFeePerTicketCents),
    ).toEqual([125, 126, 0]);
    expect(feesOf(mixed)).toEqual(feesOf(alone));
    expect(itemFees(mixed, GA)).toEqual(itemFees(alone, GA));
    expectDiscountedToZero(mixed, VIP, 1);
  });

  it("the waiver ladder leaves the discounted-to-$0 ticket out, so no allowance is spent on it", async () => {
    const lines: Line[] = [
      { ticketTypeId: GA, qty: 1 },
      { ticketTypeId: VIP, qty: 1 },
    ];
    const evaluation = await evaluate(lines, [VIP_FREE]);
    const items = aggregateItems(lines);
    const options = { now: NOW, seatPrices: unseatedSeatPrices(items) };

    // Without the discounts the ladder leads with the VIP ticket's 300¢: an
    // allowance of one ticket would have been spent there.
    expect(
      collectWaivableTicketFees(
        computeOrderAmounts(items, ticketTypes(), terms(FIXED), options),
      ),
    ).toEqual([300, 200]);
    // With them, the only fee to waive is the $30 ticket's.
    expect(
      collectWaivableTicketFees(
        computeOrderAmounts(items, ticketTypes(), terms(FIXED), {
          ...options,
          discounts: evaluation.ticketDiscounts,
        }),
      ),
    ).toEqual([200]);

    const waived = price("ONLINE", lines, FIXED, TN, evaluation, 1);
    expect(waived.feesWaivedCents).toBe(200);
    expect(waived.waivedTicketCount).toBe(1);
    expect(waived.feesPlatformCents).toBe(0);
    expect(itemFees(waived, GA)[0]!.platformFeeWaivedCents).toBe(200);
    expectDiscountedToZero(waived, VIP, 1);
    expectFinalizeSumIsTheCharge(waived);
    // And it is the $30 ticket's own waived price.
    expect(feesOf(waived)).toEqual(feesOf(price("ONLINE", ONE_GA, FIXED, TN, null, 1)));
  });
});

describe("priceComputedCart refuses a cart priced without its promo", () => {
  const LINES: Line[] = [
    { ticketTypeId: GA, qty: 1 },
    { ticketTypeId: VIP, qty: 1 },
  ];
  const computed = (discounts?: PromoEvaluationResult["ticketDiscounts"]) => {
    const items = aggregateItems(LINES);
    return computeOrderAmounts(items, ticketTypes(), terms(FIXED), {
      now: NOW,
      seatPrices: unseatedSeatPrices(items),
      ...(discounts ? { discounts } : {}),
    });
  };

  it("a computation that still carries the free ticket's fee is an INTERNAL error, not a charge", async () => {
    const evaluation = await evaluate(LINES, [VIP_FREE]);
    expect(() =>
      priceComputedCart({
        channel: "ONLINE",
        computation: computed(),
        payoutTerms: terms(FIXED),
        now: NOW,
        promo: evaluation,
        taxImpositions: TN,
      }),
    ).toThrow(/discounted_to_zero_mismatch/);
  });

  it("a computation priced with a promo that is then not passed is refused too", async () => {
    const evaluation = await evaluate(LINES, [VIP_FREE]);
    expect(() =>
      priceComputedCart({
        channel: "ONLINE",
        computation: computed(evaluation.ticketDiscounts),
        payoutTerms: terms(FIXED),
        now: NOW,
        taxImpositions: TN,
      }),
    ).toThrow(/discounted_to_zero_mismatch/);
  });

  it("priced with the promo, it is exactly what priceCart returns, and its input is not mutated", async () => {
    const evaluation = await evaluate(LINES, [VIP_FREE]);
    const computation = computed(evaluation.ticketDiscounts);
    const snapshot = JSON.parse(JSON.stringify(computation));
    const priced = priceComputedCart({
      channel: "ONLINE",
      computation,
      payoutTerms: terms(FIXED),
      now: NOW,
      promo: evaluation,
      taxImpositions: TN,
    });
    expect(priced).toEqual(price("ONLINE", LINES, FIXED, TN, evaluation));
    expect(JSON.parse(JSON.stringify(computation))).toEqual(snapshot);
  });
});
