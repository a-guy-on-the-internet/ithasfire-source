import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";

import { previewPromos } from "../preview-promos";

// ─────────────────────────────────────────────────────────────────────────────
// previewPromos — membership benefits (preview parity with checkout).
//
// A signed-in member must see their membership discount BEFORE the order is
// created, resolved through the same `resolveMemberBenefits` +
// `evaluatePromoApplications` pipeline `createCheckout` runs. Anonymous
// previews and callers that don't opt in (`includeMemberBenefits` defaults to
// false — the POS door path) keep the pre-existing behaviour exactly.
//
// The "no code material in the response" property used to be a deliberate
// omission guarding a real leak: the benefit was backed by a PRIVATE promo
// whose code, once echoed, could be read from DevTools and shared as a public
// discount (the typed-code path checks no entitlement). It is now STRUCTURAL —
// a benefit has no code anywhere — so these assertions pin that the shape
// stays codeless rather than that a filter still runs.
//
// The preview must NEVER take a promo hold — asserted against a spied
// `promos.createHolds` in every test.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const TT_GA = "00000000-0000-4000-8000-0000000000a2";
const BUYER_ID = "00000000-0000-4000-8000-0000000000c1";
const TIER_ID = "00000000-0000-4000-8000-0000000000d1";
const MEMBERSHIP_ID = "00000000-0000-4000-8000-0000000000d2";
const BENEFIT_ID = "00000000-0000-4000-8000-0000000000d3";
const TYPED_PROMO_ID = "00000000-0000-4000-8000-0000000000b3";
const NOW = new Date("2026-08-10T20:00:00Z");

const typedPromo = {
  id: TYPED_PROMO_ID,
  code: "EARLYBIRD",
  codeNormalized: "EARLYBIRD",
  kind: "AMOUNT" as const,
  value: 500,
  currency: "usd",
  scope: "ORG" as const,
  scopeId: ORG_ID,
  startsAt: null,
  endsAt: null,
  maxRedemptions: null,
  maxRedemptionsPerHuman: null,
  minOrderCents: 0,
  maxDiscountCents: null,
  stackable: true,
  isPublic: false,
  status: "ACTIVE" as const,
};

type MakeReposOptions = {
  membershipStatus?: string;
  benefitOverrides?: Record<string, unknown>;
  tierOverrides?: Record<string, unknown>;
};

function makeRepos({
  membershipStatus = "active",
  benefitOverrides = {},
  tierOverrides = {},
}: MakeReposOptions = {}) {
  const memberships = [
    {
      id: MEMBERSHIP_ID,
      tierId: TIER_ID,
      memberHumanId: BUYER_ID,
      status: membershipStatus,
      startedAt: new Date("2026-01-01T00:00:00Z"),
    },
  ];

  const createHolds = vi.fn();
  const repos = {
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        categoryId: null,
        placeId: null,
        currency: "usd",
      })),
      listTicketTypes: vi.fn(async () => [
        {
          id: TT_GA,
          name: "GA",
          priceCents: 2000,
          pricingMode: "FIXED" as const,
          minimumCents: null,
          suggestedCents: null,
          capacity: 100,
          status: "ACTIVE" as const,
          seatSectionId: null,
        },
      ]),
    },
    promos: {
      findActiveByCodes: vi.fn(async ({ codes }: { codes: string[] }) =>
        codes.includes("EARLYBIRD") ? [typedPromo] : [],
      ),
      getRedemptionStats: vi.fn(async () => ({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      })),
      createHolds,
    },
    memberships: {
      // Mirrors the adapter contract: `statuses` filters the rows returned.
      listForMember: vi.fn(async ({ statuses }: { statuses?: string[] }) =>
        memberships.filter((m) => !statuses || statuses.includes(m.status)),
      ),
    },
    membershipTiers: {
      listByIds: vi.fn(async (ids: string[]) =>
        ids.includes(TIER_ID)
          ? [
              {
                id: TIER_ID,
                ownerOrgId: ORG_ID,
                ownerHumanId: null,
                name: "Gold",
                description: null,
                benefitsDescription: null,
                priceCents: 1000,
                currency: "usd",
                interval: "MONTH",
                stripeProductId: null,
                stripePriceId: null,
                status: "ACTIVE",
                sortOrder: 0,
                createdAt: NOW,
                updatedAt: NOW,
                ...tierOverrides,
              },
            ]
          : [],
      ),
      listBenefitsForTiers: vi.fn(async (tierIds: string[]) =>
        tierIds.includes(TIER_ID)
          ? [
              {
                id: BENEFIT_ID,
                tierId: TIER_ID,
                discountKind: "PERCENT",
                discountValue: 20,
                maxDiscountCents: null,
                categoryId: null,
                placeId: null,
                label: null,
                ...benefitOverrides,
              },
            ]
          : [],
      ),
    },
  } as unknown as Repos;

  return { repos, createHolds };
}

describe("previewPromos — membership benefits", () => {
  it("includes the signed-in member's benefit with a labelled source and takes no hold", async () => {
    const { repos, createHolds } = makeRepos();

    const result = await previewPromos(
      { repos, clock: { now: () => NOW } },
      {
        eventId: EVENT_ID,
        codes: [],
        ticketSelections: [{ ticketTypeId: TT_GA, qty: 2 }],
        buyerHumanId: BUYER_ID,
        includeMemberBenefits: true,
      },
    );

    // 2 × $20 = $40 → 20% member benefit = $8.
    expect(result.orderSubtotalCents).toBe(4000);
    expect(result.totalDiscountCents).toBe(800);
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]).toMatchObject({
      kind: "PERCENT",
      value: 20,
      discountCents: 800,
      source: {
        kind: "membership",
        tierId: TIER_ID,
        tierName: "Gold",
        label: null,
      },
    });
    // Nothing code-shaped, and no promoId either: the entitlement has neither.
    expect(result.applications[0]).not.toHaveProperty("code");
    expect(result.applications[0]).not.toHaveProperty("normalizedCode");
    expect(result.applications[0]).not.toHaveProperty("promoId");
    // Not even the benefit's own id — the smallest response is the easiest
    // "no material reaches the buyer" claim to keep true.
    expect(result.applications[0]!.source).not.toHaveProperty("benefitId");
    expect(createHolds).not.toHaveBeenCalled();
  });

  it("carries the owner's label override through to the checkout line", async () => {
    const { repos } = makeRepos({ benefitOverrides: { label: "Regulars rate" } });

    const result = await previewPromos(
      { repos, clock: { now: () => NOW } },
      {
        eventId: EVENT_ID,
        codes: [],
        ticketSelections: [{ ticketTypeId: TT_GA, qty: 1 }],
        buyerHumanId: BUYER_ID,
        includeMemberBenefits: true,
      },
    );

    expect(result.applications[0]?.source).toMatchObject({
      label: "Regulars rate",
      tierName: "Gold",
    });
  });

  it("stacks a typed code with the member benefit — only the granted line carries a source", async () => {
    const { repos, createHolds } = makeRepos();

    const result = await previewPromos(
      { repos, clock: { now: () => NOW } },
      {
        eventId: EVENT_ID,
        codes: ["EARLYBIRD"],
        ticketSelections: [{ ticketTypeId: TT_GA, qty: 2 }],
        buyerHumanId: BUYER_ID,
        includeMemberBenefits: true,
      },
    );

    // Typed $5 off + 20% of $40 = $8 → $13 total.
    expect(result.totalDiscountCents).toBe(1300);
    const typed = result.applications.find((a) => a.promoId === TYPED_PROMO_ID);
    const granted = result.applications.find((a) => a.source !== undefined);
    expect(typed?.source).toBeUndefined();
    // Typed applications keep their code echo — the checkout hook's
    // rejection-pruning intersects `normalizedCode` against the queued codes.
    expect(typed?.code).toBe("EARLYBIRD");
    expect(typed?.normalizedCode).toBe("EARLYBIRD");
    expect(granted?.source).toMatchObject({
      kind: "membership",
      tierName: "Gold",
    });
    expect(granted).not.toHaveProperty("code");
    expect(granted).not.toHaveProperty("normalizedCode");
    expect(createHolds).not.toHaveBeenCalled();
  });

  it("returns nothing for an anonymous preview even when benefits are requested", async () => {
    const { repos } = makeRepos();

    const result = await previewPromos(
      { repos, clock: { now: () => NOW } },
      {
        eventId: EVENT_ID,
        codes: [],
        ticketSelections: [{ ticketTypeId: TT_GA, qty: 1 }],
        buyerHumanId: null,
        includeMemberBenefits: true,
      },
    );

    expect(result.applications).toHaveLength(0);
    expect(result.totalDiscountCents).toBe(0);
    expect(repos.memberships.listForMember).not.toHaveBeenCalled();
  });

  it("ignores membership benefits when the caller does not opt in (door/POS semantics)", async () => {
    const { repos } = makeRepos();

    const result = await previewPromos(
      { repos, clock: { now: () => NOW } },
      {
        eventId: EVENT_ID,
        codes: ["EARLYBIRD"],
        ticketSelections: [{ ticketTypeId: TT_GA, qty: 1 }],
        // Identity present (e.g. an authed operator session) but the flag is
        // absent — the operator's memberships must not leak into the quote,
        // and per-human caps stay keyed to nobody, as before.
        buyerHumanId: BUYER_ID,
      },
    );

    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]?.promoId).toBe(TYPED_PROMO_ID);
    expect(result.applications[0]?.source).toBeUndefined();
    expect(repos.memberships.listForMember).not.toHaveBeenCalled();
    // The per-human stat lookup runs anonymously (humanId undefined).
    expect(repos.promos.getRedemptionStats).toHaveBeenCalledWith({
      promoId: TYPED_PROMO_ID,
      humanId: undefined,
      now: NOW,
    });
  });

  it("grants nothing for a CANCELED membership", async () => {
    const { repos } = makeRepos({ membershipStatus: "canceled" });

    const result = await previewPromos(
      { repos, clock: { now: () => NOW } },
      {
        eventId: EVENT_ID,
        codes: [],
        ticketSelections: [{ ticketTypeId: TT_GA, qty: 1 }],
        buyerHumanId: BUYER_ID,
        includeMemberBenefits: true,
      },
    );

    expect(result.applications).toHaveLength(0);
    expect(result.totalDiscountCents).toBe(0);
  });

  it("never reads redemption stats for a benefit — those are campaign caps", async () => {
    // A benefit is valid exactly as long as the membership. Preview must not
    // invent a cap checkout does not apply, or the two would disagree.
    const { repos } = makeRepos();

    await previewPromos(
      { repos, clock: { now: () => NOW } },
      {
        eventId: EVENT_ID,
        codes: [],
        ticketSelections: [{ ticketTypeId: TT_GA, qty: 1 }],
        buyerHumanId: BUYER_ID,
        includeMemberBenefits: true,
      },
    );

    expect(repos.promos.getRedemptionStats).not.toHaveBeenCalled();
  });

  it("SECURITY: a tier owned by ANOTHER org grants nothing on this event", async () => {
    const { repos } = makeRepos({
      tierOverrides: { ownerOrgId: "00000000-0000-4000-8000-0000000000f9" },
    });

    const result = await previewPromos(
      { repos, clock: { now: () => NOW } },
      {
        eventId: EVENT_ID,
        codes: [],
        ticketSelections: [{ ticketTypeId: TT_GA, qty: 1 }],
        buyerHumanId: BUYER_ID,
        includeMemberBenefits: true,
      },
    );

    expect(result.applications).toHaveLength(0);
    expect(result.totalDiscountCents).toBe(0);
  });
});
