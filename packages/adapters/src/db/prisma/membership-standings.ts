import type { MembershipStanding } from "@prisma/client";
import type {
  MembershipStandingRecord,
  MembershipStandingsRepo,
} from "@th/ports/repos/membership-standings";

import type { PrismaClientOrTx } from "./types";

function mapStanding(row: MembershipStanding): MembershipStandingRecord {
  return {
    id: row.id,
    ownerOrgId: row.ownerOrgId ?? null,
    ownerHumanId: row.ownerHumanId ?? null,
    suspended: row.suspended,
    suspendedAt: row.suspendedAt ?? null,
    suspendedReason: row.suspendedReason ?? null,
    reserveBps: row.reserveBps,
    reserveReleaseDays: row.reserveReleaseDays,
    overriddenBy: row.overriddenBy ?? null,
    overrideReason: row.overrideReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makeMembershipStandingsRepo(
  p: PrismaClientOrTx,
): MembershipStandingsRepo {
  return {
    findForOwner: async (input) => {
      // Exactly one of the two is set by the caller; querying on the null one
      // would match every row whose other owner is set, so branch explicitly
      // rather than spreading both into the where clause.
      const where = input.ownerOrgId
        ? { ownerOrgId: input.ownerOrgId }
        : input.ownerHumanId
          ? { ownerHumanId: input.ownerHumanId }
          : null;
      if (!where) return null;

      const row = await p.membershipStanding.findFirst({ where });
      return row ? mapStanding(row) : null;
    },

    upsertForOwner: async (input) => {
      const data = {
        ...(input.suspended === undefined ? {} : { suspended: input.suspended }),
        ...(input.suspendedAt === undefined
          ? {}
          : { suspendedAt: input.suspendedAt }),
        ...(input.suspendedReason === undefined
          ? {}
          : { suspendedReason: input.suspendedReason }),
        ...(input.reserveBps === undefined
          ? {}
          : { reserveBps: input.reserveBps }),
        ...(input.reserveReleaseDays === undefined
          ? {}
          : { reserveReleaseDays: input.reserveReleaseDays }),
        ...(input.overriddenBy === undefined
          ? {}
          : { overriddenBy: input.overriddenBy }),
        ...(input.overrideReason === undefined
          ? {}
          : { overrideReason: input.overrideReason }),
      };

      const row = input.ownerOrgId
        ? await p.membershipStanding.upsert({
            where: { ownerOrgId: input.ownerOrgId },
            create: { ownerOrgId: input.ownerOrgId, ...data },
            update: data,
          })
        : await p.membershipStanding.upsert({
            where: { ownerHumanId: input.ownerHumanId! },
            create: { ownerHumanId: input.ownerHumanId!, ...data },
            update: data,
          });
      return mapStanding(row);
    },

    listAll: async () => {
      const rows = await p.membershipStanding.findMany({
        orderBy: { createdAt: "asc" },
      });
      return rows.map(mapStanding);
    },
  };
}
