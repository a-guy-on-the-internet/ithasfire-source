import type {
  CommunityModeratorApplicationRecord,
  CommunityModeratorApplicationStatus,
} from "@th/types";

export interface CreateCommunityModeratorApplicationInput {
  applicantHumanId: string;
  statement?: string | null;
}

export interface ListPendingCommunityModeratorApplicationsInput {
  cursor?: string | null;
  limit?: number;
}

export interface ListPendingCommunityModeratorApplicationsResult {
  items: CommunityModeratorApplicationRecord[];
  nextCursor: string | null;
}

export interface ClaimPendingCommunityModeratorApplicationForReviewInput {
  id: string;
  reviewedByHumanId: string;
  reviewedAt: Date;
}

export interface MarkCommunityModeratorApplicationReviewedInput {
  id: string;
  status: "APPROVED" | "REJECTED";
  reviewedByHumanId: string;
  reviewedAt: Date;
  reviewNote?: string | null;
}

export interface CommunityModeratorApplicationsRepo {
  create(
    input: CreateCommunityModeratorApplicationInput,
  ): Promise<CommunityModeratorApplicationRecord>;
  getById(id: string): Promise<CommunityModeratorApplicationRecord | null>;
  /** The applicant's open PENDING application, if any (one-open-at-a-time guard). */
  findPendingByApplicant(
    applicantHumanId: string,
  ): Promise<CommunityModeratorApplicationRecord | null>;
  listPending(
    input: ListPendingCommunityModeratorApplicationsInput,
  ): Promise<ListPendingCommunityModeratorApplicationsResult>;
  /**
   * Atomically claim a PENDING application for review (status guard in the
   * WHERE clause). Returns null when the application is not PENDING — the
   * loser of a concurrent double-review sees null and bails.
   */
  claimPendingForReview(
    input: ClaimPendingCommunityModeratorApplicationForReviewInput,
  ): Promise<CommunityModeratorApplicationRecord | null>;
  markReviewed(
    input: MarkCommunityModeratorApplicationReviewedInput,
  ): Promise<CommunityModeratorApplicationRecord>;
}

export type {
  CommunityModeratorApplicationRecord,
  CommunityModeratorApplicationStatus,
};
