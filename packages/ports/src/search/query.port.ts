import type {
  Result,
  SearchAutocompleteInput,
  SearchAutocompleteOutput,
  SearchHealthStatus,
  SearchPortError,
  SearchQueryInput,
  SearchQueryResult,
  SearchRelatedInput,
  SearchRelatedResult,
} from "./types";

/**
 * Read-side contract for search queries. Implementations should apply adapter-specific optimizations while
 * returning stable DTOs for transports and use cases.
 */
export interface SearchQueryPort {
  /**
   * Provides lightweight autocomplete suggestions. Inputs with `query.length < 2` should short-circuit to
   * an empty set to avoid unnecessary backend work.
   */
  autocomplete(
    input: SearchAutocompleteInput,
  ): Promise<Result<SearchAutocompleteOutput, SearchPortError>>;
  /**
   * Executes the main search query, optionally returning facet counts and ticket availability metadata.
   */
  search(
    input: SearchQueryInput,
  ): Promise<Result<SearchQueryResult, SearchPortError>>;
  /**
   * Returns semantically-related events given a source event id, falling back to shared tags/orgs when
   * vectors are unavailable.
   */
  related(
    input: SearchRelatedInput,
  ): Promise<Result<SearchRelatedResult, SearchPortError>>;
  /**
   * Optional health probe that adapters can expose for readiness/liveness diagnostics.
   */
  health?(): Promise<SearchHealthStatus>;
}
