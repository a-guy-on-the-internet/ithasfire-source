import type { SettlementLinesRepo } from "@th/ports/repos/settlement-lines";

import type { PrismaClientOrTx } from "./types";

export function makeSettlementLinesRepo(
  p: PrismaClientOrTx,
): SettlementLinesRepo {
  return {
    addDraft: async (rows) => {
      if (!rows.length) return;
      await p.settlementLine.createMany({
        data: rows.map((r) => ({
          settlementId: r.settlementId,
          orderId: r.orderId,
          orderSplitId: r.orderSplitId,
          payeeId: r.payeeId,
          amountCents: r.amountCents,
          currency: r.currency,
        })),
        skipDuplicates: true,
      });
    },

    getById: async (settlementLineId) => {
      const row = await p.settlementLine.findUnique({
        where: { id: settlementLineId },
        select: {
          id: true,
          settlementId: true,
          orderId: true,
          orderSplitId: true,
          payeeId: true,
          amountCents: true,
          currency: true,
          createdAt: true,
        },
      });
      return row ?? null;
    },

    getByIds: async (ids: string[]) => {
      if (ids.length === 0) return [];
      const rows = await p.settlementLine.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          settlementId: true,
          orderId: true,
          orderSplitId: true,
          payeeId: true,
          amountCents: true,
          currency: true,
          createdAt: true,
        },
      });
      return rows;
    },

    listByOrderId: async (orderId) => {
      const rows = await p.settlementLine.findMany({
        where: { orderId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          settlementId: true,
          orderId: true,
          orderSplitId: true,
          payeeId: true,
          amountCents: true,
          currency: true,
          createdAt: true,
        },
      });
      return rows;
    },

    listBySettlementId: async (settlementId) => {
      const rows = await p.settlementLine.findMany({
        where: { settlementId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          settlementId: true,
          orderId: true,
          orderSplitId: true,
          payeeId: true,
          amountCents: true,
          currency: true,
          createdAt: true,
        },
      });
      return rows;
    },

    settlementIdsWithDisputedOrders: async (
      settlementIds,
      blockedStatuses,
    ) => {
      if (settlementIds.length === 0 || blockedStatuses.length === 0) {
        return new Set<string>();
      }

      const rows = await p.settlementLine.findMany({
        where: {
          settlementId: { in: settlementIds },
          order: { disputeStatus: { in: [...blockedStatuses] } },
        },
        select: { settlementId: true },
        distinct: ["settlementId"],
      });

      return new Set(rows.map((row) => row.settlementId));
    },

    settlementIdsWithOrderKinds: async (settlementIds, kinds) => {
      if (settlementIds.length === 0 || kinds.length === 0) {
        return new Set<string>();
      }

      const rows = await p.settlementLine.findMany({
        where: {
          settlementId: { in: settlementIds },
          order: { kind: { in: [...kinds] } },
        },
        select: { settlementId: true },
        distinct: ["settlementId"],
      });

      return new Set(rows.map((row) => row.settlementId));
    },

    sumSettlementAmountsForOrderKinds: async (settlementIds, kinds) => {
      if (settlementIds.length === 0 || kinds.length === 0) {
        return new Map<string, number>();
      }

      // One grouped query: the relation filter narrows lines to orders of
      // the requested kinds, and the per-settlement sum is done in the
      // database. Same access path as settlementIdsWithOrderKinds above —
      // this is its "how much?" sibling (the rolling reserve applies to the
      // membership AMOUNT inside a payout, not to its mere presence).
      const groups = await p.settlementLine.groupBy({
        by: ["settlementId"],
        where: {
          settlementId: { in: settlementIds },
          order: { kind: { in: [...kinds] } },
        },
        _sum: { amountCents: true },
      });

      return new Map(
        groups.map((g) => [g.settlementId, g._sum.amountCents ?? 0] as const),
      );
    },

    settlementIdsForOrderWithSettlementStatuses: async (orderId, statuses) => {
      if (statuses.length === 0) return new Set<string>();

      const rows = await p.settlementLine.findMany({
        where: {
          orderId,
          settlement: { status: { in: [...statuses] } },
        },
        select: { settlementId: true },
        distinct: ["settlementId"],
      });

      return new Set(rows.map((row) => row.settlementId));
    },
  };
}
