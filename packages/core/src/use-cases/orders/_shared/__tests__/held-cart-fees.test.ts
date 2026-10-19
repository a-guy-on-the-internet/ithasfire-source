import { describe, expect, it, vi } from "vitest";

import { fail } from "@th/errors";
import type { Repos } from "@th/ports/repos";

import type { TicketDiscount } from "../../../../lib/orders/discounted-to-zero";
import {
  aggregateItems,
  computeOrderAmounts,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "../../checkout-helpers";
import { quoteHeldCartFees } from "../held-cart-fees";

/**
 * `quoteHeldCartFees`: the platform fee the charge will take for the buyer's
 * held cart with a set of discounts, stated as the fee itself.
 *
 * These pin the function against `computeOrderAmounts` (the charge's own
 * arithmetic) and pin its edges: which fee-waiver reservations it counts,
 * what it answers for a cart the charge would refuse, and what it does with a
 * fault. The whole chain against the real `createCheckout` (fresh hold, a
 * cart back from a decline, a reloaded cart) is
 * `apps/web/src/lib/pricing/promo-to-zero-create-checkout.test.ts`.
 *
 * Owner rulings 2026-10-10: a $0 ticket pays no fee, and neither does a
 * ticket a promo brings down to $0.
 */

const EVENT = {
  id: "00000000-0000-4000-8000-0000000000e1",
  orgId: "00000000-0000-4000-8000-0000000000a1",
  humanId: null,
};
const BUYER = "00000000-0000-4000-8000-0000000000b1";
const CART = "00000000-0000-4000-8000-0000000000c1";
const GA = "00000000-0000-4000-8000-0000000000a2";
const VIP = "00000000-0000-4000-8000-0000000000a3";
const SEATED = "00000000-0000-4000-8000-0000000000a4";
const SECTION = "00000000-0000-4000-8000-0000000000d1";
const SEAT_A = "00000000-0000-4000-8000-0000000000d2";
const SEAT_B = "00000000-0000-4000-8000-0000000000d3";
const NOW = new Date("2026-04-26T20:00:00Z");

/** The live GLOBAL policy's shape: 3.33% capped at 50¢ a ticket. */
const POLICY = {
  id: "policy-1",
  version: 7,
  scopeType: "GLOBAL",
  scopeId: null,
  status: "ACTIVE",
  feeMode: "PASS_THROUGH",
  buyerFeePct: 0.0333,
  maxFeeCents: 50,
  minFeeCents: 0,
  platformFixedCents: 0,
  maxPlatformFeeCents: null as number | null,
  processsorFeePct: 0.029,
  processorFixedCents: 30,
  payoutPct: 0,
  payoutFixedCents: 0,
  monthlyPayoutCents: 0,
};
const TERMS = {
  id: "terms-1",
  kind: "PRIMARY",
  status: "ACTIVE",
  feeMode: "PASS_THROUGH",
  feePolicyId: POLICY.id,
  version: 1,
};
const LINES = [
  {
    id: "line-1",
    agreementId: TERMS.id,
    payeeId: "payee-1",
    percent: 100,
    floorCents: 0,
    capPercent: null,
    priority: 0,
    rounding: "FLOOR",
  },
];

const tier = (id: string, priceCents: number, extra: object = {}) => ({
  id,
  priceCents,
  status: "ACTIVE",
  pricingMode: "FIXED" as const,
  minimumCents: null,
  seatSectionId: null as string | null,
  scheduledPriceCents: null,
  scheduledPriceAt: null,
  salesOpenAt: null as Date | null,
  salesCloseAt: null as Date | null,
  ...extra,
});
/** $10 GA (fee 33¢), $50 VIP (fee 50¢), a $20 seated tier (fee 50¢). */
const TICKET_TYPES = [
  tier(GA, 1000),
  tier(VIP, 5000),
  tier(SEATED, 2000, { seatSectionId: SECTION }),
];

type Waiver = {
  id: string;
  side: "ORGANIZER" | "BUYER";
  subjectType: "ORG" | "HUMAN";
  subjectId: string;
  ticketsGranted: number;
  ticketsUsed: number;
  status: "ACTIVE" | "EXHAUSTED" | "REVOKED";
  effectiveFrom: Date;
  effectiveTo: Date | null;
};
const orgWaiver = (overrides: Partial<Waiver> = {}): Waiver => ({
  id: "waiver-1",
  side: "ORGANIZER",
  subjectType: "ORG",
  subjectId: EVENT.orgId,
  ticketsGranted: 1,
  ticketsUsed: 0,
  status: "ACTIVE",
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveTo: null,
  ...overrides,
});

type Redemption = {
  waiverId: string;
  ticketsReserved: number;
  status: "RESERVED" | "SETTLED" | "RELEASED";
};

function makeRepos(world: {
  waivers?: Waiver[];
  /** What the cart being quoted has reserved. */
  ownRedemptions?: Redemption[];
  policy?: typeof POLICY;
}) {
  const waivers = world.waivers ?? [];
  const feeWaivers = {
    // The adapter's filter: ACTIVE, has headroom, in window.
    resolveApplicable: vi.fn(async () =>
      waivers.filter(
        (waiver) =>
          waiver.status === "ACTIVE" &&
          waiver.ticketsUsed < waiver.ticketsGranted &&
          waiver.effectiveFrom <= NOW &&
          (waiver.effectiveTo === null || waiver.effectiveTo > NOW),
      ),
    ),
    listRedemptionsByOrder: vi.fn(async (orderId: string) =>
      orderId === CART ? (world.ownRedemptions ?? []) : [],
    ),
    getById: vi.fn(
      async (id: string) => waivers.find((waiver) => waiver.id === id) ?? null,
    ),
    reserve: vi.fn(),
    release: vi.fn(),
  };
  const repos = {
    events: { getById: vi.fn(async () => EVENT) },
    payoutTerms: {
      listByEvent: vi.fn(async () => [TERMS]),
      listLines: vi.fn(async () => LINES),
    },
    feePolicies: { getById: vi.fn(async () => world.policy ?? POLICY) },
    feeWaivers,
  };
  return { repos: repos as unknown as Repos, fakes: repos };
}

type Selection = { ticketTypeId: string; qty: number; seatIds?: string[] };

const CART_B: Selection[] = [
  { ticketTypeId: GA, qty: 2 },
  { ticketTypeId: VIP, qty: 1 },
];
const VIP_FREE: TicketDiscount[] = [{ discountCents: 5000, ticketTypeId: VIP }];

function quote(
  world: Parameters<typeof makeRepos>[0],
  cart: {
    selections?: Selection[];
    discounts?: TicketDiscount[];
    totalDiscountCents?: number;
    seatOverrides?: Map<string, number | null>;
    ticketTypes?: typeof TICKET_TYPES;
    buyerHumanId?: string | null;
    event?: { id: string; orgId: string | null; humanId: string | null };
  } = {},
) {
  const { repos, fakes } = makeRepos(world);
  const reportError = vi.fn();
  const discounts = cart.discounts ?? [];
  const full = quoteHeldCartFees(
    { repos, reportError },
    {
      event: cart.event ?? EVENT,
      buyerHumanId: cart.buyerHumanId === undefined ? BUYER : cart.buyerHumanId,
      heldOrderId: CART,
      selections: cart.selections ?? CART_B,
      ticketTypes: cart.ticketTypes ?? TICKET_TYPES,
      seatOverrides: cart.seatOverrides ?? new Map(),
      discounts,
      totalDiscountCents:
        cart.totalDiscountCents ??
        discounts.reduce((sum, discount) => sum + discount.discountCents, 0),
      now: NOW,
      useCase: "test",
    },
  );
  // `promise`: the fee for the cart with its discounts (what most tests
  // read). `full`: the whole statement, `withoutDiscounts` included.
  const promise = full.then((fees) =>
    fees
      ? {
          buyerPlatformFeeCents: fees.buyerPlatformFeeCents,
          platformFeeWaivedCents: fees.platformFeeWaivedCents,
        }
      : null,
  );
  return { promise, full, reportError, fakes, repos };
}

/** The charge's own arithmetic for the same cart, discounts and waiver count. */
function charged(
  selections: Selection[],
  discounts: TicketDiscount[],
  waivedTickets: number,
  policy = POLICY,
  seatPrices: Map<string, number | null> = new Map(),
) {
  const ticketTypes = new Map<string, TicketTypeSummary>(
    TICKET_TYPES.map((type) => [type.id, type as unknown as TicketTypeSummary]),
  );
  const computation = computeOrderAmounts(
    aggregateItems(selections),
    ticketTypes,
    { agreement: TERMS, lines: LINES, feePolicy: policy } as unknown as PayoutTermsContext,
    {
      now: NOW,
      seatPrices,
      ...(discounts.length > 0 ? { discounts } : {}),
      ...(waivedTickets > 0 ? { waivedTickets } : {}),
    },
  );
  return {
    buyerPlatformFeeCents: computation.buyerFeesCents,
    platformFeeWaivedCents: computation.feesWaivedCents,
  };
}

describe("quoteHeldCartFees: the fee, as the charge computes it", () => {
  it("no discount, no allowance: every ticket's fee (33 + 33 + 50)", async () => {
    const fees = await quote({}).promise;
    expect(fees).toEqual({ buyerPlatformFeeCents: 116, platformFeeWaivedCents: 0 });
    expect(fees).toEqual(charged(CART_B, [], 0));
  });

  it("a discount that brings VIP to $0: its fee is not in the statement (33 + 33)", async () => {
    const fees = await quote({}, { discounts: VIP_FREE }).promise;
    expect(fees).toEqual({ buyerPlatformFeeCents: 66, platformFeeWaivedCents: 0 });
    expect(fees).toEqual(charged(CART_B, VIP_FREE, 0));
  });

  it("one ticket of free allowance, no discount: the dearest fee (VIP's 50) is waived", async () => {
    const fees = await quote({ waivers: [orgWaiver()] }).promise;
    expect(fees).toEqual({ buyerPlatformFeeCents: 66, platformFeeWaivedCents: 50 });
    expect(fees).toEqual(charged(CART_B, [], 1));
  });

  it("review scenario B: the allowance AND the discount. VIP is free, so the waiver takes a $10 ticket's 33: 33 left, not 66 − 50", async () => {
    const fees = await quote({ waivers: [orgWaiver()] }, { discounts: VIP_FREE })
      .promise;
    expect(fees).toEqual({ buyerPlatformFeeCents: 33, platformFeeWaivedCents: 33 });
    expect(fees).toEqual(charged(CART_B, VIP_FREE, 1));
  });

  it("never waives more tickets than still carry a fee, however large the allowance", async () => {
    const fees = await quote(
      { waivers: [orgWaiver({ ticketsGranted: 50 })] },
      { discounts: VIP_FREE },
    ).promise;
    expect(fees).toEqual({ buyerPlatformFeeCents: 0, platformFeeWaivedCents: 66 });
  });

  it("an order-level fee cap is applied before the waiver, as on the charge", async () => {
    const policy = { ...POLICY, maxFeeCents: null, platformFixedCents: 50, buyerFeePct: 0.05, maxPlatformFeeCents: 250 };
    const fees = await quote(
      { waivers: [orgWaiver()], policy },
      { discounts: VIP_FREE },
    ).promise;
    // 2 × (50 + 50) = 200 once VIP is free: under the cap; one waived.
    expect(fees).toEqual({ buyerPlatformFeeCents: 100, platformFeeWaivedCents: 100 });
    expect(fees).toEqual(charged(CART_B, VIP_FREE, 1, policy));
  });

  it("a seat with a price override is priced at the override, and a discount that clears it frees its fee", async () => {
    const selections = [{ ticketTypeId: SEATED, qty: 2, seatIds: [SEAT_A, SEAT_B] }];
    const seatOverrides = new Map<string, number | null>([[SEAT_A, 900]]);
    // SEAT_A at $9.00 (fee 30), SEAT_B at the tier's $20.00 (fee 50).
    const plain = await quote({}, { selections, seatOverrides }).promise;
    expect(plain).toEqual({ buyerPlatformFeeCents: 80, platformFeeWaivedCents: 0 });
    // An order-wide $28.99 leaves one cent, on one seat; the other is free.
    const discounts = [{ discountCents: 2899, ticketTypeId: null }];
    const fees = await quote({}, { selections, seatOverrides, discounts }).promise;
    expect(fees).toEqual(
      charged(
        selections,
        discounts,
        0,
        POLICY,
        new Map<string, number | null>([
          [SEAT_A, 900],
          [SEAT_B, null],
        ]),
      ),
    );
    expect(fees!.buyerPlatformFeeCents).toBeLessThan(80);
  });

  it("a free order (the discounts cover every ticket) carries no fee, whatever the allowance", async () => {
    const run = quote(
      { waivers: [orgWaiver()] },
      { discounts: [{ discountCents: 7000, ticketTypeId: null }] },
    );
    expect(await run.promise).toEqual({
      buyerPlatformFeeCents: 0,
      platformFeeWaivedCents: 0,
    });
  });

  it("reserves and releases nothing", async () => {
    const run = quote({ waivers: [orgWaiver()] }, { discounts: VIP_FREE });
    await run.promise;
    expect(run.fakes.feeWaivers.reserve).not.toHaveBeenCalled();
    expect(run.fakes.feeWaivers.release).not.toHaveBeenCalled();
  });
});

describe("quoteHeldCartFees: withoutDiscounts, the same cart with no discount at all", () => {
  // What the page shows beside "no discount" while it has no statement for a
  // changed set of codes. It must not depend on the codes.
  it("no discount: the same two figures twice", async () => {
    expect(await quote({ waivers: [orgWaiver()] }).full).toEqual({
      buyerPlatformFeeCents: 66,
      platformFeeWaivedCents: 50,
      withoutDiscounts: { buyerPlatformFeeCents: 66, platformFeeWaivedCents: 50 },
    });
  });

  it("a freeing discount: the statement drops VIP's fee, withoutDiscounts keeps it (116)", async () => {
    const fees = await quote({}, { discounts: VIP_FREE }).full;
    expect(fees).toEqual({
      buyerPlatformFeeCents: 66,
      platformFeeWaivedCents: 0,
      withoutDiscounts: { buyerPlatformFeeCents: 116, platformFeeWaivedCents: 0 },
    });
    expect(fees!.withoutDiscounts).toEqual(charged(CART_B, [], 0));
  });

  it("review scenario B: 33 with the code, 66 (VIP's 50 waived) without it, as the charge prices each", async () => {
    const fees = await quote({ waivers: [orgWaiver()] }, { discounts: VIP_FREE })
      .full;
    expect(fees).toEqual({
      buyerPlatformFeeCents: 33,
      platformFeeWaivedCents: 33,
      withoutDiscounts: { buyerPlatformFeeCents: 66, platformFeeWaivedCents: 50 },
    });
    expect(fees!.withoutDiscounts).toEqual(charged(CART_B, [], 1));
  });

  it.each([
    ["a freeing code", VIP_FREE],
    ["a partial code", [{ discountCents: 1000, ticketTypeId: null }]],
    ["a code that makes the whole order free", [{ discountCents: 7000, ticketTypeId: null }]],
  ] as Array<[string, TicketDiscount[]]>)(
    "does not depend on the codes: %s",
    async (_name, discounts) => {
      const none = await quote({ waivers: [orgWaiver()] }).full;
      const withCodes = await quote({ waivers: [orgWaiver()] }, { discounts }).full;
      expect(withCodes!.withoutDiscounts).toEqual(none!.withoutDiscounts);
    },
  );

  it("a free order still states the no-discount fee (the code can be removed)", async () => {
    expect(
      await quote({}, { discounts: [{ discountCents: 7000, ticketTypeId: null }] })
        .full,
    ).toEqual({
      buyerPlatformFeeCents: 0,
      platformFeeWaivedCents: 0,
      withoutDiscounts: { buyerPlatformFeeCents: 116, platformFeeWaivedCents: 0 },
    });
  });

  it("counts the allowance this cart itself holds, like the statement", async () => {
    const fees = await quote(
      {
        waivers: [orgWaiver({ ticketsUsed: 1, status: "EXHAUSTED" })],
        ownRedemptions: [
          { waiverId: "waiver-1", ticketsReserved: 1, status: "RESERVED" },
        ],
      },
      { discounts: VIP_FREE },
    ).full;
    expect(fees!.withoutDiscounts).toEqual({
      buyerPlatformFeeCents: 66,
      platformFeeWaivedCents: 50,
    });
  });

  it("is not a ceiling: a tiny order cap with a waiver can leave MORE fee once the dearest ticket is free", async () => {
    // Order cap 15¢, one ticket of allowance. Undiscounted, the capped 15¢
    // sits almost all on VIP and the waiver takes it. With VIP free the cap
    // spreads over the two $10 tickets and the waiver takes only one share.
    // Each figure is the charge's own; they are shown one or the other.
    const policy = {
      ...POLICY,
      maxFeeCents: null,
      platformFixedCents: 50,
      buyerFeePct: 0.05,
      maxPlatformFeeCents: 15,
    };
    const fees = await quote(
      { waivers: [orgWaiver()], policy },
      { discounts: VIP_FREE },
    ).full;
    expect(fees).toEqual({
      ...charged(CART_B, VIP_FREE, 1, policy),
      withoutDiscounts: charged(CART_B, [], 1, policy),
    });
    expect(fees!.buyerPlatformFeeCents).toBeGreaterThan(
      fees!.withoutDiscounts.buyerPlatformFeeCents,
    );
  });
});

describe("quoteHeldCartFees: the allowance this cart itself holds", () => {
  // The cart has been to `createCheckout` once: it reserved the organiser's
  // one ticket of allowance, which is now EXHAUSTED and so absent from
  // `resolveApplicable`. The next charge releases it before it looks.
  const exhausted = orgWaiver({ ticketsUsed: 1, status: "EXHAUSTED" });
  const reserved: Redemption[] = [
    { waiverId: "waiver-1", ticketsReserved: 1, status: "RESERVED" },
  ];

  it("counts its own RESERVED tickets on an allowance its reservation exhausted: 33, as the retry is charged", async () => {
    const fees = await quote(
      { waivers: [exhausted], ownRedemptions: reserved },
      { discounts: VIP_FREE },
    ).promise;
    expect(fees).toEqual({ buyerPlatformFeeCents: 33, platformFeeWaivedCents: 33 });
  });

  it("without that count the same cart would be quoted 66 (the allowance looks spent)", async () => {
    const fees = await quote({ waivers: [exhausted] }, { discounts: VIP_FREE })
      .promise;
    expect(fees).toEqual({ buyerPlatformFeeCents: 66, platformFeeWaivedCents: 0 });
  });

  it("adds its own reservation to what is still free on the allowance", async () => {
    const fees = await quote(
      {
        waivers: [orgWaiver({ ticketsGranted: 2, ticketsUsed: 1 })],
        ownRedemptions: reserved,
      },
      { discounts: VIP_FREE },
    ).promise;
    // One free + one of its own: both $10 tickets waived.
    expect(fees).toEqual({ buyerPlatformFeeCents: 0, platformFeeWaivedCents: 66 });
  });

  it.each([
    ["a RELEASED redemption", { ownRedemptions: [{ ...reserved[0]!, status: "RELEASED" as const }], waivers: [exhausted] }],
    ["a SETTLED redemption (not this pending cart's to get back)", { ownRedemptions: [{ ...reserved[0]!, status: "SETTLED" as const }], waivers: [exhausted] }],
    ["an allowance since REVOKED", { ownRedemptions: reserved, waivers: [{ ...exhausted, status: "REVOKED" as const }] }],
    ["an allowance whose window has closed", { ownRedemptions: reserved, waivers: [{ ...exhausted, effectiveTo: new Date("2026-04-26T19:00:00Z") }] }],
    ["an allowance not yet in effect", { ownRedemptions: reserved, waivers: [{ ...exhausted, effectiveFrom: new Date("2026-05-01T00:00:00Z") }] }],
    ["an allowance that no longer exists", { ownRedemptions: reserved, waivers: [] }],
    ["an allowance granted to another organiser", { ownRedemptions: reserved, waivers: [{ ...exhausted, subjectId: "00000000-0000-4000-8000-0000000000ff" }] }],
    ["a buyer allowance granted to someone else", { ownRedemptions: reserved, waivers: [{ ...exhausted, side: "BUYER" as const, subjectType: "HUMAN" as const, subjectId: "00000000-0000-4000-8000-0000000000fe" }] }],
  ])("does NOT count %s: the fee is quoted higher (66), never lower", async (_name, world) => {
    const fees = await quote(world, { discounts: VIP_FREE }).promise;
    expect(fees).toEqual({ buyerPlatformFeeCents: 66, platformFeeWaivedCents: 0 });
  });

  it("counts the buyer's own allowance, and an organiser-human's when the event has no org", async () => {
    const buyerOwn = await quote(
      {
        ownRedemptions: reserved,
        waivers: [{ ...exhausted, side: "BUYER", subjectType: "HUMAN", subjectId: BUYER }],
      },
      { discounts: VIP_FREE },
    ).promise;
    expect(buyerOwn!.buyerPlatformFeeCents).toBe(33);

    const organiserHuman = "00000000-0000-4000-8000-0000000000aa";
    const noOrg = await quote(
      {
        ownRedemptions: reserved,
        waivers: [{ ...exhausted, subjectType: "HUMAN", subjectId: organiserHuman }],
      },
      {
        discounts: VIP_FREE,
        event: { id: EVENT.id, orgId: null, humanId: organiserHuman },
      },
    ).promise;
    expect(noOrg!.buyerPlatformFeeCents).toBe(33);
  });

  it("a fault reading the cart's reservation is reported and counts none: quoted higher, never lower", async () => {
    const { repos, fakes } = makeRepos({ waivers: [exhausted], ownRedemptions: reserved });
    const boom = new Error("redemptions read failed");
    fakes.feeWaivers.listRedemptionsByOrder.mockRejectedValue(boom);
    const reportError = vi.fn();
    const fees = await quoteHeldCartFees(
      { repos, reportError },
      {
        event: EVENT,
        buyerHumanId: BUYER,
        heldOrderId: CART,
        selections: CART_B,
        ticketTypes: TICKET_TYPES,
        seatOverrides: new Map(),
        discounts: VIP_FREE,
        totalDiscountCents: 5000,
        now: NOW,
        useCase: "previewPromos",
      },
    );
    // No reservation counted, so no waiver, with the code or without it:
    // 33 + 33 with VIP free, 33 + 33 + 50 at full price.
    expect(fees).toEqual({
      buyerPlatformFeeCents: 66,
      platformFeeWaivedCents: 0,
      withoutDiscounts: { buyerPlatformFeeCents: 116, platformFeeWaivedCents: 0 },
    });
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: { useCase: "previewPromos", step: "ownFeeWaiverReservation" },
      }),
    );
  });
});

describe("quoteHeldCartFees: no statement", () => {
  it.each([
    [
      "a tier whose sales have closed",
      { ticketTypes: [tier(GA, 1000, { salesCloseAt: new Date("2026-04-01T00:00:00Z") }), TICKET_TYPES[1]!, TICKET_TYPES[2]!] },
    ],
    [
      "a tier that is no longer ACTIVE",
      { ticketTypes: [tier(GA, 1000, { status: "ARCHIVED" }), TICKET_TYPES[1]!, TICKET_TYPES[2]!] },
    ],
    [
      "seats that do not cover the quantity",
      { selections: [{ ticketTypeId: SEATED, qty: 2, seatIds: [SEAT_A] }] },
    ],
    [
      "a pay-what-you-want line with no amount",
      { ticketTypes: [tier(GA, 0, { pricingMode: "ADJUSTABLE", minimumCents: 500 }), TICKET_TYPES[1]!, TICKET_TYPES[2]!] },
    ],
  ])("a cart the charge would refuse (%s): null, and NOT reported", async (_name, cart) => {
    const run = quote({}, cart as never);
    expect(await run.promise).toBeNull();
    expect(run.reportError).not.toHaveBeenCalled();
  });

  it("no primary payout terms (the charge refuses the event): null, not reported", async () => {
    const { repos, fakes } = makeRepos({});
    fakes.payoutTerms.listByEvent.mockResolvedValue([]);
    const reportError = vi.fn();
    const fees = await quoteHeldCartFees(
      { repos, reportError },
      {
        event: EVENT,
        buyerHumanId: BUYER,
        heldOrderId: CART,
        selections: CART_B,
        ticketTypes: TICKET_TYPES,
        seatOverrides: new Map(),
        discounts: [],
        totalDiscountCents: 0,
        now: NOW,
        useCase: "test",
      },
    );
    expect(fees).toBeNull();
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([
    ["a read that throws", new Error("payout terms read failed")],
    ["an internal invariant", (() => { try { fail("INTERNAL", { message: "rounding_invariant" }); } catch (err) { return err; } })()],
    ["a legacy internal throw", { code: "internal", message: "rounding_invariant" }],
  ])("a FAULT (%s) is reported once and answers null; it never throws", async (_name, fault) => {
    const { repos, fakes } = makeRepos({});
    fakes.payoutTerms.listByEvent.mockRejectedValue(fault);
    const reportError = vi.fn();
    const logger = { error: vi.fn() };
    const fees = await quoteHeldCartFees(
      { repos, reportError, logger: logger as never },
      {
        event: EVENT,
        buyerHumanId: BUYER,
        heldOrderId: CART,
        selections: CART_B,
        ticketTypes: TICKET_TYPES,
        seatOverrides: new Map(),
        discounts: VIP_FREE,
        totalDiscountCents: 5000,
        now: NOW,
        useCase: "previewPromos",
      },
    );
    expect(fees).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      fault,
      expect.objectContaining({
        tags: { useCase: "previewPromos", step: "quoteHeldCartFees" },
        extra: { eventId: EVENT.id, orderId: CART },
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "held_cart_fee_quote_failed",
      expect.objectContaining({ err: fault }),
    );
  });

  it("a reporter that throws changes nothing: still null, still no throw", async () => {
    const { repos, fakes } = makeRepos({});
    fakes.payoutTerms.listByEvent.mockRejectedValue(new Error("down"));
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(
      quoteHeldCartFees(
        { repos, reportError },
        {
          event: EVENT,
          buyerHumanId: BUYER,
          heldOrderId: CART,
          selections: CART_B,
          ticketTypes: TICKET_TYPES,
          seatOverrides: new Map(),
          discounts: [],
          totalDiscountCents: 0,
          now: NOW,
          useCase: "test",
        },
      ),
    ).resolves.toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("with no reporter wired a fault still answers null", async () => {
    const { repos, fakes } = makeRepos({});
    fakes.payoutTerms.listByEvent.mockRejectedValue(new Error("down"));
    await expect(
      quoteHeldCartFees(
        { repos },
        {
          event: EVENT,
          buyerHumanId: BUYER,
          heldOrderId: CART,
          selections: CART_B,
          ticketTypes: TICKET_TYPES,
          seatOverrides: new Map(),
          discounts: [],
          totalDiscountCents: 0,
          now: NOW,
          useCase: "test",
        },
      ),
    ).resolves.toBeNull();
  });
});
