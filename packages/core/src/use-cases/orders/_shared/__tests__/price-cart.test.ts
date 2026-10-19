import { describe, expect, it } from "vitest";

import { computeExpectedPaymentAmount } from "../../../../lib/orders/compute-expected-payment-amount";
import { solveProcessingFeeGrossUp } from "../../../../lib/pricing/processing-cost-schedule";
import {
  resolveTaxImpositions,
  type TaxImposition,
} from "../../../../lib/pricing/tax-impositions";
import {
  aggregateItems,
  computeOrderAmounts,
  type OrderComputation,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "../../checkout-helpers";
import {
  priceCart,
  priceComputedCart,
  type PriceCartChannel,
  type PriceCartInput,
  type PriceCartPromo,
  type PricedCart,
} from "../price-cart";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const GA = "33333333-3333-4333-8333-333333333333";
const VIP = "33333333-3333-4333-8333-333333333334";
const PWYW = "33333333-3333-4333-8333-333333333335";

const CHANNELS: PriceCartChannel[] = ["ONLINE", "DOOR_CARD", "DOOR_CASH"];

function payoutTerms(
  overrides: Partial<{
    buyerFeePct: number;
    platformFixedCents: number;
    maxPlatformFeeCents: number | null;
    processorFeePct: number;
    processorFixedCents: number;
  }> = {},
): PayoutTermsContext {
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
      maxFeeCents: null,
      minFeeCents: 0,
      maxPlatformFeeCents: overrides.maxPlatformFeeCents ?? null,
      platformFixedCents: overrides.platformFixedCents ?? 50,
      processsorFeePct: overrides.processorFeePct ?? 0.029,
      processorFixedCents: overrides.processorFixedCents ?? 30,
      payoutPct: 0,
      payoutFixedCents: 0,
      monthlyPayoutCents: 0,
    },
  } as unknown as PayoutTermsContext;
}

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
    [GA, { ...base, id: GA, priceCents: 2500 }],
    [VIP, { ...base, id: VIP, priceCents: 8000 }],
    [
      PWYW,
      {
        ...base,
        id: PWYW,
        priceCents: 0,
        pricingMode: "ADJUSTABLE",
        minimumCents: 100,
      },
    ],
  ]);
}

/** Impositions exactly as checkout gets them, with NO local rows. */
function impositions(
  situs: { countryCode: string; region: string; postalCode: string },
  rateBps: number,
): TaxImposition[] {
  return resolveTaxImpositions({ situs, salesTaxRateBps: rateBps }, []);
}

const TN = impositions(
  { countryCode: "US", region: "TN", postalCode: "37203" },
  975,
);
const MN = impositions(
  { countryCode: "US", region: "MN", postalCode: "55101" },
  888,
);
// Illinois taxes the ticket face only.
const IL = impositions(
  { countryCode: "US", region: "IL", postalCode: "62701" },
  625,
);
const NO_TAX: TaxImposition[] = [];

/** A promo shaped like `evaluatePromoApplications` output. */
function amountPromo(cents: number): PriceCartPromo {
  return {
    totalDiscountCents: cents,
    discountItems: [
      {
        kind: "discount",
        ticketTypeId: undefined,
        qty: 1,
        unitPriceCents: -cents,
        amountCents: -cents,
        meta: { promoId: "promo-1", code: "SAVE" },
      },
    ],
    // An order-wide code: one discount on every ticket. Required: a promo
    // that does not say which tickets it is on is refused (see the
    // `promo_ticket_discounts_missing` case below).
    ticketDiscounts: [{ discountCents: cents, ticketTypeId: null }],
  };
}

type Cart = {
  name: string;
  lines: Array<{ ticketTypeId: string; qty: number; donationAmountCents?: number }>;
  taxImpositions: TaxImposition[];
  promo?: PriceCartPromo;
  waivedTickets?: number;
  terms?: PayoutTermsContext;
};

const CARTS: Cart[] = [
  { name: "TN 2 × $25", lines: [{ ticketTypeId: GA, qty: 2 }], taxImpositions: TN },
  { name: "MN 3 × $25", lines: [{ ticketTypeId: GA, qty: 3 }], taxImpositions: MN },
  { name: "no-tax 2 × $25", lines: [{ ticketTypeId: GA, qty: 2 }], taxImpositions: NO_TAX },
  { name: "IL face-only 2 × $25", lines: [{ ticketTypeId: GA, qty: 2 }], taxImpositions: IL },
  {
    name: "TN mixed tiers + PWYW",
    lines: [
      { ticketTypeId: GA, qty: 3 },
      { ticketTypeId: VIP, qty: 1 },
      { ticketTypeId: PWYW, qty: 1, donationAmountCents: 777 },
    ],
    taxImpositions: TN,
  },
  {
    name: "MN $5 promo",
    lines: [{ ticketTypeId: GA, qty: 2 }],
    taxImpositions: MN,
    promo: amountPromo(500),
  },
  {
    name: "TN fee waiver on 1 of 3",
    lines: [{ ticketTypeId: GA, qty: 3 }],
    taxImpositions: TN,
    waivedTickets: 1,
  },
  {
    name: "TN order fee cap",
    lines: [{ ticketTypeId: VIP, qty: 5 }],
    taxImpositions: TN,
    terms: payoutTerms({ maxPlatformFeeCents: 300 }),
  },
];

function price(cart: Cart, channel: PriceCartChannel): PricedCart {
  return priceCart({
    channel,
    items: aggregateItems(cart.lines),
    ticketTypes: ticketTypes(),
    payoutTerms: cart.terms ?? payoutTerms(),
    now: NOW,
    promo: cart.promo,
    waivedTickets: cart.waivedTickets,
    taxImpositions: cart.taxImpositions,
  });
}

const ticketMeta = (priced: PricedCart) =>
  priced.items
    .filter((item) => item.kind === "ticket")
    .map((item) => item.meta as Record<string, number>);

describe("priceCart — DOOR_CARD is online checkout", () => {
  it.each(CARTS)("$name: ONLINE and DOOR_CARD produce identical output", (cart) => {
    const online = price(cart, "ONLINE");
    const card = price(cart, "DOOR_CARD");
    expect({ ...card, channel: "ONLINE" }).toEqual(online);
  });

  it("ONLINE reproduces the frozen createCheckout numbers (TN 2 × $25: tax 542, processor 207, charge 6099)", () => {
    const online = price(CARTS[0]!, "ONLINE");
    expect(online.amountGrossCents).toBe(5000);
    expect(online.feesPlatformCents).toBe(350);
    expect(online.taxAmountCents).toBe(542);
    expect(online.processorFeeCents).toBe(207);
    expect(online.chargeTotalCents).toBe(6099);
  });
});

describe("priceCart — DOOR_CASH is ticket + tax: no platform fee, no processing fee", () => {
  // Owner ruling 2026-10-08: a cash sale at the door = ticket price (after
  // any promo) + tax, nothing else. It revises R3 (cash used to pay the
  // platform fee too).
  it("TN (BUYER_TOTAL): tax drops because neither fee is in the base any more", () => {
    const online = price(CARTS[0]!, "ONLINE");
    const cash = price(CARTS[0]!, "DOOR_CASH");

    expect(cash.processorFeeCents).toBe(0);
    expect(cash.processorFeeDisplayCents).toBe(0);
    expect(cash.processorPct).toBe(0);
    expect(cash.processorFixedCents).toBe(0);
    // Same face as online; no platform fee for the buyer or the organiser.
    expect(cash.amountGrossCents).toBe(online.amountGrossCents);
    expect(online.feesPlatformCents).toBe(350);
    expect(cash.feesPlatformCents).toBe(0);
    expect(cash.buyerFeesCents).toBe(0);
    expect(cash.feesWaivedCents).toBe(0);
    expect(cash.waivedTicketCount).toBe(0);
    // Online: round(9.75% × (5000 + 350 + 207)) = 542.
    // Cash:   round(9.75% × 5000) = round(487.5)  = 488.
    expect(online.taxAmountCents).toBe(542);
    expect(cash.taxAmountCents).toBe(488);
    expect(cash.taxLines).toEqual([
      expect.objectContaining({
        code: "SALES",
        base: "BUYER_TOTAL",
        taxableAmountCents: 5000,
        amountCents: 488,
      }),
    ]);
    // 5000 + 488.
    expect(cash.chargeTotalCents).toBe(5488);
  });

  it("MN (BUYER_TOTAL): tax re-solved on the face alone", () => {
    const online = price(CARTS[1]!, "ONLINE");
    const cash = price(CARTS[1]!, "DOOR_CASH");
    expect(cash.processorFeeCents).toBe(0);
    expect(cash.feesPlatformCents).toBe(0);
    // 3 × 2500 = 7500; 8.88% × 7500 = 666 exactly.
    expect(cash.taxAmountCents).toBe(666);
    expect(cash.chargeTotalCents).toBe(7500 + 666);
    expect(cash.taxAmountCents).toBeLessThan(online.taxAmountCents);
  });

  it("IL (TICKET_FACE): tax is unchanged, only the two fees go", () => {
    const online = price(CARTS[3]!, "ONLINE");
    const cash = price(CARTS[3]!, "DOOR_CASH");
    // 6.25% × 5000 = 312.5 → 313 on both channels.
    expect(cash.taxAmountCents).toBe(online.taxAmountCents);
    expect(cash.taxAmountCents).toBe(313);
    expect(cash.processorFeeCents).toBe(0);
    expect(online.processorFeeCents).toBeGreaterThan(0);
    expect(cash.chargeTotalCents).toBe(
      online.chargeTotalCents -
        online.processorFeeCents -
        online.buyerFeesCents,
    );
    expect(cash.chargeTotalCents).toBe(5000 + 313);
  });

  it("the requested fixture — TN 9.25%, 2 × $20.00, 5% platform fee: before vs after the 2026-10-08 ruling", () => {
    const terms = payoutTerms({ platformFixedCents: 0 });
    const tn925 = impositions(
      { countryCode: "US", region: "TN", postalCode: "37203" },
      925,
    );
    const cart = {
      channel: "DOOR_CASH" as const,
      items: aggregateItems([{ ticketTypeId: GA, qty: 2 }]),
      ticketTypes: new Map([[GA, { ...ticketTypes().get(GA)!, priceCents: 2000 }]]),
      payoutTerms: terms,
      now: NOW,
      taxImpositions: tn925,
    };
    const cash = priceCart(cart);
    // BEFORE (cash paid the platform fee): 4000 face + 200 fee (5% × 2000 × 2)
    //   + round(9.25% × 4200) = round(388.5) = 389 tax → 4589.
    // AFTER: 4000 face + round(9.25% × 4000) = 370 tax → 4370.
    expect(cash.feesPlatformCents).toBe(0);
    expect(cash.taxAmountCents).toBe(370);
    expect(cash.chargeTotalCents).toBe(4370);
    expect(ticketMeta(cash).map((m) => m.buyerTotalCents)).toEqual([2000, 2000]);
    // The card at the door is untouched: 4000 + 200 + 404 tax + 169 processing.
    const card = priceCart({ ...cart, channel: "DOOR_CARD" });
    expect([
      card.feesPlatformCents,
      card.taxAmountCents,
      card.processorFeeCents,
      card.chargeTotalCents,
    ]).toEqual([200, 404, 169, 4773]);
  });

  it("DOOR_CASH equals ONLINE priced under a zero-fee policy (no platform fee, no processor rate)", () => {
    const cash = price(CARTS[4]!, "DOOR_CASH");
    const zeroFeeOnline = price(
      {
        ...CARTS[4]!,
        terms: payoutTerms({
          buyerFeePct: 0,
          platformFixedCents: 0,
          processorFeePct: 0,
          processorFixedCents: 0,
        }),
      },
      "ONLINE",
    );
    expect({ ...cash, channel: "ONLINE" }).toEqual(zeroFeeOnline);
  });

  it("an order fee cap changes nothing on cash: there is no fee to cap", () => {
    const cash = price(CARTS[7]!, "DOOR_CASH");
    expect(cash.feesPlatformCents).toBe(0);
    // 5 × 8000 = 40000; 9.75% → 3900.
    expect(cash.taxAmountCents).toBe(3900);
    expect(cash.chargeTotalCents).toBe(43_900);
  });

  it("a fee policy row still saying ABSORB: the organiser owes no fee on cash either", () => {
    const base = payoutTerms();
    const absorb = {
      ...base,
      agreement: { ...base.agreement, feeMode: "ABSORB" },
      feePolicy: { ...base.feePolicy, feeMode: "ABSORB" },
    } as unknown as PayoutTermsContext;
    const cash = price({ ...CARTS[0]!, terms: absorb }, "DOOR_CASH");
    expect(cash.feesPlatformCents).toBe(0);
    expect(cash.buyerFeesCents).toBe(0);
    expect(cash.chargeTotalCents).toBe(5488);
  });

  it("refuses a computation carrying a fee waiver: cash has no fee to waive", () => {
    expect(() => price(CARTS[6]!, "DOOR_CASH")).toThrow(
      expect.objectContaining({ code: "INTERNAL" }),
    );
    expect(() => price(CARTS[6]!, "DOOR_CASH")).toThrow(/door_cash_fee_waiver/);
  });

  it("no item carries a fee on a cash sale: each ticket's buyer total is its face", () => {
    const cash = price(CARTS[4]!, "DOOR_CASH");
    for (const meta of ticketMeta(cash)) {
      expect(meta.processorFeeShareCents ?? 0).toBe(0);
      expect(meta.platformFeePerTicketCents).toBe(0);
    }
    const items = cash.items.filter((item) => item.kind === "ticket");
    for (const item of items) {
      const meta = item.meta as Record<string, number>;
      expect(meta.buyerTotalCents).toBe(item.amountCents);
      expect(meta.buyerUnitTotalCents).toBe(item.amountCents);
    }
  });

  it("a promo: tax on the discounted face, buyer totals stay the face, the discount line carries the cut", () => {
    const cash = price(CARTS[5]!, "DOOR_CASH");
    // MN 2 × 2500 − 500 = 4500; 8.88% × 4500 = 399.6 → 400.
    expect(cash.amountGrossCents).toBe(4500);
    expect(cash.taxAmountCents).toBe(400);
    expect(cash.chargeTotalCents).toBe(4900);
    expect(ticketMeta(cash).map((m) => m.buyerTotalCents)).toEqual([2500, 2500]);
  });

  it("the online processor fee is the gross-up over everything else the buyer pays", () => {
    const online = price(CARTS[3]!, "ONLINE");
    expect(online.processorFeeCents).toBe(
      solveProcessingFeeGrossUp(
        online.amountGrossCents + online.buyerFeesCents + online.taxAmountCents,
        0.029,
        30,
      ),
    );
  });
});

describe("priceCart — per-item buyer totals reconcile to the charge on every channel", () => {
  // A waived cart cannot be priced as cash (refused above): cash has no fee.
  const cases = CARTS.flatMap((cart) =>
    CHANNELS.filter(
      (channel) => !(channel === "DOOR_CASH" && cart.waivedTickets),
    ).map((channel) => ({ ...cart, channel })),
  );

  it.each(cases)("$name / $channel", (cart) => {
    const priced = price(cart, cart.channel);

    // What finalize recomputes from the order rows (AMOUNT_MISMATCH guard):
    // Σ ticket buyerTotalCents + Σ discount lines + tax.
    expect(
      computeExpectedPaymentAmount({
        amountGrossCents: priced.amountGrossCents,
        feesPlatformCents: priced.feesPlatformCents,
        taxAmountCents: priced.taxAmountCents,
        items: priced.items.map((item) => ({ ...item, meta: item.meta })),
      }),
    ).toBe(priced.chargeTotalCents);

    // Σ ticket buyer totals = face + platform fee + processor fee.
    const buyerTotals = ticketMeta(priced).reduce(
      (sum, meta) => sum + meta.buyerTotalCents,
      0,
    );
    expect(buyerTotals).toBe(
      priced.faceCents + priced.buyerFeesCents + priced.processorFeeCents,
    );

    // The charge is exactly its parts; Σ PLATFORM tax lines is the tax.
    expect(priced.chargeTotalCents).toBe(
      priced.amountGrossCents +
        priced.buyerFeesCents +
        priced.taxAmountCents +
        priced.processorFeeCents,
    );
    expect(
      priced.orderTaxLines
        .filter((line) => line.collector === "PLATFORM")
        .reduce((sum, line) => sum + line.amountCents, 0),
    ).toBe(priced.taxAmountCents);

    // Integer cents everywhere.
    for (const value of [
      priced.chargeTotalCents,
      priced.taxAmountCents,
      priced.processorFeeCents,
      ...ticketMeta(priced).map((meta) => meta.buyerTotalCents),
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe("priceCart — free carts", () => {
  it.each(CHANNELS)("%s: a promo covering the face zeroes every fee, tax and the charge", (channel) => {
    const priced = price(
      {
        name: "free",
        lines: [{ ticketTypeId: GA, qty: 1 }],
        taxImpositions: TN,
        promo: amountPromo(2500),
      },
      channel,
    );
    expect(priced.isFree).toBe(true);
    expect(priced.feesPlatformCents).toBe(0);
    expect(priced.buyerFeesCents).toBe(0);
    expect(priced.taxAmountCents).toBe(0);
    expect(priced.processorFeeCents).toBe(0);
    expect(priced.chargeTotalCents).toBe(0);
  });
});

describe("priceCart — item shape when no processor fee is charged", () => {
  const freeCart: Cart = {
    name: "free",
    lines: [{ ticketTypeId: GA, qty: 2 }],
    taxImpositions: TN,
    promo: amountPromo(5000),
  };

  it("a free cart has the same items on every channel (cash included)", () => {
    const online = price(freeCart, "ONLINE");
    for (const channel of ["DOOR_CARD", "DOOR_CASH"] as const) {
      expect(price(freeCart, channel).items).toEqual(online.items);
    }
    // The free path's shape: the share is present and 0.
    for (const meta of ticketMeta(online)) {
      expect(meta.processorFeeShareCents).toBe(0);
    }
  });

  it("a paid cash cart carries no share key, like a zero-rate online cart", () => {
    for (const meta of ticketMeta(price(CARTS[0]!, "DOOR_CASH"))) {
      expect("processorFeeShareCents" in meta).toBe(false);
    }
  });
});

describe("priceCart — a promo must say which tickets its discounts are on", () => {
  // The type requires `ticketDiscounts`; test fixtures sit outside typecheck,
  // so the refusal is what stops one from being priced as "one discount on
  // the whole order" (which frees the wrong tickets of their fee, silently).
  const withoutTicketDiscounts = (cents: number) => {
    const { ticketDiscounts: _dropped, ...rest } = amountPromo(cents);
    return rest as unknown as PriceCartPromo;
  };

  it.each(CHANNELS)("%s: priceCart refuses a promo without ticketDiscounts", (channel) => {
    expect(() =>
      price({ ...CARTS[0]!, promo: withoutTicketDiscounts(500) }, channel),
    ).toThrowError(/promo_ticket_discounts_missing/);
  });

  it("the refusal is an INTERNAL fault, not a buyer-facing refusal", () => {
    let thrown: unknown;
    try {
      price({ ...CARTS[0]!, promo: withoutTicketDiscounts(500) }, "ONLINE");
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe("INTERNAL");
  });

  it("an empty list is a statement (no ticket is discounted), not a missing one", () => {
    const promo = { ...amountPromo(500), ticketDiscounts: [] };
    expect(() => price({ ...CARTS[0]!, promo }, "ONLINE")).not.toThrow();
  });
});

describe("priceCart — purity", () => {
  it("returns copies of the promo's discount items, not the caller's objects", () => {
    const promo = amountPromo(500);
    const priced = price({ ...CARTS[0]!, promo }, "ONLINE");
    const returned = priced.items.filter((item) => item.kind === "discount");
    expect(returned).toEqual(promo.discountItems);
    expect(returned[0]).not.toBe(promo.discountItems[0]);
    expect(returned[0]!.meta).not.toBe(promo.discountItems[0]!.meta);
  });

  it("priceComputedCart does not mutate the computation it is given", () => {
    const terms = payoutTerms();
    const computation: OrderComputation = computeOrderAmounts(
      aggregateItems([{ ticketTypeId: GA, qty: 3 }]),
      ticketTypes(),
      terms,
      { now: NOW },
    );
    const before = structuredClone(computation);

    for (const channel of CHANNELS) {
      priceComputedCart({
        channel,
        computation,
        payoutTerms: terms,
        now: NOW,
        taxImpositions: TN,
      });
    }

    expect(computation).toEqual(before);
  });

  it("priceCart and priceComputedCart over the same computation agree", () => {
    const terms = payoutTerms();
    const input: PriceCartInput = {
      channel: "ONLINE",
      items: aggregateItems([{ ticketTypeId: GA, qty: 3 }]),
      ticketTypes: ticketTypes(),
      payoutTerms: terms,
      now: NOW,
      waivedTickets: 1,
      promo: amountPromo(300),
      taxImpositions: MN,
    };
    const whole = priceCart(input);
    const staged = priceComputedCart({
      channel: "ONLINE",
      computation: computeOrderAmounts(input.items, input.ticketTypes, terms, {
        now: NOW,
        waivedTickets: 1,
      }),
      payoutTerms: terms,
      now: NOW,
      promo: input.promo,
      taxImpositions: MN,
    });
    expect(staged).toEqual(whole);
  });

  it("same input, same answer (deterministic)", () => {
    expect(price(CARTS[4]!, "DOOR_CASH")).toEqual(price(CARTS[4]!, "DOOR_CASH"));
  });

  it("stamps the fee policy snapshot checkout persists", () => {
    expect(price(CARTS[0]!, "DOOR_CARD").feePolicySnapshot).toEqual({
      payoutTermsId: "terms-1",
      payoutTermsVersion: 3,
      agreementId: "terms-1",
      agreementVersion: 3,
      feePolicyId: "policy-1",
      feePolicyVersion: 7,
      feeMode: "PASS_THROUGH",
      // The credit rule settlement reads back (owner ruling 2026-10-11): the
      // organiser is credited the full ticket price.
      organiserCredit: "FULL_PRICE",
      computedAt: NOW.toISOString(),
    });
  });
});
