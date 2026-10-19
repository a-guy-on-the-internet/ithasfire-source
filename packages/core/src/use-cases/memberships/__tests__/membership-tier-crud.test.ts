import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MembershipTierRecord } from "@th/ports/repos/membership-tiers";

import { archiveMembershipTier } from "../archive-membership-tier";
import { startMembership } from "../start-membership";
import { updateMembershipTier } from "../update-membership-tier";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const TIER_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";

describe("updateMembershipTier", () => {
  it("edits name/description/sortOrder/price on an unpublished draft", async () => {
    const ctx = makeCtx({ tier: buildTier() });

    await updateMembershipTier(ctx.deps, {
      actorHumanId: ACTOR_ID,
      tierId: TIER_ID,
      name: "Backer",
      description: "Support the room",
      priceCents: 2500,
      sortOrder: 3,
    });

    expect(ctx.tiers.update).toHaveBeenCalledWith({
      id: TIER_ID,
      name: "Backer",
      description: "Support the room",
      priceCents: 2500,
      sortOrder: 3,
    });
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "membership_tier",
        action: "membership_tier.updated",
      }),
    );
  });

  it("refuses a price change once the tier has EVER had a subscriber — any status", async () => {
    const ctx = makeCtx({ tier: buildTier(), subscriberCountEver: 1 });

    await expect(
      updateMembershipTier(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        priceCents: 2500,
      }),
    ).rejects.toMatchObject({
      code: "MEMBERSHIP_TIER_PRICE_LOCKED",
      meta: expect.objectContaining({ reason: "has_subscribers" }),
    });
    expect(ctx.tiers.update).not.toHaveBeenCalled();
  });

  it("refuses a price change once a Stripe Price is minted, even with zero subscribers", async () => {
    // Publish short-circuits when stripePriceId is set, so an edited
    // priceCents would never re-mint — new members would be billed the OLD
    // amount while the admin believes the price changed.
    const ctx = makeCtx({
      tier: buildTier({ stripePriceId: "price_1", stripeProductId: "prod_1" }),
    });

    await expect(
      updateMembershipTier(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        priceCents: 2500,
      }),
    ).rejects.toMatchObject({
      code: "MEMBERSHIP_TIER_PRICE_LOCKED",
      meta: expect.objectContaining({ reason: "price_minted" }),
    });
    expect(ctx.tiers.update).not.toHaveBeenCalled();
  });

  it("treats an unchanged price as no price change — editable alongside other fields", async () => {
    const ctx = makeCtx({ tier: buildTier(), subscriberCountEver: 12 });

    await updateMembershipTier(ctx.deps, {
      actorHumanId: ACTOR_ID,
      tierId: TIER_ID,
      priceCents: 1000, // same as current
      name: "Renamed",
    });

    expect(ctx.tiers.update).toHaveBeenCalledWith({
      id: TIER_ID,
      name: "Renamed",
    });
  });

  it("edits benefitsDescription even on a published tier with live members", async () => {
    // The field it replaced (taxCategory) was permanently locked the moment a
    // tier had live subscribers. This one is the opposite by construction:
    // it describes an entitlement resolved fresh at every checkout, nothing
    // about it is minted into Stripe, and past orders keep the discount they
    // already recorded — so there is nothing a live member could desync from.
    const ctx = makeCtx({
      tier: buildTier({ status: "ACTIVE", stripePriceId: "price_1" }),
      subscriberCountEver: 40,
    });

    await updateMembershipTier(ctx.deps, {
      actorHumanId: ACTOR_ID,
      tierId: TIER_ID,
      benefitsDescription: "Two guest-list spots a month",
    });

    expect(ctx.tiers.update).toHaveBeenCalledWith({
      id: TIER_ID,
      benefitsDescription: "Two guest-list spots a month",
    });
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          changed: expect.objectContaining({ benefitsDescription: true }),
        }),
      }),
    );
  });

  it("rejects taxCategory outright — the field is gone, not merely ignored", async () => {
    const ctx = makeCtx({ tier: buildTier() });

    // `.strict()` throwing is the point. A stale client still posting the old
    // form field must not get a 200 that silently drops it — that reads to the
    // owner as "category saved" when every tier is, and stays, DIGITAL. The
    // lock this replaced (MEMBERSHIP_TIER_TAX_CATEGORY_LOCKED) no longer
    // exists in @th/errors, so there is no softer refusal to fall back to.
    await expect(
      updateMembershipTier(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        taxCategory: "ADMISSION",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(ctx.tiers.update).not.toHaveBeenCalled();
  });

  it("refuses to edit an archived tier", async () => {
    const ctx = makeCtx({ tier: buildTier({ status: "ARCHIVED" }) });

    await expect(
      updateMembershipTier(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        name: "Zombie",
      }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_TIER_ARCHIVED" });
  });

  it("refuses an actor without a finance role", async () => {
    const ctx = makeCtx({ tier: buildTier(), orgRole: "VIEWER" });

    await expect(
      updateMembershipTier(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        name: "Nope",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.tiers.update).not.toHaveBeenCalled();
  });

  it("refuses a non-owner actor on a human-owned tier", async () => {
    const ctx = makeCtx({
      tier: buildTier({ ownerOrgId: null, ownerHumanId: HUMAN_ID }),
    });

    await expect(
      updateMembershipTier(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        name: "Nope",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("404s on an unknown tier", async () => {
    const ctx = makeCtx({ tier: null });

    await expect(
      updateMembershipTier(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        name: "Ghost",
      }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_TIER_NOT_FOUND" });
  });
});

describe("archiveMembershipTier", () => {
  it("archives and audit-logs", async () => {
    const ctx = makeCtx({ tier: buildTier({ status: "ACTIVE" }) });

    const result = await archiveMembershipTier(ctx.deps, {
      actorHumanId: ACTOR_ID,
      tierId: TIER_ID,
    });

    expect(ctx.tiers.update).toHaveBeenCalledWith({
      id: TIER_ID,
      status: "ARCHIVED",
    });
    expect(result.status).toBe("ARCHIVED");
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "membership_tier.archived" }),
    );
  });

  it("is idempotent — archiving an archived tier writes nothing", async () => {
    const ctx = makeCtx({ tier: buildTier({ status: "ARCHIVED" }) });

    const result = await archiveMembershipTier(ctx.deps, {
      actorHumanId: ACTOR_ID,
      tierId: TIER_ID,
    });

    expect(result.status).toBe("ARCHIVED");
    expect(ctx.tiers.update).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("refuses an actor without a finance role", async () => {
    const ctx = makeCtx({
      tier: buildTier({ status: "ACTIVE" }),
      orgRole: "EDITOR",
    });

    await expect(
      archiveMembershipTier(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("startMembership refuses an archived tier — archive really closes the door", async () => {
    const ctx = makeCtx({
      tier: buildTier({ status: "ARCHIVED", stripePriceId: "price_1" }),
    });

    await expect(
      startMembership(
        {
          repos: ctx.deps.repos,
          membershipBilling: {} as never,
          taxRateLookup: {} as never,
          clock: { now: () => new Date() } as never,
        },
        {
          tierId: TIER_ID,
          memberHumanId: HUMAN_ID,
          billingCountryCode: "US",
          billingPostalCode: "37203",
        },
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_TIER_NOT_ACTIVE" });
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
    subscriberCountEver?: number;
    orgRole?: string | null;
  } = {},
) {
  const tier = options.tier === undefined ? buildTier() : options.tier;

  const tiers = {
    findById: vi.fn(async () => tier),
    update: vi.fn(
      async (input: Partial<MembershipTierRecord> & { id: string }) =>
        buildTier({ ...(tier ?? {}), ...input }),
    ),
    countSubscribers: vi.fn(async () => options.subscriberCountEver ?? 0),
  };

  // No live-subscriber count here on purpose: the only reader was the deleted
  // tax-category lock. `countSubscribers` (ever, any status) is what still
  // gates anything — the price freeze.
  const memberships = {
    findForMemberAndTier: vi.fn(async () => null),
  };

  const standings = {
    findForOwner: vi.fn(async () => null),
  };

  const orgRole = options.orgRole === undefined ? "OWNER" : options.orgRole;
  const authz = {
    getOrgMembership: vi.fn(async () =>
      orgRole ? { orgId: ORG_ID, humanId: ACTOR_ID, role: orgRole } : null,
    ),
  };

  const audit = { log: vi.fn(async () => undefined) };

  return {
    tiers,
    memberships,
    authz,
    audit,
    deps: {
      repos: {
        membershipTiers: tiers,
        memberships,
        membershipStandings: standings,
        authz,
        audit,
      } as unknown as Repos,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    },
  };
}
