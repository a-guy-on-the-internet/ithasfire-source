import type {
  Result,
  SearchIndexDeleteInput,
  SearchIndexDeleteOutput,
  SearchIndexRefreshOutput,
  SearchIndexUpsertInput,
  SearchIndexUpsertOutput,
  SearchPortError,
} from "./types";

/**
 * Defines the write-side contract for the search subsystem. Adapters may batch work internally but must
 * return deterministic summaries so upstream callers can react to success/failure without inspecting
 * vendor-specific responses.
 */
export interface SearchIndexPort {
  /**
   * Inserts or updates search documents. `mode = "merge"` allows partial updates (e.g., ticket availability)
   * while `mode = "replace"` should overwrite stored fields. Embeddings may be omitted; adapters can fetch
   * them lazily via the embedding provider.
   */
  upsertDocuments(
    input: SearchIndexUpsertInput,
  ): Promise<Result<SearchIndexUpsertOutput, SearchPortError>>;
  /**
   * Removes documents by explicit ids or scoped filters. Implementations must enforce multi-tenant rules
   * even if upstream callers already filtered inputs.
   */
  deleteDocuments(
    input: SearchIndexDeleteInput,
  ): Promise<Result<SearchIndexDeleteOutput, SearchPortError>>;
  /**
   * Forces the backing engine to refresh any write buffers. Engines without an explicit refresh should still
   * return a timestamp so callers can log when the operation completed.
   */
  refreshIndexes(): Promise<Result<SearchIndexRefreshOutput, SearchPortError>>;
}
