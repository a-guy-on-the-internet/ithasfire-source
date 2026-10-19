import type {
  SearchReindexPendingRepo,
  SearchReindexPendingRow,
  SearchReindexTarget,
} from "@th/ports/repos/search-reindex-pending";
import type {
  SearchIndexStateRecord,
  SearchIndexStateRepo,
} from "@th/ports/repos/search-index-state";

/**
 * In-memory `SearchReindexPendingRepo` with the adapter's semantics: `mark`
 * inserts or bumps the generation (resetting attempts), the guarded clear and
 * `recordFailure` only touch a row whose generation still matches, `listDue`
 * is (markedAt, entityType, entityId) ordered with a keyset cursor.
 *
 * `rows` is exposed so a test can assert on (or seed) the table directly.
 */
export function createInMemorySearchReindexPending(): SearchReindexPendingRepo & {
  rows: Map<string, SearchReindexPendingRow>;
} {
  const rows = new Map<string, SearchReindexPendingRow>();
  const key = (t: SearchReindexTarget) => `${t.entityType}:${t.entityId}`;
  type Position = Pick<
    SearchReindexPendingRow,
    "markedAt" | "entityType" | "entityId"
  >;
  const order = (a: Position, b: Position) =>
    a.markedAt.getTime() - b.markedAt.getTime() ||
    (a.entityType < b.entityType ? -1 : a.entityType > b.entityType ? 1 : 0) ||
    (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0);

  return {
    rows,
    async mark(targets, at) {
      // Duplicates collapse, as in the adapter: one bump per mark call.
      const unique = new Map(targets.map((t) => [key(t), t]));
      for (const t of unique.values()) {
        const existing = rows.get(key(t));
        rows.set(key(t), {
          entityType: t.entityType,
          entityId: t.entityId,
          generation: (existing?.generation ?? 0) + 1,
          markedAt: at,
          attempts: 0,
          lastError: null,
          lastAttemptAt: existing?.lastAttemptAt ?? null,
        });
      }
    },
    async getMany(targets) {
      return targets
        .map((t) => rows.get(key(t)))
        .filter((r): r is SearchReindexPendingRow => r !== undefined)
        .map((r) => ({ ...r }));
    },
    async listDue({ limit, maxAttempts, after }) {
      return [...rows.values()]
        .filter((r) => r.attempts < maxAttempts)
        .sort(order)
        .filter((r) => (after ? order(r, after) > 0 : true))
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async clearIfUnchanged(snapshots) {
      let deleted = 0;
      for (const s of snapshots) {
        const row = rows.get(key(s));
        if (row && row.generation === s.generation) {
          rows.delete(key(s));
          deleted += 1;
        }
      }
      return deleted;
    },
    async recordFailure(snapshots, { error, at }) {
      for (const s of snapshots) {
        const row = rows.get(key(s));
        if (row && row.generation === s.generation) {
          rows.set(key(s), {
            ...row,
            attempts: row.attempts + 1,
            lastError: error,
            lastAttemptAt: at,
          });
        }
      }
    },
  };
}

/** In-memory `SearchIndexStateRepo` with the adapter's claim semantics. */
export function createInMemorySearchIndexState(
  initial: SearchIndexStateRecord | null = null,
): SearchIndexStateRepo & { state: SearchIndexStateRecord | null } {
  const self = {
    state: initial ? { ...initial } : null,
    async get() {
      return self.state ? { ...self.state } : null;
    },
    async claimFormatRebuild({
      version,
      now,
      staleBefore,
    }: {
      version: number;
      now: Date;
      staleBefore: Date;
    }) {
      self.state ??= {
        formatVersion: 0,
        rebuildClaimedVersion: null,
        rebuildClaimedAt: null,
      };
      const s = self.state;
      const claimable =
        s.formatVersion < version &&
        (s.rebuildClaimedVersion === null ||
          s.rebuildClaimedVersion < version ||
          s.rebuildClaimedAt === null ||
          s.rebuildClaimedAt < staleBefore);
      if (!claimable) return false;
      s.rebuildClaimedVersion = version;
      s.rebuildClaimedAt = now;
      return true;
    },
    async recordFormatVersion({ version }: { version: number; at: Date }) {
      self.state ??= {
        formatVersion: 0,
        rebuildClaimedVersion: null,
        rebuildClaimedAt: null,
      };
      if (self.state.formatVersion < version)
        self.state.formatVersion = version;
    },
    async releaseFormatRebuildClaim({ version }: { version: number }) {
      if (self.state && self.state.rebuildClaimedVersion === version) {
        self.state.rebuildClaimedVersion = null;
        self.state.rebuildClaimedAt = null;
      }
    },
  };
  return self;
}
