import { describe, expect, it } from "vitest";

import { createCheckout } from "@th/core/use-cases/orders/create-checkout";
import { SALE_FEE_MODE } from "@th/core/lib/pricing/compute-ticket-price-for-agreement";
import { previewPromos } from "@th/core/use-cases/promos/preview-promos";
import { updateOrderItems } from "@th/core/use-cases/orders/update-order-items";
import { getCheckoutFeeRates } from "@th/core/use-cases/events/get-checkout-fee-rates";
import {
  derivePendingCartFees,
  derivePendingCartPricing,
} from "@th/core/lib/orders/pending-cart-fees";
import type { GetCheckoutFeeRatesOutput } from "@th/core/use-cases/events/get-checkout-fee-rates";

import { makeContext } from "./__fixtures__/create-checkout-harness";
import { estimateCartTotal, estimateHeldOrderCharge } from "./order-estimate";

/**
 * END-TO-END PWYW parity: the REAL `createCheckout` use case, run against the
 * fake repos of `packages/core/src/use-cases/orders/__tests__/create-checkout.test.ts`
 * (quarantined, untyped, in `./__fixtures__/create-checkout-harness.ts`), must
 * charge exactly what the checkout page's `estimateCartTotal` quoted before
 * the hold — for a pay-what-you-want line.
 *
 * `pay-what-you-want-parity.test.ts` proves the same thing one layer down
 * (computeOrderAmounts + the charge's tax/processor solve). This one closes
 * the gap to the PaymentIntent amount itself.
 *
 * The fee-rates payload is typed as `getCheckoutFeeRates`' OUTPUT, so a field
 * that endpoint stops sending (or renames) fails this file at compile time
 * instead of quietly passing a hand-typed shape the page never receives.
 */

/** The owner's policy: 3.33%, capped at 50¢ per ticket; Stripe 2.9% + 30¢. */
const BUYER_FEE_PCT = 0.0333;
const MAX_FEE_CENTS = 50;
const TAX_BPS = 888;

const piAmount = (ctx: ReturnType<typeof makeContext>): number => {
  const calls = ctx.mocks.payments.createPaymentIntent.mock.calls as unknown as Array<
    [{ amountCents: number }]
  >;
  return calls[calls.length - 1]![0].amountCents;
};

type Case = {
  label: string;
  feeMode: "PASS_THROUGH" | "ABSORB";
  situs: { countryCode: string; region: string; postalCode: string };
  qty: number;
  amount: number;
};

const CASES: Case[] = [
  {
    label: "PASS_THROUGH, $22.50 × 2 (fee at the 50¢ cap), tax on the face (NY)",
    feeMode: "PASS_THROUGH",
    situs: { countryCode: "US", region: "NY", postalCode: "10001" },
    qty: 2,
    amount: 2250,
  },
  {
    label: "PASS_THROUGH, $7.35 × 3 (fee under the cap), buyer-total tax (TN)",
    feeMode: "PASS_THROUGH",
    situs: { countryCode: "US", region: "TN", postalCode: "37203" },
    qty: 3,
    amount: 735,
  },
  {
    // ABSORB is removed: a policy row that still says it prices fees-on-top.
    label: "a policy still saying ABSORB, $15 × 1 — fees on top all the same",
    feeMode: "ABSORB",
    situs: { countryCode: "US", region: "NY", postalCode: "10001" },
    qty: 1,
    amount: 1500,
  },
];

describe("createCheckout ⇄ estimateCartTotal — pay what you want", () => {
  it.each(CASES)("$label", async ({ feeMode, situs, qty, amount }) => {
    const ctx = makeContext({
      feeMode,
      buyerFeePct: BUYER_FEE_PCT,
      maxFeeCents: MAX_FEE_CENTS,
      platformFixedCents: 0,
      admissionTaxRateBps: TAX_BPS,
      taxSitus: situs,
    });
    ctx.mocks.repos.events.listTicketTypes.mockResolvedValue([
      {
        id: ctx.defaults.ticketTypeId,
        priceCents: 0,
        pricingMode: "ADJUSTABLE",
        minimumCents: 500,
        suggestedCents: 1500,
        status: "ACTIVE",
        capacity: 100,
        seatSectionId: null,
        resaleAllowed: false,
        resaleCapCents: null,
        transferAllowed: true,
        scheduledPriceCents: null,
        scheduledPriceAt: null,
        salesOpenAt: null,
        salesCloseAt: null,
      },
    ] as never);

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [
        {
          ticketTypeId: ctx.defaults.ticketTypeId,
          qty,
          donationAmountCents: amount,
        },
      ],
    });

    // The page is sent the server's mode, never the policy row's.
    const servedMode = SALE_FEE_MODE;
    const passThrough = servedMode === "PASS_THROUGH";
    const base = situs.region === "TN" ? "BUYER_TOTAL" : "TICKET_FACE";
    // Exactly what `getCheckoutFeeRates` hands the page for this policy —
    // typed as that endpoint's output, not hand-shaped.
    const feeRates: GetCheckoutFeeRatesOutput = {
      eventId: ctx.defaults.eventId,
      feeMode: servedMode,
      admissionTaxRateBps: TAX_BPS,
      taxableBase: base,
      taxImpositions: [
        {
          code: "SALES",
          label: "Sales tax",
          jurisdiction: `US/${situs.region}`,
          rateBps: TAX_BPS,
          base,
          collector: "PLATFORM",
        },
      ],
      uniformTaxBase: base,
      platformFeeLabel: passThrough ? "3.33%" : null,
      processorFeeLabel: passThrough ? "2.9% + $0.30" : null,
      processingMethodRates: [],
      processorPct: passThrough ? 0.029 : null,
      processorFixedCents: passThrough ? 30 : null,
      maxPlatformFeeCents: null,
      platformFeeRates: passThrough
        ? {
            buyerFeePct: BUYER_FEE_PCT,
            maxFeeCents: MAX_FEE_CENTS,
            minFeeCents: 0,
            platformFixedCents: 0,
          }
        : null,
      // The PWYW row is priced at the tier's floor; a buyer-priced line never
      // reads it, which is part of what this parity proves.
      perTicketEstimates: [],
    };

    const estimate = estimateCartTotal(feeRates, [
      {
        ticketTypeId: ctx.defaults.ticketTypeId,
        qty,
        priceCents: 0,
        chosenAmountCents: amount,
      },
    ]);

    expect(estimate).not.toBeNull();
    expect(piAmount(ctx)).toBe(estimate!.totalCents);
    // The owner's rule: the whole chosen amount is the gross.
    expect(estimate!.grossCents).toBe(amount * qty);
    // Non-vacuous: tax (and, passed through, fees) really were charged.
    expect(estimate!.taxCents).toBeGreaterThan(0);
    if (passThrough) {
      expect(estimate!.platformFeeCents).toBeGreaterThan(0);
      expect(estimate!.processorFeeCents).toBeGreaterThan(0);
    }
  });

  it("the 50¢ per-ticket cap really binds in the first case", () => {
    // round(2250 × 3.33%) = 75¢ uncapped — so the case above exercises the cap.
    expect(Math.round(2250 * BUYER_FEE_PCT)).toBeGreaterThan(MAX_FEE_CENTS);
  });
});

describe("step 1, step 2 (fresh AND resumed) ⇄ the PaymentIntent — mixed cart with a % promo", () => {
  // The live drive's cart: 1 × GA at $35 face + 1 × PWYW at $20, WELCOME10.
  // Every input below comes from a REAL use case on the same fake repos —
  // nothing is copied from the result under test:
  //   fee rates  ← getCheckoutFeeRates   (what the page is sent)
  //   discount   ← previewPromos          (what the page previews)
  //   held order ← updateOrderItems       (the hold, its own fees)
  //   resumed    ← derivePendingCartFees  (what getActiveCartHolds returns)
  //   charge     ← createCheckout         (the PaymentIntent)
  const PWYW_ID = "99999999-9999-4999-8999-999999999999";
  const GA_FACE = 3500;
  const PWYW_AMOUNT = 2000;

  const setUp = () => {
    const ctx = makeContext({
      feeMode: "PASS_THROUGH",
      buyerFeePct: BUYER_FEE_PCT,
      maxFeeCents: MAX_FEE_CENTS,
      platformFixedCents: 0,
      admissionTaxRateBps: TAX_BPS,
      taxSitus: { countryCode: "US", region: "NY", postalCode: "10001" },
    });
    const tier = {
      status: "ACTIVE",
      capacity: 100,
      seatSectionId: null,
      resaleAllowed: false,
      resaleCapCents: null,
      transferAllowed: true,
      scheduledPriceCents: null,
      scheduledPriceAt: null,
      salesOpenAt: null,
      salesCloseAt: null,
    };
    ctx.mocks.repos.events.listTicketTypes.mockResolvedValue([
      {
        ...tier,
        id: ctx.defaults.ticketTypeId,
        name: "General Admission",
        priceCents: GA_FACE,
        pricingMode: "FIXED",
        minimumCents: null,
        suggestedCents: null,
      },
      {
        ...tier,
        id: PWYW_ID,
        name: "Pay What You Want",
        priceCents: 0,
        pricingMode: "ADJUSTABLE",
        minimumCents: 500,
        suggestedCents: 1500,
      },
    ] as never);
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([
      {
        id: "aaaaaaaa-0000-4000-8000-00000000a010",
        code: "WELCOME10",
        codeNormalized: "WELCOME10",
        status: "ACTIVE",
        kind: "PERCENT",
        scope: "EVENT",
        scopeId: ctx.defaults.eventId,
        value: 10,
        currency: "usd",
        minOrderCents: 0,
        maxRedemptions: undefined,
        maxRedemptionsPerHuman: undefined,
        maxDiscountCents: undefined,
        stackable: true,
        isPublic: true,
        startsAt: undefined,
        endsAt: undefined,
        createdAt: ctx.defaults.now,
        updatedAt: ctx.defaults.now,
      },
    ] as never);
    return ctx;
  };

  it("all four are the SAME number", async () => {
    const ctx = setUp();
    const items = [
      { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 },
      { ticketTypeId: PWYW_ID, qty: 1, donationAmountCents: PWYW_AMOUNT },
    ];
    const readDeps = { repos: ctx.deps.repos, clock: ctx.deps.clock } as never;

    const feeRates = await getCheckoutFeeRates(readDeps, {
      eventId: ctx.defaults.eventId,
    });
    const preview = await previewPromos(readDeps, {
      eventId: ctx.defaults.eventId,
      codes: ["WELCOME10"],
      ticketSelections: items,
    });
    const hold = await updateOrderItems(ctx.deps as never, {
      actorHumanId: ctx.input.buyerHumanId,
      eventId: ctx.defaults.eventId,
      items,
    });

    // Step 1 — the pre-hold estimate.
    const step1 = estimateCartTotal(
      feeRates,
      [
        { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1, priceCents: GA_FACE },
        {
          ticketTypeId: PWYW_ID,
          qty: 1,
          priceCents: 0,
          chosenAmountCents: PWYW_AMOUNT,
        },
      ],
      { discountCents: preview.totalDiscountCents },
    );
    // Step 2, fresh — the held order as updateOrderItems returned it.
    const step2Fresh = estimateHeldOrderCharge(
      feeRates,
      hold.order,
      preview.totalDiscountCents,
    );
    // Step 2, RESUMED — the cart as getActiveCartHolds re-reads it: gross and
    // platform fee from the order row, buyer fees derived from its lines.
    const resumedFees = derivePendingCartFees(
      hold.order.items.map((item) => item.meta),
      hold.order.feesPlatformCents,
    );
    const step2Resumed = estimateHeldOrderCharge(
      feeRates,
      {
        amountGrossCents: hold.order.amountGrossCents,
        buyerFeesCents: resumedFees.buyerFeesCents,
      },
      preview.totalDiscountCents,
    );

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items,
      promoCodes: ["WELCOME10"],
    });
    const charged = piAmount(ctx);

    expect(preview.totalDiscountCents).toBe(550);
    expect(resumedFees).toEqual({
      feeMode: "PASS_THROUGH",
      buyerFeesCents: hold.order.buyerFeesCents,
    });
    expect(step1!.totalCents).toBe(charged);
    expect(step2Fresh!.totalCents).toBe(charged);
    expect(step2Resumed!.totalCents).toBe(charged);
    // The live figure.
    expect(charged).toBe(5685);
  });

  it("regression: a resumed cart with the old hard-coded 0 buyer fees is NOT the charge", async () => {
    const ctx = setUp();
    const items = [
      { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 },
      { ticketTypeId: PWYW_ID, qty: 1, donationAmountCents: PWYW_AMOUNT },
    ];
    const readDeps = { repos: ctx.deps.repos, clock: ctx.deps.clock } as never;
    const feeRates = await getCheckoutFeeRates(readDeps, {
      eventId: ctx.defaults.eventId,
    });
    const hold = await updateOrderItems(ctx.deps as never, {
      actorHumanId: ctx.input.buyerHumanId,
      eventId: ctx.defaults.eventId,
      items,
    });
    const zeroFees = estimateHeldOrderCharge(
      feeRates,
      { amountGrossCents: hold.order.amountGrossCents, buyerFeesCents: 0 },
      550,
    );
    // $55.82: the platform fee missing, and a gross-up over the smaller base.
    expect(zeroFees!.totalCents).toBe(5582);
  });

  /** The buyer's membership takes $5 off (AMOUNT), auto-applied, no code. */
  const seedMemberBenefit = (ctx: ReturnType<typeof makeContext>) => {
    const TIER_ID = "99999999-9999-4999-8999-222222222222";
    ctx.mocks.repos.memberships.listForMember.mockImplementation(
      async (input: { memberHumanId: string; statuses: string[] }) =>
        input.memberHumanId === ctx.defaults.buyerHumanId &&
        input.statuses.includes("active")
          ? ([
              {
                id: "99999999-9999-4999-8999-111111111111",
                tierId: TIER_ID,
                memberHumanId: ctx.defaults.buyerHumanId,
                status: "active",
                startedAt: ctx.defaults.now,
              },
            ] as never)
          : [],
    );
    ctx.mocks.repos.membershipTiers.listByIds.mockResolvedValue([
      {
        id: TIER_ID,
        ownerOrgId: ctx.defaults.orgId,
        ownerHumanId: null,
        name: "Sustaining Member",
        description: null,
        benefitsDescription: null,
        priceCents: 1000,
        currency: "usd",
        interval: "MONTH",
        stripeProductId: null,
        stripePriceId: null,
        status: "ACTIVE",
        sortOrder: 0,
        createdAt: ctx.defaults.now,
        updatedAt: ctx.defaults.now,
      },
    ] as never);
    ctx.mocks.repos.membershipTiers.listBenefitsForTiers.mockResolvedValue([
      {
        id: "99999999-9999-4999-8999-333333333333",
        tierId: TIER_ID,
        discountKind: "AMOUNT",
        discountValue: 500,
        maxDiscountCents: null,
        categoryId: null,
        placeId: null,
        label: null,
      },
    ] as never);
  };

  it("a cart createCheckout WROTE (member benefit + typed code), resumed, is the same charge", async () => {
    const ctx = setUp();
    seedMemberBenefit(ctx);
    const items = [
      { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 },
      { ticketTypeId: PWYW_ID, qty: 1, donationAmountCents: PWYW_AMOUNT },
    ];
    const readDeps = { repos: ctx.deps.repos, clock: ctx.deps.clock } as never;
    const feeRates = await getCheckoutFeeRates(readDeps, {
      eventId: ctx.defaults.eventId,
    });

    // The buyer reached payment once: createCheckout priced and SAVED the
    // cart — order row gross AFTER both discounts, discount lines beside
    // the ticket lines.
    await createCheckout(ctx.deps, {
      ...ctx.input,
      items,
      promoCodes: ["WELCOME10"],
    });
    const charged = piAmount(ctx);
    const saved = ctx.state.order;

    // …then left and came back: what getActiveCartHolds derives from it.
    const resumed = derivePendingCartPricing(
      saved.items.map((item) => ({
        kind: item.kind,
        amountCents: item.amountCents,
        meta: item.meta,
      })),
      saved.feesPlatformCents,
    );
    // The page restores the codes and re-previews (member benefit included,
    // this cart excluded from its own redemption count).
    const preview = await previewPromos(readDeps, {
      eventId: ctx.defaults.eventId,
      codes: resumed.promoCodes,
      buyerHumanId: ctx.defaults.buyerHumanId,
      includeMemberBenefits: true,
      ticketSelections: items,
      excludeOrderId: saved.id,
    });
    const step2Resumed = estimateHeldOrderCharge(
      feeRates,
      {
        amountGrossCents: resumed.preDiscountGrossCents,
        buyerFeesCents: resumed.buyerFeesCents,
      },
      preview.totalDiscountCents,
    );

    expect(step2Resumed!.totalCents).toBe(charged);
    // Non-vacuous: BOTH discounts really applied, and the saved row really
    // is post-discount (the figure resume used to start from).
    expect(preview.applications.length).toBe(2);
    expect(preview.totalDiscountCents).toBeGreaterThan(500);
    expect(resumed.promoCodes).toEqual(["WELCOME10"]);
    expect(resumed.preDiscountGrossCents).toBe(GA_FACE + PWYW_AMOUNT);
    expect(saved.amountGrossCents).toBe(
      GA_FACE + PWYW_AMOUNT - preview.totalDiscountCents,
    );

    // Regression: starting from the saved (post-discount) gross took the
    // discount off twice.
    const doubleDiscounted = estimateHeldOrderCharge(
      feeRates,
      {
        amountGrossCents: saved.amountGrossCents,
        buyerFeesCents: resumed.buyerFeesCents,
      },
      preview.totalDiscountCents,
    );
    expect(doubleDiscounted!.totalCents).toBeLessThan(charged);
  });

  it("a fee waiver: the held step (fresh) is the charge — the hold prices the waived fee too", async () => {
    const ctx = setUp();
    // One ticket of allowance left. The charge reserves it; the hold must
    // price the same waived ticket WITHOUT reserving.
    const waiver = {
      id: "aaaaaaaa-0000-4000-8000-0000000000f1",
      ticketsGranted: 3,
      ticketsUsed: 2,
      ticketsRemaining: 1,
    };
    ctx.mocks.repos.feeWaivers.resolveApplicable.mockResolvedValue([waiver]);
    // The harness types `reserve` as its no-arg default; this one reads
    // the ladder, like the adapter.
    ctx.mocks.repos.feeWaivers.reserve.mockImplementation((async (input: {
      waivableTicketFeesCents: number[];
    }) => ({
      reservedTickets: Math.min(1, input.waivableTicketFeesCents.length),
      feeWaivedCents: input.waivableTicketFeesCents[0] ?? 0,
      redemptionId: "r1",
    })) as never);
    const items = [
      { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 },
      { ticketTypeId: PWYW_ID, qty: 1, donationAmountCents: PWYW_AMOUNT },
    ];
    const readDeps = { repos: ctx.deps.repos, clock: ctx.deps.clock } as never;
    const feeRates = await getCheckoutFeeRates(readDeps, {
      eventId: ctx.defaults.eventId,
    });
    const hold = await updateOrderItems(ctx.deps as never, {
      actorHumanId: ctx.input.buyerHumanId,
      eventId: ctx.defaults.eventId,
      items,
    });
    expect(ctx.mocks.repos.feeWaivers.reserve).not.toHaveBeenCalled();

    await createCheckout(ctx.deps, { ...ctx.input, items });
    const charged = piAmount(ctx);
    const step2Fresh = estimateHeldOrderCharge(feeRates, hold.order, 0);

    // Non-vacuous: the charge really waived one ticket's 50¢ fee.
    expect(ctx.mocks.repos.feeWaivers.reserve).toHaveBeenCalledTimes(1);
    expect(hold.order.buyerFeesCents).toBe(MAX_FEE_CENTS);
    expect(step2Fresh!.totalCents).toBe(charged);
  });
});
