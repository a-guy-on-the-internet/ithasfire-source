import { describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { membershipsRouter } from "../memberships";
import { createCaller } from "./test-helpers";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const TIER_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP_ID = "55555555-5555-4555-8555-555555555555";

const NOW = new Date("2026-08-10T00:00:00.000Z");

const buildTier = (overrides: Record<string, unknown> = {}) => ({
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
  status: "DRAFT",
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const buildMembership = (overrides: Record<string, unknown> = {}) => ({
  id: MEMBERSHIP_ID,
  tierId: TIER_ID,
  memberHumanId: MEMBER_ID,
  stripeSubscriptionId: "sub_1",
  stripeCustomerId: "cus_1",
  status: "active",
  taxJurisdictionId: null,
  billingPostalCode: "37203",
  billingCountryCode: "US",
  currentPeriodStart: NOW,
  currentPeriodEnd: new Date("2026-09-10T00:00:00.000Z"),
  cancelAtPeriodEnd: false,
  canceledAt: null,
  startedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const makeRepos = (
  options: {
    orgRole?: string | null;
    tier?: Record<string, unknown> | null;
    membership?: Record<string, unknown> | null;
    suspended?: boolean;
  } = {},
): Ctx["repos"] => {
  const orgRole = options.orgRole === undefined ? "OWNER" : options.orgRole;
  return {
    authz: {
      getOrgMembership: vi.fn(async () =>
        orgRole ? { orgId: ORG_ID, humanId: ACTOR_ID, role: orgRole } : null,
      ),
    },
    membershipTiers: {
      create: vi.fn(async (input: Record<string, unknown>) =>
        buildTier(input),
      ),
      findById: vi.fn(async () =>
        options.tier === undefined ? buildTier() : options.tier,
      ),
      listForOwner: vi.fn(async () => [buildTier({ status: "ACTIVE" })]),
      listBenefitsForTiers: vi.fn(async () => []),
    },
    membershipStandings: {
      findForOwner: vi.fn(async () =>
        options.suspended ? { suspended: true } : null,
      ),
    },
    memberships: {
      findById: vi.fn(async () =>
        options.membership === undefined
          ? buildMembership()
          : options.membership,
      ),
      findForMemberAndTier: vi.fn(async () => null),
      listForMember: vi.fn(async () => []),
      countByTier: vi.fn(async () => []),
    },
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        human: { id: ACTOR_ID, name: "Test Member" },
        identity: { email: "member@example.com", emailVerified: true },
      })),
    },
  } as unknown as Ctx["repos"];
};

const makeBilling = () => ({
  ensureCustomer: vi.fn(async () => ({ customerId: "cus_1" })),
  ensureProduct: vi.fn(async () => ({ productId: "prod_1" })),
  createPrice: vi.fn(async () => ({ priceId: "price_1" })),
  ensureTaxRate: vi.fn(async () => ({ taxRateId: "txr_1" })),
  createSubscription: vi.fn(),
  cancelSubscription: vi.fn(async () => ({
    subscriptionId: "sub_1",
    status: "active",
    currentPeriodStart: NOW,
    currentPeriodEnd: new Date("2026-09-10T00:00:00.000Z"),
    cancelAtPeriodEnd: true,
    canceledAt: null,
  })),
  getSubscription: vi.fn(),
  createPortalSession: vi.fn(async () => ({
    url: "https://billing.stripe.com/session/x",
  })),
});

describe("memberships router — admin tier procedures", () => {
  it("refuses tier creation for a non-admin of the org", async () => {
    const { caller } = createCaller(membershipsRouter, {
      repos: makeRepos({ orgRole: null }),
      actorHumanId: ACTOR_ID,
    });

    await expect(
      caller.tiers.create({
        ownerOrgId: ORG_ID,
        name: "Sneaky Tier",
        priceCents: 1000,
        currency: "usd",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a client-supplied actorHumanId — the actor comes from the session", async () => {
    const { caller } = createCaller(membershipsRouter, {
      repos: makeRepos(),
      actorHumanId: ACTOR_ID,
    });

    await expect(
      caller.tiers.create({
        actorHumanId: MEMBER_ID, // spoof attempt; schema is .strict()
        ownerOrgId: ORG_ID,
        name: "Tier",
        priceCents: 1000,
        currency: "usd",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("creates a tier for an org admin, injecting the session actor", async () => {
    const repos = makeRepos();
    const { caller } = createCaller(membershipsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    const tier = await caller.tiers.create({
      ownerOrgId: ORG_ID,
      name: "Sustaining Member",
      priceCents: 1000,
      currency: "usd",
    });

    expect(tier.id).toBe(TIER_ID);
    expect(
      (repos.authz.getOrgMembership as ReturnType<typeof vi.fn>).mock
        .calls[0]![0],
    ).toEqual({ orgId: ORG_ID, humanId: ACTOR_ID });
  });

  it("refuses tier archive for a non-finance role", async () => {
    const { caller } = createCaller(membershipsRouter, {
      repos: makeRepos({ orgRole: "VIEWER" }),
      actorHumanId: ACTOR_ID,
    });

    await expect(
      caller.tiers.archive({ tierId: TIER_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails publish with PRECONDITION_FAILED when billing is not configured", async () => {
    const { caller } = createCaller(membershipsRouter, {
      repos: makeRepos(),
      actorHumanId: ACTOR_ID,
      // membershipBilling deliberately absent
    });

    await expect(
      caller.tiers.publish({ tierId: TIER_ID }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("lists public tiers without authentication", async () => {
    const { caller } = createCaller(membershipsRouter, {
      repos: makeRepos(),
      actorHumanId: null,
      auth: null,
      authToken: null,
    });

    const result = await caller.tiers.listPublic({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty("stripePriceId");
  });
});

describe("memberships router — member procedures", () => {
  it("refuses cancel of a foreign membership", async () => {
    const billing = makeBilling();
    const { caller } = createCaller(membershipsRouter, {
      repos: makeRepos({ membership: buildMembership() }),
      actorHumanId: ACTOR_ID, // membership belongs to MEMBER_ID
      membershipBilling: billing as never,
    });

    await expect(
      caller.cancel({ membershipId: MEMBERSHIP_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(billing.cancelSubscription).not.toHaveBeenCalled();
  });

  it("refuses a portal session for a foreign membership", async () => {
    const billing = makeBilling();
    const { caller } = createCaller(membershipsRouter, {
      repos: makeRepos({ membership: buildMembership() }),
      actorHumanId: ACTOR_ID,
      membershipBilling: billing as never,
      publicAppUrl: "https://ithasfire.com",
    });

    await expect(
      caller.portalSession({ membershipId: MEMBERSHIP_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(billing.createPortalSession).not.toHaveBeenCalled();
  });

  it("mints a portal session for the member with a same-site return URL", async () => {
    const billing = makeBilling();
    const { caller } = createCaller(membershipsRouter, {
      repos: makeRepos({ membership: buildMembership() }),
      actorHumanId: MEMBER_ID,
      membershipBilling: billing as never,
      publicAppUrl: "https://ithasfire.com/",
    });

    const result = await caller.portalSession({
      membershipId: MEMBERSHIP_ID,
    });

    expect(result.url).toBe("https://billing.stripe.com/session/x");
    expect(billing.createPortalSession).toHaveBeenCalledWith({
      customerId: "cus_1",
      returnUrl: "https://ithasfire.com/account/memberships",
    });
  });

  it("rejects an off-site returnPath on portalSession", async () => {
    const billing = makeBilling();
    const { caller } = createCaller(membershipsRouter, {
      repos: makeRepos({ membership: buildMembership() }),
      actorHumanId: MEMBER_ID,
      membershipBilling: billing as never,
      publicAppUrl: "https://ithasfire.com",
    });

    await expect(
      caller.portalSession({
        membershipId: MEMBERSHIP_ID,
        returnPath: "//evil.example.com/phish",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(billing.createPortalSession).not.toHaveBeenCalled();
  });

  it("refuses start while the owner's standing is suspended — no Stripe writes", async () => {
    const billing = makeBilling();
    const { caller } = createCaller(membershipsRouter, {
      repos: makeRepos({
        tier: buildTier({ status: "ACTIVE", stripePriceId: "price_1" }),
        suspended: true,
      }),
      actorHumanId: MEMBER_ID,
      membershipBilling: billing as never,
      taxRateLookup: {
        lookupByPostalCode: vi.fn(async () => ({
          rateBps: 925,
          source: "ziptax",
        })),
      } as never,
    });

    await expect(
      caller.start({
        tierId: TIER_ID,
        billingCountryCode: "US",
        billingPostalCode: "37203",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(billing.ensureCustomer).not.toHaveBeenCalled();
    expect(billing.createSubscription).not.toHaveBeenCalled();
  });

  it("start returns the first invoice's PaymentIntent client secret for Elements — and no Stripe ids", async () => {
    const billing = makeBilling();
    // `default_incomplete`: the subscription starts `incomplete` and hands
    // back the confirmation secret for the browser.
    billing.createSubscription.mockResolvedValue({
      subscriptionId: "sub_1",
      status: "incomplete",
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date("2026-09-10T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      paymentIntentClientSecret: "pi_1_secret_abc",
    } as never);

    const repos = makeRepos({
      tier: buildTier({ status: "ACTIVE", stripePriceId: "price_1" }),
    }) as unknown as Record<string, Record<string, unknown>>;
    repos.memberships!.findForMemberAndTier = vi.fn(async () => null);
    repos.memberships!.create = vi.fn(
      async (input: Record<string, unknown>) =>
        buildMembership({ status: input.status }),
    );
    repos.payees = {
      getBySubject: vi.fn(async () => ({ id: "payee_1" })),
      getById: vi.fn(async () => ({
        id: "payee_1",
        stripeAccountId: "acct_owner",
        chargesEnabled: true,
      })),
    };
    // Cached 0% jurisdiction — no TaxRate minting on this path.
    repos.membershipTaxJurisdictions = {
      findLive: vi.fn(async () => ({
        id: "77777777-7777-4777-8777-777777777777",
        countryCode: "US",
        postalCode: "37203",
        rateBps: 0,
        rateSource: "ziptax",
        stripeTaxRateId: null,
        checkedAt: NOW,
      })),
    };

    const { caller } = createCaller(membershipsRouter, {
      repos: repos as unknown as Ctx["repos"],
      actorHumanId: MEMBER_ID,
      membershipBilling: billing as never,
      taxRateLookup: {
        lookupByPostalCode: vi.fn(async () => ({
          rateBps: 0,
          source: "ziptax",
        })),
      } as never,
    });

    const result = await caller.start({
      tierId: TIER_ID,
      billingCountryCode: "US",
      billingPostalCode: "37203",
    });

    expect(result.paymentIntentClientSecret).toBe("pi_1_secret_abc");
    expect(result.status).toBe("incomplete");
    // The output schema strips billing internals — the secret is the ONLY
    // Stripe-facing value that crosses the wire.
    expect(result).not.toHaveProperty("stripeSubscriptionId");
    expect(result).not.toHaveProperty("stripeCustomerId");
  });

  it("fails start with PRECONDITION_FAILED when billing is not configured", async () => {
    const { caller } = createCaller(membershipsRouter, {
      repos: makeRepos(),
      actorHumanId: MEMBER_ID,
    });

    await expect(
      caller.start({
        tierId: TIER_ID,
        billingCountryCode: "US",
        billingPostalCode: "37203",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("lists the caller's memberships, never someone else's", async () => {
    const repos = makeRepos();
    const { caller } = createCaller(membershipsRouter, {
      repos,
      actorHumanId: MEMBER_ID,
    });

    const result = await caller.mine.list();

    expect(result.items).toEqual([]);
    expect(repos.memberships.listForMember).toHaveBeenCalledWith({
      memberHumanId: MEMBER_ID,
    });
  });
});

describe("memberships router — memberBlocks (member-gated page content)", () => {
  const PAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  const MAIN_BLOCK = {
    id: "b-main",
    pageId: PAGE_ID,
    kind: "about",
    orderIndex: 0,
    data: { content: "public copy" },
    visible: true,
    section: "main",
  };
  const MEMBER_BLOCK = {
    id: "b-members",
    pageId: PAGE_ID,
    kind: "links",
    orderIndex: 1,
    data: { content: "members only" },
    visible: true,
    section: "memberships",
  };

  const makeMemberBlocksRepos = (options: { member?: boolean } = {}) => {
    const repos = makeRepos({
      tier: buildTier({ status: "ACTIVE" }),
    }) as unknown as Record<string, Record<string, unknown>>;
    repos.memberships!.listForMember = vi.fn(async () =>
      options.member === false ? [] : [buildMembership()],
    );
    repos.entityPages = {
      getByOwner: vi.fn(async () => ({ id: PAGE_ID, visibility: "PUBLIC" })),
      listBlocks: vi.fn(async () => [MAIN_BLOCK, MEMBER_BLOCK]),
    };
    return repos as unknown as Ctx["repos"];
  };

  it("requires authentication", async () => {
    const { caller } = createCaller(membershipsRouter, {
      repos: makeMemberBlocksRepos(),
      actorHumanId: null,
      auth: null,
      authToken: null,
    });

    await expect(
      caller.memberBlocks({ ownerType: "ORGANIZATION", ownerId: ORG_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns only memberships-section blocks for a member, keying on the SESSION actor", async () => {
    const repos = makeMemberBlocksRepos();
    const { caller } = createCaller(membershipsRouter, {
      repos,
      actorHumanId: MEMBER_ID,
    });

    const result = await caller.memberBlocks({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
    });

    expect(result.blocks.map((b: { id: string }) => b.id)).toEqual([
      "b-members",
    ]);
    // The membership gate keys on the session, in benefit-granting statuses.
    expect(repos.memberships.listForMember).toHaveBeenCalledWith({
      memberHumanId: MEMBER_ID,
      statuses: ["active", "trialing"],
    });
  });

  it("rejects a client-supplied actorHumanId (strict schema)", async () => {
    const { caller } = createCaller(membershipsRouter, {
      repos: makeMemberBlocksRepos(),
      actorHumanId: MEMBER_ID,
    });

    await expect(
      caller.memberBlocks({
        actorHumanId: ACTOR_ID, // spoof attempt
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns an EMPTY list — not an error — for a signed-in non-member, without touching the blocks", async () => {
    const repos = makeMemberBlocksRepos({ member: false });
    const { caller } = createCaller(membershipsRouter, {
      repos,
      actorHumanId: MEMBER_ID,
    });

    const result = await caller.memberBlocks({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
    });

    expect(result).toEqual({ blocks: [] });
    expect(
      (repos as unknown as Record<string, Record<string, unknown>>).entityPages!
        .listBlocks,
    ).not.toHaveBeenCalled();
  });
});

