import { describe, expect, it, vi } from "vitest";

import type { MembershipRecord } from "@th/ports/repos/memberships";
import type {
  MembershipTierBenefitRecord,
  MembershipTierRecord,
} from "@th/ports/repos/membership-tiers";

import {
  resolveMemberBenefits,
  type ResolveMemberBenefitsRepos,
} from "../resolve-member-benefits";
import { MEMBERSHIP_BENEFIT_GRANTING_STATUSES } from "../membership-status";

// ─────────────────────────────────────────────────────────────────────────────
// resolveMemberBenefits — entitlement + owner scope.
//
// Membership status and benefit narrowing (categoryId / placeId) are decided
// HERE, and so is the grant's `ownerScope`, derived from the tier's owner.
// Matching that scope against the event is enforced downstream by
// computeEligibleAmount inside evaluatePromoApplications — the same one gate
// typed codes go through.
//
// There is deliberately NO GLOBAL case to test any more: a grant's scope comes
// from the tier owner, so GLOBAL is unrepresentable rather than filtered.
//
// The status fakes FILTER by the statuses the resolver passes, mirroring the
// adapter's `status: { in: statuses }` — so "CANCELED grants nothing" is
// proven by the resolver's own argument, not by a fake that ignores it.
// ─────────────────────────────────────────────────────────────────────────────

const MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const TIER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_TIER_ID = "33333333-3333-4333-8333-999999999999";
const MEMBERSHIP_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_MEMBERSHIP_ID = "66666666-6666-4666-8666-777777777777";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_HUMAN_ID = "55555555-5555-4555-8555-555555555555";
const CATEGORY_ID = "88888888-8888-4888-8888-111111111111";
const PLACE_ID = "99999999-9999-4999-8999-111111111111";
const NOW = new Date("2026-08-10T12:00:00.000Z");

function makeMembership(
  overrides: Partial<MembershipRecord> = {},
): MembershipRecord {
  return {
    id: MEMBERSHIP_ID,
    tierId: TIER_ID,
    memberHumanId: MEMBER_ID,
    stripeSubscriptionId: "sub_1",
    stripeCustomerId: "cus_1",
    status: "active",
    taxJurisdictionId: null,
    billingPostalCode: null,
    billingCountryCode: null,
    currentPeriodStart: NOW,
    currentPeriodEnd: NOW,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeTier(
  overrides: Partial<MembershipTierRecord> = {},
): MembershipTierRecord {
  return {
    id: TIER_ID,
    ownerOrgId: ORG_ID,
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeBenefit(
  overrides: Partial<MembershipTierBenefitRecord> = {},
): MembershipTierBenefitRecord {
  return {
    id: "benefit-1",
    tierId: TIER_ID,
    discountKind: "PERCENT",
    discountValue: 100,
    maxDiscountCents: null,
    categoryId: null,
    placeId: null,
    label: null,
    ...overrides,
  };
}

function makeRepos(seed: {
  memberships?: MembershipRecord[];
  tiers?: MembershipTierRecord[];
  benefits?: MembershipTierBenefitRecord[];
}) {
  const memberships = {
    // Mirrors the adapter: only rows whose status is IN the caller's list.
    listForMember: vi.fn(
      async (input: { memberHumanId: string; statuses: string[] }) =>
        (seed.memberships ?? []).filter(
          (m) =>
            m.memberHumanId === input.memberHumanId &&
            input.statuses.includes(m.status),
        ),
    ),
  };
  const membershipTiers = {
    listByIds: vi.fn(async (ids: string[]) =>
      (seed.tiers ?? [makeTier()]).filter((tier) => ids.includes(tier.id)),
    ),
    listBenefitsForTiers: vi.fn(async (tierIds: string[]) =>
      (seed.benefits ?? []).filter((b) => tierIds.includes(b.tierId)),
    ),
  };
  return {
    repos: {
      memberships,
      membershipTiers,
    } as unknown as ResolveMemberBenefitsRepos,
    memberships,
    membershipTiers,
  };
}

const baseEvent = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  categoryId: null,
  placeId: null,
};

describe("resolveMemberBenefits — status gating", () => {
  it("grants the tier's benefit terms for an active membership", async () => {
    const ctx = makeRepos({
      memberships: [makeMembership({ status: "active" })],
      benefits: [makeBenefit({ discountKind: "AMOUNT", discountValue: 500 })],
    });

    const grants = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: baseEvent,
      now: NOW,
    });

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      membershipId: MEMBERSHIP_ID,
      tierId: TIER_ID,
      tierName: "Sustaining Member",
      benefitId: "benefit-1",
      discountKind: "AMOUNT",
      discountValue: 500,
      maxDiscountCents: null,
      label: null,
    });
  });

  it("carries NO code material — there is nothing to leak", async () => {
    const ctx = makeRepos({
      memberships: [makeMembership()],
      benefits: [makeBenefit()],
    });

    const grants = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: baseEvent,
      now: NOW,
    });

    const serialized = JSON.stringify(grants[0]);
    expect(serialized).not.toMatch(/"code"/);
    expect(serialized).not.toMatch(/"promoId"/);
    expect(Object.keys(grants[0]!)).not.toContain("promo");
  });

  it("queries ONLY the benefit-granting statuses (single definition)", async () => {
    const ctx = makeRepos({});

    await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: baseEvent,
      now: NOW,
    });

    expect(ctx.memberships.listForMember).toHaveBeenCalledWith({
      memberHumanId: MEMBER_ID,
      statuses: [...MEMBERSHIP_BENEFIT_GRANTING_STATUSES],
    });
    // Pin the definition itself: past_due / canceled must never creep in.
    expect(MEMBERSHIP_BENEFIT_GRANTING_STATUSES).toEqual([
      "active",
      "trialing",
    ]);
  });

  it("a CANCELED membership grants NOTHING", async () => {
    const ctx = makeRepos({
      memberships: [makeMembership({ status: "canceled" })],
      benefits: [makeBenefit()],
    });

    const grants = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: baseEvent,
      now: NOW,
    });

    expect(grants).toEqual([]);
    expect(ctx.membershipTiers.listBenefitsForTiers).not.toHaveBeenCalled();
  });

  it("a PAST_DUE membership grants NOTHING (failing card must not keep earning discounts)", async () => {
    const ctx = makeRepos({
      memberships: [makeMembership({ status: "past_due" })],
      benefits: [makeBenefit()],
    });

    const grants = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: baseEvent,
      now: NOW,
    });

    expect(grants).toEqual([]);
  });

  it("a trialing membership grants (Stripe treats a trial as an entitled period)", async () => {
    const ctx = makeRepos({
      memberships: [makeMembership({ status: "trialing" })],
      benefits: [makeBenefit()],
    });

    const grants = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: baseEvent,
      now: NOW,
    });

    expect(grants).toHaveLength(1);
  });
});

describe("resolveMemberBenefits — benefit narrowing", () => {
  it("category-narrowed benefit applies only to events in that category", async () => {
    const ctx = makeRepos({
      memberships: [makeMembership()],
      benefits: [makeBenefit({ categoryId: CATEGORY_ID })],
    });

    const matching = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: { ...baseEvent, categoryId: CATEGORY_ID },
      now: NOW,
    });
    expect(matching).toHaveLength(1);

    const otherCategory = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: { ...baseEvent, categoryId: PLACE_ID },
      now: NOW,
    });
    expect(otherCategory).toEqual([]);

    // Null-category event: narrowing means "only there", never "anywhere".
    const uncategorised = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: { ...baseEvent, categoryId: null },
      now: NOW,
    });
    expect(uncategorised).toEqual([]);
  });

  it("place-narrowed benefit applies only to events at that place", async () => {
    const ctx = makeRepos({
      memberships: [makeMembership()],
      benefits: [makeBenefit({ placeId: PLACE_ID })],
    });

    const matching = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: { ...baseEvent, placeId: PLACE_ID },
      now: NOW,
    });
    expect(matching).toHaveLength(1);

    const elsewhere = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: { ...baseEvent, placeId: CATEGORY_ID },
      now: NOW,
    });
    expect(elsewhere).toEqual([]);

    const noPlace = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: { ...baseEvent, placeId: null },
      now: NOW,
    });
    expect(noPlace).toEqual([]);
  });
});

describe("resolveMemberBenefits — derived owner scope", () => {
  it("an ORG-owned tier scopes its grant to that org", async () => {
    const ctx = makeRepos({
      memberships: [makeMembership()],
      tiers: [makeTier({ ownerOrgId: ORG_ID, ownerHumanId: null })],
      benefits: [makeBenefit()],
    });

    const grants = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: baseEvent,
      now: NOW,
    });

    expect(grants[0]!.ownerScope).toEqual({ kind: "ORG", orgId: ORG_ID });
  });

  it("a HUMAN-owned tier scopes its grant to that human", async () => {
    const ctx = makeRepos({
      memberships: [makeMembership()],
      tiers: [makeTier({ ownerOrgId: null, ownerHumanId: OWNER_HUMAN_ID })],
      benefits: [makeBenefit()],
    });

    const grants = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: { ...baseEvent, orgId: null, humanId: OWNER_HUMAN_ID },
      now: NOW,
    });

    expect(grants[0]!.ownerScope).toEqual({
      kind: "HUMAN",
      humanId: OWNER_HUMAN_ID,
    });
  });

  it("an unattributable tier (neither owner id) grants nothing", async () => {
    const ctx = makeRepos({
      memberships: [makeMembership()],
      tiers: [makeTier({ ownerOrgId: null, ownerHumanId: null })],
      benefits: [makeBenefit()],
    });

    const grants = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: baseEvent,
      now: NOW,
    });

    expect(grants).toEqual([]);
  });

  it("reads every granting tier in ONE query, not a per-tier fan-out", async () => {
    const ctx = makeRepos({
      memberships: [
        makeMembership(),
        makeMembership({
          id: OTHER_MEMBERSHIP_ID,
          tierId: OTHER_TIER_ID,
          stripeSubscriptionId: "sub_2",
        }),
      ],
      tiers: [makeTier(), makeTier({ id: OTHER_TIER_ID, name: "Patron" })],
      benefits: [
        makeBenefit(),
        makeBenefit({ id: "benefit-2", tierId: OTHER_TIER_ID }),
      ],
    });

    await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: baseEvent,
      now: NOW,
    });

    expect(ctx.membershipTiers.listByIds).toHaveBeenCalledTimes(1);
    expect(ctx.membershipTiers.listByIds).toHaveBeenCalledWith([
      TIER_ID,
      OTHER_TIER_ID,
    ]);
  });

  it("returns EVERY entitled benefit — picking one is the pipeline's job", async () => {
    // Two tiers, one benefit each. The resolver reports both; the
    // one-benefit-per-order rule lives in evaluatePromoApplications, where the
    // remaining subtotal is known.
    const ctx = makeRepos({
      memberships: [
        makeMembership(),
        makeMembership({
          id: OTHER_MEMBERSHIP_ID,
          tierId: OTHER_TIER_ID,
          stripeSubscriptionId: "sub_2",
        }),
      ],
      tiers: [makeTier(), makeTier({ id: OTHER_TIER_ID, name: "Patron" })],
      benefits: [
        makeBenefit(),
        makeBenefit({ id: "benefit-2", tierId: OTHER_TIER_ID }),
      ],
    });

    const grants = await resolveMemberBenefits(ctx.repos, {
      memberHumanId: MEMBER_ID,
      event: baseEvent,
      now: NOW,
    });

    expect(grants.map((grant) => grant.benefitId)).toEqual([
      "benefit-1",
      "benefit-2",
    ]);
  });
});
