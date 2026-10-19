/**
 * The durable "needs reindex" list behind the edit-triggered, batched search
 * reindex (core `search/search-reindex-marks.ts`).
 *
 * A write that changes anything a search document shows calls {@link mark}
 * INSIDE its own transaction, so the mark commits exactly when the edit does
 * and a crash between commit and the post-commit reindex can no longer lose
 * the refresh. Rows are removed only by a GUARDED clear: the caller reads the
 * rows (their `generation`) BEFORE the reindex reads the source data, and
 * {@link clearIfUnchanged} deletes a row only if its generation is still the
 * one it read. A concurrent edit bumps the generation, so its mark survives.
 */
export type SearchReindexEntityType =
  | "event"
  | "human"
  | "place"
  | "organization";

export interface SearchReindexTarget {
  entityType: SearchReindexEntityType;
  entityId: string;
}

export interface SearchReindexPendingRow extends SearchReindexTarget {
  /** Bumped by every mark; the clear guard compares it. */
  generation: number;
  markedAt: Date;
  /** Failed drain attempts since the last mark (a new mark resets it). */
  attempts: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
}

/** Position in the (markedAt, entityType, entityId) order. */
export type SearchReindexPendingCursor = SearchReindexTarget & {
  markedAt: Date;
};

/** A row as it was read before a reindex: the clear guard's snapshot. */
export type SearchReindexPendingSnapshot = SearchReindexTarget & {
  generation: number;
};

export interface SearchReindexPendingRepo {
  /**
   * Insert each target, or bump an existing row's generation, set `markedAt`
   * to `at` and reset `attempts`/`lastError`. Call it INSIDE the edit's
   * transaction and let a failure propagate (a swallowed statement error
   * inside a transaction turns its COMMIT into a silent ROLLBACK).
   * Duplicates in `targets` are collapsed.
   */
  mark(targets: SearchReindexTarget[], at: Date): Promise<void>;

  /** The current rows for `targets` (absent ones are simply not returned). */
  getMany(targets: SearchReindexTarget[]): Promise<SearchReindexPendingRow[]>;

  /**
   * Oldest-marked-first page of rows with `attempts < maxAttempts`. Rows at or
   * over the cap are parked for the nightly full reindex.
   */
  listDue(input: {
    limit: number;
    maxAttempts: number;
    /**
     * Keyset cursor: only rows strictly after this one in
     * (markedAt, entityType, entityId) order. Lets one drain run page past
     * rows that just failed instead of re-reading them.
     */
    after?: SearchReindexPendingCursor;
  }): Promise<SearchReindexPendingRow[]>;

  /**
   * Delete each row only if its generation still equals the snapshot's.
   * One statement per row (never a multi-row DELETE), so the clear holds at
   * most one row lock at a time and cannot deadlock against an edit that is
   * marking several entities. Returns how many rows were deleted.
   */
  clearIfUnchanged(rows: SearchReindexPendingSnapshot[]): Promise<number>;

  /**
   * Record a failed attempt (`attempts + 1`, `lastError`, `lastAttemptAt`) on
   * each row whose generation still equals the snapshot's. A row re-marked in
   * the meantime is left alone: its fresh mark already reset the counter.
   */
  recordFailure(
    rows: SearchReindexPendingSnapshot[],
    input: { error: string; at: Date },
  ): Promise<void>;
}
