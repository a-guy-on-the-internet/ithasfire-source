import { describe, expect, it, vi } from "vitest";

import { DEMO_IDS } from "../src/scripts/seed/ids.js";
import { ensureMembershipFixtures } from "../src/scripts/seed/memberships.js";

/**
 * DRIFT GUARD for the membership seed fixtures.
 *
 * These are DISPLAY fixtures. Their one hard constraint is that no scheduled
 * job can ever act on them, which is the same rule the payout fixtures had to
 * learn: `seed/payouts.ts` dropped its reserve columns because the payout
 * batch's reserve sweep would otherwise have replayed holds for payouts that
 * never happened.
 *
 * The membership equivalent is the tax-jurisdiction linkage.
 * `memberships.refresh-tax-jurisdictions` selects memberships by
 * `listByTaxJurisdictionId` and repoints each one's Stripe
 * `default_tax_rates` through the real Billing API — so a fixture carrying a
 * jurisdiction would put `sub_seed_*` into that call the first time any rate
 * changed. These tests fail the moment someone "helpfully" fills those columns
 * in, which is the only place that decision can be caught before it reaches a
 * job.
 */

type CreateCall = { data: Record<string, unknown> };

function makeFakePrisma() {
  const tierCreates: CreateCall[] = [];
  const membershipCreates: CreateCall[] = [];
  const existingTierIds = new Set<string>();
  const existingMembershipIds = new Set<string>();

  const prisma = {
    organization: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id })),
      ),
    },
    human: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id })),
      ),
    },
    membershipTier: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        existingTierIds.has(where.id) ? { id: where.id } : null,
      ),
      create: vi.fn(async (call: CreateCall) => {
        tierCreates.push(call);
        existingTierIds.add(call.data.id as string);
        return call.data;
      }),
    },
    membership: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            id?: string;
            tierId_memberHumanId?: { tierId: string; memberHumanId: string };
          };
        }) => {
          if (where.id) {
            return existingMembershipIds.has(where.id) ? { id: where.id } : null;
          }
          // No hand-created conflicting row in these tests.
          return null;
        },
      ),
      create: vi.fn(async (call: CreateCall) => {
        membershipCreates.push(call);
        existingMembershipIds.add(call.data.id as string);
        return call.data;
      }),
    },
  };

  return {
    prisma: prisma as never,
    tierCreates,
    membershipCreates,
    existingTierIds,
    existingMembershipIds,
  };
}

const NOW = new Date("2026-09-11T12:00:00.000Z");

describe("seed/memberships — inert to every scheduled job", () => {
  it("NEVER sets a tax jurisdiction on a membership", async () => {
    // `memberships.refresh-tax-jurisdictions` would chase these into the real
    // Stripe Billing API with an id Stripe has never heard of.
    const f = makeFakePrisma();
    await ensureMembershipFixtures(f.prisma, NOW);

    expect(f.membershipCreates.length).toBeGreaterThan(0);
    for (const call of f.membershipCreates) {
      expect(call.data.taxJurisdictionId).toBeUndefined();
      expect(call.data.billingPostalCode).toBeUndefined();
      expect(call.data.billingCountryCode).toBeUndefined();
    }
  });

  it("NEVER sets Stripe product/price ids on a tier", async () => {
    // A fake price id would make a "Join" click hit Stripe with a price that
    // does not exist, AND permanently block `publishMembershipTier` from ever
    // minting real objects for that tier (it early-returns when both are set).
    const f = makeFakePrisma();
    await ensureMembershipFixtures(f.prisma, NOW);

    expect(f.tierCreates.length).toBeGreaterThan(0);
    for (const call of f.tierCreates) {
      expect(call.data.stripeProductId).toBeUndefined();
      expect(call.data.stripePriceId).toBeUndefined();
    }
  });

  it("leaves canceledAt null — a cancel-at-period-end row is still live", async () => {
    const f = makeFakePrisma();
    await ensureMembershipFixtures(f.prisma, NOW);
    for (const call of f.membershipCreates) {
      expect(call.data.canceledAt).toBeUndefined();
    }
  });
});

describe("seed/memberships — fills gaps, never clobbers", () => {
  it("creates nothing on a second run", async () => {
    const f = makeFakePrisma();
    const first = await ensureMembershipFixtures(f.prisma, NOW);
    expect(first.tiers).toBeGreaterThan(0);
    expect(first.memberships).toBeGreaterThan(0);

    const second = await ensureMembershipFixtures(f.prisma, NOW);
    expect(second).toEqual({ tiers: 0, memberships: 0 });
  });

  it("never issues an update or a delete", async () => {
    const f = makeFakePrisma();
    await ensureMembershipFixtures(f.prisma, NOW);
    // The fake has no `update` / `delete` at all: calling one would throw, so
    // the run completing at all is the assertion. Restated explicitly so the
    // intent survives someone widening the fake.
    expect(
      (f.prisma as unknown as Record<string, Record<string, unknown>>)
        .membershipTier.update,
    ).toBeUndefined();
    expect(
      (f.prisma as unknown as Record<string, Record<string, unknown>>).membership
        .update,
    ).toBeUndefined();
  });

  it("skips memberships whose tier a previous run did not create", async () => {
    const f = makeFakePrisma();
    // Pretend the tiers already exist (a previous run made them) but the
    // memberships do not: every membership must still attach.
    f.existingTierIds.add(DEMO_IDS.membershipTierSustaining);
    const result = await ensureMembershipFixtures(f.prisma, NOW);

    expect(result.tiers).toBeGreaterThan(0);
    const sustainingRows = f.membershipCreates.filter(
      (c) => c.data.tierId === DEMO_IDS.membershipTierSustaining,
    );
    expect(sustainingRows.length).toBeGreaterThan(0);
  });

  it("skips a fixture whose OWNER org is absent, instead of crashing on the FK", async () => {
    const f = makeFakePrisma();
    f.prisma.organization.findMany = vi.fn(async () => []);
    const result = await ensureMembershipFixtures(f.prisma, NOW);

    // Only the human-owned tier survives.
    expect(f.tierCreates.map((c) => c.data.id)).toEqual([
      DEMO_IDS.membershipTierBacker,
    ]);
    expect(result.tiers).toBe(1);
  });

  it("skips a fixture whose MEMBER is absent", async () => {
    const f = makeFakePrisma();
    f.prisma.human.findMany = vi.fn(async () => []);
    const result = await ensureMembershipFixtures(f.prisma, NOW);
    expect(result.memberships).toBe(0);
  });
});

describe("seed/memberships — the states the platform surfaces branch on", () => {
  it("covers active, trialing, past_due, unpaid and incomplete", async () => {
    const f = makeFakePrisma();
    await ensureMembershipFixtures(f.prisma, NOW);
    const statuses = new Set(
      f.membershipCreates.map((c) => c.data.status as string),
    );
    expect(statuses).toEqual(
      new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]),
    );
  });

  it("includes a cancel-at-period-end row ending INSIDE the 14-day window", async () => {
    const f = makeFakePrisma();
    await ensureMembershipFixtures(f.prisma, NOW);
    const leaving = f.membershipCreates.filter(
      (c) => c.data.cancelAtPeriodEnd === true,
    );
    expect(leaving.length).toBeGreaterThanOrEqual(2);
    for (const row of leaving) {
      const end = row.data.currentPeriodEnd as Date;
      expect(end.getTime()).toBeGreaterThan(NOW.getTime());
      expect(end.getTime()).toBeLessThan(NOW.getTime() + 14 * 86_400_000);
      // Still LIVE: the "Leaving" section is about members who have not gone
      // yet. A canceled status would drop them out of the bucket entirely.
      expect(["active", "trialing"]).toContain(row.data.status);
    }
  });

  it("ages the incomplete signup past the 24h grace window", async () => {
    const f = makeFakePrisma();
    await ensureMembershipFixtures(f.prisma, NOW);
    const incomplete = f.membershipCreates.filter(
      (c) => c.data.status === "incomplete",
    );
    expect(incomplete).toHaveLength(1);
    const createdAt = incomplete[0]!.data.createdAt as Date;
    expect(NOW.getTime() - createdAt.getTime()).toBeGreaterThan(24 * 3_600_000);
  });

  it("prices the annual tier so the rounding remainder is non-zero", async () => {
    // An all-divisible fixture set would leave the remainder branch of the
    // revenue panel permanently unexercised in dev, which is exactly where a
    // rounding bug would hide.
    const f = makeFakePrisma();
    await ensureMembershipFixtures(f.prisma, NOW);

    const tierById = new Map(
      f.tierCreates.map((c) => [c.data.id as string, c.data]),
    );
    const activeByTier = new Map<string, number>();
    for (const m of f.membershipCreates) {
      if (m.data.status !== "active") continue;
      const tierId = m.data.tierId as string;
      activeByTier.set(tierId, (activeByTier.get(tierId) ?? 0) + 1);
    }

    let usdAnnualised = 0;
    for (const [tierId, count] of activeByTier) {
      const tier = tierById.get(tierId);
      if (!tier || tier.currency !== "usd") continue;
      const perMember =
        tier.interval === "YEAR"
          ? (tier.priceCents as number)
          : (tier.priceCents as number) * 12;
      usdAnnualised += perMember * count;
    }

    expect(usdAnnualised % 12).not.toBe(0);
  });

  it("covers an ORG-owned tier, a HUMAN-owned tier and a non-USD currency", async () => {
    const f = makeFakePrisma();
    await ensureMembershipFixtures(f.prisma, NOW);
    const tiers = f.tierCreates.map((c) => c.data);
    expect(tiers.some((t) => t.ownerOrgId && !t.ownerHumanId)).toBe(true);
    expect(tiers.some((t) => t.ownerHumanId && !t.ownerOrgId)).toBe(true);
    expect(tiers.some((t) => t.currency !== "usd")).toBe(true);
    // Exactly one owner per tier — the XOR core enforces and Prisma cannot.
    for (const t of tiers) {
      expect(Boolean(t.ownerOrgId) !== Boolean(t.ownerHumanId)).toBe(true);
    }
  });

  it("includes a DRAFT tier so 'N active / M total' is not always equal", async () => {
    const f = makeFakePrisma();
    await ensureMembershipFixtures(f.prisma, NOW);
    const statuses = f.tierCreates.map((c) => c.data.status);
    expect(statuses).toContain("DRAFT");
    expect(statuses).toContain("ACTIVE");
  });
});
