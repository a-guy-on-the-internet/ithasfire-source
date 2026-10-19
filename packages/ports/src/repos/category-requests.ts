import type {
  EventCategoryRequestKind,
  EventCategoryRequestRecord,
  EventCategoryRequestStatus,
} from "@th/types";

export interface CreateCategoryRequestInput {
  kind: EventCategoryRequestKind;
  name: string;
  slug: string;
  categoryId?: string | null;
  categorySlug?: string | null;
  categoryName?: string | null;
  eventId?: string | null;
  requesterHumanId: string;
  reviewNote?: string | null;
  /** The requester's UI locale ("en" | "es"); null / omitted = English. */
  locale?: string | null;
}

export interface FindPendingCategoryRequestInput {
  kind: EventCategoryRequestKind;
  slug: string;
  categoryId?: string | null;
}

export interface ListCategoryRequestsInput {
  status?: EventCategoryRequestStatus;
  kind?: EventCategoryRequestKind;
  limit?: number;
  offset?: number;
}

export interface ListCategoryRequestsResult {
  requests: EventCategoryRequestRecord[];
  total: number;
}

export interface MarkCategoryRequestReviewedInput {
  id: string;
  status: "APPROVED" | "REJECTED";
  reviewedByHumanId: string;
  reviewedAt: Date;
  reviewNote?: string | null;
  resolvedCategoryId?: string | null;
}

export interface ClaimPendingCategoryRequestForReviewInput {
  id: string;
  reviewedByHumanId: string;
  reviewedAt: Date;
}

export interface CategoryRequestsRepo {
  create(
    input: CreateCategoryRequestInput,
  ): Promise<EventCategoryRequestRecord>;
  findPending(
    input: FindPendingCategoryRequestInput,
  ): Promise<EventCategoryRequestRecord | null>;
  /**
   * The PENDING root-category request for `slug` (kind CATEGORY, no
   * `categoryId`), as a list oldest first. The partial unique index
   * `EventCategoryRequest_pending_root_unique_idx` allows at most one such
   * row, so the list has zero or one entries. Legacy scoped requests (rows
   * with a `categoryId`) are excluded: they never asked for a root category.
   * Used when a category is created directly, to resolve the request that
   * was waiting for it.
   */
  listPendingBySlug(slug: string): Promise<EventCategoryRequestRecord[]>;
  getById(id: string): Promise<EventCategoryRequestRecord | null>;
  list(input: ListCategoryRequestsInput): Promise<ListCategoryRequestsResult>;
  claimPendingForReview(
    input: ClaimPendingCategoryRequestForReviewInput,
  ): Promise<EventCategoryRequestRecord | null>;
  markReviewed(
    input: MarkCategoryRequestReviewedInput,
  ): Promise<EventCategoryRequestRecord>;
}

export type {
  EventCategoryRequestKind,
  EventCategoryRequestRecord,
  EventCategoryRequestStatus,
};
