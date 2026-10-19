import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MembershipTierRecord } from "@th/ports/repos/membership-tiers";

import { createMembershipTier } from "../create-membership-tier";
import { publishMembershipTier } from "../publish-membership-tier";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const TIER_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";

describe("createMembershipTier", () => {
  it("creates a DRAFT and mints no Stripe objects", async () => {
    const ctx = makeCtx();

    await createMembershipTier(ctx.deps, baseTierInput());

    expect(ctx.tiers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerOrgId: ORG_ID,
        ownerHumanId: null,
        priceCents: 1000,
        currency: "usd",
        interval: "MONTH",
      }),
    );
    // Stripe Prices are immutable — minting one per edit of an unfinished
    // draft would leave permanent orphans.
    expect(ctx.billing.ensureProduct).not.toHaveBeenCalled();
    expect(ctx.billing.createPrice).not.toHaveBeenCalled();
  });

  it("writes no tax category at all — the concept is gone, not defaulted", async () => {
    const ctx = makeCtx();

    // A category could never move a rate: TaxRateLookupPort takes only
    // {postalCode, countryCode} and returns ONE rate. All it ever did was
    // split a ZIP's jurisdiction cache into a row and a provider call per
    // category, while implying a tax determination nobody made. Pinning the
    // ABSENCE is what stops it being reintroduced as a "harmless" default.
    await createMembershipTier(ctx.deps, baseTierInput());

    const written = ctx.tiers.create.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(written).not.toHaveProperty("taxCategory");

    // And a stale client fails LOUDLY rather than appearing to set a category
    // we would silently never honour — the strict schema refuses the key.
    await expect(
      createMembershipTier(ctx.deps, {
        ...baseTierInput(),
        taxCategory: "ADMISSION",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a tier owned by both an org and a human", async () => {
    const ctx = makeCtx();

    await expect(
      createMembershipTier(ctx.deps, {
        ...baseTierInput(),
        ownerHumanId: HUMAN_ID,
      }),
    ).rejects.toThrow();
  });

  it("rejects a tier owned by neither", async () => {
    const ctx = makeCtx();

    await expect(
      createMembershipTier(ctx.deps, {
        ...baseTierInput(),
        ownerOrgId: null,
      }),
    ).rejects.toThrow();
  });

  it("refuses when the owner's memberships are suspended", async () => {
    const ctx = makeCtx({ suspended: true });

    await expect(
      createMembershipTier(ctx.deps, baseTierInput()),
    ).rejects.toMatchObject({ code: "MEMBERSHIPS_SUSPENDED" });
  });

  it("allows a human-owned tier — there is no ticket-volume gate", async () => {
    const ctx = makeCtx();

    // A solo artist with zero ticket sales can still open memberships: the $2
    // Connect fee is recovered from the payout, so they are self-funding.
    // The actor must BE the human owner.
    await createMembershipTier(ctx.deps, {
      ...baseTierInput(),
      actorHumanId: HUMAN_ID,
      ownerOrgId: null,
      ownerHumanId: HUMAN_ID,
    });

    expect(ctx.tiers.create).toHaveBeenCalledWith(
      expect.objectContaining({ ownerHumanId: HUMAN_ID, ownerOrgId: null }),
    );
  });

  it("refuses a human-owned tier created by someone else", async () => {
    const ctx = makeCtx();

    await expect(
      createMembershipTier(ctx.deps, {
        ...baseTierInput(),
        actorHumanId: ACTOR_ID,
        ownerOrgId: null,
        ownerHumanId: HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(ctx.tiers.create).not.toHaveBeenCalled();
  });

  it("refuses an org tier when the actor lacks a finance role", async () => {
    const ctx = makeCtx({ orgRole: "VIEWER" });

    await expect(
      createMembershipTier(ctx.deps, baseTierInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.tiers.create).not.toHaveBeenCalled();
  });
});

describe("publishMembershipTier", () => {
  it("mints product + price and activates", async () => {
    const ctx = makeCtx({ tier: buildTier() });

    const result = await publishMembershipTier(ctx.deps, { actorHumanId: ACTOR_ID, tierId: TIER_ID });

    expect(ctx.billing.ensureProduct).toHaveBeenCalledWith(
      expect.objectContaining({ tierId: TIER_ID }),
    );
    expect(ctx.billing.createPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "prod_1",
        unitAmountCents: 1000,
        interval: "month",
      }),
    );
    expect(ctx.tiers.attachStripeIds).toHaveBeenCalledWith({
      id: TIER_ID,
      stripeProductId: "prod_1",
      stripePriceId: "price_1",
    });
    expect(result.status).toBe("ACTIVE");
  });

  it("is idempotent — a republish mints no second Price but still heals the Product", async () => {
    const ctx = makeCtx({
      tier: buildTier({
        stripeProductId: "prod_1",
        stripePriceId: "price_1",
        status: "ACTIVE",
      }),
    });

    await publishMembershipTier(ctx.deps, { actorHumanId: ACTOR_ID, tierId: TIER_ID });

    // A second Price would silently bill new members a different amount from
    // existing ones — the worst kind of double-click bug.
    expect(ctx.billing.createPrice).not.toHaveBeenCalled();
    // ensureProduct DOES run on republish: Products are mutable, and this is
    // the repair path for products minted before statement descriptors
    // existed (the adapter updates the descriptor when it differs).
    expect(ctx.billing.ensureProduct).toHaveBeenCalledTimes(1);
    expect(ctx.billing.ensureProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        tierId: TIER_ID,
        statementDescriptor: "DRKMTTR COLLECTIVE",
      }),
    );
  });

  it("passes the ORG owner's name, sanitised, as the statement descriptor", async () => {
    // Dispute-prevention item 1: the member's card statement must show the
    // venue they knowingly support, inside Stripe's 22-char cap.
    const ctx = makeCtx({
      tier: buildTier(),
      orgName: "The East Nashville Community Arts Collective",
    });

    await publishMembershipTier(ctx.deps, { actorHumanId: ACTOR_ID, tierId: TIER_ID });

    expect(ctx.billing.ensureProduct).toHaveBeenCalledWith(
      expect.objectContaining({ statementDescriptor: "THE EAST NASHVILLE" }),
    );
  });

  it("uses the HUMAN owner's name for a human-owned tier", async () => {
    const ctx = makeCtx({
      tier: buildTier({ ownerOrgId: null, ownerHumanId: ACTOR_ID }),
      humanName: "Jess Vigeant",
    });

    await publishMembershipTier(ctx.deps, { actorHumanId: ACTOR_ID, tierId: TIER_ID });

    expect(ctx.organizations.getByIds).not.toHaveBeenCalled();
    expect(ctx.billing.ensureProduct).toHaveBeenCalledWith(
      expect.objectContaining({ statementDescriptor: "JESS VIGEANT" }),
    );
  });

  it("falls back to MEMBERSHIP when the owner row has no usable name", async () => {
    const ctx = makeCtx({ tier: buildTier(), orgName: null });

    await publishMembershipTier(ctx.deps, { actorHumanId: ACTOR_ID, tierId: TIER_ID });

    // A missing display name must not block a publish — the descriptor just
    // degrades to the branded fallback.
    expect(ctx.billing.ensureProduct).toHaveBeenCalledWith(
      expect.objectContaining({ statementDescriptor: "MEMBERSHIP" }),
    );
  });

  it("keys the price idempotency on the amount so a real price change can mint a new one", async () => {
    const ctx = makeCtx({ tier: buildTier({ priceCents: 2500 }) });

    await publishMembershipTier(ctx.deps, { actorHumanId: ACTOR_ID, tierId: TIER_ID });

    expect(ctx.billing.createPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `membership-tier-price:${TIER_ID}:2500`,
      }),
    );
  });

  it("maps a YEAR interval to Stripe's 'year'", async () => {
    const ctx = makeCtx({ tier: buildTier({ interval: "YEAR" }) });

    await publishMembershipTier(ctx.deps, { actorHumanId: ACTOR_ID, tierId: TIER_ID });

    expect(ctx.billing.createPrice).toHaveBeenCalledWith(
      expect.objectContaining({ interval: "year" }),
    );
  });

  it("refuses to publish an archived tier", async () => {
    const ctx = makeCtx({ tier: buildTier({ status: "ARCHIVED" }) });

    await expect(
      publishMembershipTier(ctx.deps, { actorHumanId: ACTOR_ID, tierId: TIER_ID }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_TIER_ARCHIVED" });
  });

  it("refuses to publish while suspended", async () => {
    const ctx = makeCtx({ tier: buildTier(), suspended: true });

    await expect(
      publishMembershipTier(ctx.deps, { actorHumanId: ACTOR_ID, tierId: TIER_ID }),
    ).rejects.toMatchObject({ code: "MEMBERSHIPS_SUSPENDED" });
    expect(ctx.billing.createPrice).not.toHaveBeenCalled();
  });

  it("404s on an unknown tier", async () => {
    const ctx = makeCtx({ tier: null });

    await expect(
      publishMembershipTier(ctx.deps, { actorHumanId: ACTOR_ID, tierId: TIER_ID }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_TIER_NOT_FOUND" });
  });
});

// ── Harness ────────────────────────────────────────────────────────────────

function baseTierInput() {
  return {
    actorHumanId: ACTOR_ID,
    ownerOrgId: ORG_ID,
    name: "Sustaining Member",
    priceCents: 1000,
    currency: "USD",
    interval: "MONTH" as const,
  };
}

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
    status: "DRAFT",
    sortOrder: 0,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    updatedAt: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  };
}

function makeCtx(
  options: {
    tier?: MembershipTierRecord | null;
    suspended?: boolean;
    /** Org role the actor holds (null = not a member). Defaults to OWNER. */
    orgRole?: string | null;
    /** Owner display names backing the statement descriptor. */
    orgName?: string | null;
    humanName?: string | null;
  } = {},
) {
  const tiers = {
    create: vi.fn(async (input: Record<string, unknown>) =>
      buildTier(input as Partial<MembershipTierRecord>),
    ),
    findById: vi.fn(async () =>
      options.tier === undefined ? buildTier() : options.tier,
    ),
    listForOwner: vi.fn(async () => []),
    update: vi.fn(async (input: { id: string; status?: string }) =>
      buildTier({ status: (input.status ?? "DRAFT") as never }),
    ),
    attachStripeIds: vi.fn(async () =>
      buildTier({ stripeProductId: "prod_1", stripePriceId: "price_1" }),
    ),
    countSubscribers: vi.fn(async () => 0),
  };

  const standings = {
    findForOwner: vi.fn(async () =>
      options.suspended ? { suspended: true } : null,
    ),
    upsertForOwner: vi.fn(async () => ({ suspended: false })),
  };

  const orgRole = options.orgRole === undefined ? "OWNER" : options.orgRole;
  const authz = {
    getOrgMembership: vi.fn(async () =>
      orgRole ? { orgId: ORG_ID, humanId: ACTOR_ID, role: orgRole } : null,
    ),
  };

  const billing = {
    ensureCustomer: vi.fn(async () => ({ customerId: "cus_1" })),
    ensureProduct: vi.fn(async () => ({ productId: "prod_1" })),
    createPrice: vi.fn(async () => ({ priceId: "price_1" })),
    ensureTaxRate: vi.fn(async () => ({ taxRateId: "txr_1" })),
    createSubscription: vi.fn(),
    updateSubscriptionTaxRates: vi.fn(),
    cancelSubscription: vi.fn(),
    getSubscription: vi.fn(),
    createPortalSession: vi.fn(),
  };

  // Owner display names — the statement-descriptor source.
  const organizations = {
    getByIds: vi.fn(async (ids: string[]) =>
      options.orgName === null
        ? []
        : ids.map((id) => ({
            id,
            name: options.orgName ?? "DRKMTTR Collective",
          })),
    ),
  };
  const humans = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: options.humanName ?? "Jess Vigeant" })),
    ),
  };

  return {
    tiers,
    standings,
    authz,
    billing,
    organizations,
    humans,
    deps: {
      repos: {
        membershipTiers: tiers,
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
