import type {
  CountPendingObjectDeletionsInput,
  EnqueuePendingObjectDeletionItem,
  EnqueuePendingObjectDeletionOnceItem,
  EnqueuePendingObjectDeletionOnceResult,
  ListDuePendingObjectDeletionsInput,
  MarkPendingObjectDeletionDeadInput,
  MarkPendingObjectDeletionFailedInput,
  PendingObjectDeletionKind,
  PendingObjectDeletionOutboxHealth,
  PendingObjectDeletionRecord,
  PendingObjectDeletionStatus,
  PendingObjectDeletionsRepo,
} from "@th/ports/repos/pending-object-deletions";

import type { PrismaClientOrTx } from "./types";

type PendingObjectDeletionRow = {
  id: string;
  targetKey: string;
  targetKind: string;
  status: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  source: string | null;
  sourceId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: PendingObjectDeletionRow): PendingObjectDeletionRecord {
  return {
    id: row.id,
    targetKey: row.targetKey,
    targetKind: row.targetKind as PendingObjectDeletionKind,
    status: row.status as PendingObjectDeletionStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
    source: row.source,
    sourceId: row.sourceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCreateData(item: EnqueuePendingObjectDeletionItem) {
  return {
    ...(item.id ? { id: item.id } : {}),
    targetKey: item.targetKey,
    targetKind: item.targetKind,
    source: item.source ?? null,
    sourceId: item.sourceId ?? null,
    // status PENDING and attempts 0 come from the schema defaults;
    // nextAttemptAt too (now()) unless the item asks to wait.
    ...(item.notBefore ? { nextAttemptAt: item.notBefore } : {}),
  };
}

export function makePendingObjectDeletionsRepo(
  p: PrismaClientOrTx,
): PendingObjectDeletionsRepo {
  return {
    async enqueueMany(
      items: EnqueuePendingObjectDeletionItem[],
    ): Promise<void> {
      if (items.length === 0) return;
      await p.pendingObjectDeletion.createMany({
        data: items.map(toCreateData),
      });
    },

    async enqueueOnce(
      item: EnqueuePendingObjectDeletionOnceItem,
    ): Promise<EnqueuePendingObjectDeletionOnceResult> {
      // skipDuplicates is `ON CONFLICT DO NOTHING`: a taken id is not an
      // error, so the caller's transaction stays usable. A racing insert of
      // the same id blocks this one until it commits or rolls back.
      const { count } = await p.pendingObjectDeletion.createMany({
        data: [toCreateData(item)],
        skipDuplicates: true,
      });
      if (count === 1) return { inserted: true };
      const row = await p.pendingObjectDeletion.findUnique({
        where: { id: item.id },
      });
      return { inserted: false, existing: row ? toRecord(row) : null };
    },

    async getById(id: string): Promise<PendingObjectDeletionRecord | null> {
      const row = await p.pendingObjectDeletion.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async listDue(
      input: ListDuePendingObjectDeletionsInput,
    ): Promise<PendingObjectDeletionRecord[]> {
      const rows = await p.pendingObjectDeletion.findMany({
        where: {
          status: "PENDING",
          nextAttemptAt: { lte: input.now },
        },
        orderBy: { nextAttemptAt: "asc" },
        take: input.limit,
      });
      return rows.map(toRecord);
    },

    async markDeleted(id: string): Promise<number> {
      // deleteMany (not delete) so a row already drained by an overlapping run
      // is a 0-row no-op instead of throwing P2025. The no-leasing model is
      // only safe if bookkeeping is idempotent. The affected count lets the
      // caller distinguish "I drained it" (1) from "a peer beat me" (0).
      const { count } = await p.pendingObjectDeletion.deleteMany({
        where: { id },
      });
      return count;
    },

    async markFailed(
      input: MarkPendingObjectDeletionFailedInput,
    ): Promise<void> {
      // updateMany so a vanished row is a 0-row no-op (no P2025).
      await p.pendingObjectDeletion.updateMany({
        where: { id: input.id },
        data: {
          attempts: { increment: 1 },
          lastError: input.lastError,
          nextAttemptAt: input.nextAttemptAt,
        },
      });
    },

    async markDead(input: MarkPendingObjectDeletionDeadInput): Promise<void> {
      // updateMany so a vanished row is a 0-row no-op (no P2025).
      await p.pendingObjectDeletion.updateMany({
        where: { id: input.id },
        data: {
          attempts: { increment: 1 },
          lastError: input.lastError,
          status: "DEAD",
        },
      });
    },

    async cancelPending(
      input: Parameters<PendingObjectDeletionsRepo["cancelPending"]>[0],
    ): Promise<number> {
      if (input.targetKeys.length === 0) return 0;
      // PENDING only: a DEAD row is an ops record of a delete that already
      // failed for good, and stays for the dashboard.
      const { count } = await p.pendingObjectDeletion.deleteMany({
        where: {
          source: input.source,
          status: "PENDING",
          targetKey: { in: [...input.targetKeys] },
        },
      });
      return count;
    },

    async countOutboxHealth(
      input: CountPendingObjectDeletionsInput,
    ): Promise<PendingObjectDeletionOutboxHealth> {
      // `source` is applied to BOTH counts or NEITHER. A dead count scoped to
      // moderation sitting next to an overdue count over the whole table would
      // be two different questions wearing one label, and the reader has no way
      // to tell.
      const scope = input.source ? { source: input.source } : {};

      // Two indexed counts. No "still undeleted" clause: `markDeleted` HARD
      // DELETES on success, so a row existing IS that condition.
      const [dead, overdue] = await Promise.all([
        p.pendingObjectDeletion.count({ where: { ...scope, status: "DEAD" } }),
        p.pendingObjectDeletion.count({
          where: {
            ...scope,
            status: "PENDING",
            nextAttemptAt: { lte: input.dueBefore },
          },
        }),
      ]);
      return { dead, overdue };
    },
  };
}
