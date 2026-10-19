import type { MembershipBenefit, MembershipTier } from "@prisma/client";
import type {
  CreateMembershipTierInput,
  MembershipDiscountKind,
  MembershipInterval,
  MembershipOwnerTierStats,
  MembershipTierBenefitRecord,
  MembershipTierRecord,
  MembershipTierStatus,
  MembershipTiersRepo,
} from "@th/ports/repos/membership-tiers";

import type { PrismaClientOrTx } from "./types";

function mapTier(row: MembershipTier): MembershipTierRecord {
  return {
    id: row.id,
    ownerOrgId: row.ownerOrgId ?? null,
    ownerHumanId: row.ownerHumanId ?? null,
    name: row.name,
    description: row.description ?? null,
    benefitsDescription: row.benefitsDescription ?? null,
    priceCents: row.priceCents,
    currency: row.currency,
    interval: row.interval as MembershipInterval,
    stripeProductId: row.stripeProductId ?? null,
    stripePriceId: row.stripePriceId ?? null,
    status: row.status as MembershipTierStatus,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makeMembershipTiersRepo(
  p: PrismaClientOrTx,
): MembershipTiersRepo {
  return {
    create: async (input: CreateMembershipTierInput) => {
      const row = await p.membershipTier.create({
        data: {
          ownerOrgId: input.ownerOrgId ?? null,
          ownerHumanId: input.ownerHumanId ?? null,
          name: input.name,
          description: input.description ?? null,
          benefitsDescription: input.benefitsDescription ?? null,
          priceCents: input.priceCents,
          currency: input.currency,
          interval: input.interval,
          sortOrder: input.sortOrder ?? 0,
        },
      });
      return mapTier(row);
    },

    findById: async (id: string) => {
      const row = await p.membershipTier.findUnique({ where: { id } });
      return row ? mapTier(row) : null;
    },

    listByIds: async (ids: string[]) => {
      if (ids.length === 0) {
        return [];
      }
      const rows = await p.membershipTier.findMany({
        where: { id: { in: ids } },
      });
      return rows.map(mapTier);
    },

    listForOwner: async (input) => {
      const rows = await p.membershipTier.findMany({
        where: {
          ...(input.ownerOrgId ? { ownerOrgId: input.ownerOrgId } : {}),
          ...(input.ownerHumanId ? { ownerHumanId: input.ownerHumanId } : {}),
          ...(input.statuses?.length ? { status: { in: input.statuses } } : {}),
        },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      });
      return rows.map(mapTier);
    },

    update: async (input) => {
      const row = await p.membershipTier.update({
        where: { id: input.id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          ...(input.benefitsDescription === undefined
            ? {}
            : { benefitsDescription: input.benefitsDescription }),
          ...(input.priceCents === undefined
            ? {}
            : { priceCents: input.priceCents }),
          ...(input.sortOrder === undefined
            ? {}
            : { sortOrder: input.sortOrder }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
      });
      return mapTier(row);
    },

    attachStripeIds: async (input) => {
      const row = await p.membershipTier.update({
        where: { id: input.id },
        data: {
          stripeProductId: input.stripeProductId,
          stripePriceId: input.stripePriceId,
        },
      });
      return mapTier(row);
    },

    countSubscribers: async (tierId: string) =>
      p.membership.count({ where: { tierId } }),

    listOwnersWithTiers: async (input) => {
      // ONE query: every tier with a relation-filtered membership count, then
      // folded per owner in memory. `groupBy` can't count across a relation,
      // and a per-owner fan-out would be the N+1 this read exists to avoid.
      const tiers = await p.membershipTier.findMany({
        select: {
          ownerOrgId: true,
          ownerHumanId: true,
          status: true,
          _count: {
            select: {
              memberships: {
                where: { status: { in: input.memberStatuses } },
              },
            },
          },
        },
      });

      const byOwner = new Map<string, MembershipOwnerTierStats>();
      for (const tier of tiers) {
        // Exactly one owner id is set (enforced in core); a row with neither
        // is unattributable and skipped rather than invented as an owner.
        if (!tier.ownerOrgId && !tier.ownerHumanId) continue;
        const key = tier.ownerOrgId
          ? `ORG:${tier.ownerOrgId}`
          : `HUMAN:${tier.ownerHumanId}`;
        let stats = byOwner.get(key);
        if (!stats) {
          stats = {
            ownerOrgId: tier.ownerOrgId ?? null,
            ownerHumanId: tier.ownerHumanId ?? null,
            tierCount: 0,
            activeTierCount: 0,
            memberCount: 0,
          };
          byOwner.set(key, stats);
        }
        stats.tierCount += 1;
        if (tier.status === "ACTIVE") stats.activeTierCount += 1;
        stats.memberCount += tier._count.memberships;
      }

      return [...byOwner.values()];
    },

    listBenefitsForTiers: async (tierIds: string[]) => {
      if (tierIds.length === 0) {
        return [];
      }
      // The old defensive filters (kind, non-null terms) are gone because the
      // schema now guarantees both: one enum value, terms NOT NULL. What
      // remains is the one real predicate — retired benefits grant nothing.
      const rows = await p.membershipBenefit.findMany({
        where: {
          tierId: { in: tierIds },
          archivedAt: null,
        },
        // `id` breaks a same-millisecond createdAt tie, so the downstream
        // best-benefit selection (which keeps the FIRST on an equal-value tie)
        // resolves the same way on every checkout.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return rows.map(mapBenefit);
    },

    createBenefit: async (input) => {
      const row = await p.membershipBenefit.create({
        data: {
          tierId: input.tierId,
          kind: "DISCOUNT",
          discountKind: input.discountKind,
          discountValue: input.discountValue,
          maxDiscountCents: input.maxDiscountCents ?? null,
          categoryId: input.categoryId ?? null,
          placeId: input.placeId ?? null,
          label: input.label ?? null,
        },
      });
      return mapBenefit(row);
    },

    updateBenefit: async (input) => {
      const row = await p.membershipBenefit.update({
        where: { id: input.id },
        data: {
          // The terms PAIR is required by the port and always written together
          // — they are validated as a pair, so a partial write could turn
          // PERCENT 50 into PERCENT 5000 without failing validation.
          discountKind: input.discountKind,
          discountValue: input.discountValue,
          ...(input.maxDiscountCents === undefined
            ? {}
            : { maxDiscountCents: input.maxDiscountCents }),
          ...(input.categoryId === undefined
            ? {}
            : { categoryId: input.categoryId }),
          ...(input.placeId === undefined ? {} : { placeId: input.placeId }),
          ...(input.label === undefined ? {} : { label: input.label }),
        },
      });
      return mapBenefit(row);
    },

    findBenefitById: async (id: string) => {
      const row = await p.membershipBenefit.findUnique({ where: { id } });
      // A retired benefit is invisible to the attach/edit/remove surface,
      // exactly as it is to checkout.
      if (!row || row.archivedAt != null) {
        return null;
      }
      return mapBenefit(row);
    },

    deleteBenefit: async (input: { id: string; archivedAt: Date }) => {
      // RETIRE, not delete — the redemption ledger keeps its FK. See the port
      // doc for why this is worth the asymmetry with its name.
      //
      // The instant comes from the caller's ClockPort rather than `new Date()`
      // here, matching `membershipTaxJurisdictions.archive` one file over: an
      // adapter reaching for wall time is untestable and is the one thing in
      // this domain that would not be reproducible from a fixed clock.
      await p.membershipBenefit.update({
        where: { id: input.id },
        data: { archivedAt: input.archivedAt },
      });
    },
  };
}

function mapBenefit(row: MembershipBenefit): MembershipTierBenefitRecord {
  return {
    id: row.id,
    tierId: row.tierId,
    discountKind: row.discountKind as MembershipDiscountKind,
    discountValue: row.discountValue,
    maxDiscountCents: row.maxDiscountCents ?? null,
    categoryId: row.categoryId ?? null,
    placeId: row.placeId ?? null,
    label: row.label ?? null,
  };
}
