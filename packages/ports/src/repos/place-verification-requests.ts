import type {
  AcknowledgeVerificationInput,
  CreatePlaceVerificationRequestInput,
  ListClaimsByClaimantInput,
  ListClaimsByClaimantResult,
  ListStaleVerificationDocsInput,
  ListVerificationQueueInput,
  PlaceVerificationRequestRecord,
  UpdateVerificationDecisionInput,
  VerificationQueueItem,
  WithdrawVerificationInput,
} from "@th/types/repos/place-verification";

export interface PlaceVerificationRequestsRepo {
  create(
    input: CreatePlaceVerificationRequestInput,
  ): Promise<PlaceVerificationRequestRecord>;
  getById(requestId: string): Promise<PlaceVerificationRequestRecord | null>;
  /** Returns the most recent request for a place (any status). */
  getLatestForPlace(
    placeId: string,
  ): Promise<PlaceVerificationRequestRecord | null>;
  /** List all requests for a place, newest first. */
  listForPlace(placeId: string): Promise<PlaceVerificationRequestRecord[]>;
  /**
   * Returns the active (PENDING or IN_REVIEW) request for a place if one exists.
   * Used to enforce idempotency on submission and surface the in-flight request
   * in the detail panel.
   */
  getActiveForPlace(
    placeId: string,
  ): Promise<PlaceVerificationRequestRecord | null>;
  /**
   * Returns the active (PENDING / IN_REVIEW) OWNERSHIP_CLAIM request for a
   * place, if one exists. Enforces the "one active claim per place" rule
   * (FR-009) alongside the DB partial-unique backstop.
   */
  getActiveClaimForPlace(
    placeId: string,
  ): Promise<PlaceVerificationRequestRecord | null>;
  /**
   * Batch variant: returns the active (PENDING / IN_REVIEW) request status
   * for each placeId that has one. Missing placeIds get no map entry. Used
   * by listing endpoints that need to render the "effective" verification
   * badge (since IN_REVIEW only lives on the request, not on Place itself).
   */
  getActiveStatusByPlaceIds(
    placeIds: string[],
  ): Promise<Map<string, "PENDING" | "IN_REVIEW">>;
  /** @deprecated use getActiveForPlace which now covers PENDING + IN_REVIEW. */
  hasPendingForPlace(placeId: string): Promise<boolean>;
  /**
   * Claimant-facing list (all statuses) of the ownership claims + disputes a
   * signed-in human has filed, newest first, hydrated with the target place's
   * name + current slug. ORG_SUBMISSION rows are excluded (legacy org
   * verifications have their own surfaces). Keyset cursor scheme mirrors
   * `eventEditSuggestions.listBySubmitter` (cursor = request id, orderBy
   * createdAt desc, id desc). Never exposes reviewer identity.
   */
  listByClaimant(
    input: ListClaimsByClaimantInput,
  ): Promise<ListClaimsByClaimantResult>;
  /**
   * How many claims + disputes (all statuses) a human has filed. Same row set
   * as {@link listByClaimant} — ORG_SUBMISSION rows excluded — so a non-zero
   * count always means that list renders at least one row. Exists so
   * "does this human have any venue claims?" surfaces (the account-settings
   * nav) never have to page the rows just to read `.length`.
   */
  countByClaimant(claimantHumanId: string): Promise<number>;
  /**
   * OPEN ownership claims a human has filed: source OWNERSHIP_CLAIM, status
   * PENDING or IN_REVIEW (the same "active" set the one-active-claim-per-place
   * partial-unique index uses), keyed on `claimantHumanId` — the person who
   * filed, whether they claimed for themselves or for an org. Each such row
   * holds its place at PENDING. Disputes are excluded: they freeze nothing.
   * Feeds the anti-squatting cap (FR-004).
   */
  countOpenClaimsByClaimant(claimantHumanId: string): Promise<number>;
  updateDecision(
    input: UpdateVerificationDecisionInput,
  ): Promise<PlaceVerificationRequestRecord>;
  /**
   * Marks a PENDING request as IN_REVIEW and records the platform admin who
   * picked it up. Atomic guard: returns null if the request is no longer
   * PENDING (already claimed or decided).
   */
  acknowledge(
    input: AcknowledgeVerificationInput,
  ): Promise<PlaceVerificationRequestRecord | null>;
  /**
   * Marks a PENDING request as WITHDRAWN. Returns null if the request is no
   * longer PENDING (already acknowledged or decided).
   */
  withdraw(
    input: WithdrawVerificationInput,
  ): Promise<PlaceVerificationRequestRecord | null>;
  /**
   * Releases an IN_REVIEW lock back to PENDING (admin steps away without a
   * decision). Caller must verify that the actor is the original acknowledger.
   * Returns null if the request is not currently IN_REVIEW.
   */
  release(input: {
    requestId: string;
  }): Promise<PlaceVerificationRequestRecord | null>;
  /**
   * Powers the platform review queue. Sorted PENDING first (oldest createdAt),
   * then IN_REVIEW (oldest acknowledgedAt). Returns hydrated rows with place,
   * submitter, reviewer, and acknowledger summaries.
   */
  listQueue(
    input: ListVerificationQueueInput,
  ): Promise<{ items: VerificationQueueItem[]; total: number }>;
  /**
   * Aggregate counts for the queue header banner.
   */
  getQueueStats(): Promise<{
    pending: number;
    inReview: number;
    reviewedThisMonth: number;
    oldestPendingAgeMs: number | null;
  }>;
}

export type {
  AcknowledgeVerificationInput,
  ClaimantPlaceClaimItem,
  CreatePlaceVerificationRequestInput,
  ListClaimsByClaimantInput,
  ListClaimsByClaimantResult,
  ListStaleVerificationDocsInput,
  ListVerificationQueueInput,
  PlaceOwnerType,
  PlaceVerificationRequestRecord,
  PlaceVerificationRequestSource,
  UpdateVerificationDecisionInput,
  VerificationQueueItem,
  WithdrawVerificationInput,
} from "@th/types/repos/place-verification";
