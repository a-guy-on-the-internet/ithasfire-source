import { vi } from "vitest";

import { createInMemorySearchReindexPending } from "./search-reindex-pending";

/**
 * Give an ad-hoc fake `Repos` the surface the search index write fence
 * (`buildSearchIndex` → `withIndexWriteFence`) needs, IN PLACE, keeping every
 * method the test already defined:
 *
 *  - `repos.tx(fn)` → runs `fn(repos)` (the fence re-reads through it);
 *  - `events.lockLocationsAtPlace` / `events.lockRows` → recorded no-ops;
 *  - `events.findManyByIds` → derived from the test's own `events.getById`,
 *    so a fixture keyed on `getById` answers both reads identically.
 *
 * In place (not a copy) so a test that re-stubs `repos.events.getById` after
 * wrapping is still the one the fence sees.
 */
export function withSearchIndexFence<R>(repos: R): R {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural test double
  const r = repos as any;
  r.events ??= {};
  r.events.lockLocationsAtPlace ??= vi.fn(async () => undefined);
  r.events.lockRows ??= vi.fn(async () => undefined);
  // A fixture's per-id `getById` failure is skipped here, not thrown: the
  // real `findManyByIds` is one query that cannot fail for a single id, and
  // the per-id read the indexer does next still surfaces that failure.
  r.events.findManyByIds ??= vi.fn(async (ids: string[]) => {
    const rows = await Promise.all(
      ids.map(async (id) => {
        try {
          return r.events.getById ? await r.events.getById(id) : null;
        } catch {
          return null;
        }
      }),
    );
    return rows.filter((row) => row !== null && row !== undefined);
  });
  r.tx ??= vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(r));
  // The post-commit reindex snapshots and clears the entity's
  // `SearchReindexPending` mark (edit-triggered batched reindex).
  r.searchReindexPending ??= createInMemorySearchReindexPending();
  return repos;
}
