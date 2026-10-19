// ─────────────────────────────────────────────────────────────────────────────
// ReviewAggregate repo (attendee-reviews FR-004). Generic snapshot-not-live
// publication for attendee reviews: one review rolls up to four subject types,
// each carrying one coarsened public snapshot row. Public reads serve the
// stored snapshot VERBATIM and never touch live AttendeeReview rows.
// ─────────────────────────────────────────────────────────────────────────────

/** The four aggregation targets a single attendee review rolls up to. */
export type ReviewAggregateSubjectType = "EVENT" | "PLACE" | "OWNER" | "SERIES";

export interface ReviewAggregateRecord {
  id: string;
  subjectType: ReviewAggregateSubjectType;
  subjectId: string;
  /** The coarsened public snapshot (core's AttendeeReviewSnapshot), as JSON. */
  snapshot: unknown;
  computedAt: Date;
}

export interface SetReviewAggregateInput {
  subjectType: ReviewAggregateSubjectType;
  subjectId: string;
  /** The coarsened snapshot object, stored as JSON. */
  snapshot: unknown;
  computedAt: Date;
}

export interface ListReviewAggregateSubjectIdsInput {
  subjectType: ReviewAggregateSubjectType;
  limit: number;
  /** Cursor: return subjectIds strictly greater than this (ascending order). */
  afterSubjectId?: string;
}

export interface ReviewAggregatesRepo {
  /**
   * The stored snapshot for a subject, or null when none has been published.
   * The ONLY public read path — callers must NEVER fall back to live reviews.
   */
  getBySubject(input: {
    subjectType: ReviewAggregateSubjectType;
    subjectId: string;
  }): Promise<ReviewAggregateRecord | null>;

  /**
   * Upserts the snapshot for a subject (attendee-reviews recompute). The only
   * writer of this table.
   */
  setSnapshot(input: SetReviewAggregateInput): Promise<void>;

  /**
   * subjectIds of a given type that currently carry a published snapshot,
   * ascending, cursor-paginated via `afterSubjectId`. Unioned with the
   * has-reviews sweep so a subject whose reviews were all hidden gets its stale
   * snapshot overwritten with the empty one instead of serving forever.
   */
  listSubjectIdsWithAggregate(
    input: ListReviewAggregateSubjectIdsInput,
  ): Promise<string[]>;
}
