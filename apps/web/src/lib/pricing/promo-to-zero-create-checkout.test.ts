import { describe, expect, it, vi } from "vitest";

import { createCheckout } from "@th/core/use-cases/orders/create-checkout";
import { getActiveCartHolds } from "@th/core/use-cases/orders/get-active-cart-holds";
import { previewPromos } from "@th/core/use-cases/promos/preview-promos";
import { updateOrderItems } from "@th/core/use-cases/orders/update-order-items";
import { getCheckoutFeeRates } from "@th/core/use-cases/events/get-checkout-fee-rates";

import { makeContext } from "./__fixtures__/create-checkout-harness";
import { feeWaivedCentsFor } from "./fee-waiver";
import { withStatedHeldFees } from "./held-order-fees";
import { estimateCartTotal, estimateHeldOrderCharge } from "./order-estimate";

/**
 * Owner rulings, 2026-10-10: "If $0 is the cost of the tickets there shouldn't
 * be any fee" and "yes a promo brought down to $0 should have no fee too."
 *
 * What the checkout page SHOWS must be what `createCheckout` CHARGES when a
 * code makes one ticket of a paid cart free: at step 1, on the held step, and
 * on the held step again after the cart has already been to payment once.
 *
 * Every input is a real use case on one set of fake repos, and every figure
 * the page shows is built by the functions the page calls:
 *
 *   fee rates   ← getCheckoutFeeRates   (what the page is sent)
 *   preview     ← previewPromos          (discount, the pre-hold fee
 *                                         reduction, and `heldCartFees`)
 *   held order  ← updateOrderItems       (the hold, priced without the promo)
 *   reloaded    ← getActiveCartHolds     (the cart on file, whoever saved it)
 *   charge      ← createCheckout         (the PaymentIntent)
 *
 *   step 1      = estimateCartTotal(rates, cart, { discount, feeReduction })
 *   held step   = estimateHeldOrderCharge(rates,
 *                   withStatedHeldFees(order, preview.heldCartFees), discount)
 *
 * The fee-waiver fake is a ledger with the adapter's rules, because two of
 * the cases are about a cart that already holds a reservation.
 */

const VIP_ID = "99999999-9999-4999-8999-999999999999";
const WAIVER_ID = "aaaaaaaa-0000-4000-8000-0000000000f1";
const FEE_POLICY_ID = "55555555-5555-4555-8555-555555555555";
const VIP_FACE = 5000;

type World = {
  label: string;
  gaCents: number;
  /** "live": 3.33% capped at 50¢ a ticket. "fixed": 5% + 50¢ a ticket. */
  policy: "live" | "fixed";
  orderCapCents?: number;
  allowance?: number;
  storedFeeMode?: "PASS_THROUGH" | "ABSORB";
  taxBps?: number;
  situs?: { countryCode: string; region: string; postalCode: string };
};

type Promo = {
  kind: "PERCENT" | "AMOUNT";
  value: number;
  scope: "EVENT" | "TICKET_TYPE";
};
const VIP_FREE: Promo = { kind: "PERCENT", value: 100, scope: "TICKET_TYPE" };

type Ctx = ReturnType<typeof makeContext>;
type Qty = { ga: number; vip: number };

/** The fee-waiver adapter's rules, in memory. */
function installWaiverLedger(ctx: Ctx, granted: number) {
  const waiver = {
    id: WAIVER_ID,
    subjectType: "ORG",
    subjectId: ctx.defaults.orgId,
    side: "ORGANIZER",
    ticketsGranted: granted,
    ticketsUsed: 0,
    status: "ACTIVE",
    effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
    effectiveTo: null,
  };
  const redemptions = new Map<
    string,
    { ticketsReserved: number; feeWaivedCents: number; status: string }
  >();
  const record = () => ({
    ...waiver,
    ticketsRemaining: waiver.ticketsGranted - waiver.ticketsUsed,
  });
  const repo = ctx.mocks.repos.feeWaivers as Record<string, unknown>;
  repo.resolveApplicable = vi.fn(async () =>
    waiver.status === "ACTIVE" && waiver.ticketsUsed < waiver.ticketsGranted
      ? [record()]
      : [],
  );
  const reserve = vi.fn(
    async (input: {
      orderId: string;
      waivableTicketFeesCents: number[];
    }) => {
      const take = Math.min(
        input.waivableTicketFeesCents.length,
        waiver.status === "ACTIVE"
          ? waiver.ticketsGranted - waiver.ticketsUsed
          : 0,
      );
      if (take <= 0) {
        return { reservedTickets: 0, feeWaivedCents: 0, redemptionId: null };
      }
      waiver.ticketsUsed += take;
      if (waiver.ticketsUsed >= waiver.ticketsGranted) {
        waiver.status = "EXHAUSTED";
      }
      const feeWaivedCents = input.waivableTicketFeesCents
        .slice(0, take)
        .reduce((sum, cents) => sum + cents, 0);
      redemptions.set(input.orderId, {
        ticketsReserved: take,
        feeWaivedCents,
        status: "RESERVED",
      });
      return {
        reservedTickets: take,
        feeWaivedCents,
        redemptionId: `redemption-${input.orderId}`,
      };
    },
  );
  repo.reserve = reserve;
  repo.release = vi.fn(async (orderId: string) => {
    const redemption = redemptions.get(orderId);
    if (!redemption || redemption.status === "RELEASED") {
      return { releasedTickets: 0 };
    }
    redemption.status = "RELEASED";
    waiver.ticketsUsed = Math.max(
      0,
      waiver.ticketsUsed - redemption.ticketsReserved,
    );
    if (waiver.status === "EXHAUSTED") waiver.status = "ACTIVE";
    return { releasedTickets: redemption.ticketsReserved };
  });
  repo.listRedemptionsByOrder = vi.fn(async (orderId: string) => {
    const redemption = redemptions.get(orderId);
    return redemption
      ? [
          {
            id: `redemption-${orderId}`,
            waiverId: WAIVER_ID,
            orderId,
            ...redemption,
          },
        ]
      : [];
  });
  repo.getById = vi.fn(async (id: string) =>
    id === WAIVER_ID ? record() : null,
  );
  return { waiver, reserve };
}

async function setUp(world: World, promo: Promo | null, qty: Qty) {
  const ctx = makeContext({
    feeMode: world.storedFeeMode ?? "PASS_THROUGH",
    buyerFeePct: world.policy === "live" ? 0.0333 : 0.05,
    maxFeeCents: world.policy === "live" ? 50 : null,
    platformFixedCents: world.policy === "live" ? 0 : 50,
    admissionTaxRateBps: world.taxBps ?? 0,
    ...(world.situs ? { taxSitus: world.situs } : {}),
  });
  if (world.orderCapCents != null) {
    // The harness hands out ONE fee policy object and has no option for the
    // order-level cap: set it on that object.
    const policy = await ctx.mocks.repos.feePolicies.getById(FEE_POLICY_ID);
    if (!policy) {
      throw new Error("the harness has no fee policy to cap");
    }
    policy.maxPlatformFeeCents = world.orderCapCents;
  }
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
    pricingMode: "FIXED",
    minimumCents: null,
    suggestedCents: null,
  };
  ctx.mocks.repos.events.listTicketTypes.mockResolvedValue([
    { ...tier, id: ctx.defaults.ticketTypeId, name: "General Admission", priceCents: world.gaCents },
    { ...tier, id: VIP_ID, name: "VIP", priceCents: VIP_FACE },
  ] as never);
  if (promo) {
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([
      {
        id: "aaaaaaaa-0000-4000-8000-00000000a010",
        code: "VIPCODE",
        codeNormalized: "VIPCODE",
        status: "ACTIVE",
        kind: promo.kind,
        scope: promo.scope,
        scopeId: promo.scope === "TICKET_TYPE" ? VIP_ID : ctx.defaults.eventId,
        value: promo.value,
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
  }
  const ledger = installWaiverLedger(ctx, world.allowance ?? 0);

  // Every order id this test names is the buyer's own PENDING cart on this
  // event: what `excludeOrderId` and `pendingOrderId` are checked against.
  const ownCarts = new Set<string>();
  // Only the fields the two ownership checks read: not a whole order row.
  ctx.mocks.repos.orders.getById.mockImplementation((async (id: string) =>
    ownCarts.has(id)
      ? {
          id,
          buyerHumanId: ctx.defaults.buyerHumanId,
          eventId: ctx.defaults.eventId,
          status: "PENDING",
          stripePaymentIntentId: null,
          items: [],
        }
      : { ...ctx.state.order }) as never);

  const items = [
    ...(qty.ga > 0 ? [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: qty.ga }] : []),
    ...(qty.vip > 0 ? [{ ticketTypeId: VIP_ID, qty: qty.vip }] : []),
  ];
  const cartLines = [
    { ticketTypeId: ctx.defaults.ticketTypeId, qty: qty.ga, priceCents: world.gaCents },
    { ticketTypeId: VIP_ID, qty: qty.vip, priceCents: VIP_FACE },
  ];
  const readDeps = { repos: ctx.deps.repos, clock: ctx.deps.clock } as never;
  const feeRates = await getCheckoutFeeRates(readDeps, {
    eventId: ctx.defaults.eventId,
  });
  let attempt = 0;

  /** `promos.preview`, as the page calls it (signed in; held cart if any). */
  const preview = (codes: string[], heldOrderId?: string) =>
    previewPromos(readDeps, {
      eventId: ctx.defaults.eventId,
      codes,
      ticketSelections: items,
      includeMemberBenefits: true,
      buyerHumanId: ctx.defaults.buyerHumanId,
      ...(heldOrderId ? { excludeOrderId: heldOrderId } : {}),
    });

  /** Step 1: the pre-hold estimate, with the preview's discount and reduction. */
  const step1 = async (codes: string[]) => {
    const p = await preview(codes);
    return estimateCartTotal(feeRates, cartLines, {
      discountCents: p.totalDiscountCents,
      platformFeeReductionCents: p.platformFeeReductionCents,
    })!;
  };

  type PageOrder = {
    id: string;
    amountGrossCents: number;
    feesPlatformCents: number;
    buyerFeesCents: number;
    feeWaivedCents?: number;
    items?: ReadonlyArray<{ meta?: unknown }>;
  };

  /**
   * The held step, as Checkout.tsx builds it: the order with the server's
   * stated fee, the held charge solved on top, and the rows the summary
   * prints from the two.
   */
  const heldStep = async (order: PageOrder, codes: string[]) => {
    const p = await preview(codes, order.id);
    const heldOrder = withStatedHeldFees(order, p.heldCartFees, "PASS_THROUGH")!;
    const charge = estimateHeldOrderCharge(
      feeRates,
      { ...heldOrder, feeMode: "PASS_THROUGH" },
      p.totalDiscountCents,
    )!;
    return {
      // The fee for these codes, and the cart's fee with no discount at all.
      stated: p.heldCartFees && {
        buyerPlatformFeeCents: p.heldCartFees.buyerPlatformFeeCents,
        platformFeeWaivedCents: p.heldCartFees.platformFeeWaivedCents,
      },
      withoutDiscounts: p.heldCartFees?.withoutDiscounts ?? null,
      totalCents: charge.totalCents,
      // The rows, as OrderSummary / MobileCTABar print them.
      subtotalCents: heldOrder.amountGrossCents,
      discountCents: p.totalDiscountCents,
      platformFeeRowCents: heldOrder.feesPlatformCents,
      processingRowCents: charge.processorFeeCents ?? 0,
      taxRowCents: charge.taxCents,
      feeWaivedNoteCents: feeWaivedCentsFor(heldOrder),
    };
  };

  /**
   * The held step in the moment after the buyer CHANGED the codes and before
   * the server has answered for the new ones: the page shows no discount
   * (the hook drops the old result at once), and beside it the cart's
   * no-discount fee from the last statement made for this cart
   * (`useCheckoutPromoPreview`'s `liveHeldCartFees`).
   */
  const heldStepBeforeTheAnswer = (
    order: PageOrder,
    lastWithoutDiscounts: {
      buyerPlatformFeeCents: number;
      platformFeeWaivedCents: number;
    } | null,
  ) => {
    const heldOrder = withStatedHeldFees(order, lastWithoutDiscounts, "PASS_THROUGH")!;
    const charge = estimateHeldOrderCharge(
      feeRates,
      { ...heldOrder, feeMode: "PASS_THROUGH" },
      0,
    )!;
    return {
      totalCents: charge.totalCents,
      subtotalCents: heldOrder.amountGrossCents,
      discountCents: 0,
      platformFeeRowCents: heldOrder.feesPlatformCents,
      processingRowCents: charge.processorFeeCents ?? 0,
      taxRowCents: charge.taxCents,
      feeWaivedNoteCents: feeWaivedCentsFor(heldOrder),
    };
  };

  const hold = async (): Promise<PageOrder> => {
    const held = await updateOrderItems(ctx.deps as never, {
      actorHumanId: ctx.defaults.buyerHumanId,
      eventId: ctx.defaults.eventId,
      items,
    });
    ownCarts.add(held.order.id);
    return held.order;
  };

  /** `createCheckout` from the held step, as "Continue to payment" calls it. */
  const charge = async (pendingOrderId: string, codes: string[]) => {
    attempt += 1;
    const data = await createCheckout(ctx.deps, {
      ...ctx.input,
      clientKey: `attempt-${attempt}`,
      items,
      pendingOrderId,
      ...(codes.length > 0 ? { promoCodes: codes } : {}),
    });
    const calls = ctx.mocks.payments.createPaymentIntent.mock
      .calls as unknown as Array<[{ amountCents: number }]>;
    // The cart the buyer now holds. Its fee-waiver reservation, if it has
    // one, is keyed by the id `reserve` was last called with.
    const cartId = ledger.reserve.mock.calls.at(-1)?.[0].orderId ?? data.orderId;
    ownCarts.add(cartId);
    ownCarts.add(data.orderId);
    return { data, cartId, piAmountCents: calls.at(-1)![0].amountCents };
  };

  /**
   * The held order after a declined card, WITHOUT a reload: the page's
   * reducer (`asHeldOrder`) keeps the hold's lines and gross and
   * createCheckout's fee figures.
   */
  const afterDecline = (
    held: PageOrder,
    charged: Awaited<ReturnType<typeof charge>>,
  ): PageOrder => ({
    ...held,
    id: charged.cartId,
    feesPlatformCents: charged.data.feesPlatformCents,
    buyerFeesCents: charged.data.buyerFeesCents,
    feeWaivedCents: charged.data.feeWaivedCents,
  });

  /**
   * The same cart after a RELOAD: the real `getActiveCartHolds` over the
   * order `createCheckout` saved, mapped as `useCheckoutState` maps it.
   */
  const afterReload = async (cartId: string): Promise<PageOrder> => {
    const saved = ctx.state.lastCreatePendingInput!;
    const { carts } = await getActiveCartHolds(
      {
        repos: {
          orders: {
            listPendingCarts: async () => ({
              items: [
                {
                  id: cartId,
                  eventId: ctx.defaults.eventId,
                  eventName: "Launch Party",
                  eventSlug: null,
                  eventStartsAt: null,
                  amountGrossCents: saved.amountGrossCents,
                  feesPlatformCents: saved.feesPlatformCents,
                  currency: "usd",
                  holdExpiresAt: null,
                  createdAt: ctx.defaults.now,
                  ticketSummary: [],
                  lines: saved.items.map((item) => ({
                    kind: item.kind,
                    amountCents: item.amountCents,
                    meta: item.meta ?? null,
                  })),
                },
              ],
            }),
          },
        },
        clock: ctx.deps.clock,
      } as never,
      { actorHumanId: ctx.defaults.buyerHumanId },
    );
    const cart = carts[0]!;
    return {
      id: cart.id,
      amountGrossCents: cart.preDiscountGrossCents,
      feesPlatformCents: cart.feesPlatformCents,
      buyerFeesCents: cart.buyerFeesCents,
      items: saved.items,
    };
  };

  return {
    ctx,
    ledger,
    feeRates,
    step1,
    heldStep,
    heldStepBeforeTheAnswer,
    hold,
    charge,
    afterDecline,
    afterReload,
  };
}

/** The rows the held summary prints add up to the total it prints. */
const rowsSum = (step: {
  subtotalCents: number;
  discountCents: number;
  platformFeeRowCents: number;
  processingRowCents: number;
  taxRowCents: number;
}) =>
  step.subtotalCents -
  step.discountCents +
  step.platformFeeRowCents +
  step.processingRowCents +
  step.taxRowCents;

describe("review scenario A: $30 + $50, a code makes the $50 ticket free (live fee shape, no tax)", () => {
  const WORLD: World = { label: "A", gaCents: 3000, policy: "live" };

  it("every step shows $31.72 and $31.72 is charged, the first time and after a decline", async () => {
    const t = await setUp(WORLD, VIP_FREE, { ga: 1, vip: 1 });

    // Step 1.
    const s1 = await t.step1(["VIPCODE"]);
    expect(s1.totalCents).toBe(3172);
    expect(s1.platformFeeCents).toBe(50);

    // Step 2, fresh hold. The hold itself still carries both fees.
    const held = await t.hold();
    expect(held.buyerFeesCents).toBe(100);
    const fresh = await t.heldStep(held, ["VIPCODE"]);
    expect(fresh.stated).toEqual({ buyerPlatformFeeCents: 50, platformFeeWaivedCents: 0 });
    expect(fresh.totalCents).toBe(3172);
    expect(fresh.platformFeeRowCents).toBe(50);
    expect(rowsSum(fresh)).toBe(fresh.totalCents);

    // The charge.
    const first = await t.charge(held.id, ["VIPCODE"]);
    expect(first.piAmountCents).toBe(3172);
    expect(first.data.buyerFeesCents).toBe(50);

    // Declined, no reload: the order now carries createCheckout's 50.
    const declined = t.afterDecline(held, first);
    expect(declined.buyerFeesCents).toBe(50);
    const backOnDetails = await t.heldStep(declined, ["VIPCODE"]);
    expect(backOnDetails.totalCents).toBe(3172);
    expect(backOnDetails.platformFeeRowCents).toBe(50);
    expect(rowsSum(backOnDetails)).toBe(backOnDetails.totalCents);

    // Declined, page reloaded: the cart on file, fee already 50, and the
    // pre-hold reduction for this cart is also 50. Subtracting one from the
    // other (the first design) showed $31.21.
    const reloaded = await t.afterReload(first.cartId);
    expect(reloaded.buyerFeesCents).toBe(50);
    expect(reloaded.amountGrossCents).toBe(8000);
    const resumed = await t.heldStep(reloaded, ["VIPCODE"]);
    expect(resumed.stated).toEqual({ buyerPlatformFeeCents: 50, platformFeeWaivedCents: 0 });
    expect(resumed.totalCents).toBe(3172);
    expect(rowsSum(resumed)).toBe(resumed.totalCents);

    const retry = await t.charge(first.cartId, ["VIPCODE"]);
    expect(retry.piAmountCents).toBe(3172);
  });

  it("the code taken off a cart that was already charged-for with it: the held step shows both fees again, as charged", async () => {
    const t = await setUp(WORLD, VIP_FREE, { ga: 1, vip: 1 });
    const held = await t.hold();
    const first = await t.charge(held.id, ["VIPCODE"]);
    const reloaded = await t.afterReload(first.cartId);
    // The cart on file says 50; with no code the charge takes 100.
    expect(reloaded.buyerFeesCents).toBe(50);
    const withoutCode = await t.heldStep(reloaded, []);
    expect(withoutCode.stated).toEqual({ buyerPlatformFeeCents: 100, platformFeeWaivedCents: 0 });
    const charged = await t.charge(first.cartId, []);
    expect(withoutCode.totalCents).toBe(charged.piAmountCents);
    expect(charged.data.buyerFeesCents).toBe(100);
    expect(rowsSum(withoutCode)).toBe(withoutCode.totalCents);
  });

  it("regression: the moment after the code is removed (no answer yet for the cart without it), the page already shows the full-price fee: the charge, not 51¢ under it", async () => {
    const t = await setUp(WORLD, VIP_FREE, { ga: 1, vip: 1 });
    const held = await t.hold();
    const first = await t.charge(held.id, ["VIPCODE"]);

    for (const [name, order] of [
      ["declined, no reload", t.afterDecline(held, first)],
      ["declined, reloaded", await t.afterReload(first.cartId)],
    ] as const) {
      // With the code on, the server stated 50 for this cart, and 100 for it
      // at full price.
      const withCode = await t.heldStep(order, ["VIPCODE"]);
      expect(withCode.stated, name).toEqual({ buyerPlatformFeeCents: 50, platformFeeWaivedCents: 0 });
      expect(withCode.withoutDiscounts, name).toEqual({ buyerPlatformFeeCents: 100, platformFeeWaivedCents: 0 });

      // Code removed, nothing back from the server yet.
      const between = t.heldStepBeforeTheAnswer(order, withCode.withoutDiscounts);
      expect(between.platformFeeRowCents, name).toBe(100);
      expect(rowsSum(between), name).toBe(between.totalCents);
      // And once it answers, the same figure.
      const answered = await t.heldStep(order, []);
      expect(between.totalCents, name).toBe(answered.totalCents);

      // What it showed without that figure: the order's own 50, beside the
      // full price. 51¢ under what the buyer is then charged:
      // (8000 + 50 + 30) / 0.971 = 8321.32, shown as 8322, against 8373.
      const unstated = t.heldStepBeforeTheAnswer(order, null);
      expect(unstated.platformFeeRowCents, name).toBe(50);
      expect(unstated.totalCents, name).toBe(8322);
      expect(between.totalCents - unstated.totalCents, name).toBe(51);
    }

    const charged = await t.charge(first.cartId, []);
    expect(charged.data.buyerFeesCents).toBe(100);
    const between = t.heldStepBeforeTheAnswer(
      t.afterDecline(held, first),
      { buyerPlatformFeeCents: 100, platformFeeWaivedCents: 0 },
    );
    expect(between.totalCents).toBe(charged.piAmountCents);
    // $80.00 + $1.00, grossed up for 2.9% + 30¢: 8130 / 0.971 = 8372.81.
    expect(charged.piAmountCents).toBe(8373);
  });

  it("what the page said before it was wired: the free ticket's fee and its processing, 52¢ over the charge", async () => {
    const t = await setUp(WORLD, VIP_FREE, { ga: 1, vip: 1 });
    const unwired = estimateCartTotal(
      t.feeRates,
      [
        { ticketTypeId: t.ctx.defaults.ticketTypeId, qty: 1, priceCents: 3000 },
        { ticketTypeId: VIP_ID, qty: 1, priceCents: VIP_FACE },
      ],
      { discountCents: 5000 },
    )!;
    expect(unwired.totalCents).toBe(3224);
    expect(unwired.platformFeeCents).toBe(100);
  });
});

describe("review scenario B: $50 VIP + 2 × $10 with ONE ticket of fee-waiver allowance, a code makes VIP free", () => {
  const WORLD: World = { label: "B", gaCents: 1000, policy: "live", allowance: 1 };

  it("the hold waives VIP's 50¢ (66¢ left); with the code the waiver moves to a $10 ticket: 33¢ shown, 33¢ charged", async () => {
    const t = await setUp(WORLD, VIP_FREE, { ga: 2, vip: 1 });

    const held = await t.hold();
    expect(held.buyerFeesCents).toBe(66);
    expect(feeWaivedCentsFor(held)).toBe(50);

    const fresh = await t.heldStep(held, ["VIPCODE"]);
    expect(fresh.stated).toEqual({ buyerPlatformFeeCents: 33, platformFeeWaivedCents: 33 });
    // At full price the waiver is back on VIP: the hold's own figures.
    expect(fresh.withoutDiscounts).toEqual({ buyerPlatformFeeCents: 66, platformFeeWaivedCents: 50 });
    expect(fresh.platformFeeRowCents).toBe(33);
    // The note says what the charge waives, not what the hold waived.
    expect(fresh.feeWaivedNoteCents).toBe(33);
    expect(rowsSum(fresh)).toBe(fresh.totalCents);
    // The statement reserved nothing.
    expect(t.ledger.waiver.ticketsUsed).toBe(0);

    const first = await t.charge(held.id, ["VIPCODE"]);
    expect(first.data.buyerFeesCents).toBe(33);
    expect(first.data.feeWaivedCents).toBe(33);
    expect(fresh.totalCents).toBe(first.piAmountCents);
    // $20.00 + 33¢, grossed up for 2.9% + 30¢.
    expect(first.piAmountCents).toBe(2125);

    // After a decline this cart holds the whole allowance (EXHAUSTED). The
    // next charge releases it first, so the statement still counts it.
    expect(t.ledger.waiver.status).toBe("EXHAUSTED");
    const reloaded = await t.afterReload(first.cartId);
    expect(reloaded.buyerFeesCents).toBe(33);
    const resumed = await t.heldStep(reloaded, ["VIPCODE"]);
    expect(resumed.totalCents).toBe(2125);
    const backOnDetails = await t.heldStep(t.afterDecline(held, first), ["VIPCODE"]);
    expect(backOnDetails.totalCents).toBe(2125);
    const retry = await t.charge(first.cartId, ["VIPCODE"]);
    expect(retry.piAmountCents).toBe(2125);
  });

  it("step 1 knows no waiver (it never has): it shows the charge or MORE, never less", async () => {
    const t = await setUp(WORLD, VIP_FREE, { ga: 2, vip: 1 });
    const s1 = await t.step1(["VIPCODE"]);
    // 33 + 33: the freed VIP fee is off, the waiver is not known yet.
    expect(s1.platformFeeCents).toBe(66);
    const held = await t.hold();
    const first = await t.charge(held.id, ["VIPCODE"]);
    expect(s1.totalCents).toBeGreaterThanOrEqual(first.piAmountCents);
    expect(s1.totalCents - first.piAmountCents).toBe(34);
  });
});

const WORLDS: Array<[World, Qty, { holdFee: number; chargedFee: number }]> = [
  [
    { label: "5% + 50¢, no tax", gaCents: 3000, policy: "fixed" },
    { ga: 1, vip: 1 },
    { holdFee: 500, chargedFee: 200 },
  ],
  [
    {
      label: "tax on the ticket face (IL 10.25%)",
      gaCents: 3000,
      policy: "fixed",
      taxBps: 1025,
      situs: { countryCode: "US", region: "IL", postalCode: "60601" },
    },
    { ga: 1, vip: 1 },
    { holdFee: 500, chargedFee: 200 },
  ],
  [
    {
      label: "tax on everything the buyer pays (TN 9.75%)",
      gaCents: 3000,
      policy: "fixed",
      taxBps: 975,
      situs: { countryCode: "US", region: "TN", postalCode: "37203" },
    },
    { ga: 1, vip: 1 },
    { holdFee: 500, chargedFee: 200 },
  ],
  [
    {
      label: "the live shape with buyer-total tax (TN)",
      gaCents: 3000,
      policy: "live",
      taxBps: 975,
      situs: { countryCode: "US", region: "TN", postalCode: "37203" },
    },
    { ga: 1, vip: 1 },
    { holdFee: 100, chargedFee: 50 },
  ],
  [
    // 200 + 300 capped at 250; with VIP free, the $30 ticket's own 200.
    { label: "an order fee cap the freed ticket lifts the cart under", gaCents: 3000, policy: "fixed", orderCapCents: 250 },
    { ga: 1, vip: 1 },
    { holdFee: 250, chargedFee: 200 },
  ],
  [
    // 200 + 200 + 300 capped at 250; with VIP free, 400 still capped at 250.
    { label: "an order fee cap the cart is still over", gaCents: 3000, policy: "fixed", orderCapCents: 250 },
    { ga: 2, vip: 1 },
    { holdFee: 250, chargedFee: 250 },
  ],
  [
    { label: "a policy row that still says ABSORB (priced as PASS_THROUGH)", gaCents: 3000, policy: "fixed", storedFeeMode: "ABSORB" },
    { ga: 1, vip: 1 },
    { holdFee: 500, chargedFee: 200 },
  ],
  [
    // Hold: 700 capped to 350 (100, 100, 150), the dearest waived: 200.
    // Charge: VIP free, 200 + 200 capped to 350 (175, 175), one waived: 175.
    { label: "a cap AND an allowance, with buyer-total tax (TN)", gaCents: 3000, policy: "fixed", orderCapCents: 350, allowance: 1, taxBps: 975, situs: { countryCode: "US", region: "TN", postalCode: "37203" } },
    { ga: 2, vip: 1 },
    { holdFee: 200, chargedFee: 175 },
  ],
];

describe.each(WORLDS)("the held step ⇄ the PaymentIntent: $label", (world, qty, pinned) => {
  it("a code that frees the VIP ticket: fresh hold, back from a decline, and reloaded all show the charge; rows add up", async () => {
    const t = await setUp(world, VIP_FREE, qty);
    const held = await t.hold();
    expect(held.buyerFeesCents).toBe(pinned.holdFee);

    const fresh = await t.heldStep(held, ["VIPCODE"]);
    const first = await t.charge(held.id, ["VIPCODE"]);
    expect(first.data.buyerFeesCents).toBe(pinned.chargedFee);
    expect(fresh.platformFeeRowCents).toBe(pinned.chargedFee);
    expect(fresh.totalCents).toBe(first.piAmountCents);
    expect(rowsSum(fresh)).toBe(fresh.totalCents);

    const backOnDetails = await t.heldStep(t.afterDecline(held, first), ["VIPCODE"]);
    const resumed = await t.heldStep(await t.afterReload(first.cartId), ["VIPCODE"]);
    const retry = await t.charge(first.cartId, ["VIPCODE"]);
    expect(retry.piAmountCents).toBe(first.piAmountCents);
    expect(backOnDetails.totalCents).toBe(retry.piAmountCents);
    expect(resumed.totalCents).toBe(retry.piAmountCents);
    expect(rowsSum(backOnDetails)).toBe(backOnDetails.totalCents);
    expect(rowsSum(resumed)).toBe(resumed.totalCents);
  });

  it("step 1 shows the charge too (or more, where only the hold can know a fee waiver)", async () => {
    const t = await setUp(world, VIP_FREE, qty);
    const s1 = await t.step1(["VIPCODE"]);
    const held = await t.hold();
    const first = await t.charge(held.id, ["VIPCODE"]);
    if (world.allowance) {
      expect(s1.totalCents).toBeGreaterThanOrEqual(first.piAmountCents);
    } else {
      expect(s1.totalCents).toBe(first.piAmountCents);
      expect(s1.platformFeeCents).toBe(pinned.chargedFee);
    }
  });

  it.each([
    ["half off the VIP ticket type", { kind: "PERCENT", value: 50, scope: "TICKET_TYPE" }],
    ["20% off the order", { kind: "PERCENT", value: 20, scope: "EVENT" }],
    ["$10 off the order", { kind: "AMOUNT", value: 1000, scope: "EVENT" }],
  ] as Array<[string, Promo]>)(
    "%s frees no ticket: the fee is the hold's own, at every step, and it is the charge's",
    async (_name, promo) => {
      const t = await setUp(world, promo, qty);
      const held = await t.hold();
      const fresh = await t.heldStep(held, ["VIPCODE"]);
      // No ticket reaches $0: the statement is the fee the hold already had.
      expect(fresh.platformFeeRowCents).toBe(held.buyerFeesCents);
      const first = await t.charge(held.id, ["VIPCODE"]);
      expect(first.data.buyerFeesCents).toBe(held.buyerFeesCents);
      expect(fresh.totalCents).toBe(first.piAmountCents);
      const resumed = await t.heldStep(await t.afterReload(first.cartId), ["VIPCODE"]);
      expect(resumed.totalCents).toBe(first.piAmountCents);
      expect(rowsSum(resumed)).toBe(resumed.totalCents);
    },
  );

  it("no code at all: nothing here moved (the statement is the hold's fee)", async () => {
    const t = await setUp(world, null, qty);
    const held = await t.hold();
    const fresh = await t.heldStep(held, []);
    expect(fresh.platformFeeRowCents).toBe(held.buyerFeesCents);
    const first = await t.charge(held.id, []);
    expect(fresh.totalCents).toBe(first.piAmountCents);
  });
});

describe("the free ticket adds nothing to a paid cart", () => {
  it.each([
    ["100% off the VIP ticket type", VIP_FREE],
    ["$50 off the VIP ticket type", { kind: "AMOUNT", value: 5000, scope: "TICKET_TYPE" }],
  ] as Array<[string, Promo]>)(
    "%s: the charge is the $30 ticket's alone, fee, tax and processing (TN, 5% + 50¢)",
    async (_name, promo) => {
      const world: World = {
        label: "TN",
        gaCents: 3000,
        policy: "fixed",
        taxBps: 975,
        situs: { countryCode: "US", region: "TN", postalCode: "37203" },
      };
      const mixed = await setUp(world, promo, { ga: 1, vip: 1 });
      const alone = await setUp(world, null, { ga: 1, vip: 0 });
      const mixedHeld = await mixed.hold();
      const aloneHeld = await alone.hold();
      const mixedStep = await mixed.heldStep(mixedHeld, ["VIPCODE"]);
      const aloneStep = await alone.heldStep(aloneHeld, []);
      const mixedCharge = await mixed.charge(mixedHeld.id, ["VIPCODE"]);
      const aloneCharge = await alone.charge(aloneHeld.id, []);

      expect(mixedCharge.piAmountCents).toBe(aloneCharge.piAmountCents);
      // $30.00 + $2.00 fee, TN tax on the buyer total, grossed up: $36.62.
      expect(mixedCharge.piAmountCents).toBe(3662);
      expect(mixedStep.platformFeeRowCents).toBe(aloneStep.platformFeeRowCents);
      expect(mixedStep.taxRowCents).toBe(aloneStep.taxRowCents);
      expect(mixedStep.processingRowCents).toBe(aloneStep.processingRowCents);
      expect((await mixed.step1(["VIPCODE"])).totalCents).toBe(3662);
    },
  );

  it("several of each: three free VIP tickets beside two paid ones cost what the two cost", async () => {
    const world: World = { label: "live", gaCents: 3000, policy: "live" };
    const mixed = await setUp(world, VIP_FREE, { ga: 2, vip: 3 });
    const alone = await setUp(world, null, { ga: 2, vip: 0 });
    const mixedHeld = await mixed.hold();
    expect(mixedHeld.buyerFeesCents).toBe(250);
    const step = await mixed.heldStep(mixedHeld, ["VIPCODE"]);
    expect(step.platformFeeRowCents).toBe(100);
    const mixedCharge = await mixed.charge(mixedHeld.id, ["VIPCODE"]);
    const aloneCharge = await alone.charge((await alone.hold()).id, []);
    expect(step.totalCents).toBe(mixedCharge.piAmountCents);
    expect(mixedCharge.piAmountCents).toBe(aloneCharge.piAmountCents);
  });
});

describe("a code that makes the whole order free", () => {
  it("no fee at any step, and the page quotes $0", async () => {
    const world: World = { label: "free", gaCents: 3000, policy: "fixed", taxBps: 975, situs: { countryCode: "US", region: "TN", postalCode: "37203" } };
    const t = await setUp(world, { kind: "PERCENT", value: 100, scope: "EVENT" }, { ga: 1, vip: 1 });
    const s1 = await t.step1(["VIPCODE"]);
    expect(s1.totalCents).toBe(0);
    expect(s1.platformFeeCents).toBe(0);
    const held = await t.hold();
    const step = await t.heldStep(held, ["VIPCODE"]);
    expect(step.stated).toEqual({ buyerPlatformFeeCents: 0, platformFeeWaivedCents: 0 });
    expect(step.totalCents).toBe(0);
  });
});

describe("no statement from the server", () => {
  it("the order is left exactly as it is: a fresh hold then shows its own fee, which is the charge's or MORE", async () => {
    const t = await setUp({ label: "A", gaCents: 3000, policy: "live" }, VIP_FREE, { ga: 1, vip: 1 });
    const held = await t.hold();
    // What the page shows while the preview has not answered for the held
    // cart: the previous (pre-hold) answer, which states no held fee.
    expect(withStatedHeldFees(held, null, "PASS_THROUGH")).toBe(held);
    const noStatement = estimateHeldOrderCharge(
      t.feeRates,
      { ...held, feeMode: "PASS_THROUGH" },
      5000,
    )!;
    const first = await t.charge(held.id, ["VIPCODE"]);
    expect(noStatement.totalCents).toBe(3224);
    expect(noStatement.totalCents).toBeGreaterThan(first.piAmountCents);
  });
});
