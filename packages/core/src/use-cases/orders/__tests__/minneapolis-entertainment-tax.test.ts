import { describe, expect, it, vi } from "vitest";

import type { PromoRecord } from "@th/ports/repos/promos";

import { createCheckout } from "../create-checkout";
import { computeExpectedPaymentAmount } from "../../../lib/orders/compute-expected-payment-amount";
import { estimateOrderTotal } from "../../../lib/pricing/estimate-order-total";
import { solveProcessingFeeGrossUp } from "../../../lib/pricing/processing-cost-schedule";
import { estimateCheckoutTax } from "../../events/estimate-checkout-tax";
import { getCheckoutFeeRates } from "../../events/get-checkout-fee-rates";
import {
  loadListingBuyerTotalsByEventId,
  type ListingBuyerTotalEvent,
} from "../../events/_shared/listing-buyer-totals";
import { makeContext } from "./__fixtures__/create-checkout-harness";

// ─────────────────────────────────────────────────────────────────────────────
// The SHIPPED Minneapolis entertainment tax (3% of the post-discount ticket
// face, collected by the platform) through the REAL createCheckout and the
// REAL buyer-facing quotes. No tax-imposition seam: the harness and the quote
// use cases resolve against `LOCAL_TAX_IMPOSITION_RULES` as production does.
//
// Fixture (same as the TN / MN suites in create-checkout.test.ts): $25 face,
// flat 50¢ platform fee per ticket, Stripe 2.9% + 30¢ grossed up
// (PASS_THROUGH), Minneapolis general sales tax 6.875% + 2.15% = 903 bps on
// Minnesota's BUYER_TOTAL base, venue at ZIP 55403.
//
// Worked numbers, 1 ticket, no promo:
//   ent.   = round(2500 × 3%)                        = 75   (face only)
//   SALES  = round((2500 + 50 + processor) × 9.03%)  = 241  (no ent. in base)
//   processor = gross-up over 2500 + 50 + 241 + 75   = 117
//   SALES base = 2500 + 50 + 117 = 2667 → round(240.83) = 241
//   charge = 2500 + 50 + 241 + 75 + 117               = 2983
// ─────────────────────────────────────────────────────────────────────────────

const MPLS = { countryCode: "US", region: "MN", postalCode: "55403" };
const MN_SALES_BPS = 903;
const MPLS_ENT_BPS = 300;

const fixture = {
  feeMode: "PASS_THROUGH" as const,
  buyerFeePct: 0,
  platformFixedCents: 50,
  ticketPriceCents: 2500,
  admissionTaxRateBps: MN_SALES_BPS,
  taxSitus: MPLS,
};

type Ctx = ReturnType<typeof makeContext>;

const piAmount = (ctx: Ctx): number => {
  const calls = ctx.mocks.payments.createPaymentIntent.mock.calls;
  const last = calls[calls.length - 1] as [{ amountCents: number }] | undefined;
  return last![0].amountCents;
};

const lines = (ctx: Ctx) => ctx.state.lastCreateTaxLinesInput!.lines;

const finalizeExpected = (ctx: Ctx) => {
  const pending = ctx.state.lastCreatePendingInput!;
  return computeExpectedPaymentAmount({
    amountGrossCents: pending.amountGrossCents,
    feesPlatformCents: pending.feesPlatformCents,
    taxAmountCents: pending.taxAmountCents ?? 0,
    items: pending.items.map((item) => ({
      amountCents: item.amountCents,
      meta: item.meta ?? {},
      kind: item.kind,
    })),
  });
};

function eventPromo(ctx: Ctx, valueCents: number): PromoRecord {
  return {
    id: "promo-1",
    code: "SAVE5",
    codeNormalized: "SAVE5",
    status: "ACTIVE",
    kind: "AMOUNT",
    scope: "EVENT",
    scopeId: ctx.defaults.eventId,
    value: valueCents,
    currency: "usd",
    minOrderCents: 0,
    maxRedemptions: undefined,
    maxRedemptionsPerHuman: undefined,
    maxDiscountCents: undefined,
    stackable: false,
    isPublic: false,
    startsAt: undefined,
    endsAt: undefined,
    createdAt: ctx.defaults.now,
    updatedAt: ctx.defaults.now,
  };
}

async function buy(
  ctx: Ctx,
  qty: number,
  promoCodes?: string[],
): Promise<Awaited<ReturnType<typeof createCheckout>>> {
  return createCheckout(ctx.deps, {
    ...ctx.input,
    items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty }],
    ...(promoCodes ? { promoCodes } : {}),
  });
}

describe("createCheckout at a Minneapolis venue (55403) — the shipped entertainment tax", () => {
  it("persists TWO platform lines, SALES first; ent. is 3% of the face, SALES excludes it", async () => {
    const ctx = makeContext(fixture);
    const result = await buy(ctx, 1);

    expect(lines(ctx)).toEqual([
      {
        code: "SALES",
        label: "Sales tax",
        jurisdiction: "US/MN",
        rateBps: MN_SALES_BPS,
        base: "BUYER_TOTAL",
        collector: "PLATFORM",
        taxableAmountCents: 2500 + 50 + 117,
        amountCents: 241,
      },
      {
        code: "MPLS_ENTERTAINMENT",
        label: "Minneapolis entertainment tax",
        jurisdiction: "US/MN/Minneapolis",
        rateBps: MPLS_ENT_BPS,
        base: "TICKET_FACE",
        collector: "PLATFORM",
        taxableAmountCents: 2500,
        amountCents: 75,
      },
    ]);

    // Pinned worked numbers (header).
    expect(result.taxAmountCents).toBe(241 + 75);
    expect(result.processorFeeCents).toBe(117);
    expect(piAmount(ctx)).toBe(2983);

    const [sales, ent] = lines(ctx);
    // ent. = round(face × 3%).
    expect(ent!.amountCents).toBe(Math.round((2500 * MPLS_ENT_BPS) / 10_000));
    // NO TAX-ON-TAX: SALES base is net + platform + processor — the ent. line
    // is not in it.
    expect(sales!.taxableAmountCents).toBe(
      2500 + 50 + result.processorFeeCents,
    );
    expect(sales!.amountCents).toBe(
      Math.round((sales!.taxableAmountCents * MN_SALES_BPS) / 10_000),
    );
    // Σ lines = taxAmountCents on the result AND on the persisted order.
    expect(sales!.amountCents + ent!.amountCents).toBe(result.taxAmountCents);
    expect(ctx.state.lastCreatePendingInput!.taxAmountCents).toBe(
      result.taxAmountCents,
    );
    // The processor fee is grossed up over BOTH taxes, and Stripe is asked for
    // a charge that includes both.
    expect(result.processorFeeCents).toBe(
      solveProcessingFeeGrossUp(2500 + 50 + result.taxAmountCents, 0.029, 30),
    );
    expect(piAmount(ctx)).toBe(
      2500 + 50 + sales!.amountCents + ent!.amountCents + result.processorFeeCents,
    );
    // Finalize accepts this PaymentIntent (AMOUNT_MISMATCH invariant).
    expect(finalizeExpected(ctx)).toBe(piAmount(ctx));
    // Settlement basis does not move.
    expect(ctx.state.lastCreatePendingInput!.amountGrossCents).toBe(2500);
  });

  it("taxes the POST-discount face under a promo (2 × 2500 − 500 = 4500 → ent. 135)", async () => {
    const ctx = makeContext(fixture);
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([
      eventPromo(ctx, 500),
    ]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });

    const result = await buy(ctx, 2, ["save5"]);

    const pending = ctx.state.lastCreatePendingInput!;
    expect(pending.amountGrossCents).toBe(4500);
    const [sales, ent] = lines(ctx);
    expect(lines(ctx).map((line) => line.code)).toEqual([
      "SALES",
      "MPLS_ENTERTAINMENT",
    ]);
    expect(ent).toMatchObject({ taxableAmountCents: 4500, amountCents: 135 });
    expect(ent!.amountCents).toBe(Math.round((4500 * MPLS_ENT_BPS) / 10_000));
    // SALES: post-discount net + platform fee + processor fee, never the ent.
    expect(sales!.taxableAmountCents).toBe(
      4500 + result.feesPlatformCents + result.processorFeeCents,
    );
    expect(sales!.amountCents).toBe(
      Math.round((sales!.taxableAmountCents * MN_SALES_BPS) / 10_000),
    );
    expect(sales!.amountCents + ent!.amountCents).toBe(result.taxAmountCents);
    expect(pending.taxAmountCents).toBe(result.taxAmountCents);
    expect(piAmount(ctx)).toBe(
      4500 +
        result.feesPlatformCents +
        result.taxAmountCents +
        result.processorFeeCents,
    );
    expect(finalizeExpected(ctx)).toBe(piAmount(ctx));
    // Worked: platform 100 (on the PRE-discount lines), processor 186,
    // SALES round((4500 + 100 + 186) × 9.03%) = round(432.18) = 432,
    // charge 4500 + 100 + 432 + 135 + 186 = 5353.
    expect(result.feesPlatformCents).toBe(100);
    expect(result.processorFeeCents).toBe(186);
    expect(sales!.amountCents).toBe(432);
    expect(piAmount(ctx)).toBe(5353);
  });

  it("a ZIP outside the city (Bloomington 55420) persists SALES only", async () => {
    const ctx = makeContext({
      ...fixture,
      taxSitus: { ...MPLS, postalCode: "55420" },
    });
    const result = await buy(ctx, 1);

    expect(lines(ctx).map((line) => line.code)).toEqual(["SALES"]);
    // The pre-row MN numbers (create-checkout.test.ts, 676c342d0).
    expect(result.taxAmountCents).toBe(241);
    expect(piAmount(ctx)).toBe(2906);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Quote parity: what a buyer is SHOWN before checkout equals what
// createCheckout charges, at the same Minneapolis venue.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const clock = { now: () => new Date("2026-06-01T00:00:00.000Z") };

/**
 * Read-side fakes for the quote use cases (pattern: taxable-base-estimates),
 * plus the batch reads the all-in listing surface uses (pattern:
 * listing-buyer-totals.test.ts).
 */
function makeQuoteRepos(faceCents = 2500) {
  const feePolicy = {
    id: "policy-1",
    version: 1,
    status: "ACTIVE",
    scopeType: "GLOBAL",
    scopeId: null,
    effectiveTo: null,
    feeMode: "PASS_THROUGH",
    buyerFeePct: 0,
    maxFeeCents: null,
    minFeeCents: 0,
    maxPlatformFeeCents: null,
    platformFixedCents: 50,
    processsorFeePct: 0.029,
    processorFixedCents: 30,
    payoutPct: 0,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
  };
  const terms = {
    id: "agreement-1",
    kind: "PRIMARY",
    status: "ACTIVE",
    feeMode: "PASS_THROUGH",
    feePolicyId: "policy-1",
    version: 1,
  };
  const termsLine = {
    id: "line-1",
    agreementId: "agreement-1",
    payeeId: "payee-1",
    percent: 100,
    floorCents: 0,
    capPercent: null,
    priority: 0,
    rounding: "FLOOR",
  };
  return {
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: "22222222-2222-4222-8222-222222222222",
        humanId: null,
        title: "Minneapolis Show",
        slug: "minneapolis-show",
        status: "PUBLISHED",
        currency: "usd",
        admissionTaxRateBps: MN_SALES_BPS,
        placeId: null,
        savedLocationId: null,
        ...MPLS,
        startsAt: new Date("2026-12-01T20:00:00.000Z"),
        endsAt: null,
      })),
      listTicketTypes: vi.fn(async () => [
        {
          id: TT_ID,
          name: "General",
          description: null,
          priceCents: faceCents,
          pricingMode: "FIXED",
          minimumCents: null,
          suggestedCents: null,
          capacity: 100,
          status: "ACTIVE",
          seatSectionId: null,
          resaleAllowed: false,
          resaleCapCents: null,
          resaleSellerMarkupShareBpsOverride: null,
          transferAllowed: true,
          doorPriceCents: null,
          scheduledPriceCents: null,
          scheduledPriceAt: null,
          salesOpenAt: null,
          salesCloseAt: null,
        },
      ]),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => [terms]),
      listLines: vi.fn(async () => [termsLine]),
      listByEventIds: vi.fn(
        async (ids: readonly string[]) =>
          new Map(ids.map((id) => [id, id === EVENT_ID ? [terms] : []])),
      ),
      listLinesByTermsIds: vi.fn(
        async (ids: readonly string[]) =>
          new Map(
            ids.map((id) => [id, id === "agreement-1" ? [termsLine] : []]),
          ),
      ),
    },
    feePolicies: {
      getById: vi.fn(async (id: string) =>
        id === "policy-1" ? feePolicy : null,
      ),
      getByIds: vi.fn(
        async (ids: readonly string[]) =>
          new Map(
            ids.filter((id) => id === "policy-1").map((id) => [id, feePolicy]),
          ),
      ),
      resolveEffective: vi.fn(async () => null),
      resolveEffectiveForScopes: vi.fn(async () => new Map()),
    },
    places: {
      getById: vi.fn(async () => null),
      getByIds: vi.fn(async () => new Map()),
    },
    savedLocations: {
      getById: vi.fn(async () => null),
      getByIds: vi.fn(async () => new Map()),
    },
  } as never as Parameters<typeof getCheckoutFeeRates>[0]["repos"] &
    Parameters<typeof loadListingBuyerTotalsByEventId>[0]["repos"] & {
      events: { listTicketTypes: () => Promise<never[]> };
    };
}

describe("Minneapolis quote parity — the buyer-facing estimate equals the charge", () => {
  it.each([1, 2, 3])(
    "qty %i: getCheckoutFeeRates → estimateOrderTotal and estimateCheckoutTax match createCheckout",
    async (qty) => {
      const ctx = makeContext(fixture);
      const charged = await buy(ctx, qty);

      const rates = await getCheckoutFeeRates(
        { repos: makeQuoteRepos(), clock },
        { eventId: EVENT_ID },
      );
      expect(rates.taxImpositions.map((line) => line.code)).toEqual([
        "SALES",
        "MPLS_ENTERTAINMENT",
      ]);
      // SALES on the buyer total, ent. on the face → no single honest label.
      expect(rates.uniformTaxBase).toBeNull();

      const row = rates.perTicketEstimates[0]!;
      const cart = estimateOrderTotal({
        items: [
          {
            faceCents: row.unitPriceCents,
            platformFeePerTicketCents: row.platformFeeCents,
            qty,
          },
        ],
        taxImpositions: rates.taxImpositions,
        feeMode: rates.feeMode,
        processorPct: rates.processorPct ?? 0,
        processorFixedCents: rates.processorFixedCents ?? 0,
        maxPlatformFeeCents: rates.maxPlatformFeeCents,
      });
      expect(cart.taxCents).toBe(charged.taxAmountCents);
      expect(cart.processorFeeCents).toBe(charged.processorFeeCents);
      expect(cart.totalCents).toBe(piAmount(ctx));
      if (qty === 1) {
        expect(row.taxEstimateCents).toBe(charged.taxAmountCents);
        expect(row.buyerUnitTotalCents).toBe(piAmount(ctx));
      }

      const est = await estimateCheckoutTax(
        { repos: makeQuoteRepos(), clock },
        { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty }] },
      );
      expect(est.taxAmountCents).toBe(charged.taxAmountCents);
      expect(est.taxImpositions.map((line) => line.code)).toEqual([
        "SALES",
        "MPLS_ENTERTAINMENT",
      ]);
    },
  );

  it("with a $5 promo: estimateOrderTotal(discountCents) matches createCheckout", async () => {
    const ctx = makeContext(fixture);
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([
      eventPromo(ctx, 500),
    ]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });
    const charged = await buy(ctx, 2, ["save5"]);

    const rates = await getCheckoutFeeRates(
      { repos: makeQuoteRepos(), clock },
      { eventId: EVENT_ID },
    );
    const row = rates.perTicketEstimates[0]!;
    const cart = estimateOrderTotal({
      items: [
        {
          faceCents: row.unitPriceCents,
          platformFeePerTicketCents: row.platformFeeCents,
          qty: 2,
        },
      ],
      taxImpositions: rates.taxImpositions,
      feeMode: rates.feeMode,
      processorPct: rates.processorPct ?? 0,
      processorFixedCents: rates.processorFixedCents ?? 0,
      maxPlatformFeeCents: rates.maxPlatformFeeCents,
      discountCents: 500,
    });
    expect(cart.taxCents).toBe(charged.taxAmountCents);
    expect(cart.processorFeeCents).toBe(charged.processorFeeCents);
    expect(cart.totalCents).toBe(piAmount(ctx));
  });
  // ── Pinned literals: a solver bug that moved quote AND charge together
  // would pass the equalities above; these numbers are worked by hand.

  it("qty 3 at $25 charges 8880, and the quote says 8880", async () => {
    // gross 7500, platform 3 × 50 = 150, ent. round(7500 × 3%) = 225
    // SALES 717 → processor = ceil((7650 + 717 + 225 + 30) / 0.971) − 8592
    //   = ceil(8879.51) − 8592 = 288
    // SALES = round((7650 + 288) × 9.03%) = round(716.80) = 717 ✓
    // tax 717 + 225 = 942; charge 7650 + 942 + 288 = 8880
    const ctx = makeContext(fixture);
    const charged = await buy(ctx, 3);
    expect(lines(ctx).map((l) => [l.code, l.taxableAmountCents, l.amountCents])).toEqual([
      ["SALES", 7938, 717],
      ["MPLS_ENTERTAINMENT", 7500, 225],
    ]);
    expect(charged.taxAmountCents).toBe(942);
    expect(charged.processorFeeCents).toBe(288);
    expect(piAmount(ctx)).toBe(8880);

    const rates = await getCheckoutFeeRates(
      { repos: makeQuoteRepos(), clock },
      { eventId: EVENT_ID },
    );
    const row = rates.perTicketEstimates[0]!;
    const cart = estimateOrderTotal({
      items: [
        {
          faceCents: row.unitPriceCents,
          platformFeePerTicketCents: row.platformFeeCents,
          qty: 3,
        },
      ],
      taxImpositions: rates.taxImpositions,
      feeMode: rates.feeMode,
      processorPct: rates.processorPct ?? 0,
      processorFixedCents: rates.processorFixedCents ?? 0,
      maxPlatformFeeCents: rates.maxPlatformFeeCents,
    });
    expect(cart.totalCents).toBe(8880);
  });

  it("a non-round $27.50 face charges 3272 (ent. 82.5 rounds to 83), and the quote says 3272", async () => {
    // gross 2750, platform 50, ent. round(2750 × 3%) = round(82.5) = 83
    // SALES 264 → processor = ceil((2800 + 264 + 83 + 30) / 0.971) − 3147
    //   = ceil(3271.88) − 3147 = 125
    // SALES = round((2800 + 125) × 9.03%) = round(264.13) = 264 ✓
    // tax 264 + 83 = 347; charge 2800 + 347 + 125 = 3272
    const ctx = makeContext({ ...fixture, ticketPriceCents: 2750 });
    const charged = await buy(ctx, 1);
    expect(lines(ctx).map((l) => [l.code, l.taxableAmountCents, l.amountCents])).toEqual([
      ["SALES", 2925, 264],
      ["MPLS_ENTERTAINMENT", 2750, 83],
    ]);
    expect(charged.taxAmountCents).toBe(347);
    expect(charged.processorFeeCents).toBe(125);
    expect(piAmount(ctx)).toBe(3272);

    const rates = await getCheckoutFeeRates(
      { repos: makeQuoteRepos(2750), clock },
      { eventId: EVENT_ID },
    );
    expect(rates.perTicketEstimates[0]!.buyerUnitTotalCents).toBe(3272);
    expect(rates.perTicketEstimates[0]!.taxEstimateCents).toBe(347);
    const est = await estimateCheckoutTax(
      { repos: makeQuoteRepos(2750), clock },
      { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty: 1 }] },
    );
    expect(est.taxAmountCents).toBe(347);
  });

  it("the all-in LISTING price (loadListingBuyerTotalsByEventId) for one $25 ticket is 2983, the checkout charge", async () => {
    const repos = makeQuoteRepos();
    const event = (await repos.events.getById(EVENT_ID)) as unknown as
      ListingBuyerTotalEvent;
    const tiers = await repos.events.listTicketTypes(EVENT_ID);
    const reportError = vi.fn();

    const totals = await loadListingBuyerTotalsByEventId(
      { repos, reportError },
      [event],
      new Map([[EVENT_ID, tiers]]),
      clock.now(),
      { useCase: "minneapolis-parity-test" },
    );

    expect(reportError).not.toHaveBeenCalled();
    expect(totals.get(EVENT_ID)).toBe(2983);

    const ctx = makeContext(fixture);
    await buy(ctx, 1);
    expect(piAmount(ctx)).toBe(totals.get(EVENT_ID));
  });
});
