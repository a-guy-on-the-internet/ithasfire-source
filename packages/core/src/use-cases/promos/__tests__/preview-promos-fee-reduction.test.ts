import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";

import {
  aggregateItems,
  computeOrderAmounts,
  unseatedSeatPrices,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "../../orders/checkout-helpers";
import { previewPromos } from "../preview-promos";

/**
 * Owner ruling, 2026-10-10: "yes a promo brought down to $0 should have no fee
 * too."
 *
 * The charge takes no platform fee for a ticket a discount makes free. The
 * page's estimate is built from per-ticket fee rows that know nothing about a
 * discount, so the preview tells it how much fee comes off:
 * `platformFeeReductionCents`. These pin that figure against the charge's own
 * arithmetic (`computeOrderAmounts` with and without the discounts).
 */

const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const GA = "00000000-0000-4000-8000-0000000000a2";
const VIP = "00000000-0000-4000-8000-0000000000a3";
const NOW = new Date("2026-04-26T20:00:00Z");

type Policy = {
  buyerFeePct: number;
  maxFeeCents: number | null;
  minFeeCents: number;
  platformFixedCents: number;
  maxPlatformFeeCents: number | null;
};

/** 5% + 50¢ per ticket: $30 → 200¢, $50 → 300¢. */
const FIXED: Policy = {
  buyerFeePct: 0.05,
  maxFeeCents: null,
  minFeeCents: 0,
  platformFixedCents: 50,
  maxPlatformFeeCents: null,
};
/** The live GLOBAL policy's shape: 3.33% capped at 50¢ a ticket. */
const LIVE_SHAPE: Policy = {
  buyerFeePct: 0.0333,
  maxFeeCents: 50,
  minFeeCents: 0,
  platformFixedCents: 0,
  maxPlatformFeeCents: null,
};

function feePolicy(policy: Policy) {
  return {
    id: "policy-1",
    version: 7,
    scopeType: "GLOBAL",
    scopeId: null,
    status: "ACTIVE",
    feeMode: "PASS_THROUGH",
    ...policy,
    processsorFeePct: 0.029,
    processorFixedCents: 30,
    payoutPct: 0,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
  };
}

type PromoOverrides = Record<string, unknown>;

function makeRepos(promos: PromoOverrides[], policy: Policy | null) {
  const promoRecords = promos.map((overrides, index) => ({
    id: `00000000-0000-4000-8000-0000000000b${index}`,
    code: `CODE${index}`,
    codeNormalized: `CODE${index}`,
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
    ...overrides,
  }));
  const tier = {
    pricingMode: "FIXED" as const,
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    status: "ACTIVE" as const,
    seatSectionId: null,
  };
  const resolveEffective = vi.fn(async (query: { scopeType: string }) =>
    policy && query.scopeType === "GLOBAL" ? feePolicy(policy) : null,
  );
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
    promos: {
      findActiveByCodes: vi.fn(async () => promoRecords),
      getRedemptionStats: vi.fn(async () => ({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      })),
    },
    // No payout terms pinned to the event: the policy resolves by scope, as
    // the page's fee rows resolve it.
    payoutTerms: { listByEvent: vi.fn(async () => []) },
    feePolicies: { resolveEffective },
  } as unknown as Repos;
  return { repos, resolveEffective, codes: promoRecords.map((p) => p.code) };
}

type Line = { ticketTypeId: string; qty: number };

async function preview(
  lines: Line[],
  promos: PromoOverrides[],
  policy: Policy | null,
) {
  const { repos, resolveEffective, codes } = makeRepos(promos, policy);
  const result = await previewPromos(
    { repos, clock: { now: () => NOW } },
    { eventId: EVENT_ID, codes, ticketSelections: lines },
  );
  return { result, resolveEffective };
}

/** What the charge's own arithmetic says comes off, for the same cart and discounts. */
function chargeFeeReduction(
  lines: Line[],
  policy: Policy,
  discounts: Array<{ discountCents: number; ticketTypeId: string | null }>,
): number {
  const base = {
    pricingMode: "FIXED" as const,
    minimumCents: null,
    seatSectionId: null,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    salesOpenAt: null,
    salesCloseAt: null,
  };
  const ticketTypes = new Map<string, TicketTypeSummary>([
    [GA, { ...base, id: GA, priceCents: 3000 }],
    [VIP, { ...base, id: VIP, priceCents: 5000 }],
  ]);
  const terms = {
    agreement: {
      id: "terms-1",
      kind: "PRIMARY",
      status: "ACTIVE",
      feeMode: "PASS_THROUGH",
      feePolicyId: "policy-1",
      version: 1,
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
    feePolicy: feePolicy(policy),
  } as unknown as PayoutTermsContext;
  const items = aggregateItems(lines);
  const options = { now: NOW, seatPrices: unseatedSeatPrices(items) };
  const without = computeOrderAmounts(items, ticketTypes, terms, options);
  const withDiscounts = computeOrderAmounts(items, ticketTypes, terms, {
    ...options,
    discounts,
  });
  return without.feesPlatformCents - withDiscounts.feesPlatformCents;
}

const MIXED: Line[] = [
  { ticketTypeId: GA, qty: 1 },
  { ticketTypeId: VIP, qty: 1 },
];

describe("previewPromos — platformFeeReductionCents", () => {
  it.each([
    ["5% + 50¢", FIXED, 300],
    ["the live policy's shape (3.33% capped at 50¢)", LIVE_SHAPE, 50],
  ] as Array<[string, Policy, number]>)(
    "%s: 100% off the VIP type takes the VIP ticket's own fee off",
    async (_name, policy, expected) => {
      const { result } = await preview(MIXED, [{}], policy);
      expect(result.totalDiscountCents).toBe(5000);
      expect(result.platformFeeReductionCents).toBe(expected);
      expect(result.platformFeeReductionCents).toBe(
        chargeFeeReduction(MIXED, policy, [
          { discountCents: 5000, ticketTypeId: VIP },
        ]),
      );
    },
  );

  it("a fixed amount that covers the ticket does the same", async () => {
    const { result } = await preview(
      MIXED,
      [{ kind: "AMOUNT", value: 5000 }],
      FIXED,
    );
    expect(result.totalDiscountCents).toBe(5000);
    expect(result.platformFeeReductionCents).toBe(300);
  });

  it("every ticket of the type: three free VIP tickets take three fees off", async () => {
    const lines: Line[] = [
      { ticketTypeId: GA, qty: 2 },
      { ticketTypeId: VIP, qty: 3 },
    ];
    const { result } = await preview(lines, [{}], FIXED);
    expect(result.totalDiscountCents).toBe(15000);
    expect(result.platformFeeReductionCents).toBe(900);
    expect(result.platformFeeReductionCents).toBe(
      chargeFeeReduction(lines, FIXED, [
        { discountCents: 15000, ticketTypeId: VIP },
      ]),
    );
  });

  it("is net of the order-level fee cap, as the charge is", async () => {
    // Cap 251¢. Both fees (500¢) cap to 251¢; the $30 ticket's 200¢ alone is
    // under it. What comes off the buyer's fee is 51¢, not the VIP's 300¢.
    const capped: Policy = { ...FIXED, maxPlatformFeeCents: 251 };
    const { result } = await preview(MIXED, [{}], capped);
    expect(result.platformFeeReductionCents).toBe(51);
    expect(result.platformFeeReductionCents).toBe(
      chargeFeeReduction(MIXED, capped, [
        { discountCents: 5000, ticketTypeId: VIP },
      ]),
    );
  });

  it.each([
    ["50% off the VIP type", [{ value: 50 }], MIXED],
    ["20% off the order", [{ value: 20, scope: "EVENT", scopeId: EVENT_ID }], MIXED],
    ["$10 off the order", [{ kind: "AMOUNT", value: 1000, scope: "EVENT", scopeId: EVENT_ID }], MIXED],
    [
      "$50 off the VIP type across two VIP tickets",
      [{ kind: "AMOUNT", value: 5000 }],
      [
        { ticketTypeId: GA, qty: 1 },
        { ticketTypeId: VIP, qty: 2 },
      ] as Line[],
    ],
  ] as Array<[string, PromoOverrides[], Line[]]>)(
    "%s: no ticket reaches $0, nothing comes off, and the fee policy is not even read",
    async (_name, promos, lines) => {
      const { result, resolveEffective } = await preview(lines, promos, FIXED);
      expect(result.totalDiscountCents).toBeGreaterThan(0);
      expect(result.platformFeeReductionCents).toBe(0);
      expect(resolveEffective).not.toHaveBeenCalled();
    },
  );

  it("a discount that frees the whole order reports 0: a free order has no fee to reduce", async () => {
    const { result, resolveEffective } = await preview(
      MIXED,
      [{ scope: "EVENT", scopeId: EVENT_ID }],
      FIXED,
    );
    expect(result.totalDiscountCents).toBe(8000);
    expect(result.platformFeeReductionCents).toBe(0);
    expect(resolveEffective).not.toHaveBeenCalled();
  });

  it("no fee policy at any scope: the buyer pays no platform fee, so nothing comes off", async () => {
    const { result } = await preview(MIXED, [{}], null);
    expect(result.totalDiscountCents).toBe(5000);
    expect(result.platformFeeReductionCents).toBe(0);
  });

  it("a fault reading the fee policy is not swallowed into a figure", async () => {
    const { repos, codes } = makeRepos([{}], FIXED);
    (repos.feePolicies.resolveEffective as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("db down"),
    );
    await expect(
      previewPromos(
        { repos, clock: { now: () => NOW } },
        { eventId: EVENT_ID, codes, ticketSelections: MIXED },
      ),
    ).rejects.toThrow("db down");
  });
});
