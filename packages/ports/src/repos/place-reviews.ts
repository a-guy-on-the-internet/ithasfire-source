import type {
  PlaceReviewRecord,
  CreatePlaceReviewInput,
  ListPlaceReviewsInput,
  ListModerationReviewsInput,
  ListModerationReviewsResult,
  RespondToPlaceReviewInput,
  FlagPlaceReviewInput,
  PatchReviewEmailInput,
  PlaceStatsRecord,
  UpsertPlaceStatsInput,
  SetPlaceStatsPublicSnapshotInput,
  ListPlaceIdsWithVisibleReviewsInput,
} from "@th/types/repos/place-reviews";

export interface PlaceReviewsRepo {
  create(input: CreatePlaceReviewInput): Promise<PlaceReviewRecord>;
  getById(id: string): Promise<PlaceReviewRecord | null>;
  listByPlace(input: ListPlaceReviewsInput): Promise<PlaceReviewRecord[]>;
  countByPlace(placeId: string, visibleOnly?: boolean): Promise<number>;
  listForModeration(
    input: ListModerationReviewsInput,
  ): Promise<ListModerationReviewsResult>;
  respond(input: RespondToPlaceReviewInput): Promise<PlaceReviewRecord>;
  flag(input: FlagPlaceReviewInput): Promise<PlaceReviewRecord>;
  hide(reviewId: string): Promise<PlaceReviewRecord>;
  unhide(reviewId: string): Promise<PlaceReviewRecord>;
  /**
   * Returns all non-hidden, non-flagged reviews for a place.
   * Used by the stats recalculation job.
   */
  listForStats(placeId: string): Promise<PlaceReviewRecord[]>;
  /**
   * Move a review to a different place (staff-only correction).
   * Returns the updated review record.
   */
  reassignPlace(
    reviewId: string,
    newPlaceId: string,
  ): Promise<PlaceReviewRecord>;
  /**
   * Lightweight aggregate counts for the public stats banner.
   * Returns distinct reviewed-place count, total review count,
   * and distinct contributor (anonymousEmail) count.
   */
  globalStats(): Promise<{
    venuesRated: number;
    totalReviews: number;
    contributors: number;
  }>;
  patchEmail(input: PatchReviewEmailInput): Promise<void>;
  /**
   * Distinct placeIds that have at least one visible (non-hidden,
   * non-flagged) review, ascending, cursor-paginated via `afterPlaceId`.
   * Drives the full public-snapshot recompute sweep.
   */
  listPlaceIdsWithVisibleReviews(
    input: ListPlaceIdsWithVisibleReviewsInput,
  ): Promise<string[]>;
}

export interface PlaceStatsRepo {
  getByPlaceId(placeId: string): Promise<PlaceStatsRecord | null>;
  upsert(input: UpsertPlaceStatsInput): Promise<PlaceStatsRecord>;
  /**
   * Writes the public anonymized snapshot for a place (creating the
   * PlaceStats row if it doesn't exist yet). The ONLY writer of
   * publicSnapshot/publicSnapshotAt — `upsert` never touches them.
   */
  setPublicSnapshot(input: SetPlaceStatsPublicSnapshotInput): Promise<void>;
  /**
   * Place ids whose PlaceStats row is STALE — stale-on-anything (venue-track-
   * record spec 2026-09-24, FR-008; R10, R12). A place is stale when, since
   * its `lastCalculatedAt`, ANY of these happened:
   *
   *   1. a `PlaceReview` at the place was created or updated;
   *   2. a PUBLISHED or COMPLETED event at the place ENDED (`Event.endsAt`
   *      crossed into the past — served by `Event(placeId, endsAt)`);
   *   3. a ticket at the place was ADMITTED (an ACCEPTED `TicketScan` row,
   *      via the event's `placeId` — served by `TicketScan(scannedAt)`; the
   *      attendance basis, R11). A revert writes no log row, so it does not
   *      make a place stale on its own — the sweep picks it up;
   *   4. an eligible order at the place changed (`PLACE_STATS_ELIGIBLE_ORDER_STATUSES`,
   *      the set recalculatePlaceStats reads for tickets sold — served by
   *      `Order(updatedAt)`);
   *
   * ALWAYS when no PlaceStats row exists for a place with a show or a
   * review — the clause that makes a place with ZERO performer reviews and
   * one past event get computed at all (the old contract keyed on review
   * timestamps alone); and ALWAYS when the row is older than the window
   * (`STALE_WINDOW_DAYS`, 30, exported by the Prisma adapter) — the sweep.
   *
   * ONE window (R12). Arms 3 and 4 look back `STALE_WINDOW_DAYS` of activity
   * rather than to each place's own `lastCalculatedAt` (bounding by recent
   * activity is what keeps them from scaling with total history — measured
   * ~7 µs per event ever hosted the other way), and the sweep recomputes any
   * row older than the same window. Together they are exact: an activity
   * after a row's stamp is either inside the lookback or the row is old
   * enough to sweep. The only remaining assumption is DRAIN CAPACITY: at the
   * job's default `batchSize` 50 and `*\/30 * * * *`, ~2,400 places a day
   * (~600 under prod's every-2-hours override in prod.tfvars).
   * Rows come back oldest-first (never-computed ahead of everything), so
   * after an outage the swept rows drain FIRST and a place with fresh
   * activity waits behind them — it does not "self-heal in one sweep".
   *
   * Every arm must be index-bounded (NFR-005) — no full scan of `Ticket`. At
   * most `limit` ids (default 100); the caller runs every 30 minutes.
   */
  listStalePlaceIds(limit?: number): Promise<string[]>;
  /**
   * placeIds that currently carry a published (non-null) publicSnapshot,
   * ascending, cursor-paginated via `afterPlaceId`. Unioned with
   * listPlaceIdsWithVisibleReviews by the weekly recompute sweep so a place
   * whose reviews were all hidden gets its stale snapshot overwritten with
   * the empty one instead of serving forever.
   */
  listPlaceIdsWithPublishedSnapshot(
    input: ListPlaceIdsWithVisibleReviewsInput,
  ): Promise<string[]>;
  /**
   * Published-snapshot candidates for "trusted venues near you" lists:
   * ACTIVE places in the given city carrying a non-null publicSnapshot AND
   * whose performer-review switch is on (`Place.communityReviewsEnabled`).
   * The switch filter is UNCONDITIONAL — this read exists only to feed a
   * public performer surface, and a place that turned performer reviews off
   * serves none (venue-track-record-and-review-switch FR-003).
   * Returns the raw snapshot JSON — callers MUST shape it through the
   * anonymization policy (toPublicHeadlineSummary). Live stats columns
   * (wouldPlayAgainPct, reviewCountPublic, …) are deliberately not selected:
   * they refresh every 30 minutes and would leak exact per-place aggregates.
   */
  listPublishedSnapshotsByCity(input: {
    city: string;
    region?: string;
    excludePlaceId: string;
    limit: number;
  }): Promise<
    Array<{
      placeId: string;
      placeName: string;
      publicSnapshot: unknown;
    }>
  >;
}

export type {
  PlaceReviewRecord,
  CreatePlaceReviewInput,
  ListPlaceReviewsInput,
  ListModerationReviewsInput,
  ListModerationReviewsResult,
  ModerationFilter,
  RespondToPlaceReviewInput,
  FlagPlaceReviewInput,
  PatchReviewEmailInput,
  PlaceStatsRecord,
  UpsertPlaceStatsInput,
  SetPlaceStatsPublicSnapshotInput,
  ListPlaceIdsWithVisibleReviewsInput,
  GenreCloudEntry,
  DayOfWeekEntry,
  PlaceReviewPaymentMethod,
  PlaceReviewSource,
} from "@th/types/repos/place-reviews";
