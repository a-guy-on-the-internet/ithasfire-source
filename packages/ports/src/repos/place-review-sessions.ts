import type {
  PlaceReviewSessionRecord,
  UpsertPlaceReviewSessionInput,
  UpdateSessionStepInput,
  CaptureSessionEmailInput,
  CompleteSessionInput,
  FindAbandonedSessionsInput,
  BindSessionReviewInput,
} from "@th/types/repos/place-review-sessions";

export interface PlaceReviewSessionsRepo {
  upsert(
    input: UpsertPlaceReviewSessionInput,
  ): Promise<PlaceReviewSessionRecord>;
  getBySessionToken(
    sessionToken: string,
  ): Promise<PlaceReviewSessionRecord | null>;
  /** The one row for this (token, place) — tokens are reused across places. */
  getBySessionTokenAndPlace(
    sessionToken: string,
    placeId: string,
  ): Promise<PlaceReviewSessionRecord | null>;
  /** Point the (token, place) row at a review created in the same tx. */
  bindReview(input: BindSessionReviewInput): Promise<PlaceReviewSessionRecord>;
  updateStep(input: UpdateSessionStepInput): Promise<void>;
  captureEmail(
    input: CaptureSessionEmailInput,
  ): Promise<PlaceReviewSessionRecord>;
  complete(input: CompleteSessionInput): Promise<PlaceReviewSessionRecord>;
  findAbandoned(
    input: FindAbandonedSessionsInput,
  ): Promise<PlaceReviewSessionRecord[]>;
  markAbandonmentEmailSent(id: string): Promise<void>;
  markRecoveryUnsubscribed(email: string): Promise<void>;
  isRecoveryUnsubscribed(email: string): Promise<boolean>;
}

export type {
  PlaceReviewSessionRecord,
  UpsertPlaceReviewSessionInput,
  UpdateSessionStepInput,
  CaptureSessionEmailInput,
  CompleteSessionInput,
  FindAbandonedSessionsInput,
  BindSessionReviewInput,
} from "@th/types/repos/place-review-sessions";
