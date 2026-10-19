import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";

import { quoteHeldCartFees } from "../../orders/_shared/held-cart-fees";
import { previewPromos } from "../preview-promos";

/**
 * `promos.preview` states the held cart's platform fee (`heldCartFees`) only
 * for the buyer's OWN pending cart on this event. The statement reads that
 * cart's fee-waiver reservation, so the gate is what keeps it from ever being
 * computed over someone else's order: the id is client-supplied.
 *
 * `quoteHeldCartFees` itself is covered in
 * `orders/_shared/__tests__/held-cart-fees.test.ts`, and the whole chain
 * (hold, preview, charge) against the real use cases in
 * `apps/web/src/lib/pricing/promo-to-zero-create-checkout.test.ts`. Here it
 * is replaced, so these tests see only whether the preview asks for it, with
 * what, and what it does with the answer.
 */
vi.mock("../../orders/_shared/held-cart-fees", () => ({
  quoteHeldCartFees: vi.fn(),
}));

const quote = vi.mocked(quoteHeldCartFees);

const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const OTHER_EVENT_ID = "00000000-0000-4000-8000-0000000000e2";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const GA = "00000000-0000-4000-8000-0000000000a2";
const VIP = "00000000-0000-4000-8000-0000000000a3";
const BUYER = "00000000-0000-4000-8000-0000000000c1";
const STRANGER = "00000000-0000-4000-8000-0000000000c2";
const ORDER_ID = "00000000-0000-4000-8000-0000000000d1";
const NOW = new Date("2026-04-26T20:00:00Z");

const STATED = {
  buyerPlatformFeeCents: 200,
  platformFeeWaivedCents: 0,
  withoutDiscounts: { buyerPlatformFeeCents: 500, platformFeeWaivedCents: 0 },
};

type OrderRow = { buyerHumanId: string; eventId: string; status: string } | null;

function makeRepos(order: OrderRow) {
  const tier = {
    pricingMode: "FIXED" as const,
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    status: "ACTIVE" as const,
    seatSectionId: null,
  };
  const getById = vi.fn(async () => order);
  const repos = {
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        currency: "usd",
      })),
      listTicketTypes: vi.fn(async () => [
        { ...tier, id: GA, name: "GA", priceCents: 3000 },
        { ...tier, id: VIP, name: "VIP", priceCents: 5000 },
      ]),
    },
    orders: { getById },
    promos: {
      findActiveByCodes: vi.fn(async () => [
        {
          id: "00000000-0000-4000-8000-0000000000b0",
          code: "VIPFREE",
          codeNormalized: "VIPFREE",
          kind: "PERCENT" as const,
          value: 100,
          currency: "usd",
          scope: "TICKET_TYPE" as const,
          scopeId: VIP,
          startsAt: null,
          endsAt: null,
          maxRedemptions: null,
          maxRedemptionsPerHuman: null,
          minOrderCents: 0,
          maxDiscountCents: null,
          stackable: true,
          isPublic: false,
          status: "ACTIVE" as const,
        },
      ]),
      getRedemptionStats: vi.fn(async () => ({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      })),
    },
    memberships: { listForMember: vi.fn(async () => []) },
    // 5% + 50¢, resolved by scope, for the pre-hold reduction.
    payoutTerms: { listByEvent: vi.fn(async () => []) },
    feePolicies: {
      resolveEffective: vi.fn(async (query: { scopeType: string }) =>
        query.scopeType === "GLOBAL"
          ? {
              id: "policy-1",
              version: 1,
              scopeType: "GLOBAL",
              scopeId: null,
              status: "ACTIVE",
              feeMode: "PASS_THROUGH",
              buyerFeePct: 0.05,
              platformFixedCents: 50,
              minFeeCents: 0,
              maxFeeCents: null,
              maxPlatformFeeCents: null,
              processsorFeePct: 0.029,
              processorFixedCents: 30,
              payoutPct: 0,
              payoutFixedCents: 0,
              monthlyPayoutCents: 0,
            }
          : null,
      ),
    },
  } as unknown as Repos;
  return { repos, getById };
}

const CART = [
  { ticketTypeId: GA, qty: 1 },
  { ticketTypeId: VIP, qty: 1 },
];

const OWN_PENDING: OrderRow = {
  buyerHumanId: BUYER,
  eventId: EVENT_ID,
  status: "PENDING",
};

function run(
  order: OrderRow,
  input: {
    buyerHumanId?: string | null;
    includeMemberBenefits?: boolean;
    excludeOrderId?: string;
  },
) {
  const { repos, getById } = makeRepos(order);
  const reportError = vi.fn();
  const result = previewPromos(
    { repos, clock: { now: () => NOW }, reportError },
    {
      eventId: EVENT_ID,
      codes: ["VIPFREE"],
      ticketSelections: CART,
      ...input,
    },
  );
  return { result, getById, repos, reportError };
}

beforeEach(() => {
  quote.mockReset();
  quote.mockResolvedValue(STATED);
});

describe("previewPromos — heldCartFees is stated only for the buyer's own pending cart", () => {
  it("the buyer's own PENDING cart on this event: the statement is asked for and returned as given", async () => {
    const { result, repos, reportError } = run(OWN_PENDING, {
      buyerHumanId: BUYER,
      includeMemberBenefits: true,
      excludeOrderId: ORDER_ID,
    });
    const output = await result;

    expect(output.heldCartFees).toEqual(STATED);
    expect(quote).toHaveBeenCalledTimes(1);
    const [deps, params] = quote.mock.calls[0]!;
    expect(deps.repos).toBe(repos);
    expect(deps.reportError).toBe(reportError);
    expect(params).toMatchObject({
      buyerHumanId: BUYER,
      heldOrderId: ORDER_ID,
      selections: CART,
      // The evaluation's own per-ticket discounts and total: 100% off VIP.
      discounts: [{ discountCents: 5000, ticketTypeId: VIP }],
      totalDiscountCents: 5000,
      now: NOW,
      useCase: "previewPromos",
    });
    expect(params.event).toMatchObject({ id: EVENT_ID, orgId: ORG_ID });
    // The event's ticket types as the repo listed them, every status: the
    // quote narrows to ACTIVE itself, as the charge does.
    expect(params.ticketTypes.map((type) => type.id)).toEqual([GA, VIP]);
    // The pre-hold delta is still answered beside it, untouched.
    expect(output.platformFeeReductionCents).toBe(300);
    expect(output.totalDiscountCents).toBe(5000);
  });

  it("no statement (the quote answered null): the preview still answers, with null", async () => {
    quote.mockResolvedValue(null);
    const output = await run(OWN_PENDING, {
      buyerHumanId: BUYER,
      includeMemberBenefits: true,
      excludeOrderId: ORDER_ID,
    }).result;
    expect(output.heldCartFees).toBeNull();
    expect(output.totalDiscountCents).toBe(5000);
    expect(output.platformFeeReductionCents).toBe(300);
  });

  it("no pending order named (step 1, the door, a URL preview): null, and no order is read", async () => {
    const { result, getById } = run(OWN_PENDING, {
      buyerHumanId: BUYER,
      includeMemberBenefits: true,
    });
    expect((await result).heldCartFees).toBeNull();
    expect(getById).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });

  it("signed out: null, and the named order is never read", async () => {
    const { result, getById } = run(OWN_PENDING, {
      buyerHumanId: null,
      includeMemberBenefits: true,
      excludeOrderId: ORDER_ID,
    });
    expect((await result).heldCartFees).toBeNull();
    expect(getById).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });

  it("the session is not asserted to be the buyer (the door preview): null, and the named order is never read", async () => {
    // The till's operator is signed in, but is not the buyer.
    const { result, getById } = run(OWN_PENDING, {
      buyerHumanId: BUYER,
      includeMemberBenefits: false,
      excludeOrderId: ORDER_ID,
    });
    expect((await result).heldCartFees).toBeNull();
    expect(getById).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });

  it.each([
    ["someone else's cart", { ...OWN_PENDING!, buyerHumanId: STRANGER }],
    ["the buyer's cart on another event", { ...OWN_PENDING!, eventId: OTHER_EVENT_ID }],
    ["an order already paid", { ...OWN_PENDING!, status: "PAID" }],
    ["a cancelled order", { ...OWN_PENDING!, status: "CANCELLED" }],
    ["an order that does not exist", null],
  ] as Array<[string, OrderRow]>)("%s: null, and nothing is priced", async (_name, order) => {
    const output = await run(order, {
      buyerHumanId: BUYER,
      includeMemberBenefits: true,
      excludeOrderId: ORDER_ID,
    }).result;
    expect(output.heldCartFees).toBeNull();
    expect(quote).not.toHaveBeenCalled();
    // The preview itself is unaffected.
    expect(output.totalDiscountCents).toBe(5000);
  });
});
