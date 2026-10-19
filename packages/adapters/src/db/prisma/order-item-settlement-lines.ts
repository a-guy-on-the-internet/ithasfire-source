import type {
  OrderItemSettlementLinesRepo,
  OrderItemSettlementLineDraftRow,
  OrderItemSettlementLineRecord,
} from "@th/ports/repos/order-item-settlement-lines";

import type { PrismaClientOrTx } from "./types";

export function makeOrderItemSettlementLinesRepo(
  p: PrismaClientOrTx,
): OrderItemSettlementLinesRepo {
  return {
    addDraft: async (rows: OrderItemSettlementLineDraftRow[]) => {
      if (rows.length === 0) return;

      // Skip duplicates using upsert-like behavior
      await p.orderItemSettlementLine.createMany({
        data: rows.map((r) => ({
          orderItemId: r.orderItemId,
          settlementLineId: r.settlementLineId,
          amountCents: r.amountCents,
        })),
        skipDuplicates: true,
      });
    },

    listBySettlementLineId: async (settlementLineId: string) => {
      const lines = await p.orderItemSettlementLine.findMany({
        where: { settlementLineId },
        orderBy: { createdAt: "asc" },
      });
      return lines.map(mapOrderItemSettlementLine);
    },

    listByOrderItemId: async (orderItemId: string) => {
      const lines = await p.orderItemSettlementLine.findMany({
        where: { orderItemId },
        orderBy: { createdAt: "asc" },
      });
      return lines.map(mapOrderItemSettlementLine);
    },

    listByOrderItemIds: async (orderItemIds: string[]) => {
      if (orderItemIds.length === 0) return [];
      const lines = await p.orderItemSettlementLine.findMany({
        where: { orderItemId: { in: orderItemIds } },
        orderBy: { createdAt: "asc" },
      });
      return lines.map(mapOrderItemSettlementLine);
    },

    listOrderItemIdsBySettlementIds: async (settlementIds: string[]) => {
      if (settlementIds.length === 0) return [];
      // Single query with a join: settlement line → order item settlement line
      const rows = await p.orderItemSettlementLine.findMany({
        where: {
          settlementLine: {
            settlementId: { in: settlementIds },
          },
        },
        select: { orderItemId: true },
        distinct: ["orderItemId"],
      });
      return rows.map((r) => r.orderItemId);
    },
  };
}

const mapOrderItemSettlementLine = (line: {
  id: string;
  orderItemId: string;
  settlementLineId: string;
  amountCents: number;
  createdAt: Date;
}): OrderItemSettlementLineRecord => ({
  id: line.id,
  orderItemId: line.orderItemId,
  settlementLineId: line.settlementLineId,
  amountCents: line.amountCents,
  createdAt: line.createdAt,
});
