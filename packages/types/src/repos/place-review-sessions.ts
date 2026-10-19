// ─────────────────────────────────────────────────────────────────────────────
// Place Review Session — tracks form attempts for funnel analytics and
// abandonment recovery.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaceReviewSessionRecord {
  id: string;
  sessionToken: string;
  humanId: string | null;
  placeId: string;

  email: string | null;
  emailCapturedAt: Date | null;

  lastStepKey: string | null;
  lastStepAt: Date | null;
  pageReached: number;

  completedAt: Date | null;
  placeReviewId: string | null;

  abandonmentEmailSentAt: Date | null;
  recoveryUnsubscribedAt: Date | null;
  incentiveShownAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertPlaceReviewSessionInput {
  sessionToken: string;
  placeId: string;
  humanId?: string | null;
}

export interface UpdateSessionStepInput {
  sessionToken: string;
  lastStepKey: string;
  pageReached: number;
}

export interface CaptureSessionEmailInput {
  sessionToken: string;
  email: string;
}

export interface CompleteSessionInput {
  sessionToken: string;
  placeReviewId: string;
}

/**
 * Bind a freshly created review to the (sessionToken, placeId) session row,
 * creating the row if the form never managed to. Runs in the transaction that
 * creates the review, so the review can't belong to anyone else yet.
 */
export interface BindSessionReviewInput {
  sessionToken: string;
  placeId: string;
  placeReviewId: string;
  humanId?: string | null;
  completedAt: Date;
}

export interface FindAbandonedSessionsInput {
  staleAfter: Date;
  limit?: number;
}
