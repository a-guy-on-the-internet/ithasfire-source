import type { MembershipTaxJurisdiction } from "@prisma/client";
import type {
  CreateMembershipTaxJurisdictionInput,
  MembershipTaxJurisdictionKey,
  MembershipTaxJurisdictionRecord,
  MembershipTaxJurisdictionsRepo,
} from "@th/ports/repos/membership-tax-jurisdictions";

import type { PrismaClientOrTx } from "./types";

function mapJurisdiction(
  row: MembershipTaxJurisdiction,
): MembershipTaxJurisdictionRecord {
  return {
    id: row.id,
    countryCode: row.countryCode,
    postalCode: row.postalCode,
    rateBps: row.rateBps,
    rateSource: row.rateSource,
    stripeTaxRateId: row.stripeTaxRateId ?? null,
    checkedAt: row.checkedAt,
    effectiveFrom: row.effectiveFrom ?? null,
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makeMembershipTaxJurisdictionsRepo(
  p: PrismaClientOrTx,
): MembershipTaxJurisdictionsRepo {
  return {
    findLive: async (key: MembershipTaxJurisdictionKey) => {
      // `archivedAt: null` is load-bearing, not defensive: superseded rows are
      // retained for subscriptions still pointing at them, so without it a
      // lookup could resurrect last quarter's rate.
      const row = await p.membershipTaxJurisdiction.findFirst({
        where: {
          countryCode: key.countryCode,
          postalCode: key.postalCode,
          archivedAt: null,
        },
      });
      return row ? mapJurisdiction(row) : null;
    },

    findById: async (id: string) => {
      const row = await p.membershipTaxJurisdiction.findUnique({
        where: { id },
      });
      return row ? mapJurisdiction(row) : null;
    },

    create: async (input: CreateMembershipTaxJurisdictionInput) => {
      const row = await p.membershipTaxJurisdiction.create({
        data: {
          countryCode: input.countryCode,
          postalCode: input.postalCode,
          rateBps: input.rateBps,
          rateSource: input.rateSource,
          checkedAt: input.checkedAt,
          effectiveFrom: input.effectiveFrom ?? null,
        },
      });
      return mapJurisdiction(row);
    },

    listStale: async (input: { staleBefore: Date; limit: number }) => {
      const rows = await p.membershipTaxJurisdiction.findMany({
        where: {
          archivedAt: null,
          checkedAt: { lte: input.staleBefore },
        },
        orderBy: { checkedAt: "asc" },
        take: input.limit,
      });
      return rows.map(mapJurisdiction);
    },

    archive: async (input: { id: string; archivedAt: Date }) => {
      const row = await p.membershipTaxJurisdiction.update({
        where: { id: input.id },
        data: { archivedAt: input.archivedAt },
      });
      return mapJurisdiction(row);
    },

    touchCheckedAt: async (input: { id: string; checkedAt: Date }) => {
      const row = await p.membershipTaxJurisdiction.update({
        where: { id: input.id },
        data: { checkedAt: input.checkedAt },
      });
      return mapJurisdiction(row);
    },

    attachStripeTaxRateId: async (input: {
      id: string;
      stripeTaxRateId: string;
    }) => {
      const row = await p.membershipTaxJurisdiction.update({
        where: { id: input.id },
        data: { stripeTaxRateId: input.stripeTaxRateId },
      });
      return mapJurisdiction(row);
    },

    migrateMemberships: async (input: {
      fromJurisdictionId: string;
      toJurisdictionId: string;
    }) => {
      const { count } = await p.membership.updateMany({
        where: { taxJurisdictionId: input.fromJurisdictionId },
        data: { taxJurisdictionId: input.toJurisdictionId },
      });
      return { migratedCount: count };
    },
  };
}
