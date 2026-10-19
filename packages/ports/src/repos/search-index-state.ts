/**
 * Which `SEARCH_INDEX_FORMAT_VERSION` (core `search/search-index-format.ts`)
 * the search index was last fully rebuilt at, and the claim that lets exactly
 * one `search.ensure-format` delivery run the rebuild after a format change
 * (Pub/Sub may redeliver while a rebuild is still running).
 */
export interface SearchIndexStateRecord {
  /** Format version of the last successful full rebuild (0 = never). */
  formatVersion: number;
  rebuildClaimedVersion: number | null;
  rebuildClaimedAt: Date | null;
}

export interface SearchIndexStateRepo {
  get(): Promise<SearchIndexStateRecord | null>;

  /**
   * Atomically claim the right to trigger a full rebuild for `version`.
   * Returns true for exactly one caller while the claim is fresh: the row
   * must be below `version`, and not already claimed for `version` (or
   * higher) at or after `staleBefore`. An expired claim (the rebuild never
   * recorded success — it crashed, or a page failed) can be taken again.
   */
  claimFormatRebuild(input: {
    version: number;
    now: Date;
    staleBefore: Date;
  }): Promise<boolean>;

  /**
   * A full rebuild written by code at `version` succeeded. Monotonic: never
   * lowers a stored version (an older build's nightly run is a no-op here).
   */
  recordFormatVersion(input: { version: number; at: Date }): Promise<void>;

  /**
   * Give a claim back (the rebuild threw), so the retried delivery can take
   * it at once instead of waiting for the claim to go stale.
   */
  releaseFormatRebuildClaim(input: { version: number }): Promise<void>;
}
