import type { IdempotencyRepo } from "@th/ports/repos/idempotency";

import type { PrismaClientOrTx } from "./types";

export function makeIdempotencyRepo(p: PrismaClientOrTx): IdempotencyRepo {
  return {
    seen: async (key: string) => {
      const rec = await p.auditLog.findFirst({
        where: { entity: "idempotency", entityId: key },
      });
      return !!rec;
    },
    remember: async (key: string) => {
      await p.auditLog.create({
        data: {
          entity: "idempotency",
          entityId: key,
          action: "remember",
          data: {},
        },
      });
    },
  };
}
