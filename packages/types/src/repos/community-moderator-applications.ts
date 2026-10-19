export type CommunityModeratorApplicationStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED";

/**
 * Application to become a COMMUNITY_MODERATOR. Platform ADMIN reviews;
 * APPROVE grants the HumanRole + writes an AuditLog row. Mirrors the
 * EventCategoryRequestRecord shape.
 */
export interface CommunityModeratorApplicationRecord {
  id: string;
  applicantHumanId: string;
  statement: string | null;
  status: CommunityModeratorApplicationStatus;
  reviewedByHumanId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}
