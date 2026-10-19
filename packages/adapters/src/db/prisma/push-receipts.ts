import type {
  CreatePushReceiptsInput,
  ListDuePushReceiptsInput,
  PushReceiptRecord,
  PushReceiptsRepo,
  ReschedulePushReceiptsInput,
} from "@th/ports/repos/push-receipts";

import type { PrismaClientOrTx } from "./types";

const pushReceiptSelect = {
  id: true,
  ticketId: true,
  pushDeviceId: true,
  attempts: true,
  checkAfter: true,
  createdAt: true,
} as const;

export function makePushReceiptsRepo(p: PrismaClientOrTx): PushReceiptsRepo {
  return {
    async createMany(input: CreatePushReceiptsInput): Promise<void> {
      if (input.items.length === 0) return;
      await p.pushReceipt.createMany({
        data: input.items.map((item) => ({
          ticketId: item.ticketId,
          pushDeviceId: item.pushDeviceId,
          checkAfter: input.checkAfter,
        })),
        // Defensive: no known path re-inserts the same ticketId (a retried
        // Expo POST mints fresh ticket ids), but this write rides shotgun on
        // the send path, so an unforeseen double-persistence must degrade to
        // a silent skip rather than a P2002 bubbling into the send.
        skipDuplicates: true,
      });
    },

    async listDue(
      input: ListDuePushReceiptsInput,
    ): Promise<PushReceiptRecord[]> {
      return p.pushReceipt.findMany({
        where: { checkAfter: { lte: input.now } },
        orderBy: { checkAfter: "asc" },
        take: input.limit,
        select: pushReceiptSelect,
      });
    },

    async deleteByIds(ids: string[]): Promise<number> {
      if (ids.length === 0) return 0;
      // deleteMany so rows already drained by an overlapping run are 0-row
      // no-ops instead of throwing P2025 (no-leasing model, see the port).
      const { count } = await p.pushReceipt.deleteMany({
        where: { id: { in: ids } },
      });
      return count;
    },

    async reschedule(input: ReschedulePushReceiptsInput): Promise<void> {
      if (input.ids.length === 0) return;
      // updateMany so vanished rows are 0-row no-ops (no P2025).
      await p.pushReceipt.updateMany({
        where: { id: { in: input.ids } },
        data: {
          attempts: { increment: 1 },
          checkAfter: input.checkAfter,
        },
      });
    },
  };
}
