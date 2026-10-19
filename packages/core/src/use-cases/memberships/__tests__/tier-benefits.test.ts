import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type {
  MembershipTierBenefitRecord,
  MembershipTierRecord,
} from "@th/ports/repos/membership-tiers";

import { attachTierBenefit } from "../attach-tier-benefit";
import { updateTierBenefit } from "../update-tier-benefit";
import { removeTierBenefit } from "../remove-tier-benefit";

// ─────────────────────────────────────────────────────────────────────────────
// Benefit CRUD.
//
// The cross-tenant guard that used to live here — `ensurePromoScopeOwnedByOwner`
// refusing a promo scoped to somebody else — is GONE, and deliberately so: a
// benefit no longer references a promo, so there is no foreign scope to attach.
// The guard moved into the model itself (`resolveMemberBenefits` derives each
// grant's ownerScope from the tier's owner) and is pinned in
// `resolve-member-benefits.test.ts` and `checkout-promos.test.ts`. What remains
// enforceable HERE is tier ownership and term validity.
// ─────────────────────────────────────────────────────────────────────────────

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const TIER_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";
const BENEFIT_ID = "66666666-6666-4666-8666-666666666666";
const PLACE_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-08-20T12:00:00.000Z");

describe("attachTierBenefit", () => {
  it("creates a benefit carrying its own terms", async () => {
    const ctx = makeCtx();

    const result = await attachTierBenefit(ctx.deps, {
      actorHumanId: ACTOR_ID,
      tierId: TIER_ID,
      discountKind: "AMOUNT",
      discountValue: 500,
      placeId: PLACE_ID,
    });

    expect(ctx.tiers.createBenefit).toHaveBeenCalledWith({
      tierId: TIER_ID,
      discountKind: "AMOUNT",
      discountValue: 500,
      maxDiscountCents: null,
      categoryId: null,
      placeId: PLACE_ID,
      label: null,
    });
    expect(result).toMatchObject({
      id: BENEFIT_ID,
      discountKind: "AMOUNT",
      discountValue: 500,
    });
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "membership_tier.benefit_attached" }),
    );
  });

  it("never reads or writes anything promo-shaped", async () => {
    const ctx = makeCtx();

    const result = await attachTierBenefit(ctx.deps, {
      actorHumanId: ACTOR_ID,
      tierId: TIER_ID,
      discountKind: "PERCENT",
      discountValue: 20,
    });

    expect(ctx.promos.getById).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/promoId|"code"/);
  });

  it("attaches on a human-owned tier with no promo-ownership check to pass", async () => {
    const ctx = makeCtx({
      tier: buildTier({ ownerOrgId: null, ownerHumanId: HUMAN_ID }),
    });

    await expect(
      attachTierBenefit(ctx.deps, {
        actorHumanId: HUMAN_ID,
        tierId: TIER_ID,
        discountKind: "AMOUNT",
        discountValue: 250,
      }),
    ).resolves.toMatchObject({ discountValue: 250 });
  });

  describe("term validation", () => {
    const invalid: Array<{ name: string; terms: Record<string, unknown> }> = [
      {
        name: "PERCENT above 100",
        terms: { discountKind: "PERCENT", discountValue: 101 },
      },
      {
        name: "a cap below the AMOUNT it caps",
        terms: {
          discountKind: "AMOUNT",
          discountValue: 1000,
          maxDiscountCents: 500,
        },
      },
    ];

    for (const { name, terms } of invalid) {
      it(`refuses ${name}`, async () => {
        const ctx = makeCtx();
        await expect(
          attachTierBenefit(ctx.deps, {
            actorHumanId: ACTOR_ID,
            tierId: TIER_ID,
            ...terms,
          }),
        ).rejects.toMatchObject({ code: "MEMBERSHIP_BENEFIT_INVALID_TERMS" });
        expect(ctx.tiers.createBenefit).not.toHaveBeenCalled();
      });
    }

    it("refuses a zero discount at the schema boundary", async () => {
      const ctx = makeCtx();
      await expect(
        attachTierBenefit(ctx.deps, {
          actorHumanId: ACTOR_ID,
          tierId: TIER_ID,
          discountKind: "AMOUNT",
          discountValue: 0,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(ctx.tiers.createBenefit).not.toHaveBeenCalled();
    });
  });

  it("returns the existing row instead of stacking a duplicate", async () => {
    const ctx = makeCtx({
      existingBenefits: [buildBenefit({ discountKind: "AMOUNT", discountValue: 500 })],
    });

    const result = await attachTierBenefit(ctx.deps, {
      actorHumanId: ACTOR_ID,
      tierId: TIER_ID,
      discountKind: "AMOUNT",
      discountValue: 500,
    });

    expect(result.id).toBe(BENEFIT_ID);
    expect(ctx.tiers.createBenefit).not.toHaveBeenCalled();
  });

  it("refuses an archived tier", async () => {
    const ctx = makeCtx({ tier: buildTier({ status: "ARCHIVED" }) });

    await expect(
      attachTierBenefit(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        discountKind: "AMOUNT",
        discountValue: 500,
      }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_TIER_ARCHIVED" });
  });

  it("refuses an actor without a finance role", async () => {
    const ctx = makeCtx({ orgRole: "SCANNER" });

    await expect(
      attachTierBenefit(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        discountKind: "AMOUNT",
        discountValue: 500,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.tiers.createBenefit).not.toHaveBeenCalled();
  });
});

describe("updateTierBenefit", () => {
  it("edits terms in place regardless of subscriber count", async () => {
    // Nothing about a benefit is locked by live members: it is resolved fresh
    // at every checkout, there is no Stripe object behind it, and past orders
    // keep the discount they recorded.
    const ctx = makeCtx({ benefitById: buildBenefit() });

    const result = await updateTierBenefit(ctx.deps, {
      actorHumanId: ACTOR_ID,
      tierId: TIER_ID,
      benefitId: BENEFIT_ID,
      discountKind: "PERCENT",
      discountValue: 25,
      maxDiscountCents: 1500,
      label: "Members save",
    });

    expect(ctx.tiers.updateBenefit).toHaveBeenCalledWith({
      id: BENEFIT_ID,
      discountKind: "PERCENT",
      discountValue: 25,
      maxDiscountCents: 1500,
      categoryId: null,
      placeId: null,
      label: "Members save",
    });
    expect(result).toMatchObject({ discountKind: "PERCENT", discountValue: 25 });
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "membership_tier.benefit_updated" }),
    );
  });

  it("404s when the benefit belongs to a DIFFERENT tier — no cross-tier probing", async () => {
    const ctx = makeCtx({
      benefitById: buildBenefit({ tierId: "12121212-1212-4121-8121-121212121212" }),
    });

    await expect(
      updateTierBenefit(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        benefitId: BENEFIT_ID,
        discountKind: "AMOUNT",
        discountValue: 100,
      }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_BENEFIT_NOT_FOUND" });
    expect(ctx.tiers.updateBenefit).not.toHaveBeenCalled();
  });

  it("applies the SAME term rules as attach", async () => {
    const ctx = makeCtx({ benefitById: buildBenefit() });

    await expect(
      updateTierBenefit(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        benefitId: BENEFIT_ID,
        discountKind: "PERCENT",
        discountValue: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(ctx.tiers.updateBenefit).not.toHaveBeenCalled();
  });

  it("refuses an actor without a finance role", async () => {
    const ctx = makeCtx({ benefitById: buildBenefit(), orgRole: null });

    await expect(
      updateTierBenefit(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        benefitId: BENEFIT_ID,
        discountKind: "AMOUNT",
        discountValue: 100,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.tiers.updateBenefit).not.toHaveBeenCalled();
  });
});

describe("removeTierBenefit", () => {
  it("RETIRES rather than deletes — the discount ledger keeps its FK", async () => {
    // The externally-visible contract is unchanged (the benefit stops granting
    // and vanishes from every admin read), but the row survives so the
    // PromoRedemption rows it produced keep their foreign key. Hard-deleting
    // used to cascade those away — erasing the platform's record of granted
    // margin from an ordinary product action with no destructive-action
    // warning. This asserts the USE CASE still calls the same repo method;
    // that the method now soft-deletes is pinned in the adapter test.
    const ctx = makeCtx({ benefitById: buildBenefit() });

    const result = await removeTierBenefit(ctx.deps, {
      actorHumanId: ACTOR_ID,
      tierId: TIER_ID,
      benefitId: BENEFIT_ID,
    });

    expect(result).toEqual({ benefitId: BENEFIT_ID, removed: true });
    expect(ctx.tiers.deleteBenefit).toHaveBeenCalledWith({
      id: BENEFIT_ID,
      archivedAt: NOW,
    });
  });

  it("removes and audit-logs", async () => {
    const ctx = makeCtx({ benefitById: buildBenefit() });

    const result = await removeTierBenefit(ctx.deps, {
      actorHumanId: ACTOR_ID,
      tierId: TIER_ID,
      benefitId: BENEFIT_ID,
    });

    // The instant comes from the injected clock, not the adapter's wall time,
    // so a retirement is reproducible from a fixed clock like every other
    // archive in this domain.
    expect(ctx.tiers.deleteBenefit).toHaveBeenCalledWith({
      id: BENEFIT_ID,
      archivedAt: NOW,
    });
    expect(result).toEqual({ benefitId: BENEFIT_ID, removed: true });
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "membership_tier.benefit_removed" }),
    );
  });

  it("404s when the benefit belongs to a DIFFERENT tier — no cross-tier probing", async () => {
    const ctx = makeCtx({
      benefitById: buildBenefit({ tierId: "12121212-1212-4121-8121-121212121212" }),
    });

    await expect(
      removeTierBenefit(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        benefitId: BENEFIT_ID,
      }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_BENEFIT_NOT_FOUND" });
    expect(ctx.tiers.deleteBenefit).not.toHaveBeenCalled();
  });

  it("404s on an unknown benefit", async () => {
    const ctx = makeCtx({ benefitById: null });

    await expect(
      removeTierBenefit(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        benefitId: BENEFIT_ID,
      }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_BENEFIT_NOT_FOUND" });
  });

  it("refuses an actor without a finance role", async () => {
    const ctx = makeCtx({ orgRole: null });

    await expect(
      removeTierBenefit(ctx.deps, {
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        benefitId: BENEFIT_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.tiers.deleteBenefit).not.toHaveBeenCalled();
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

function buildBenefit(
  overrides: Partial<MembershipTierBenefitRecord> = {},
): MembershipTierBenefitRecord {
  return {
    id: BENEFIT_ID,
    tierId: TIER_ID,
    discountKind: "AMOUNT",
    discountValue: 500,
    maxDiscountCents: null,
    categoryId: null,
    placeId: null,
    label: null,
    ...overrides,
  };
}

function makeCtx(
  options: {
    tier?: MembershipTierRecord | null;
    existingBenefits?: MembershipTierBenefitRecord[];
    benefitById?: MembershipTierBenefitRecord | null;
    orgRole?: string | null;
  } = {},
) {
  const tier = options.tier === undefined ? buildTier() : options.tier;

  const tiers = {
    findById: vi.fn(async () => tier),
    listBenefitsForTiers: vi.fn(async () => options.existingBenefits ?? []),
    createBenefit: vi.fn(
      async (
        input: Omit<MembershipTierBenefitRecord, "id" | "maxDiscountCents" | "label"> & {
          maxDiscountCents?: number | null;
          label?: string | null;
        },
      ): Promise<MembershipTierBenefitRecord> => ({
        id: BENEFIT_ID,
        tierId: input.tierId,
        discountKind: input.discountKind,
        discountValue: input.discountValue,
        maxDiscountCents: input.maxDiscountCents ?? null,
        categoryId: input.categoryId ?? null,
        placeId: input.placeId ?? null,
        label: input.label ?? null,
      }),
    ),
    updateBenefit: vi.fn(
      async (input: { id: string } & Partial<MembershipTierBenefitRecord>) =>
        buildBenefit({ ...input, id: input.id }),
    ),
    findBenefitById: vi.fn(async () => options.benefitById ?? null),
    deleteBenefit: vi.fn(async () => undefined),
  };

  const promos = { getById: vi.fn(async () => null) };
  const events = { getById: vi.fn(async () => null) };

  const orgRole = options.orgRole === undefined ? "OWNER" : options.orgRole;
  const authz = {
    getOrgMembership: vi.fn(async () =>
      orgRole ? { orgId: ORG_ID, humanId: ACTOR_ID, role: orgRole } : null,
    ),
  };

  const audit = { log: vi.fn(async () => undefined) };

  return {
    tiers,
    promos,
    audit,
    deps: {
      repos: {
        membershipTiers: tiers,
        promos,
        events,
        authz,
        audit,
      } as unknown as Repos,
      clock: { now: () => NOW },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    },
  };
}
