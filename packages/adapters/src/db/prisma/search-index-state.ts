import type { SearchIndexStateRepo } from "@th/ports/repos/search-index-state";

import type { PrismaClientOrTx } from "./types";

/** The singleton row's key. */
const STATE_ID = "search";

export function makeSearchIndexStateRepo(
  p: PrismaClientOrTx,
): SearchIndexStateRepo {
  /** Create the singleton if missing (ON CONFLICT DO NOTHING). */
  async function ensureRow(): Promise<void> {
    await p.searchIndexState.createMany({
      data: [{ id: STATE_ID }],
      skipDuplicates: true,
    });
  }

  return {
    async get() {
      const row = await p.searchIndexState.findUnique({
        where: { id: STATE_ID },
      });
      if (!row) return null;
      return {
        formatVersion: row.formatVersion,
        rebuildClaimedVersion: row.rebuildClaimedVersion,
        rebuildClaimedAt: row.rebuildClaimedAt,
      };
    },

    async claimFormatRebuild({ version, now, staleBefore }) {
      await ensureRow();
      // One conditional UPDATE: Postgres re-checks the WHERE against the row
      // a concurrent claimer just committed, so exactly one caller sees
      // count = 1 while the claim is fresh.
      const res = await p.searchIndexState.updateMany({
        where: {
          id: STATE_ID,
          formatVersion: { lt: version },
          OR: [
            { rebuildClaimedVersion: null },
            { rebuildClaimedVersion: { lt: version } },
            { rebuildClaimedAt: null },
            { rebuildClaimedAt: { lt: staleBefore } },
          ],
        },
        data: { rebuildClaimedVersion: version, rebuildClaimedAt: now },
      });
      return res.count === 1;
    },

    async recordFormatVersion({ version, at }) {
      await ensureRow();
      await p.searchIndexState.updateMany({
        where: { id: STATE_ID, formatVersion: { lt: version } },
        data: { formatVersion: version, updatedAt: at },
      });
    },

    async releaseFormatRebuildClaim({ version }) {
      await p.searchIndexState.updateMany({
        where: { id: STATE_ID, rebuildClaimedVersion: version },
        data: { rebuildClaimedVersion: null, rebuildClaimedAt: null },
      });
    },
  };
}
