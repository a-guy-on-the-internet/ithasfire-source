/**
 * Multi-Index Search Port
 *
 * Contract for searching across multiple entity types (events, humans, places).
 * Supports both autocomplete suggestions and full-text search with facets.
 */

import type { Result, SearchPortError, SearchHealthStatus } from "./types";
import type {
  MultiSearchAutocompleteInput,
  MultiSearchAutocompleteOutput,
  MultiSearchIndexInput,
  MultiSearchIndexOutput,
  MultiSearchDeleteInput,
  MultiSearchDeleteOutput,
  MultiSearchIndexStats,
  MultiSearchSweepInput,
  SearchSweepToken,
} from "./multi-index.types";

/**
 * Query-side contract for multi-index search.
 */
export interface MultiSearchQueryPort {
  /**
   * Provides lightweight autocomplete suggestions across all indexed entity types.
   * Results are ranked by relevance and optionally filtered by type or geography.
   */
  autocomplete(
    input: MultiSearchAutocompleteInput,
  ): Promise<Result<MultiSearchAutocompleteOutput, SearchPortError>>;

  /**
   * Optional health probe for readiness/liveness diagnostics.
   */
  health?(): Promise<SearchHealthStatus>;
}

/**
 * Write-side contract for multi-index search.
 */
export interface MultiSearchIndexPort {
  /**
   * TRUE when the index is a table in the primary database (the Postgres
   * backend), so a document write can run on a caller's transaction via
   * `Repos.searchDocuments` and commit or roll back with it. Absent/false
   * for an external engine (Meilisearch), whose writes are never
   * transactional. Read by core's `bindSearchToTx`.
   */
  readonly indexLivesInPrimaryDatabase?: boolean;

  /**
   * Inserts or updates documents in the search index.
   * Documents are routed to the appropriate index based on their `type` field.
   */
  upsertDocuments(
    input: MultiSearchIndexInput,
  ): Promise<Result<MultiSearchIndexOutput, SearchPortError>>;

  /**
   * Removes documents by ID, type, or ownership filters.
   */
  deleteDocuments(
    input: MultiSearchDeleteInput,
  ): Promise<Result<MultiSearchDeleteOutput, SearchPortError>>;

  /**
   * NON-DESTRUCTIVE FULL REBUILD, step 1: take the sweep marker. Every
   * document written from here on (by the rebuild, or concurrently by an
   * incremental write) is stamped at or after it by the INDEX's own clock at
   * write time, never by the writer's read time.
   */
  beginSweep(): Promise<Result<SearchSweepToken, SearchPortError>>;

  /**
   * NON-DESTRUCTIVE FULL REBUILD, step 2 (per type, after that type's pass
   * wrote every live document): delete the documents of `type` written before
   * `token` — the ones nothing rewrote, i.e. entities no longer searchable —
   * except `keepIds`. Deletes only; never writes a document.
   */
  deleteUnswept(
    input: MultiSearchSweepInput,
  ): Promise<Result<MultiSearchDeleteOutput, SearchPortError>>;

  /**
   * Returns statistics about the indexed documents.
   */
  getStats(): Promise<Result<MultiSearchIndexStats, SearchPortError>>;

  /**
   * Ensures all indexes exist and are properly configured.
   * Call this once at startup or when deploying schema changes.
   */
  ensureIndexes(): Promise<Result<void, SearchPortError>>;
}

/**
 * The document writes of {@link MultiSearchIndexPort}, bound to one database
 * transaction (`Repos.searchDocuments`). Only meaningful when the search port
 * reports `indexLivesInPrimaryDatabase`.
 */
export type SearchDocumentsWriter = Pick<
  MultiSearchIndexPort,
  "upsertDocuments" | "deleteDocuments"
>;

/**
 * Combined port for implementations that provide both query and index capabilities.
 */
export interface MultiSearchPort
  extends MultiSearchQueryPort, MultiSearchIndexPort {}
