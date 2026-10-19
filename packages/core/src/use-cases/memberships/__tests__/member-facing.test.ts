import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MembershipRecord } from "@th/ports/repos/memberships";
import type {
  MembershipTierBenefitRecord,
  MembershipTierRecord,
} from "@th/ports/repos/membership-tiers";

import { createMembershipPortalSession } from "../create-membership-portal-session";
import { listMyMemberships } from "../list-my-memberships";
import { listPublicTiers } from "../list-public-tiers";
import { listTiersForOwner } from "../list-tiers-for-owner";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const TIER_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";
const MEMBERSHIP_ID = "55555555-5555-4555-8555-555555555555";

describe("createMembershipPortalSession", () => {
  it("mints a portal session against the member's own customer", async () => {
    const ctx = makeCtx({ membership: buildMembership() });

    const result = await createMembershipPortalSession(ctx.deps, {
      actorHumanId: HUMAN_ID,
      membershipId: MEMBERSHIP_ID,
      returnUrl: "https://ithasfire.com/account/memberships",
    });

    expect(ctx.billing.createPortalSession).toHaveBeenCalledWith({
      customerId: "cus_1",
      returnUrl: "https://ithasfire.com/account/memberships",
    });
    expect(result).toEqual({ url: "https://billing.stripe.com/session/x" });
  });

  it("REFUSES a foreign membership — a portal session is a billing-account takeover", async () => {
    const ctx = makeCtx({ membership: buildMembership() });

    await expect(
      createMembershipPortalSession(ctx.deps, {
        actorHumanId: ACTOR_ID, // not the member
        membershipId: MEMBERSHIP_ID,
        returnUrl: "https://ithasfire.com/account/memberships",
      }),
    ).rejects.toMatchObject({ code: "HUMAN_MISMATCH" });
    expect(ctx.billing.createPortalSession).not.toHaveBeenCalled();
  });

  it("404s on an unknown membership", async () => {
    const ctx = makeCtx({ membership: null });

    await expect(
      createMembershipPortalSession(ctx.deps, {
        actorHumanId: HUMAN_ID,
        membershipId: MEMBERSHIP_ID,
        returnUrl: "https://ithasfire.com/account/memberships",
      }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_FOUND" });
  });
});

describe("listMyMemberships", () => {
  it("shapes memberships with tier + owner display name, newest first, no Stripe ids", async () => {
    const older = buildMembership({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "canceled",
    });
    const newer = buildMembership({
      startedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const ctx = makeCtx({ myMemberships: [older, newer] });

    const result = await listMyMemberships(ctx.deps, {
      actorHumanId: HUMAN_ID,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.id).toBe(MEMBERSHIP_ID); // newest first
    expect(result.items[0]!.tier).toEqual({
      id: TIER_ID,
      name: "Sustaining Member",
      priceCents: 1000,
      currency: "usd",
      interval: "MONTH",
    });
    expect(result.items[0]!.owner).toEqual({
      type: "ORGANIZATION",
      id: ORG_ID,
      name: "DRKMTTR Collective",
    });
    // Canceled history is part of the account view.
    expect(result.items[1]!.status).toBe("canceled");
    // Billing internals never leave core.
    expect(result.items[0]).not.toHaveProperty("stripeSubscriptionId");
    expect(result.items[0]).not.toHaveProperty("stripeCustomerId");
    // No status filter: the account view is the member's full history.
    expect(ctx.memberships.listForMember).toHaveBeenCalledWith({
      memberHumanId: HUMAN_ID,
    });
  });

  it("returns empty for a member with no memberships", async () => {
    const ctx = makeCtx({ myMemberships: [] });

    const result = await listMyMemberships(ctx.deps, {
      actorHumanId: HUMAN_ID,
    });

    expect(result.items).toEqual([]);
  });
});

describe("listPublicTiers", () => {
  it("returns ACTIVE tiers only, with display fields only", async () => {
    const ctx = makeCtx({
      ownerTiers: [
        buildTier({
          status: "ACTIVE",
          benefitsDescription: "Two guest-list spots a month",
        }),
      ],
    });

    const result = await listPublicTiers(ctx.deps, {
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
    });

    expect(ctx.tiers.listForOwner).toHaveBeenCalledWith({
      ownerOrgId: ORG_ID,
      ownerHumanId: null,
      statuses: ["ACTIVE"],
    });
    // Exact equality, not objectContaining: this shape feeds an
    // UNAUTHENTICATED page, so the test has to fail when a field appears as
    // much as when one goes missing.
    expect(result.items[0]).toEqual({
      id: TIER_ID,
      name: "Sustaining Member",
      description: null,
      // The owner's own claim about what members get — the whole reason a
      // visitor can choose between tiers, so it is public by design.
      benefitsDescription: "Two guest-list spots a month",
      priceCents: 1000,
      currency: "usd",
      interval: "MONTH",
      sortOrder: 0,
    });
    expect(result.items[0]).not.toHaveProperty("stripePriceId");
    expect(result.items[0]).not.toHaveProperty("taxCategory");
  });

  it("hides everything when the owner's standing is suspended", async () => {
    const ctx = makeCtx({
      ownerTiers: [buildTier({ status: "ACTIVE" })],
      suspended: true,
    });

    const result = await listPublicTiers(ctx.deps, {
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
    });

    expect(result.items).toEqual([]);
    expect(ctx.tiers.listForOwner).not.toHaveBeenCalled();
  });
});

describe("listTiersForOwner", () => {
  it("returns every status with benefits, live member counts and the price lock", async () => {
    const draft = buildTier({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "DRAFT",
    });
    const active = buildTier({ status: "ACTIVE", stripePriceId: "price_1" });
    const ctx = makeCtx({
      ownerTiers: [active, draft],
      benefits: [
        {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          tierId: TIER_ID,
          discountKind: "PERCENT",
          discountValue: 20,
          maxDiscountCents: 1500,
          categoryId: null,
          placeId: null,
          label: "Members save",
        },
      ],
      liveCountByTier: { [TIER_ID]: 12 },
      everCountByTier: { [TIER_ID]: 15 },
    });

    const result = await listTiersForOwner(ctx.deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
    });

    const activeTier = result.items.find((item) => item.id === TIER_ID)!;
    expect(activeTier.memberCount).toBe(12);
    expect(activeTier.priceLocked).toBe(true);
    // The admin surface hands back the benefit's OWN terms — there is no promo
    // behind it to go fetch, so if the discount maths did not survive this
    // projection the editor would have nothing to render.
    expect(activeTier.benefits).toEqual([
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        tierId: TIER_ID,
        discountKind: "PERCENT",
        discountValue: 20,
        maxDiscountCents: 1500,
        categoryId: null,
        placeId: null,
        label: "Members save",
      },
    ]);

    const draftTier = result.items.find((item) => item.id === draft.id)!;
    expect(draftTier.memberCount).toBe(0);
    expect(draftTier.priceLocked).toBe(false);
    expect(draftTier.benefits).toEqual([]);
  });

  it("refuses a non-member of the org", async () => {
    const ctx = makeCtx({ orgRole: null });

    await expect(
      listTiersForOwner(ctx.deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ── Harness ────────────────────────────────────────────────────────────────

function buildTier(
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
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    updatedAt: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  };
}

function buildMembership(
  overrides: Partial<MembershipRecord> = {},
): MembershipRecord {
  return {
    id: MEMBERSHIP_ID,
    tierId: TIER_ID,
    memberHumanId: HUMAN_ID,
    stripeSubscriptionId: "sub_1",
    stripeCustomerId: "cus_1",
    status: "active",
    taxJurisdictionId: null,
    billingPostalCode: "37203",
    billingCountryCode: "US",
    currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    startedAt: new Date("2026-05-01T00:00:00.000Z"),
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeCtx(
  options: {
    membership?: MembershipRecord | null;
    myMemberships?: MembershipRecord[];
    ownerTiers?: MembershipTierRecord[];
    benefits?: MembershipTierBenefitRecord[];
    liveCountByTier?: Record<string, number>;
    everCountByTier?: Record<string, number>;
    suspended?: boolean;
    orgRole?: string | null;
  } = {},
) {
  const tiersById = new Map(
    (options.ownerTiers ?? [buildTier()]).map((tier) => [tier.id, tier]),
  );

  const tiers = {
    findById: vi.fn(async (id: string) => tiersById.get(id) ?? buildTier()),
    listForOwner: vi.fn(async () => options.ownerTiers ?? [buildTier()]),
    listBenefitsForTiers: vi.fn(async () => options.benefits ?? []),
  };

  const memberships = {
    findById: vi.fn(async () =>
      options.membership === undefined ? buildMembership() : options.membership,
    ),
    listForMember: vi.fn(async () => options.myMemberships ?? []),
    countByTier: vi.fn(
      async (input: { tierIds: string[]; statuses?: string[] }) => {
        const source = input.statuses
          ? (options.liveCountByTier ?? {})
          : (options.everCountByTier ?? {});
        return Object.entries(source)
          .filter(([tierId]) => input.tierIds.includes(tierId))
          .map(([tierId, count]) => ({ tierId, count }));
      },
    ),
  };

  const standings = {
    findForOwner: vi.fn(async () =>
      options.suspended ? { suspended: true } : null,
    ),
  };

  const orgRole = options.orgRole === undefined ? "OWNER" : options.orgRole;
  const authz = {
    getOrgMembership: vi.fn(async () =>
      orgRole ? { orgId: ORG_ID, humanId: ACTOR_ID, role: orgRole } : null,
    ),
  };

  const organizations = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.includes(ORG_ID)
        ? [{ id: ORG_ID, name: "DRKMTTR Collective" }]
        : [],
    ),
  };

  const humans = {
    getByIds: vi.fn(async () => []),
  };

  const billing = {
    createPortalSession: vi.fn(async () => ({
      url: "https://billing.stripe.com/session/x",
    })),
  };

  return {
    tiers,
    memberships,
    billing,
    deps: {
      repos: {
        membershipTiers: tiers,
        memberships,
        membershipStandings: standings,
        authz,
        organizations,
        humans,
      } as unknown as Repos,
      membershipBilling: billing as never,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    },
  };
}
