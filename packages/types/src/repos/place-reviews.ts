// ─────────────────────────────────────────────────────────────────────────────
// Place Review & Place Stats — repo record types and input shapes.
// ─────────────────────────────────────────────────────────────────────────────

export type PlaceReviewPaymentMethod =
  | "GUARANTEE"
  | "DOOR_SPLIT"
  | "TICKET_SALES"
  | "BAR_PERCENTAGE"
  | "TIPS_ONLY"
  | "PAY_TO_PLAY"
  | "UNPAID"
  | "OTHER";

export type PlaceReviewPromotionLevel =
  | "ACTIVELY_PROMOTED"
  | "POSTED_ONCE"
  | "NO_PROMOTION";

export type PlaceReviewSoundQuality =
  | "GREAT"
  | "ADEQUATE"
  | "BAD"
  | "NONEXISTENT";

export type PlaceReviewStageEquipment = "FULL" | "PARTIAL" | "NONE";

export type PlaceReviewAudienceFit = "PERFECT_FIT" | "OKAY" | "WRONG_CROWD";

export type PlaceReviewPlayAgain = "YES" | "MAYBE" | "NO";

export type PlaceReviewParking =
  | "DEDICATED_LOT"
  | "STREET_NEARBY"
  | "DIFFICULT"
  | "NIGHTMARE";

export type PlaceReviewBookerRating =
  | "EXCELLENT"
  | "GOOD"
  | "OKAY"
  | "POOR"
  | "TERRIBLE";

export type PlaceReviewSource = "SURVEY" | "PLATFORM" | "IMPORTED";

export type PlaceReviewMerchPolicy =
  | "ALLOWED_FREELY"
  | "ALLOWED_WITH_CUT"
  | "NOT_ALLOWED";

export type PlaceReviewStaffSupport = "YES" | "SOMEWHAT" | "NO";

export type PlaceReviewIndependentVenue = "YES" | "NO" | "NOT_SURE";

export type PlaceReviewTimeOfDay =
  | "MORNING"
  | "AFTERNOON"
  | "EVENING"
  | "NIGHT";

// ---------------------------------------------------------------------------
// PlaceReview record
// ---------------------------------------------------------------------------

export interface PlaceReviewRecord {
  id: string;
  placeId: string;
  humanId: string | null;
  anonymousName: string | null;
  anonymousEmail: string | null;

  payoutCents: number | null;
  paymentMethod: PlaceReviewPaymentMethod;
  paymentDetail: string | null;

  venuePromoted: PlaceReviewPromotionLevel;
  promotionDetail: string | null;

  soundQuality: PlaceReviewSoundQuality;
  soundDetail: string | null;

  stageEquipment: PlaceReviewStageEquipment;
  stageEquipmentDetail: string | null;

  audienceFit: PlaceReviewAudienceFit;
  audienceDetail: string | null;

  parkingLoadIn: PlaceReviewParking;
  parkingDetail: string | null;

  bookerRating: PlaceReviewBookerRating;
  bookerDetail: string | null;

  wouldPlayAgain: PlaceReviewPlayAgain;
  comment: string | null;

  genre: string | null;
  genreTags: string[];
  estimatedDraw: number | null;

  gigDate: Date | null;
  gigTimeOfDay: PlaceReviewTimeOfDay | null;
  gigTimeExact: string | null;
  dayOfWeek: number | null;
  merchAllowed: PlaceReviewMerchPolicy | null;
  merchCutPct: number | null;
  staffSupport: PlaceReviewStaffSupport | null;
  photoKeys: string[];
  independentVenue: PlaceReviewIndependentVenue | null;

  source: PlaceReviewSource;
  eventId: string | null;

  sourceCampaign: string | null;
  sourceChannel: string | null;

  responseText: string | null;
  responseById: string | null;
  respondedAt: Date | null;

  flagged: boolean;
  flagReason: string | null;
  hidden: boolean;

  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// PlaceReview inputs
// ---------------------------------------------------------------------------

export interface CreatePlaceReviewInput {
  placeId: string;
  humanId?: string | null;
  anonymousName?: string | null;
  anonymousEmail?: string | null;

  payoutCents?: number | null;
  paymentMethod: PlaceReviewPaymentMethod;
  paymentDetail?: string | null;

  venuePromoted: PlaceReviewPromotionLevel;
  promotionDetail?: string | null;

  soundQuality: PlaceReviewSoundQuality;
  soundDetail?: string | null;

  stageEquipment: PlaceReviewStageEquipment;
  stageEquipmentDetail?: string | null;

  audienceFit: PlaceReviewAudienceFit;
  audienceDetail?: string | null;

  parkingLoadIn: PlaceReviewParking;
  parkingDetail?: string | null;

  bookerRating: PlaceReviewBookerRating;
  bookerDetail?: string | null;

  wouldPlayAgain: PlaceReviewPlayAgain;
  comment?: string | null;

  genre?: string | null;
  genreTags?: string[];
  estimatedDraw?: number | null;

  gigDate?: Date | null;
  gigTimeOfDay?: PlaceReviewTimeOfDay | null;
  gigTimeExact?: string | null;
  dayOfWeek?: number | null;
  merchAllowed?: PlaceReviewMerchPolicy | null;
  merchCutPct?: number | null;
  staffSupport?: PlaceReviewStaffSupport | null;
  photoKeys?: string[];
  independentVenue?: PlaceReviewIndependentVenue | null;

  source?: PlaceReviewSource;
  eventId?: string | null;

  sourceCampaign?: string | null;
  sourceChannel?: string | null;
}

export interface ListPlaceReviewsInput {
  placeId: string;
  /** Exclude hidden and/or flagged reviews. */
  visibleOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface RespondToPlaceReviewInput {
  reviewId: string;
  responseById: string;
  responseText: string;
}

export interface FlagPlaceReviewInput {
  reviewId: string;
  flagReason: string;
}

export type ModerationFilter = "all" | "flagged" | "hidden" | "visible";

export interface ListModerationReviewsInput {
  placeId?: string;
  moderationFilter: ModerationFilter;
  limit?: number;
  offset?: number;
}

export interface ListModerationReviewsResult {
  reviews: PlaceReviewRecord[];
  total: number;
}

// ---------------------------------------------------------------------------
// PlaceStats record
// ---------------------------------------------------------------------------

export interface GenreCloudEntry {
  genre: string;
  count: number;
}

export interface DayOfWeekEntry {
  day: number;
  count: number;
}

export interface PlaceStatsRecord {
  id: string;
  placeId: string;

  reviewCount: number;
  reviewCountPublic: number;

  payoutMeanCents: number | null;
  payoutMedianCents: number | null;
  payoutMinCents: number | null;
  payoutMaxCents: number | null;
  payoutStdDevCents: number | null;
  payoutSampleSize: number;

  payoutGuaranteePct: number | null;
  payoutDoorSplitPct: number | null;
  payoutTicketSalesPct: number | null;
  payoutTipsPct: number | null;
  payoutPayToPlayPct: number | null;
  payoutUnpaidPct: number | null;

  promotionScore: number | null;
  soundScore: number | null;
  audienceFitScore: number | null;
  wouldPlayAgainPct: number | null;
  bookerScore: number | null;
  parkingScore: number | null;
  stageEquipmentScore: number | null;

  drawMean: number | null;
  drawMedian: number | null;
  drawMin: number | null;
  drawMax: number | null;
  drawSampleSize: number;

  payToPlayFlagged: boolean;
  equipmentLiedFlagged: boolean;
  noPromotionFlagged: boolean;

  genreCloud: GenreCloudEntry[];

  merchAllowedPct: number | null;
  avgMerchCutPct: number | null;
  dayOfWeekDistribution: DayOfWeekEntry[];
  staffSupportScore: number | null;
  independentVenuePct: number | null;

  totalEventCount: number;
  totalTicketsSold: number;
  avgTicketPriceCents: number | null;
  /**
   * TICKETS SOLD per past show — not attendance. Kept for its existing
   * readers; the venue track record never surfaces it. Checked-in figures
   * live in the `checkedIn*` fields below.
   */
  avgAttendance: number | null;

  // ── Track record (venue-track-record spec 2026-09-24, FR-009) ──────────
  // Door-derived, written by recalculatePlaceStats. All six are REQUIRED on
  // the upsert input (see UpsertPlaceStatsInput): a recalculation that does
  // not know them has not computed the track record.

  /**
   * Past PUBLISHED PUBLIC venue-confirmed events at the place, RSVP-only
   * shows included. Same rows as `totalEventCount` but on an `endsAt <= now`
   * basis (that one is `startsAt <= now`): they differ only by in-progress
   * shows. One Event row = one show: a recurring listing is ONE row however
   * many nights it names, so a residency counts once and its read-time
   * cadence is `null` — by design, not a bug.
   */
  showsHosted: number;
  /**
   * `endsAt` of the earliest show in `showsHosted`; null when none. RULED
   * 2026-09-24: the whole track record is on an `endsAt` basis — a show has
   * happened when it has ended (`track-record-policy.ts`).
   */
  firstShowAt: Date | null;
  /** `endsAt` of the latest show in `showsHosted`; null when none. */
  lastShowAt: Date | null;
  /**
   * Shows in `showsHosted` with at least ONE admitted ticket — an ACCEPTED
   * row in the `TicketScan` log (R11; `TicketsRepo.countScannedByEvent`).
   */
  scannedEventCount: number;
  /**
   * Admitted tickets summed across the `scannedEventCount` shows. Counted
   * from the scan log, so a ticket refunded after the door still counts.
   */
  checkedInTotal: number;
  /**
   * `checkedInTotal / scannedEventCount`, rounded; null when
   * `scannedEventCount === 0`. The mean is over shows WITH ≥1 scan only — a
   * show with zero scans is EXCLUDED, never counted as 0 (R4). Never
   * serialised past core: public readers derive an attendance BAND from it.
   */
  checkedInAvg: number | null;

  /**
   * Public anonymized snapshot (place-review-anonymization spec). Shaped by
   * core's anonymization-policy module; opaque at this layer. Null until the
   * recompute job first publishes one.
   */
  publicSnapshot: unknown;
  publicSnapshotAt: Date | null;

  lastCalculatedAt: Date;
}

// ---------------------------------------------------------------------------
// PlaceStats upsert input (used by the recalculation job)
// ---------------------------------------------------------------------------

/**
 * Note: deliberately excludes the publicSnapshot columns — the live-stats
 * recalculation must never touch the anonymized snapshot (it is written only
 * by setPublicSnapshot, on the weekly cadence).
 */
export type UpsertPlaceStatsInput = Omit<
  PlaceStatsRecord,
  "id" | "publicSnapshot" | "publicSnapshotAt"
>;

// ---------------------------------------------------------------------------
// Public snapshot inputs (place-review-anonymization spec)
// ---------------------------------------------------------------------------

export interface SetPlaceStatsPublicSnapshotInput {
  placeId: string;
  /** The coarsened snapshot object (core's PlacePublicSnapshot), stored as JSON. */
  snapshot: unknown;
  computedAt: Date;
}

export interface ListPlaceIdsWithVisibleReviewsInput {
  limit: number;
  /** Cursor: return placeIds strictly greater than this (ascending order). */
  afterPlaceId?: string;
}

export interface PatchReviewEmailInput {
  reviewId: string;
  email: string;
}
