import type { CacheGenerationPort } from "@th/ports/read-through-cache";
import type { Repos, TxOptions, TxRepos } from "@th/ports/repos";
import type {
  MultiSearchIndexPort,
  MultiSearchPort,
  SearchDocumentsWriter,
} from "@th/ports/search/multi-index.port";

/**
 * Bumps the shared public-read generation after every SEARCH INDEX write.
 *
 * ## Why the index, and not only the mutation
 *
 * `search.featuredEvents` (the home page's featured list) reads the search
 * index, and the index is written LATER than the mutation that changed the
 * row: a fire-and-forget post-commit reindex, the jobs drain behind
 * `searchReindexPending` marks, the full reindex, scheduled price flips. A
 * bump at the mutation alone makes every instance reload the OLD document and
 * keep it for the cache TTL. So the index write itself bumps — in whichever
 * process performs it (API or jobs).
 *
 * ## Commit semantics
 *
 * - Port writes (every method `INDEX_METHOD_BUMPS` marks `true`): autocommit
 *   (Postgres table outside a transaction, or Meilisearch). Bump once the call
 *   settles — success OR failure: a failed Meilisearch batch may have applied
 *   some chunks, and an extra reload costs one read.
 * - Transaction-bound writes (`repos.searchDocuments` inside `repos.tx`, used
 *   via core's `searchForTx` by the index write fence and the privacy scrub):
 *   a write only MARKS the transaction; the bump happens after `repos.tx`
 *   resolves, i.e. after COMMIT. Bumping inside would let another instance
 *   reload pre-commit rows under the new generation. A rolled-back
 *   transaction bumps nothing. Mirrors `with-outbox-drain-triggers.ts`.
 * - `repos.searchDocuments` outside a transaction: autocommit, bump on return.
 *
 * `bump` never rejects (CacheGenerationPort contract); it is awaited so a jobs
 * handler does not return (and lose CPU) before the INCR is sent.
 */
type Bumper = Pick<CacheGenerationPort, "bump">;

/** Every METHOD of the index port (`indexLivesInPrimaryDatabase` is data). */
type IndexPortMethod = {
  [K in keyof MultiSearchIndexPort]-?: MultiSearchIndexPort[K] extends (
    ...args: never[]
  ) => unknown
    ? K
    : never;
}[keyof MultiSearchIndexPort];

/**
 * Does calling this method change which documents the index serves?
 *
 * A `Record` over the port's methods, so adding a method to
 * `MultiSearchIndexPort` without classifying it here is a TYPE ERROR — a new
 * write path cannot silently skip the bump. `SearchDocumentsWriter` is a
 * `Pick` of the same port, so it is covered too. Query-port methods
 * (`autocomplete`, `health`) never write and are never wrapped.
 */
export const INDEX_METHOD_BUMPS: Record<IndexPortMethod, boolean> = {
  upsertDocuments: true,
  deleteDocuments: true,
  // The non-destructive full rebuild's stale-document delete.
  deleteUnswept: true,
  // Only takes a sweep marker; no document changes.
  beginSweep: false,
  getStats: false,
  // Creates/configures indexes; serves no different documents.
  ensureIndexes: false,
};

const WRITE_METHODS = new Set<PropertyKey>(
  Object.entries(INDEX_METHOD_BUMPS)
    .filter(([, bumps]) => bumps)
    .map(([method]) => method),
);

function bumpAfter<T extends object>(
  target: T,
  onSettled: () => Promise<void> | void,
): T {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (!WRITE_METHODS.has(prop) || typeof value !== "function") return value;
      if (!wrapped.has(prop)) {
        wrapped.set(prop, async (...args: unknown[]) => {
          try {
            return await Reflect.apply(
              value as (...a: unknown[]) => unknown,
              t,
              args,
            );
          } finally {
            await onSettled();
          }
        });
      }
      return wrapped.get(prop);
    },
  });
}

/** Decorate the search port's own (autocommit) document writes. */
export function withPublicReadBumpOnIndexWrites(
  search: MultiSearchPort,
  generation: Bumper,
): MultiSearchPort {
  // A Proxy, not a spread: `indexLivesInPrimaryDatabase`, `health` and any
  // adapter-specific members must pass through untouched (core's
  // `bindSearchToTx` reads them).
  return bumpAfter(search, () => generation.bump("search.index-write"));
}

/** Decorate `repos.searchDocuments`, bumping only after the write commits. */
export function withPublicReadBumpOnSearchDocumentWrites(
  repos: Repos,
  generation: Bumper,
): Repos {
  const root: Repos = { ...repos };
  if (repos.searchDocuments) {
    root.searchDocuments = bumpAfter<SearchDocumentsWriter>(
      repos.searchDocuments,
      () => generation.bump("search.document-write"),
    );
  }

  root.tx = async <T>(
    fn: (tx: TxRepos) => Promise<T>,
    txOptions?: TxOptions,
  ): Promise<T> => {
    let wrote = false;
    const result = await repos.tx((tx) => {
      if (!tx.searchDocuments) return fn(tx);
      return fn({
        ...tx,
        searchDocuments: bumpAfter<SearchDocumentsWriter>(
          tx.searchDocuments,
          () => {
            wrote = true;
          },
        ),
      });
    }, txOptions);
    // Committed. (A throw above means rollback: nothing to announce.)
    if (wrote) await generation.bump("search.document-write:tx");
    return result;
  };

  return root;
}
