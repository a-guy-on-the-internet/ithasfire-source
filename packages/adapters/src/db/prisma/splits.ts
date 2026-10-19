import type { SplitsRepo } from "@th/ports/repos/splits";

import type { PrismaClientOrTx } from "./types";

export function makeSplitsRepo(p: PrismaClientOrTx): SplitsRepo {
  return {
    upsertForOrder: async (orderId: string, rows) => {
      await p.orderSplit.deleteMany({ where: { orderId } });
      if (rows.length > 0) {
        await p.orderSplit.createMany({
          data: rows.map((r) => ({
            orderId,
            payeeId: r.payeeId,
            amountCents: r.amountCents,
          })),
        });
      }
    },
    getForOrder: async (orderId: string) => {
      const splits = await p.orderSplit.findMany({
        where: { orderId },
        select: { id: true, orderId: true, payeeId: true, amountCents: true },
      });
      return splits.map((s) => ({
        id: s.id,
        orderId: s.orderId,
        orderSplitId: s.id, // orderSplitId is the same as id for OrderSplit
        payeeId: s.payeeId,
        amountCents: s.amountCents,
      }));
    },
  };
}
