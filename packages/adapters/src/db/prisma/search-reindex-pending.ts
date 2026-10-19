import type {
  SearchReindexEntityType,
  SearchReindexPendingRepo,
  SearchReindexPendingRow,
  SearchReindexPendingSnapshot,
  SearchReindexTarget,
} from "@th/ports/repos/search-reindex-pending";

import type { PrismaClientOrTx } from "./types";

type Row = {
  entityType: string;
  entityId: string;
  generation: number;
  markedAt: Date;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
};

function toRow(row: Row): SearchReindexPendingRow {
  return {
    entityType: row.entityType as SearchReindexEntityType,
    entityId: row.entityId,
    generation: row.generation,
    markedAt: row.markedAt,
    attempts: row.attempts,
    lastError: row.lastError,
    lastAttemptAt: row.lastAttemptAt,
  };
}

/**
 * Collapse duplicates and sort. The sort orders the INSERT's rows; the UPDATE
 * that follows locks in whatever order Postgres scans them, so two
 * transactions marking the SAME several entities could still deadlock (one
 * is then aborted and its edit fails with a retryable error). In practice a
 * mark set is one or two entities, and edits of the same entities already
 * serialize on the entity rows themselves.
 */
function uniqueSorted(targets: SearchReindexTarget[]): SearchReindexTarget[] {
  const byKey = new Map<string, SearchReindexTarget>();
  for (const t of targets) byKey.set(`${t.entityType}:${t.entityId}`, t);
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, t]) => t);
}

/** Longest `lastError` stored; the full error goes to the reporter. */
const MAX_LAST_ERROR = 1000;

/**
 * Targets per statement in `mark`. The UPDATE's OR list costs two bind
 * parameters per target and Postgres refuses more than 65,535 in one
 * statement, so an unbounded mark (every published event in a category, a
 * tax-location sweep) would fail outright past ~32k targets. 1,000 keeps
 * each statement small and far under the limit.
 */
export const MARK_CHUNK_SIZE = 1000;

export function makeSearchReindexPendingRepo(
  p: PrismaClientOrTx,
): SearchReindexPendingRepo {
  async function markChunk(
    rows: SearchReindexTarget[],
    at: Date,
  ): Promise<void> {
    // Two statements, both race-free under concurrent markers:
    //  1. INSERT … ON CONFLICT DO NOTHING creates the missing rows (a
    //     concurrent uncommitted insert of the same key makes this wait for
    //     it, then do nothing);
    //  2. UPDATE bumps EVERY targeted row — including the ones just
    //     inserted, harmlessly — so any snapshot taken before this commit
    //     no longer matches and a racing guarded clear cannot delete it.
    await p.searchReindexPending.createMany({
      data: rows.map((t) => ({
        entityType: t.entityType,
        entityId: t.entityId,
        markedAt: at,
      })),
      skipDuplicates: true,
    });
    await p.searchReindexPending.updateMany({
      where: {
        OR: rows.map((t) => ({
          entityType: t.entityType,
          entityId: t.entityId,
        })),
      },
      data: {
        generation: { increment: 1 },
        markedAt: at,
        attempts: 0,
        lastError: null,
      },
    });
  }

  return {
    async mark(targets, at) {
      const all = uniqueSorted(targets);
      // Chunked (MARK_CHUNK_SIZE): all chunks run on `p`, so inside a
      // transaction they commit or roll back together exactly as one
      // statement pair would. Chunks follow the sorted order.
      for (let i = 0; i < all.length; i += MARK_CHUNK_SIZE) {
        await markChunk(all.slice(i, i + MARK_CHUNK_SIZE), at);
      }
    },

    async getMany(targets) {
      const rows = uniqueSorted(targets);
      if (rows.length === 0) return [];
      const found = await p.searchReindexPending.findMany({
        where: {
          OR: rows.map((t) => ({
            entityType: t.entityType,
            entityId: t.entityId,
          })),
        },
      });
      return found.map(toRow);
    },

    async listDue({ limit, maxAttempts, after }) {
      const found = await p.searchReindexPending.findMany({
        where: {
          attempts: { lt: maxAttempts },
          ...(after
            ? {
                OR: [
                  { markedAt: { gt: after.markedAt } },
                  {
                    markedAt: after.markedAt,
                    entityType: { gt: after.entityType },
                  },
                  {
                    markedAt: after.markedAt,
                    entityType: after.entityType,
                    entityId: { gt: after.entityId },
                  },
                ],
              }
            : {}),
        },
        orderBy: [
          { markedAt: "asc" },
          { entityType: "asc" },
          { entityId: "asc" },
        ],
        take: limit,
      });
      return found.map(toRow);
    },

    async clearIfUnchanged(snapshots: SearchReindexPendingSnapshot[]) {
      let deleted = 0;
      // One autocommit statement per row: never holds two row locks at once.
      for (const s of snapshots) {
        const res = await p.searchReindexPending.deleteMany({
          where: {
            entityType: s.entityType,
            entityId: s.entityId,
            generation: s.generation,
          },
        });
        deleted += res.count;
      }
      return deleted;
    },

    async recordFailure(snapshots, { error, at }) {
      const lastError = error.slice(0, MAX_LAST_ERROR);
      for (const s of snapshots) {
        await p.searchReindexPending.updateMany({
          where: {
            entityType: s.entityType,
            entityId: s.entityId,
            generation: s.generation,
          },
          data: {
            attempts: { increment: 1 },
            lastError,
            lastAttemptAt: at,
          },
        });
      }
    },
  };
}
