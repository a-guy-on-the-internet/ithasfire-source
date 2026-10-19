import type { CommunityModeratorApplicationsRepo } from "@th/ports/repos/community-moderator-applications";
import type {
  CommunityModeratorApplicationRecord,
  CommunityModeratorApplicationStatus,
} from "@th/types";

import type { PrismaClientOrTx } from "./types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const APPLICATION_SELECT = {
  id: true,
  applicantHumanId: true,
  statement: true,
  status: true,
  reviewedByHumanId: true,
  reviewedAt: true,
  reviewNote: true,
  createdAt: true,
  updatedAt: true,
} as const;

const mapRecord = (row: any): CommunityModeratorApplicationRecord => ({
  id: row.id,
  applicantHumanId: row.applicantHumanId,
  statement: row.statement ?? null,
  status: row.status as CommunityModeratorApplicationStatus,
  reviewedByHumanId: row.reviewedByHumanId ?? null,
  reviewedAt: row.reviewedAt ?? null,
  reviewNote: row.reviewNote ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

function getSafeLimit(limit?: number) {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

export function makeCommunityModeratorApplicationsRepo(
  p: PrismaClientOrTx,
): CommunityModeratorApplicationsRepo {
  return {
    async create(input) {
      const row = await p.communityModeratorApplication.create({
        data: {
          applicantHumanId: input.applicantHumanId,
          statement: input.statement ?? null,
        },
        select: APPLICATION_SELECT,
      });
      return mapRecord(row);
    },

    async getById(id) {
      const row = await p.communityModeratorApplication.findUnique({
        where: { id },
        select: APPLICATION_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async findPendingByApplicant(applicantHumanId) {
      const row = await p.communityModeratorApplication.findFirst({
        where: { applicantHumanId, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        select: APPLICATION_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    // Newest first (createdAt desc, id desc) matching the categoryRequests
    // admin-queue convention; keyset cursor = application id, same scheme as
    // eventSaves.listForHuman.
    async listPending({ cursor, limit }) {
      const safeLimit = getSafeLimit(limit);
      const rows = await p.communityModeratorApplication.findMany({
        where: { status: "PENDING" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(cursor
          ? {
              cursor: { id: cursor },
              skip: 1,
            }
          : {}),
        take: safeLimit + 1,
        select: APPLICATION_SELECT,
      });

      const hasMore = rows.length > safeLimit;
      const items = (hasMore ? rows.slice(0, safeLimit) : rows).map(mapRecord);

      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      };
    },

    // Claim stamps reviewedByHumanId/reviewedAt while status STAYS PENDING —
    // the status only flips in markReviewed. Mirrors
    // categoryRequests.claimPendingForReview: the atomic updateMany with the
    // PENDING + unreviewed guard makes the loser of a concurrent double-review
    // match zero rows and see null.
    async claimPendingForReview(input) {
      const result = await p.communityModeratorApplication.updateMany({
        where: {
          id: input.id,
          status: "PENDING",
          reviewedByHumanId: null,
          reviewedAt: null,
        },
        data: {
          reviewedByHumanId: input.reviewedByHumanId,
          reviewedAt: input.reviewedAt,
        },
      });
      if (result.count !== 1) {
        return null;
      }

      const row = await p.communityModeratorApplication.findUnique({
        where: { id: input.id },
        select: APPLICATION_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async markReviewed(input) {
      const row = await p.communityModeratorApplication.update({
        where: { id: input.id },
        data: {
          status: input.status,
          reviewedByHumanId: input.reviewedByHumanId,
          reviewedAt: input.reviewedAt,
          reviewNote: input.reviewNote ?? null,
        },
        select: APPLICATION_SELECT,
      });
      return mapRecord(row);
    },
  } satisfies CommunityModeratorApplicationsRepo;
}
