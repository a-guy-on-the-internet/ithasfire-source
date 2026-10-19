import type { TxRepos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

/**
 * The search port to use INSIDE a database transaction.
 *
 * When the index is a table in the primary database (the Postgres backend,
 * `indexLivesInPrimaryDatabase`) and the transaction exposes a bound writer
 * (`tx.searchDocuments`), document writes go through the TRANSACTION'S
 * connection: they commit or roll back with it, and they take no second pool
 * connection. Reads (`autocomplete`, `getStats`) and `ensureIndexes` stay on
 * the port.
 *
 * Why it matters (the search index write fence and the privacy scrub):
 *  · a fence whose transaction is rolled back (timeout, error) takes its
 *    document write with it, so a stale write can never land after the locks
 *    it was protected by are gone;
 *  · a scrub's DELETE is atomic with the save it belongs to: no "deleted, then
 *    the save rolled back" state.
 *
 * Otherwise (Meilisearch, or a fake without `searchDocuments`) the port is
 * returned as is and `inTx` is false; callers that need the guarantee handle
 * that case themselves (the fence re-runs once on a rejected transaction).
 */
/**
 * Brand on every port {@link bindSearchToTx} returns. Lets a helper that must
 * NEVER write on a caller's transaction (`scrubSearchDocumentsOrReport`)
 * refuse one outright instead of trusting every call site to remember.
 */
const TX_BOUND: unique symbol = Symbol("search.txBound");

/** True for a port whose writes run on a caller's database transaction. */
export function isTxBoundSearch(search: unknown): boolean {
  return (
    typeof search === "object" &&
    search !== null &&
    (search as { [TX_BOUND]?: true })[TX_BOUND] === true
  );
}

export function bindSearchToTx(
  search: MultiSearchPort,
  tx: Pick<TxRepos, "searchDocuments">,
): { search: MultiSearchPort; inTx: boolean } {
  const writer = tx.searchDocuments;
  if (search.indexLivesInPrimaryDatabase !== true || !writer) {
    return { search, inTx: false };
  }
  const health = search.health;
  const bound: MultiSearchPort & { [TX_BOUND]: true } = {
    [TX_BOUND]: true,
    indexLivesInPrimaryDatabase: true,
    autocomplete: (input) => search.autocomplete(input),
    ...(health ? { health: () => health.call(search) } : {}),
    getStats: () => search.getStats(),
    ensureIndexes: () => search.ensureIndexes(),
    // The full rebuild's sweep is never run inside a fence; if it were, it
    // stays on the port's own connection like the other non-write calls.
    beginSweep: () => search.beginSweep(),
    deleteUnswept: (input) => search.deleteUnswept(input),
    upsertDocuments: (input) => writer.upsertDocuments(input),
    deleteDocuments: (input) => writer.deleteDocuments(input),
  };
  return { search: bound, inTx: true };
}

/**
 * {@link bindSearchToTx} for the scrub call sites, which may have no search
 * port at all (search not configured → nothing to scrub).
 */
export function searchForTx(
  search: MultiSearchPort | undefined,
  tx: Pick<TxRepos, "searchDocuments">,
): MultiSearchPort | undefined {
  return search ? bindSearchToTx(search, tx).search : undefined;
}
