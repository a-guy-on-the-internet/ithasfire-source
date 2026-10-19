import type {
  HumanDelegatesRepo,
  HumanDelegateRecord,
  ListHumanDelegatesResult,
} from "@th/ports/repos/human-delegates";
import type { OrgRole } from "@th/ports/repos/authz";

import type { PrismaClientOrTx } from "./types";

export function makeHumanDelegatesRepo(
  p: PrismaClientOrTx,
): HumanDelegatesRepo {
  return {
    async addDelegate({ principalId, delegateId, role }) {
      const row = await p.humanDelegate.upsert({
        where: { principalId_delegateId: { principalId, delegateId } },
        create: { principalId, delegateId, role },
        update: { role },
        select: {
          id: true,
          principalId: true,
          delegateId: true,
          role: true,
          createdAt: true,
        },
      });

      return {
        id: row.id,
        principalId: row.principalId,
        delegateId: row.delegateId,
        role: row.role as OrgRole,
        createdAt: row.createdAt,
      } satisfies HumanDelegateRecord;
    },

    async getDelegation({ principalId, delegateId }) {
      const row = await p.humanDelegate.findUnique({
        where: { principalId_delegateId: { principalId, delegateId } },
        select: {
          id: true,
          principalId: true,
          delegateId: true,
          role: true,
          createdAt: true,
        },
      });

      if (!row) return null;

      return {
        id: row.id,
        principalId: row.principalId,
        delegateId: row.delegateId,
        role: row.role as OrgRole,
        createdAt: row.createdAt,
      } satisfies HumanDelegateRecord;
    },

    async listPrincipalsForDelegate({ delegateId, roles, principalIds }) {
      if (roles.length === 0) return [];
      if (principalIds && principalIds.length === 0) return [];
      // @@index([delegateId]) serves this read.
      const rows = await p.humanDelegate.findMany({
        where: {
          delegateId,
          role: { in: [...roles] },
          ...(principalIds ? { principalId: { in: [...principalIds] } } : {}),
        },
        select: { principalId: true },
        orderBy: { principalId: "asc" },
      });
      return rows.map((r) => r.principalId);
    },

    async listDelegates({ principalId, limit, offset }) {
      const [rows, total] = await Promise.all([
        p.humanDelegate.findMany({
          where: { principalId },
          skip: offset,
          take: limit,
          orderBy: { createdAt: "asc" },
          include: {
            delegate: {
              include: { authUser: { select: { email: true } } },
            },
          },
        }),
        p.humanDelegate.count({ where: { principalId } }),
      ]);

      return {
        items: rows.map((r) => ({
          humanId: r.delegateId,
          name: r.delegate.name,
          email: r.delegate.authUser?.email ?? null,
          role: r.role as OrgRole,
          joinedAt: r.createdAt,
        })),
        total,
      } satisfies ListHumanDelegatesResult;
    },

    async removeDelegate({ principalId, delegateId }) {
      const result = await p.humanDelegate.deleteMany({
        where: { principalId, delegateId },
      });

      return result.count > 0;
    },

    async countDelegatesByRole({ principalId, role }) {
      return p.humanDelegate.count({
        where: { principalId, role },
      });
    },
  };
}
